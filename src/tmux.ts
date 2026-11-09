import { randomBytes } from 'node:crypto';
import type { Machine } from './config.ts';
import { q, qpath, run, runOk, unreachable } from './transport/ssh.ts';

export const SESSION_RE = /^cc-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface TmuxSession { name: string; activity: number; pane: string }

// Exact-match targets: a bare `-t name` falls back to prefix matching, so a stale `cc-foo`
// would silently hit a live `cc-foo-ab12`. Session commands take `=name`, pane commands `=name:`.
const sess = (name: string) => q(`=${name}`);
const pane = (name: string) => q(`=${name}:`);

/** Every cc-* session on a machine with its last 30 pane lines, in one round trip. */
export async function snapshot(m: Machine): Promise<TmuxSession[]> {
  // Fresh random marker per call, so text shown in a pane cannot forge another session's record.
  const mark = `@@cc-${randomBytes(12).toString('hex')}@@`;
  const r = await run(m, `tmux list-sessions -F '#{session_name} #{session_activity}' 2>/dev/null | grep '^cc-' |
    while read -r s a; do echo "${mark} $s $a"; tmux capture-pane -p -J -t "=$s:" -S -30; done; true`);
  if (r.code === 255) throw unreachable(m);
  const seen = new Set<string>();
  return r.stdout.split(`${mark} `).slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n');
    const [name, act] = chunk.slice(0, nl === -1 ? undefined : nl).trim().split(' ');
    return { name, activity: Number(act) * 1000, pane: nl === -1 ? '' : chunk.slice(nl + 1) };
  }).filter((s) => SESSION_RE.test(s.name) && !seen.has(s.name) && !!seen.add(s.name));
}

export const newSession = (m: Machine, name: string, dir: string, cmd: string) =>
  runOk(m, `tmux new-session -d -s ${q(name)} -c ${qpath(dir)} ${q(cmd)}`);

/** Type literal text, then press Enter (separate call so text is never parsed as key names). */
export async function sendText(m: Machine, name: string, text: string) {
  await runOk(m, `tmux send-keys -t ${pane(name)} -l ${q(text)} && sleep 0.2 && tmux send-keys -t ${pane(name)} Enter`);
}

export const sendKeys = (m: Machine, name: string, ...keys: string[]) =>
  runOk(m, `tmux send-keys -t ${pane(name)} ${keys.map(q).join(' ')}`);

export const capture = (m: Machine, name: string, lines: number) =>
  runOk(m, `tmux capture-pane -p -J -t ${pane(name)} -S -${Math.max(1, Math.floor(lines))}`);

export const kill = (m: Machine, name: string) => runOk(m, `tmux kill-session -t ${sess(name)}`);
