import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { findMachine, findProject, projectDir, UserError, type Machine } from '../config.ts';
import { injectContext, logSession } from './memory.ts';
import type { SessionRow } from '../db.ts';
import { detectStatus, menuKeys, summarize, tail, type Status } from '../summarize.ts';
import * as tmux from '../tmux.ts';
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
    },
    async ({ project, machine, prompt, remote_control, name }) => {
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
      const cmd = `${m.claude_cmd}${remote_control ? ` --remote-control ${q(sname)}` : ''}${prompt ? ` ${q(prompt)}` : ''}`;
      await tmux.newSession(m, sname, dir, cmd);
      ctx.db.upsertSession({ name: sname, machine: m.id, project: p.id, status: prompt ? 'working' : 'waiting_input', remote_control: remote_control ? 1 : 0 });
      return {
        summary: `Started ${p.id} on ${m.id} as ${sname}${prompt ? ', first prompt sent' : ''}${remote_control ? '; it will show in the Claude app' : ''}.${warning ? ` ${warning}` : ''}`,
        session: sname,
      };
    });

  tool(server, ctx, 'session_read', 'Read a session\'s recent output. summary mode returns last_action, waiting_for, last_error, changed_files_count; tail mode returns cleaned text.',
    {
      session: z.string(),
      mode: z.enum(['summary', 'tail']).default('summary'),
      lines: z.number().int().min(1).max(500).default(60),
    },
    async ({ session, mode, lines }) => {
      const s = resolve(ctx, session);
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

  tool(server, ctx, 'session_send', 'Send a message to a session (typed, then Enter).',
    { session: z.string(), message: z.string().min(1) },
    async ({ session, message }) => {
      const s = resolve(ctx, session);
      await tmux.sendText(s.m, s.name, message);
      ctx.db.setStatus(s.name, 'working');
      return { summary: `Sent to ${s.project}.` };
    });

  tool(server, ctx, 'session_approve', 'Answer a pending permission prompt: yes, always (don\'t ask again), or no.',
    { session: z.string(), choice: z.enum(['yes', 'no', 'always']) },
    async ({ session, choice }) => {
      const s = resolve(ctx, session);
      const pane = await tmux.capture(s.m, s.name, 30);
      if (s.status !== 'waiting_approval' && detectStatus(pane) !== 'waiting_approval') {
        throw new UserError(`${s.project} is not waiting for approval; it is ${SPOKEN[s.status]}.`);
      }
      // Read the menu on screen; if none is visible, fall back to the tool-permission layout.
      const keys = menuKeys(pane, choice) ?? [{ yes: '1', always: '2', no: 'Escape' }[choice]];
      await tmux.sendKeys(s.m, s.name, ...keys);
      ctx.db.setStatus(s.name, choice === 'no' ? 'waiting_input' : 'working');
      return { summary: `Answered ${choice} for ${s.project}.` };
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
