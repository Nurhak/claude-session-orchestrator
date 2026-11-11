import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { UserError, type Config } from '../config.ts';
import type { Db } from '../db.ts';

export interface Ctx { cfg: Config; db: Db }

// Tool annotations (MCP spec; required for the Claude connector directory): a title, and whether
// the tool only reads (readOnly) or can change or end things irreversibly (destructive).
// openWorld: reaches beyond this service (other machines' sessions, LLM endpoints, agents).
type Hint = [title: string, kind: 'read' | 'write' | 'destructive', openWorld?: boolean];
const HINTS: Record<string, Hint> = {
  machine_list: ['List machines', 'read'],
  machine_status: ['Machine status', 'read'],
  session_list: ['List sessions', 'read'],
  session_read: ['Read session output', 'read'],
  session_start: ['Start a Claude Code session', 'write', true],
  session_send: ['Send a message to a session', 'write', true],
  session_wait: ['Wait for a session to reply', 'read'],
  session_approve: ['Answer a permission prompt', 'destructive', true],
  session_interrupt: ['Interrupt a session', 'write'],
  session_stop: ['Stop a session', 'destructive'],
  session_delete: ['Delete a session', 'destructive'],
  events_pending: ['What is waiting for me', 'read'],
  overview: ['Overview of all projects', 'read'],
  memory_search: ['Search shared memory', 'read'],
  memory_read: ['Read a memory file', 'read'],
  memory_write: ['Write a memory file', 'destructive'],
  memory_append: ['Append to a memory file', 'write'],
  memory_delete: ['Delete a memory file', 'destructive'],
  memory_link: ['Link shared knowledge to a project', 'write'],
  project_context: ['Project context', 'read'],
  llm_list: ['List local models', 'read'],
  llm_run: ['Run a task on a local model', 'read', true],
  agent_run: ['Run a local agent', 'destructive', true],
  agent_status: ['Local agent job status', 'read'],
};

/**
 * Register a tool that returns `{ summary, ...detail }` (one speakable sentence first),
 * with every call written to the audit log.
 */
export function tool<S extends ZodRawShape>(
  server: McpServer, ctx: Ctx, name: string, description: string, shape: S,
  fn: (args: z.infer<z.ZodObject<S>>) => Promise<{ summary: string; [k: string]: unknown }>,
) {
  const hint = HINTS[name];
  if (!hint) throw new Error(`tool ${name} has no annotation in HINTS`);
  const [title, kind, openWorldHint = false] = hint;
  const annotations = { title, readOnlyHint: kind === 'read', destructiveHint: kind === 'destructive', openWorldHint };
  server.registerTool(name, { title, description, inputSchema: shape, annotations }, (async (args: z.infer<z.ZodObject<S>>) => {
    try {
      const out = await fn(args);
      ctx.db.audit(name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 1) }] };
    } catch (e) {
      const msg = e instanceof UserError ? e.message : `Internal error: ${(e as Error).message}`;
      ctx.db.audit(name, args, msg);
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ summary: msg }) }] };
    }
  }) as never);
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
