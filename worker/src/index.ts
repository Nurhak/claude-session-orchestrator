// Hosted front door for claude-session-orchestrator.
//  /mcp        stateless MCP endpoint (OAuth 2.1 via @cloudflare/workers-oauth-provider); relays tool
//              calls to the signed-in user's own agent through their Durable Object.
//  /authorize  consent page + GitHub/Google sign-in for MCP clients (Claude).
//  /dashboard  web sign-in to create and revoke agent tokens.
//  /agent      WebSocket the user's agent dials out to (agent token).
import { AuthorizationError, CimdFetchError, OAuthProvider, authorizationErrorRedirect, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { authorizeUrl, exchange, providers, type Provider } from './identity.ts';
import { consentPage, dashboardPage, homePage, messagePage, privacyPage } from './pages.ts';
import { UserHub, type ToolInfo } from './hub.ts';

export { UserHub };

export interface Env {
  OAUTH_KV: KVNamespace;
  USER_HUB: DurableObjectNamespace<UserHub>;
  OAUTH_PROVIDER: OAuthHelpers;
  COOKIE_SECRET: string;
  GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  DEV_LOGIN?: string;
}
interface Props { userId: string; name: string }

const SCOPE = 'mcp';
const hub = (env: Env, userId: string) => env.USER_HUB.get(env.USER_HUB.idFromName(userId));
const html = (body: string, status = 200, headers = new Headers()) => {
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self' https://github.com https://accounts.google.com; frame-ancestors 'none'");
  headers.set('x-frame-options', 'DENY');
  return new Response(body, { status, headers });
};

// ---------- MCP: stateless, one Server per request ----------

const SETUP_TOOL: ToolInfo = {
  name: 'orchestrator_setup',
  title: 'Set up your orchestrator agent',
  description: 'Explains how to connect your own machine. Call this when no other orchestrator tools are listed or a tool says the agent is offline.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'Set up your orchestrator agent', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const setupText = (origin: string) =>
  `Your orchestrator agent is not connected. Open ${origin}/dashboard, sign in with the same account, create an agent token, and start the agent on your always-on machine (see the dashboard for the exact command). Your sessions, SSH keys and notes stay on your machine; this service only relays tool calls to your own agent.`;

const mcpApi: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const { userId } = (ctx as unknown as { props: Props }).props;
    const origin = new URL(request.url).origin;
    const stub = hub(env, userId);
    const server = new Server(
      { name: 'claude-session-orchestrator', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: 'Manages the user\'s Claude Code sessions on their own machines. In voice mode, call events_pending first. Every tool result starts with a one-sentence summary to read out.' },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = (await stub.tools()) as ToolInfo[];
      return { tools: tools.length ? tools : [SETUP_TOOL] } as never;
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const text = (summary: string) => ({ content: [{ type: 'text', text: JSON.stringify({ summary }) }], isError: true });
      if (req.params.name === SETUP_TOOL.name) return { content: [{ type: 'text', text: JSON.stringify({ summary: setupText(origin) }) }] };
      const result = await stub.call(req.params.name, req.params.arguments ?? {});
      return (result ?? text(setupText(origin))) as never;
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

// ---------- signed cookies (dashboard session, dashboard login state) ----------

const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(env: Env, data: string) {
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32) throw new Error('COOKIE_SECRET must be set (32+ chars)');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.COOKIE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
async function seal(env: Env, value: object, maxAgeS: number) {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ ...value, exp: Date.now() + maxAgeS * 1000 })));
  return `${body}.${await hmac(env, body)}`;
}
async function unseal<T>(env: Env, token: string | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || (await hmac(env, body)) !== sig) return null;
  const v = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as T & { exp: number };
  return v.exp > Date.now() ? v : null;
}
const cookie = (req: Request, name: string) =>
  req.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const SESSION = '__Host-cso-session', LOGIN = '__Host-cso-login';

// ---------- agent tokens (KV; only SHA-256 hashes stored) ----------

