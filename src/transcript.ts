// Reads a session's latest turn from Claude Code's own JSONL transcript: the exact reply text,
// the tools it used and the files it changed, instead of scraping the terminal.
import type { Machine } from './config.ts';
import { q, run } from './transport/ssh.ts';

export interface Turn {
  prompt: string | null;   // the user message that started this turn
  reply: string;           // assistant text blocks after it, in order
  actions: string[];       // e.g. "Bash: npm test", "Edit: src/app.ts"
  files: string[];         // files edited or written
}

const MAX_REPLY = 6000;
const TAIL_BYTES = 800_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Only accept paths that look like Claude Code transcripts (they arrive from hook payloads).
const TRANSCRIPT_RE = /^(?:~|\/)[^\0]*\/\.claude\/projects\/[^/]+\/[0-9a-f-]{36}\.jsonl$/;

export const isTranscriptPath = (p: unknown): p is string => typeof p === 'string' && TRANSCRIPT_RE.test(p);
export const isSessionId = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
type Entry = { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: string | Block[] } };

const isPrompt = (e: Entry) => {
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return !/^<(command|local-command|system)/.test(c); // slash-command plumbing is not a prompt
  return Array.isArray(c) && c.some((b) => b.type === 'text') && !c.some((b) => b.type === 'tool_result');
};

const promptText = (e: Entry) => {
  const c = e.message?.content;
  const t = typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  return t.trim().slice(0, 300);
};

function action(b: Block): string {
  const i = b.input ?? {};
  const s = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 80);
  if (b.name === 'Bash') return `Bash: ${s(i.command)}`;
  if (typeof i.file_path === 'string') return `${b.name}: ${i.file_path}`;
  if (typeof i.pattern === 'string') return `${b.name}: ${s(i.pattern)}`;
  return String(b.name ?? 'tool');
}

/** The last turn in a JSONL transcript (possibly a tail with a partial first line). */
export function lastTurn(jsonl: string): Turn {
  const entries: Entry[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* partial first line of a tail */ }
  }
  const start = entries.findLastIndex(isPrompt);
  const turn = entries.slice(start + 1).filter((e) => e.type === 'assistant' && !e.isSidechain);
  const blocks = turn.flatMap((e) => (Array.isArray(e.message?.content) ? e.message!.content as Block[] : []));
  const texts = blocks.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text!.trim());
  const tools = blocks.filter((b) => b.type === 'tool_use');
  let reply = texts.join('\n\n');
  if (reply.length > MAX_REPLY) reply = `…${reply.slice(-MAX_REPLY)}`; // the end holds the conclusion
  const files = [...new Set(tools.filter((b) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name ?? '') && typeof b.input?.file_path === 'string')
    .map((b) => b.input!.file_path as string))];
  return { prompt: start >= 0 ? promptText(entries[start]) : null, reply, actions: tools.map(action).slice(-15), files };
}

/** Fetch the tail of a session's transcript: by known path, else by the session id we started it with. */
export async function readTranscript(m: Machine, path: string | null, sessionId: string | null): Promise<string | null> {
  let cmd: string;
  if (isTranscriptPath(path)) cmd = `tail -c ${TAIL_BYTES} ${path.startsWith('~/') ? `"$HOME"${q(path.slice(1))}` : q(path)}`;
  else if (isSessionId(sessionId)) cmd = `f=$(ls -t "$HOME"/.claude/projects/*/${sessionId}.jsonl 2>/dev/null | head -1); [ -n "$f" ] && tail -c ${TAIL_BYTES} "$f"`;
  else return null;
  const r = await run(m, cmd, 10_000);
  return r.code === 0 && r.stdout.trim() ? r.stdout : null;
}

/** Delete a session's transcript file (by known path, else by session id). Returns whether a file was removed. */
export async function deleteTranscript(m: Machine, path: string | null, sessionId: string | null): Promise<boolean> {
  let target: string;
  if (isTranscriptPath(path)) target = path.startsWith('~/') ? `"$HOME"${q(path.slice(1))}` : q(path);
  else if (isSessionId(sessionId)) target = `"$HOME"/.claude/projects/*/${sessionId}.jsonl`;
  else return false;
  const r = await run(m, `n=0; for f in ${target}; do [ -f "$f" ] && rm -f "$f" && n=$((n+1)); done; echo $n`, 10_000);
  return r.code === 0 && Number(r.stdout.trim()) > 0;
}
