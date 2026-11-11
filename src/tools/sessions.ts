import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { findMachine, findProject, projectDir, UserError, type Machine } from '../config.ts';
import { injectContext, logSession } from './memory.ts';
import type { SessionRow } from '../db.ts';
import { detectStatus, menuKeys, summarize, tail, type Status } from '../summarize.ts';
import * as tmux from '../tmux.ts';
import { lastTurn, readTranscript } from '../transcript.ts';
import { q, qpath, runOk } from '../transport/ssh.ts';
import { ago, tool, type Ctx } from './common.ts';

const SPOKEN: Record<Status, string> = {
  working: 'working', waiting_input: 'waiting for input', waiting_approval: 'waiting for approval',
  idle: 'idle', stopped: 'stopped',
};

export interface LiveSession extends SessionRow { reachable: boolean; last_activity: number | null }

/** Reconcile tmux reality with the DB: new sessions get adopted, vanished ones become stopped. */
export async function refresh(ctx: Ctx, machine?: string): Promise<LiveSession[]> {
  const ms = machine ? [findMachine(ctx.cfg, machine)] : ctx.cfg.machines;
  const snaps = await Promise.all(ms.map(async (m) => {
    try { return { m, live: await tmux.snapshot(m) }; } catch { return { m, live: null }; }
  }));
  const out: LiveSession[] = [];
  for (const { m, live } of snaps) {
    const rows = new Map(ctx.db.sessions().filter((r) => r.machine === m.id).map((r) => [r.name, r]));
    if (live) {
      for (const s of live) {
        const owner = ctx.db.session(s.name)?.machine;
        if (owner && owner !== m.id) continue; // same name already tracked on another machine
        if (!rows.has(s.name)) {
          // Started outside the orchestrator: project is the middle of cc-<project>-<id>.
          ctx.db.upsertSession({ name: s.name, machine: m.id, project: s.name.slice(3).replace(/-[^-]+$/, ''), status: 'idle', remote_control: 0 });
        }
        const row = ctx.db.session(s.name)!;
        const seen = detectStatus(s.pane);
        // Pane regex is the fallback for missed hooks; it only overrides when it sees something definite.
        if (seen && seen !== row.status) ctx.db.setStatus(s.name, seen, row.last_message);
        out.push({ ...ctx.db.session(s.name)!, reachable: true, last_activity: s.activity });
        rows.delete(s.name);
      }
      for (const r of rows.values()) {
        if (r.status !== 'stopped') ctx.db.setStatus(r.name, 'stopped');
      }
    } else {
      for (const r of rows.values()) if (r.status !== 'stopped') out.push({ ...r, reachable: false, last_activity: null });
    }
  }
  return out;
}

/** Accept a full session name or a project id/alias that has exactly one live session. */
export function resolve(ctx: Ctx, name: string): SessionRow & { m: ReturnType<typeof findMachine> } {
  const n = name.trim().toLowerCase();
  let row = ctx.db.session(n) ?? ctx.db.session(`cc-${n}`);
  if (!row) {
    let pid: string | undefined;
    try { pid = findProject(ctx.cfg, n).id; } catch { /* not a project name */ }
    const cands = ctx.db.sessions().filter((r) => r.status !== 'stopped' && (r.project === pid || r.project === n));
    if (cands.length > 1) throw new UserError(`"${name}" matches ${cands.length} sessions: ${cands.map((c) => c.name).join(', ')}. Say which one.`);
    row = cands[0];
  }
  if (!row || row.status === 'stopped') throw new UserError(`No running session called "${name}".`);
  return { ...row, m: findMachine(ctx.cfg, row.machine) };
}

