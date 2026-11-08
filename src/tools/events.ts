import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Status } from '../summarize.ts';
import { SESSION_RE } from '../tmux.ts';
import { ago, tool, type Ctx } from './common.ts';
import { refresh, writeLog } from './sessions.ts';

/** Hook payload (Claude Code hook stdin JSON) → session status. Spec §13. */
export function statusFor(hook: { hook_event_name?: string; message?: string }): Status | undefined {
  if (hook.hook_event_name === 'Stop') return 'idle';
  if (hook.hook_event_name === 'SessionEnd') return 'stopped';
  if (hook.hook_event_name === 'Notification') {
    return /permission|approv|allow/i.test(hook.message ?? '') ? 'waiting_approval' : 'waiting_input';
  }
  return undefined;
}

/** POST /events?session=cc-x&machine=gpu with the hook JSON as body. Returns an HTTP status code. */
export function ingest(ctx: Ctx, session: string, machine: string | undefined, body: unknown): number {
  if (!SESSION_RE.test(session)) return 400;
  const hook = (body ?? {}) as { hook_event_name?: string; message?: string; reason?: string };
  const status = statusFor(hook);
  if (!status) return 400;
  if (!ctx.db.session(session)) {
    if (!machine || !ctx.cfg.machines.some((m) => m.id === machine)) return 404;
    ctx.db.upsertSession({ name: session, machine, project: session.slice(3).replace(/-[^-]+$/, ''), status: 'idle', remote_control: 0 });
  }
  const before = ctx.db.session(session)!;
  const msg = (hook.message ?? hook.reason)?.slice(0, 500) ?? null;
  ctx.db.setStatus(session, status, msg);
  ctx.db.addEvent(session, hook.hook_event_name!, status, msg);
  // Ended outside session_stop (e.g. /exit typed in the Claude app): log it in the background.
  if (status === 'stopped' && before.status !== 'stopped') {
    const m = ctx.cfg.machines.find((x) => x.id === before.machine);
    if (m) void writeLog(ctx, before, m, hook.reason && `Ended: ${hook.reason}`);
  }
  return 204;
}

export function register(server: McpServer, ctx: Ctx) {
  tool(server, ctx, 'events_pending', 'Sessions waiting for the user\'s answer or approval, oldest first. Call this first in voice mode.', {},
    async () => {
      await refresh(ctx); // some prompts (e.g. the startup import dialog) fire no hook; only the pane shows them
      const p = ctx.db.pending();
      return {
        summary: p.length
          ? `${p.length} waiting. ` + p.map((s) => `${s.project} on ${s.machine} needs ${s.status === 'waiting_approval' ? 'approval' : 'input'}, ${ago(s.status_since)}${s.last_message ? `: ${s.last_message}` : ''}.`).join(' ')
          : 'Nothing is waiting for you.',
        pending: p.map((s) => ({ session: s.name, project: s.project, machine: s.machine, status: s.status, since: new Date(s.status_since).toISOString(), message: s.last_message })),
      };
    });
}
