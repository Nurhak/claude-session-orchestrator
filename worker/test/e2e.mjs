// End-to-end test of the hosted flow against `wrangler dev` (DEV_LOGIN=1) on 127.0.0.1:8788.
// Run: npx wrangler dev --port 8788 --ip 127.0.0.1   then   node test/e2e.mjs
// Covers: dashboard sign-in, agent token, agent dial-out, MCP OAuth (DCR + PKCE + consent),
// tool relay with annotations, tenant isolation, token revocation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
const REPO = new URL('../..', import.meta.url).pathname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal cookie jar: the Worker sets __Host- (Secure) cookies, which fetch would not resend over http.
function browser() {
  const jar = new Map();
  return async function go(url, init = {}) {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(new URL(url, BASE), { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0/i.test(c) || v === '') jar.delete(k); else jar.set(k, v);
    }
    return res;
  };
}
const follow = async (go, res) => { while ([301, 302, 303].includes(res.status) && res.headers.get('location').startsWith(BASE)) res = await go(res.headers.get('location')); return res; };
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE }, body: new URLSearchParams(o) });

async function dashboardToken(user, label) {
  const go = browser();
  await follow(go, await go(`/login?provider=dev&as=${user}`));
  const page = await (await go('/dashboard/tokens', form({ label }))).text();
  const token = page.match(/cso_[A-Za-z0-9_-]{43}/)?.[0];
  assert.ok(token, `token page for ${user}`);
  return { go, token };
}

async function mcpLogin(user) {
  const go = browser();
  const redirect = 'http://127.0.0.1:9/cb';
  const reg = await (await fetch(`${BASE}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: `e2e ${user}`, redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, scope: 'mcp', state: 's1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` });
  const consent = await (await go(`/authorize?${q}`)).text();
  assert.match(consent, /Allow .* to manage your sessions\?/);
  assert.match(consent, /127\.0\.0\.1/); // redirect host shown
  const handle = consent.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  let res = await go('/authorize', form({ handle, provider: 'dev', dev_user: user }));
  res = await follow(go, res);
  if (!res.headers.get('location')) throw new Error(`authorize ended with ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const back = new URL(res.headers.get('location'));
  assert.equal(back.origin + back.pathname, redirect);
  const tok = await (await fetch(`${BASE}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json();
  assert.ok(tok.access_token, `access token for ${user}: ${JSON.stringify(tok)}`);
  const client = new Client({ name: `e2e-${user}`, version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
  return client;
}

function startAgent(token) {
  const tmp = mkdtempSync(join(tmpdir(), 'cso-agent-'));
  mkdirSync(join(tmp, 'cfg')); mkdirSync(join(tmp, 'proj', 'demo'), { recursive: true });
  writeFileSync(join(tmp, 'cfg', 'machines.yaml'), `machines:\n  - id: hub\n    local: true\n    projects_root: ${join(tmp, 'proj')}\n    claude_cmd: "sh -c 'echo fake-claude; cat' x"\n`);
  writeFileSync(join(tmp, 'cfg', 'projects.yaml'), 'projects:\n  - {id: demo, machine: hub}\n');
  const env = { ...process.env, CONFIG_DIR: join(tmp, 'cfg'), DB_PATH: join(tmp, 'a.db'), BRAIN_DIR: join(tmp, 'brain'), TMUX_TMPDIR: tmp,
    PORT: '8799', MCP_TOKEN: 'local-only', EVENTS_TOKEN: 'x'.repeat(32), ORCH_CLOUD_URL: 'ws://127.0.0.1:8788/agent', ORCH_AGENT_TOKEN: token };
  const p = spawn('node', ['src/server.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  return { p, log: () => log, tmp };
}

const text = (r) => JSON.parse(r.content[0].text);

// 1. Bad agent tokens are refused.
assert.equal((await fetch(`${BASE}/agent`, { headers: { authorization: 'Bearer cso_nope' } })).status, 401);

// 2. Alice: dashboard token, agent online, MCP sees her 23 annotated tools.
const alice = await dashboardToken('alice', 'e2e laptop');
const agent = startAgent(alice.token);
for (let i = 0; i < 40 && !agent.log().includes('cloud: connected'); i++) await wait(250);
assert.match(agent.log(), /cloud: connected to 127\.0\.0\.1:8788, 23 tools advertised/);
assert.match(await (await alice.go('/dashboard')).text(), /online since .* 23 tools advertised/);

const a = await mcpLogin('alice');
const tools = (await a.listTools()).tools;
assert.equal(tools.length, 23);
for (const t of tools) assert.ok(t.annotations?.title && typeof t.annotations.readOnlyHint === 'boolean' && typeof t.annotations.destructiveHint === 'boolean', `annotations on ${t.name}`);
assert.equal(tools.find((t) => t.name === 'session_stop').annotations.destructiveHint, true);
assert.equal(tools.find((t) => t.name === 'overview').annotations.readOnlyHint, true);
assert.match(text(await a.callTool({ name: 'overview', arguments: {} })).summary, /No sessions running/);
const started = text(await a.callTool({ name: 'session_start', arguments: { project: 'demo', prompt: 'hello', remote_control: false } }));
assert.match(started.summary, /Started demo on hub/);
await wait(400);
const read = text(await a.callTool({ name: 'session_read', arguments: { session: started.session, mode: 'tail' } }));
assert.match(read.text, /fake-claude/);
await a.callTool({ name: 'session_stop', arguments: { session: started.session, mode: 'kill', confirm: true } });

// 3. Bob is isolated: no agent of his own, cannot reach Alice's.
const b = await mcpLogin('bob');
const bobTools = (await b.listTools()).tools;
assert.deepEqual(bobTools.map((t) => t.name), ['orchestrator_setup']);
const bobCall = await b.callTool({ name: 'overview', arguments: {} });
assert.equal(bobCall.isError, true);
assert.match(text(bobCall).summary, /agent is not connected/);

// 4. Revoking Alice's token disconnects her agent at once; it does not reconnect.
const dash = await (await alice.go('/dashboard')).text();
const tokenId = dash.match(/name="id" value="([^"]+)"/)[1];
await alice.go('/dashboard/revoke', form({ id: tokenId }));
for (let i = 0; i < 40 && !agent.log().includes('token revoked'); i++) await wait(250);
assert.match(agent.log(), /agent token revoked; not reconnecting/);
const after = await a.callTool({ name: 'overview', arguments: {} });
assert.equal(after.isError, true);

// 5. Cross-site form posts to the dashboard are refused.
assert.equal((await alice.go('/dashboard/tokens', { ...form({ label: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' } })).status, 403);

agent.p.kill();
await a.close(); await b.close();
console.log('hosted e2e: all checks passed');
