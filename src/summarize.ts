// Heuristic parsing of Claude Code's TUI as captured by `tmux capture-pane`.
// shortcut: regexes match the current Claude Code TUI wording; re-check them when the TUI changes.

export type Status = 'working' | 'waiting_input' | 'waiting_approval' | 'idle' | 'stopped';

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]/g;
const SPINNER = /^[\s·✢✳✶✻✽*⠁-⣿]+\s*\S+…/u; // "✻ Thinking…" style status lines
const BOX = /^[\s╭╮╰╯│─┌┐└┘├┤]+$/u;

export const clean = (raw: string) =>
  raw.replace(ANSI, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l && !BOX.test(l));

const APPROVAL = /Do you want to (proceed|make this edit|create|run|allow)|❯\s*1\.\s*Yes|Allow .* \?/i;

export function detectStatus(raw: string): Status | undefined {
  const lines = clean(raw).slice(-25).join('\n');
  // The permission prompt is always drawn at the bottom; older ones scrolled up are answered.
  if (APPROVAL.test(clean(raw).slice(-8).join('\n'))) return 'waiting_approval';
  if (/esc to interrupt/i.test(lines)) return 'working';
  return undefined; // can't tell from the pane; rely on hook state
}

export interface Summary {
  last_action: string | null;
  waiting_for: string | null;
  last_error: string | null;
  changed_files_count: number;
}

export function summarize(raw: string): Summary {
  const lines = clean(raw);
  const actions = lines.filter((l) => /^\s*⏺/.test(l)).map((l) => l.replace(/^\s*⏺\s*/, ''));
  const files = new Set<string>();
  for (const l of lines) {
    const m = l.match(/⏺\s*(?:Update|Write|Edit|MultiEdit)\((.+?)\)/);
    if (m) files.add(m[1]);
  }
  const errors = lines.filter((l) => /\b(error|failed|exception)\b/i.test(l) && !SPINNER.test(l));
  let waiting: string | null = null;
  const i = lines.findLastIndex((l) => APPROVAL.test(l));
  if (i >= 0) waiting = lines.slice(Math.max(0, i - 2), i + 1).map((l) => l.trim()).join(' ').slice(0, 200);
  return {
    last_action: trim(actions.at(-1)),
    waiting_for: waiting,
    last_error: trim(errors.at(-1)),
    changed_files_count: files.size,
  };
}

/** Plain tail: no ANSI, no spinner lines, long diffs collapsed. */
export function tail(raw: string, n: number): string {
  const out: string[] = [];
  let diffRun = 0;
  for (const l of clean(raw).filter((l) => !SPINNER.test(l))) {
    const isDiff = /^\s*\d+\s*[+-]/.test(l);
    diffRun = isDiff ? diffRun + 1 : 0;
    if (diffRun === 6) out.push('  … (diff truncated)');
    if (diffRun < 6) out.push(l);
  }
  return out.slice(-n).join('\n');
}

const trim = (s?: string) => (s ? s.trim().slice(0, 200) : null);
