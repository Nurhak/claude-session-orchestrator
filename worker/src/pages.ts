import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { Provider } from './identity.ts';

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const NAMES: Record<Provider, string> = { github: 'GitHub', google: 'Google', dev: 'Local dev login' };

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--accent:#c96442;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1a;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#e08a6a;--card:#252522}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 16px}h1{font-size:1.5rem;margin:0 0 12px}h2{font-size:1.1rem;margin:28px 0 8px}
p,li{color:var(--fg)}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
code,pre{font:13px/1.5 ui-monospace,monospace}pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
button,.btn{display:inline-block;font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;margin:4px 8px 4px 0}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}input[type=text]{font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);width:100%;max-width:280px}
table{width:100%;border-collapse:collapse}td{padding:6px 4px;border-top:1px solid var(--line);vertical-align:middle}.warn{border-color:var(--accent)}
a{color:var(--accent)}footer{margin-top:40px;font-size:14px}
</style></head><body><main>${body}<footer class="muted"><a href="/">Home</a> · <a href="/dashboard">Dashboard</a> · <a href="/privacy">Privacy</a> · <a href="https://github.com/Nurhak/claude-session-orchestrator">Source</a></footer></main></body></html>`;

export const messagePage = (msg: string) => layout('Session Orchestrator', `<h1>Session Orchestrator</h1><p>${esc(msg)}</p>`);

export const homePage = (origin: string) => layout('Session Orchestrator', `
<h1>Session Orchestrator</h1>
<p>Manage all your Claude Code sessions, on all your machines, from Claude: the app, voice mode, or another session.</p>
<div class="card"><strong>1.</strong> In Claude, add a custom connector with this URL and sign in with GitHub or Google:<pre>${esc(origin)}/mcp</pre>
<strong>2.</strong> Open the <a href="/dashboard">dashboard</a>, create an agent token, and start the agent on your always-on machine.</div>
<p class="muted">Your sessions, SSH keys and notes stay on your own machine. This service signs you in and relays tool calls to your own agent, nothing else.</p>`);

export const privacyPage = (origin: string) => layout('Privacy · Session Orchestrator', `
<h1>Privacy policy</h1>
<p class="muted">Applies to ${esc(origin)}.</p>
<h2>What this service stores</h2>
<ul>
<li>Your account identifier from GitHub or Google (a numeric id or subject) and your username or email, to know which agent is yours.</li>
<li>OAuth grants and tokens for the Claude connector, stored as hashes by the OAuth library; profile details are encrypted.</li>
<li>Agent tokens you create, stored only as SHA-256 hashes, with the label and creation time you see in the dashboard.</li>
<li>The list of tools your agent advertises, so Claude can show them while your agent is offline.</li>
</ul>
<h2>What it does not store</h2>
<p>Tool arguments and results pass through to your own agent and back without being stored or logged by this service. Your sessions, code, notes, SSH keys and configuration stay on your machine.</p>
<h2>Third parties</h2>
<p>Sign-in uses GitHub or Google under their own privacy policies. The service runs on Cloudflare Workers.</p>
<h2>Deleting your data</h2>
<p>Revoke your agent tokens in the dashboard and disconnect the connector in Claude. For full deletion of your account record, open an issue at <a href="https://github.com/Nurhak/claude-session-orchestrator/issues">the project's GitHub</a>.</p>`);

export function consentPage(d: ConsentDescription, handle: string, providers: Provider[]) {
  const origin = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : 'This app registered itself; its name is not verified.';
  const buttons = providers.map((p, i) =>
    `<button name="provider" value="${p}"${i === 0 ? ' class="primary"' : ''}>Allow and sign in with ${NAMES[p]}</button>`).join('');
  return layout(`Authorize ${d.clientName}`, `
<h1>Allow ${esc(d.clientName)} to manage your sessions?</h1>
<div class="card">
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="card warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ''}
<p>It will be able to start, read, message, approve and stop Claude Code sessions through <strong>your own agent</strong>, and use its notes and local models.</p>
</div>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
${buttons || '<p>No sign-in provider is configured.</p>'}
<button name="provider" value="deny">Deny</button></form>`);
}

interface Session { userId: string; name: string }
interface TokenRow { id: string; label: string; created: number }
interface Status { online: boolean; since: number | null; tools: number }

export function dashboardPage(origin: string, s: Session | null, tokens: TokenRow[], st: Status | null, newToken: string | null, providers: Provider[]) {
  if (!s) {
    return layout('Dashboard · Session Orchestrator', `<h1>Dashboard</h1><p>Sign in to manage your agent tokens.</p>
${providers.map((p) => `<a class="btn" href="/login?provider=${p}">Sign in with ${NAMES[p]}</a>`).join('') || '<p>No sign-in provider is configured.</p>'}`);
  }
  const ws = origin.replace(/^http/, 'ws');
  const rows = tokens.map((t) => `<tr><td>${esc(t.label)}</td><td class="muted">${new Date(t.created).toISOString().slice(0, 10)}</td>
<td><form method="post" action="/dashboard/revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button>Revoke</button></form></td></tr>`).join('');
  return layout('Dashboard · Session Orchestrator', `
<h1>Dashboard</h1><p class="muted">Signed in as ${esc(s.name)}.</p>
<div class="card"><strong>Agent:</strong> ${st?.online ? `online since ${new Date(st.since!).toISOString().replace('T', ' ').slice(0, 16)} UTC` : 'offline'} · ${st?.tools ?? 0} tools advertised</div>
${newToken ? `<div class="card warn"><strong>Your new agent token.</strong> Copy it now; it will not be shown again.<pre>${esc(newToken)}</pre>
On your always-on machine:<pre>git clone https://github.com/Nurhak/claude-session-orchestrator
cd claude-session-orchestrator &amp;&amp; npm ci
cp config/machines.example.yaml config/machines.yaml   # describe your machines
cp config/projects.example.yaml config/projects.yaml   # and your projects
printf 'ORCH_CLOUD_URL=${esc(ws)}/agent\\nORCH_AGENT_TOKEN=%s\\n' '${esc(newToken)}' &gt;&gt; .env
chmod 600 .env &amp;&amp; npm start</pre></div>` : ''}
<h2>Agent tokens</h2>
${rows ? `<table>${rows}</table>` : '<p class="muted">No tokens yet.</p>'}
<form method="post" action="/dashboard/tokens"><p><input type="text" name="label" placeholder="Label, e.g. home server" maxlength="60"> <button class="primary">Create token</button></p></form>
<h2>Claude connector</h2><p>Add a custom connector in Claude with:</p><pre>${esc(origin)}/mcp</pre>
<form method="post" action="/dashboard/logout"><button>Sign out</button></form>`);
}