interface TokenRecord { id: string; userId: string; label: string; created: number }
const sha256 = async (s: string) => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function listTokens(env: Env, userId: string): Promise<TokenRecord[]> {
  return (await env.OAUTH_KV.get<TokenRecord[]>(`cso:user-tokens:${userId}`, 'json')) ?? [];
}
async function createToken(env: Env, userId: string, label: string) {
  const token = `cso_${b64u(crypto.getRandomValues(new Uint8Array(32)))}`;
  const rec: TokenRecord = { id: crypto.randomUUID(), userId, label: label.slice(0, 60) || 'agent', created: Date.now() };
  await env.OAUTH_KV.put(`cso:agent:${await sha256(token)}`, JSON.stringify(rec));
  await env.OAUTH_KV.put(`cso:token-hash:${rec.id}`, await sha256(token));
  await env.OAUTH_KV.put(`cso:user-tokens:${userId}`, JSON.stringify([...(await listTokens(env, userId)), rec]));
  return token;
}
async function revokeToken(env: Env, userId: string, id: string) {
  const list = await listTokens(env, userId);
  if (!list.some((t) => t.id === id)) return; // only the owner can revoke
  const hash = await env.OAUTH_KV.get(`cso:token-hash:${id}`);
  if (hash) await env.OAUTH_KV.delete(`cso:agent:${hash}`);
  await env.OAUTH_KV.delete(`cso:token-hash:${id}`);
  await env.OAUTH_KV.put(`cso:user-tokens:${userId}`, JSON.stringify(list.filter((t) => t.id !== id)));
  await hub(env, userId).disconnect(id);
}

