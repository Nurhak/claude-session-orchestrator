import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { UserError, type Config } from '../config.ts';
import type { Db } from '../db.ts';

export interface Ctx { cfg: Config; db: Db }

/**
 * Register a tool that returns `{ summary, ...detail }` (spec §8: one speakable sentence first),
 * with every call written to the audit log (spec §7).
 */
export function tool<S extends ZodRawShape>(
  server: McpServer, ctx: Ctx, name: string, description: string, shape: S,
  fn: (args: z.infer<z.ZodObject<S>>) => Promise<{ summary: string; [k: string]: unknown }>,
) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
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
