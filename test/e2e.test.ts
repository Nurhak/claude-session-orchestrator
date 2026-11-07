// Drives the real HTTP server, real tmux and a fake `claude` that prints Claude Code-like output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { app } from '../src/server.ts';
import { Db } from '../src/db.ts';
import type { Config } from '../src/config.ts';

const tmp = mkdtempSync(join(tmpdir(), 'orch-'));
process.env.TMUX_TMPDIR = tmp; // private tmux server, inherited by every child process
mkdirSync(join(tmp, 'proj', 'demo'), { recursive: true });

// Fake claude: echoes each line as an action; "ask" shows a permission prompt; "1" answers it.
const FAKE = `sh -c 'echo "args: $*"; while read l; do echo "⏺ Update(src/$l.ts)"; ` +
  `if [ "$l" = ask ]; then printf "Do you want to proceed?\\n❯ 1. Yes\\n"; else seq 9; fi; done' fake`;

const cfg: Config = {
  machines: [
    { id: 'node2', local: true, os: 'linux', projects_root: join(tmp, 'proj'), claude_cmd: FAKE },
    { id: 'macbook', ssh_host: '192.0.2.1', os: 'macos', projects_root: '~', local: false, claude_cmd: 'claude' },
  ],
  projects: [{ id: 'demo', aliases: ['the demo'], machine: 'node2', shared: [] }],
  endpoints: [],
};
const db = new Db(join(tmp, 't.db'));
const srv = app({ cfg, db }, 'secret');
let base = '';
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  return { err: !!r.isError, ...JSON.parse(r.content[0].text) };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});
after(async () => {
  await client.close();
  srv.close();
  const { execSync } = await import('node:child_process');
  execSync('tmux kill-server 2>/dev/null || true');
});

test('lists all tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['events_pending', 'machine_list', 'machine_status', 'overview', 'session_approve',
    'session_interrupt', 'session_list', 'session_read', 'session_send', 'session_start', 'session_stop']);
});

test('unreachable Mac fails fast with a speakable error (acceptance 4)', async () => {
  const t = Date.now();
  const r = await call('session_start', { project: 'demo', machine: 'macbook' });
  assert.ok(Date.now() - t < 6000);
  assert.ok(r.err);
  assert.match(r.summary, /macbook is unreachable.*asleep or on battery/);
  const list = await call('machine_list');
  assert.match(list.summary, /Unreachable: macbook/);
});

test('session lifecycle over MCP + hooks', async () => {
  const start = await call('session_start', { project: 'the demo', prompt: "first 'task'" });
  assert.ok(!start.err, start.summary);
  const name: string = start.session;
  assert.match(name, /^cc-demo-[0-9a-f]{4}$/);
  await wait(300);

  let read = await call('session_read', { session: 'demo', mode: 'tail' });
  assert.match(read.text, /args: --remote-control first 'task'/);

  await call('session_send', { session: name, message: 'ask' });
  await wait(500);
  read = await call('session_read', { session: name });
  assert.equal(read.changed_files_count, 1);
  assert.match(read.waiting_for, /Do you want to proceed/);

  // Hook arrives (acceptance 3).
  const post = (body: unknown, token = 'secret') => fetch(`${base}/events?session=${name}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post({ hook_event_name: 'Notification', message: 'x' }, 'wrong')).status, 401);
  assert.equal((await post({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })).status, 204);
  const pending = await call('events_pending');
  assert.equal(pending.pending[0].session, name);
  assert.equal(pending.pending[0].status, 'waiting_approval');

  const ov = await call('overview');
  assert.match(ov.summary, /1 sessions: 1 waiting for approval/);

  const ap = await call('session_approve', { session: name, choice: 'yes' });
  assert.ok(!ap.err, ap.summary);
  assert.equal((await call('events_pending')).pending.length, 0);
  await call('session_send', { session: name, message: 'go' }); // fake gets "1go", scrolls the prompt away
  await wait(400);
  assert.match((await call('session_approve', { session: name, choice: 'yes' })).summary, /not waiting for approval/);

  assert.equal((await post({ hook_event_name: 'Stop' })).status, 204);
  const list = await call('session_list');
  assert.equal(list.sessions[0].status, 'idle');
  assert.equal(list.sessions[0].remote_control, true);

  const kill = await call('session_stop', { session: name, mode: 'kill' });
  assert.match(kill.summary, /confirm=true/);
  assert.ok(!(await call('session_stop', { session: name, mode: 'kill', confirm: true })).err);
  assert.equal((await call('session_list')).sessions.length, 0);

  const audit = db.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number };
  assert.ok(audit.n >= 10);
});
