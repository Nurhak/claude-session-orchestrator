import { execFile } from 'node:child_process';
import type { Machine } from '../config.ts';
import { UserError } from '../config.ts';

/** POSIX single-quote a value for safe use in a shell command. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Turn a leading ~ into $HOME so it still expands inside quotes. */
export const qpath = (p: string) => (p === '~' || p.startsWith('~/') ? `"$HOME"${q(p.slice(1))}` : q(p));

export interface RunResult { stdout: string; stderr: string; code: number }

/**
 * Run a shell command on a machine: local sh for `local: true`, otherwise SSH.
 * Never hangs longer than timeoutMs.
 */
export function run(m: Machine, cmd: string, timeoutMs = 5000, input?: string): Promise<RunResult> {
  const [bin, args] = m.local
    ? ['sh', ['-c', cmd]]
    : ['ssh', [
        '-o', 'BatchMode=yes',
        '-o', `ConnectTimeout=${Math.max(1, Math.floor(timeoutMs / 1000) - 1)}`,
        '-o', 'ServerAliveInterval=2', '-o', 'ServerAliveCountMax=1',
        m.user ? `${m.user}@${m.ssh_host}` : m.ssh_host!,
        // Non-interactive SSH shells skip the login profile, so Homebrew (macOS) and the Claude
        // installer's ~/.local/bin are missing from PATH. tmux sessions inherit this PATH too.
        `PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; ${cmd}`,
      ]];
  return new Promise((resolve) => {
    const child = execFile(bin, args as string[], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const e = err as { code?: number | string; killed?: boolean } | null;
      // ssh exits 255 on connection failure; a timeout kills the process.
      if (e && (e.killed || (!m.local && e.code === 255))) {
        resolve({ stdout, stderr: stderr || 'unreachable', code: 255 });
      } else {
        resolve({ stdout, stderr, code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 });
      }
    });
    child.stdin?.on('error', () => {}); // remote closed early; the exit code tells the story
    child.stdin?.end(input ?? '');
  });
}

export function unreachable(m: Machine): UserError {
  const hint = m.os === 'macos'
    ? ' It is probably asleep or on battery. Start the work on another machine instead.'
    : '';
  return new UserError(`${m.id} is unreachable.${hint}`);
}

/** Like run(), but throws a speakable error when the machine is down or the command fails. */
export async function runOk(m: Machine, cmd: string, timeoutMs = 5000, input?: string): Promise<string> {
  const r = await run(m, cmd, timeoutMs, input);
  if (r.code === 255) throw unreachable(m);
  if (r.code !== 0) throw new UserError(`Command failed on ${m.id}: ${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}`);
  return r.stdout;
}
