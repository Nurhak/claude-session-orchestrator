import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import type { Ctx } from './tools/common.ts';
import * as events from './tools/events.ts';
import * as llm from './tools/llm.ts';
import * as machines from './tools/machines.ts';
import * as memory from './tools/memory.ts';
import * as sessions from './tools/sessions.ts';

export function mcpServer(ctx: Ctx) {
  const server = new McpServer({ name: 'session-orchestrator', version: '1.0.0' });
  for (const mod of [machines, sessions, events, memory, llm]) mod.register(server, ctx);
  return server;
}

export async function boot() {
  const ctx = { cfg: loadConfig(), db: new Db() };
  await memory.ensureBrain();
  ctx.db.failOrphanJobs();
  return ctx;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

async function readJson(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

function tokenOk(req: IncomingMessage, token: string | undefined) {
  if (!token) return false;
  const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function app(ctx: Ctx, eventsToken = process.env.EVENTS_TOKEN, mcpToken = process.env.MCP_TOKEN) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return void res.writeHead(405).end();
        // Loopback = cloudflared on this host, already behind Cloudflare Access.
        // Anything else (Claude Code sessions over Tailscale) must bring MCP_TOKEN.
        if (!LOOPBACK.has(req.socket.remoteAddress ?? '') && !tokenOk(req, mcpToken)) return void res.writeHead(401).end();
        // Stateless: a fresh server + transport per request; all state lives in SQLite.
        const server = mcpServer(ctx);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, await readJson(req));
      } else if (url.pathname === '/events' && req.method === 'POST') {
        if (!tokenOk(req, eventsToken)) return void res.writeHead(401).end();
        const code = events.ingest(ctx, url.searchParams.get('session') ?? '', url.searchParams.get('machine') ?? undefined, await readJson(req));
        res.writeHead(code).end();
      } else if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      } else {
        res.writeHead(404).end();
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(e instanceof SyntaxError ? 400 : 500).end();
      console.error(e);
    }
  });
}

if (import.meta.main) {
  const ctx = await boot();
  if (!process.env.EVENTS_TOKEN) console.warn('EVENTS_TOKEN is not set: /events will reject every hook.');
  const port = Number(process.env.PORT ?? 8787), host = process.env.HOST ?? '127.0.0.1';
  app(ctx).listen(port, host, () => console.log(`session-orchestrator on http://${host}:${port}/mcp`));
}