/** Best effort "what happened in this session" entry in the brain's projects/<p>/log.md. */
export async function writeLog(ctx: Ctx, s: SessionRow, m: Machine, note?: string) {
  try {
    let text = note ?? '';
    const raw = await tmux.capture(m, s.name, 400).catch(() => null);
    if (raw) {
      const sum = summarize(raw);
      text = [note, sum.last_action && `Last action: ${sum.last_action}`, `${sum.changed_files_count} files changed`,
        sum.last_error && `Last error: ${sum.last_error}`].filter(Boolean).join('. ') + '.';
    }
    await logSession(ctx, s.project, s.name, `Machine: ${m.id}. ${text || 'Session ended.'}`);
  } catch (e) {
    console.error(`session log for ${s.name} failed:`, (e as Error).message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE: Status[] = ['idle', 'waiting_input', 'waiting_approval', 'stopped'];
const WAIT = (dflt: number) => z.number().int().min(0).max(100).default(dflt)
  .describe('Seconds to wait for the session to finish its turn and return its reply (0 = return at once; max 100)');

/**
 * Wait until the session's turn ends: a hook reports idle/waiting after `since`, or (without hooks)
 * the pane shows a permission prompt, or stops showing "esc to interrupt" for two polls in a row.
 */
async function waitTurn(ctx: Ctx, name: string, m: Machine, since: number, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  let quiet = 0;
  while (Date.now() < end) {
    await sleep(2000);
    const row = ctx.db.session(name);
    if (row && DONE.includes(row.status) && row.status_since > since) return true;
    const pane = await tmux.capture(m, name, 30).catch(() => null);
    if (pane === null) return true; // session is gone
    const seen = detectStatus(pane);
    if (seen === 'waiting_approval') { ctx.db.setStatus(name, 'waiting_approval'); return true; }
    quiet = seen === 'working' ? 0 : quiet + 1;
    if (quiet >= 2 && Date.now() - since > 4000) return true;
  }
  return false;
}

/** The session's latest turn: exact reply from the transcript, else a pane summary. */
async function report(ctx: Ctx, name: string, m: Machine, done = true) {
  const row = ctx.db.session(name)!;
  const label = `${row.project} on ${m.id}`;
  const status = SPOKEN[row.status];
  const raw = await readTranscript(m, row.transcript, row.claude_id).catch(() => null);
  if (raw) {
    const t = lastTurn(raw);
    const first = t.reply.split(/(?<=[.!?])\s/)[0]?.slice(0, 220) ?? '';
    const changed = t.files.length ? ` ${t.files.length} file${t.files.length === 1 ? '' : 's'} changed.` : '';
    const head = !done ? `${label} is still working.` : row.status === 'waiting_approval' ? `${label} is waiting for your approval.` : `${label} replied:`;
    return {
      summary: `${head}${first ? ` ${first}` : ''}${changed}${!done ? ' Call session_wait to keep waiting.' : ''}`,
      status: row.status, done, reply: t.reply || null, prompt: t.prompt, actions: t.actions, files_changed: t.files,
      ...(row.status === 'waiting_approval' && { waiting_for: summarize(await tmux.capture(m, name, 30).catch(() => '')).waiting_for }),
    };
  }
  const sum = summarize(await tmux.capture(m, name, 200).catch(() => ''));
  const parts = [sum.waiting_for && `Waiting: ${sum.waiting_for}`, sum.last_action && `Last: ${sum.last_action}`,
    sum.last_error && `Error: ${sum.last_error}`].filter(Boolean);
  return { summary: `${label} is ${status}.${parts.length ? ` ${parts.join('. ')}.` : ''}${!done ? ' Call session_wait to keep waiting.' : ''}`, status: row.status, done, ...sum };
}

async function sendAndWait(ctx: Ctx, s: SessionRow & { m: Machine }, wait: number, sent: number) {
  if (!wait) return null;
  const done = await waitTurn(ctx, s.name, s.m, sent, wait);
  return report(ctx, s.name, s.m, done);
}

export function line(s: LiveSession) {
  const where = s.reachable ? '' : ' (machine unreachable, last known)';
  return `${s.project} on ${s.machine}: ${SPOKEN[s.status]} since ${ago(s.status_since)}${where}.`;
}

export function register(server: McpServer, ctx: Ctx) {
  tool(server, ctx, 'session_list', 'List Claude Code sessions with project, machine, status, last activity and Remote Control flag.',
    { machine: z.string().optional() },
    async ({ machine }) => {
      const ss = await refresh(ctx, machine);
      return {
        summary: ss.length ? `${ss.length} sessions. ${ss.map(line).join(' ')}` : 'No sessions running.',
        sessions: ss.map((s) => ({
          name: s.name, project: s.project, machine: s.machine, status: s.status,
          last_activity: s.last_activity && new Date(s.last_activity).toISOString(),
          remote_control: !!s.remote_control, machine_reachable: s.reachable,
        })),
      };
    });

  tool(server, ctx, 'session_start', 'Start a new Claude Code session in tmux for a project (Remote Control on by default so it shows in the Claude app). Machine defaults to the project\'s machine.',
    {
      project: z.string().describe('Project id or spoken alias'),
      machine: z.string().optional(),
      prompt: z.string().optional().describe('First message for the session'),
      remote_control: z.boolean().default(true),
      name: z.string().optional().describe('Custom short name; becomes cc-<name>'),
      wait: WAIT(45),
    },
    async ({ project, machine, prompt, remote_control, name, wait }) => {
      const p = findProject(ctx.cfg, project);
      const m = findMachine(ctx.cfg, machine ?? p.machine);
      const sname = name
        ? `cc-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
        : `cc-${p.id}-${randomBytes(2).toString('hex')}`;
      if (!tmux.SESSION_RE.test(sname)) throw new UserError(`"${name}" is not a usable session name.`);
      if ((await tmux.snapshot(m)).some((s) => s.name === sname)) throw new UserError(`${sname} already exists on ${m.id}.`);
      const dir = projectDir(m, p);
      await runOk(m, `test -d ${qpath(dir)}`).catch(() => { throw new UserError(`Project folder ${dir} does not exist on ${m.id}.`); });
      // Spec §5: refresh context.md and the CLAUDE.md import first. A brain problem must not block the session.
      let warning: string | undefined;
      await injectContext(ctx, m, p.id).catch((e) => { warning = `Shared context not updated: ${(e as Error).message}`; });
      // --remote-control takes an optional name, so always pass one or the prompt would be eaten as the name.
      // Our own session id makes the transcript findable: ~/.claude/projects/*/<id>.jsonl.
      const claudeId = randomUUID();
      const cmd = `${m.claude_cmd}${remote_control ? ` --remote-control ${q(sname)}` : ''} --session-id ${claudeId}${prompt ? ` ${q(prompt)}` : ''}`;
      const started = Date.now();
      await tmux.newSession(m, sname, dir, cmd);
      ctx.db.upsertSession({ name: sname, machine: m.id, project: p.id, status: prompt ? 'working' : 'waiting_input', remote_control: remote_control ? 1 : 0 });
      ctx.db.setTranscript(sname, claudeId, null);
      const base = `Started ${p.id} on ${m.id} as ${sname}${remote_control ? '; it shows in the Claude app' : ''}.${warning ? ` ${warning}` : ''}`;
      const turn = prompt ? await sendAndWait(ctx, { ...ctx.db.session(sname)!, m }, wait, started) : null;
      return turn ? { ...turn, summary: `${base} ${turn.summary}`, session: sname } : { summary: base, session: sname };
    });

  tool(server, ctx, 'session_read', 'Read a session. reply (default): its latest reply text, the tools it used and files it changed, from Claude Code\'s transcript. summary: a short status from the terminal. tail: the cleaned terminal text.',
    {
      session: z.string(),
      mode: z.enum(['reply', 'summary', 'tail']).default('reply'),
      lines: z.number().int().min(1).max(500).default(60),
    },
    async ({ session, mode, lines }) => {
      const s = resolve(ctx, session);
      if (mode === 'reply') return report(ctx, s.name, s.m, ctx.db.session(s.name)!.status !== 'working');
      const raw = await tmux.capture(s.m, s.name, Math.max(lines, 200));
      if (mode === 'tail') return { summary: `Last ${lines} lines of ${s.name}.`, text: tail(raw, lines) };
      const sum = summarize(raw);
      const parts = [
        sum.waiting_for && `Waiting: ${sum.waiting_for}`,
        sum.last_action && `Last action: ${sum.last_action}`,
        sum.last_error && `Last error: ${sum.last_error}`,
        `${sum.changed_files_count} files changed`,
      ].filter(Boolean);
      return { summary: `${s.project} on ${s.machine}: ${parts.join('. ')}.`, status: s.status, ...sum };
    });

  tool(server, ctx, 'session_send', 'Send a message to a session (typed, then Enter) and, by default, wait for its reply.',
    { session: z.string(), message: z.string().min(1), wait: WAIT(45) },
    async ({ session, message, wait }) => {
      const s = resolve(ctx, session);
      const sent = Date.now();
      await tmux.sendText(s.m, s.name, message);
      ctx.db.setStatus(s.name, 'working');
      return (await sendAndWait(ctx, s, wait, sent)) ?? { summary: `Sent to ${s.project}.` };
    });

  tool(server, ctx, 'session_wait', 'Wait for a working session to finish its turn (or ask for something), then return its reply.',
    { session: z.string(), seconds: WAIT(60) },
    async ({ session, seconds }) => {
      const s = resolve(ctx, session);
      const done = s.status !== 'working' || await waitTurn(ctx, s.name, s.m, s.status_since, seconds);
      return report(ctx, s.name, s.m, done);
    });

  tool(server, ctx, 'session_approve', 'Answer a pending permission prompt: yes, always (don\'t ask again), or no.',
    { session: z.string(), choice: z.enum(['yes', 'no', 'always']), wait: WAIT(30) },
    async ({ session, choice, wait }) => {
      const s = resolve(ctx, session);
      const pane = await tmux.capture(s.m, s.name, 30);
      if (s.status !== 'waiting_approval' && detectStatus(pane) !== 'waiting_approval') {
        throw new UserError(`${s.project} is not waiting for approval; it is ${SPOKEN[s.status]}.`);
      }
      // Read the menu on screen; if none is visible, fall back to the tool-permission layout.
      const keys = menuKeys(pane, choice) ?? [{ yes: '1', always: '2', no: 'Escape' }[choice]];
      const sent = Date.now();
      await tmux.sendKeys(s.m, s.name, ...keys);
      ctx.db.setStatus(s.name, choice === 'no' ? 'waiting_input' : 'working');
      const turn = choice === 'no' ? null : await sendAndWait(ctx, s, wait, sent);
      return turn ? { ...turn, summary: `Answered ${choice}. ${turn.summary}` } : { summary: `Answered ${choice} for ${s.project}.` };
    });

  tool(server, ctx, 'session_interrupt', 'Press Esc in a session: stops the current work, keeps the session open.',
    { session: z.string() },
    async ({ session }) => {
      const s = resolve(ctx, session);
      await tmux.sendKeys(s.m, s.name, 'Escape');
      ctx.db.setStatus(s.name, 'waiting_input');
      return { summary: `Interrupted ${s.project}.` };
    });

  tool(server, ctx, 'session_stop', 'Stop a session. graceful sends /exit; kill closes the tmux session and needs confirm=true.',
    { session: z.string(), mode: z.enum(['graceful', 'kill']).default('graceful'), confirm: z.boolean().optional() },
    async ({ session, mode, confirm }) => {
      const s = resolve(ctx, session);
      if (mode === 'kill' && confirm !== true) throw new UserError(`Killing ${s.name} needs confirm=true. Ask the user first.`);
      await writeLog(ctx, s, s.m); // while the pane still exists
      // Mark stopped first so the SessionEnd hook that /exit triggers does not log a second time.
      ctx.db.setStatus(s.name, 'stopped');
      if (mode === 'kill') await tmux.kill(s.m, s.name);
      else await tmux.sendText(s.m, s.name, '/exit');
      return { summary: `${mode === 'kill' ? 'Killed' : 'Stopped'} ${s.project} on ${s.machine}.` };
    });

  tool(server, ctx, 'overview', 'One-call status of every project: one line per session plus what is waiting on the user, and every configured project with its machine and number of running sessions. Use for "how are my projects doing?".', {},
    async () => {
      const ss = await refresh(ctx);
      const waiting = ss.filter((s) => s.status === 'waiting_approval' || s.status === 'waiting_input');
      const counts = Object.entries(Object.groupBy(ss, (s) => s.status)).map(([k, v]) => `${v!.length} ${SPOKEN[k as Status]}`);
      const running = (id: string) => ss.filter((s) => s.project === id && s.status !== 'stopped').length;
      return {
        summary: `${ctx.cfg.projects.length} projects configured. ` + (ss.length ? `${ss.length} sessions: ${counts.join(', ')}.` : 'No sessions running.'),
        lines: ss.map(line),
        pending: waiting.map((s) => ({ session: s.name, project: s.project, status: s.status, since: ago(s.status_since), message: s.last_message })),
        projects: ctx.cfg.projects.map((p) => ({ id: p.id, aliases: p.aliases, machine: p.machine, running_sessions: running(p.id) })),
      };
    });
}