// ---------- routes ----------

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER;

  if (url.pathname === '/') return html(homePage(url.origin));
  if (url.pathname === '/privacy') return html(privacyPage(url.origin));

  // The user's agent dials in here with its token.
  if (url.pathname === '/agent') {
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const rec = token.startsWith('cso_') ? await env.OAUTH_KV.get<TokenRecord>(`cso:agent:${await sha256(token)}`, 'json') : null;
    if (!rec) return new Response('invalid agent token', { status: 401 });
    const fwd = new Request(request, { headers: new Headers(request.headers) });
    fwd.headers.set('x-agent-token-id', rec.id);
    return hub(env, rec.userId).fetch(fwd);
  }

  // MCP client authorization: consent first, then sign-in with the chosen provider.
  if (url.pathname === '/authorize' && request.method === 'GET') {
    const authReq = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authReq);
    const consent = await oauth.beginConsent(authReq);
    return html(consentPage(details, consent.handle, providers(request, env)), 200, consent.headers);
  }
  if (url.pathname === '/authorize' && request.method === 'POST') {
    const form = await request.formData();
    const handleId = String(form.get('handle'));
    const provider = String(form.get('provider')) as Provider;
    if (!providers(request, env).includes(provider)) {
      const denied = await oauth.denyConsent(request, handleId);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handleId, { scope: [SCOPE] });
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier, provider }, headers: approved.headers });
    headers.set('location', await authorizeUrl(provider, request, env, state, verifier, String(form.get('dev_user') ?? 'local')));
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === '/callback') {
    const state = url.searchParams.get('state') ?? '';
    // Dashboard sign-in (our own state, bound to a signed cookie).
    if (state.startsWith('dash.')) {
      const login = await unseal<{ state: string; verifier: string; provider: Provider }>(env, cookie(request, LOGIN));
      if (!login || login.state !== state || url.searchParams.get('error')) return html(messagePage('Sign-in failed or expired. Please try again.'), 400);
      const who = await exchange(login.provider, request, env, url.searchParams.get('code') ?? '', login.verifier);
      const headers = new Headers({ location: '/dashboard' });
      headers.append('set-cookie', setCookie(SESSION, await seal(env, who, 7 * 86400), 7 * 86400));
      headers.append('set-cookie', setCookie(LOGIN, '', 0));
      return new Response(null, { status: 302, headers });
    }
    // MCP client authorization.
    const resumed = await oauth.finishUpstream<{ verifier: string; provider: Provider }>(request);
    if (url.searchParams.get('error')) {
      resumed.headers.set('location', authorizationErrorRedirect(resumed.request, 'access_denied'));
      return new Response(null, { status: 302, headers: resumed.headers });
    }
    const who = await exchange(resumed.data.provider, request, env, url.searchParams.get('code') ?? '', resumed.data.verifier);
    const { redirectTo } = await oauth.completeAuthorization({
      request: resumed.request, userId: who.userId, metadata: { name: who.name }, scope: resumed.request.scope,
      props: { userId: who.userId, name: who.name } satisfies Props,
    });
    resumed.headers.set('location', redirectTo);
    return new Response(null, { status: 302, headers: resumed.headers });
  }

  // Dashboard.
  if (url.pathname === '/login') {
    const provider = url.searchParams.get('provider') as Provider;
    if (!providers(request, env).includes(provider)) return html(messagePage('Unknown sign-in provider.'), 400);
    const state = `dash.${b64u(crypto.getRandomValues(new Uint8Array(24)))}`;
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const headers = new Headers({ location: await authorizeUrl(provider, request, env, state, verifier, url.searchParams.get('as') ?? 'local') });
    headers.append('set-cookie', setCookie(LOGIN, await seal(env, { state, verifier, provider }, 600), 600));
    return new Response(null, { status: 302, headers });
  }
  const session = await unseal<Props>(env, cookie(request, SESSION));
  if (url.pathname === '/dashboard' && request.method === 'GET') {
    if (!session) return html(dashboardPage(url.origin, null, [], null, null, providers(request, env)));
    const [tokens, status] = await Promise.all([listTokens(env, session.userId), hub(env, session.userId).status()]);
    return html(dashboardPage(url.origin, session, tokens, status, null, providers(request, env)));
  }
  if (url.pathname.startsWith('/dashboard/') && request.method === 'POST') {
    // CSRF: same-origin form posts only (plus SameSite=Lax session cookie).
    if (request.headers.get('origin') !== url.origin) return new Response('cross-site request refused', { status: 403 });
    if (!session) return Response.redirect(`${url.origin}/dashboard`, 303);
    const form = await request.formData();
    if (url.pathname === '/dashboard/tokens') {
      const token = await createToken(env, session.userId, String(form.get('label') ?? ''));
      const [tokens, status] = await Promise.all([listTokens(env, session.userId), hub(env, session.userId).status()]);
      return html(dashboardPage(url.origin, session, tokens, status, token, providers(request, env)));
    }
    if (url.pathname === '/dashboard/revoke') await revokeToken(env, session.userId, String(form.get('id')));
    if (url.pathname === '/dashboard/logout') {
      return new Response(null, { status: 303, headers: { location: '/dashboard', 'set-cookie': setCookie(SESSION, '', 0) } });
    }
    return Response.redirect(`${url.origin}/dashboard`, 303);
  }
  return new Response('not found', { status: 404 });
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return html(messagePage(error instanceof AuthorizationError ? error.description ?? 'Authorization failed.' : 'This app could not be verified.'), 400);
      }
      console.error(error);
      return html(messagePage('Something went wrong. Please try again.'), 500);
    }
  },
};

// The resource URL depends on the host (workers.dev now, a custom domain later), so build per origin.
const providersByOrigin = new Map<string, OAuthProvider<Env>>();
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const origin = new URL(request.url).origin;
    let p = providersByOrigin.get(origin);
    if (!p) {
      p = new OAuthProvider<Env>({
        apiRoute: '/mcp',
        apiHandler: mcpApi as never,
        defaultHandler: defaultHandler as never,
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/token',
        clientRegistrationEndpoint: '/register',
        scopesSupported: [SCOPE],
        requiredScopes: [SCOPE],
        resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      } as never);
      providersByOrigin.set(origin, p);
    }
    return p.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
