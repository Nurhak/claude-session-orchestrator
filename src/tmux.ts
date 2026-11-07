import type { Machine } from './config.ts';
import { q, qpath, run, runOk, unreachable } from './transport/ssh.ts';

export const SESSION_RE = /^cc-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface TmuxSession { name: string; activity: number; pane: string }

const MARK = '@@cc-orchestrator@@';

/** Every cc-* session on a machine with its last 30 pane lines, in one round trip. */
export async function snapshot(m: Machine): Promise<TmuxSession[]> {
  const r = await run(m, `tmux list-sessions -F '#{session_name} #{session_activity}' 2>/dev/null | grep '^cc-' |
    while read -r s a; do echo "${MARK} $s $a"; tmux capture-pane -p -J -t "$s" -S -30; done; true`);
  if (r.code === 255) throw unreachable(m);
  return r.stdout.split(`${MARK} `).slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n');
    const [name, act] = chunk.slice(0, nl === -1 ? undefined : nl).trim().split(' ');
    return { name, activity: Number(act) * 1000, pane: nl === -1 ? '' : chunk.slice(nl + 1) };
  }).filter((s) => SESSION_RE.test(s.name));
}

export const newSession = (m: Machine, name: string, dir: string, cmd: string) =>
  runOk(m, `tmux new-session -d -s ${q(name)} -c ${qpath(dir)} ${q(cmd)}`);

/** Type literal text, then press Enter (separate call so text is never parsed as key names). */
export async function sendText(m: Machine, name: string, text: string) {
  await runOk(m, `tmux send-keys -t ${q(name)} -l ${q(text)} && sleep 0.2 && tmux send-keys -t ${q(name)} Enter`);
}

export const sendKeys = (m: Machine, name: string, ...keys: string[]) =>
  runOk(m, `tmux send-keys -t ${q(name)} ${keys.map(q).join(' ')}`);

export const capture = (m: Machine, name: string, lines: number) =>
  runOk(m, `tmux capture-pane -p -J -t ${q(name)} -S -${Math.max(1, Math.floor(lines))}`);

export const kill = (m: Machine, name: string) => runOk(m, `tmux kill-session -t ${q(name)}`);
