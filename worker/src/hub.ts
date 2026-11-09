// One Durable Object per user (id derived only from the signed-in user id). It holds that user's
// agent WebSocket and relays tool calls to it. It runs no user code and stores no secrets: only the
// agent's advertised tool list, so tools/list still answers while the agent is offline.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index.ts';

export interface ToolInfo { name: string; title?: string; description?: string; inputSchema: unknown; annotations?: unknown }
type Result = { content: unknown[]; isError?: boolean; [k: string]: unknown };

const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOLS = 200;

export class UserHub extends DurableObject<Env> {
  private pending = new Map<string, { resolve: (r: Result) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Called by the Worker after it has verified the agent token for this user. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    for (const old of this.ctx.getWebSockets('agent')) old.close(4000, 'replaced by a newer agent connection');
    this.ctx.acceptWebSocket(server, ['agent']);
    server.serializeAttachment({ since: Date.now(), tokenId: request.headers.get('x-agent-token-id') });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: { type?: string; id?: string; result?: Result; tools?: ToolInfo[] };
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (msg.type === 'hello' && Array.isArray(msg.tools)) {
      await this.ctx.storage.put('tools', msg.tools.slice(0, MAX_TOOLS));
    } else if (msg.type === 'result' && typeof msg.id === 'string') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg.result && Array.isArray(msg.result.content) ? msg.result : { content: [{ type: 'text', text: 'Malformed agent result.' }], isError: true });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) { ws.close(code === 1005 ? 1000 : code, 'closed'); }

  async tools(): Promise<ToolInfo[]> { return (await this.ctx.storage.get<ToolInfo[]>('tools')) ?? []; }

  async status() {
    const ws = this.ctx.getWebSockets('agent')[0];
    const tools = await this.tools();
    return { online: !!ws, since: ws ? (ws.deserializeAttachment() as { since: number }).since : null, tools: tools.length };
  }

  /** Relay one tools/call to the agent; resolves with the agent's CallToolResult. */
  async call(name: string, args: unknown): Promise<Result | null> {
    const ws = this.ctx.getWebSockets('agent')[0];
    if (!ws) return null; // offline: the caller explains how to start the agent
    const id = crypto.randomUUID();
    return new Promise<Result>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Your orchestrator agent did not answer within 2 minutes.' }) }], isError: true });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ type: 'call', id, name, args }));
    });
  }

  /** Revocation: drop the live connection that used a revoked token. */
  async disconnect(tokenId: string) {
    for (const ws of this.ctx.getWebSockets('agent')) {
      if ((ws.deserializeAttachment() as { tokenId?: string }).tokenId === tokenId) ws.close(4001, 'agent token revoked');
    }
  }
}
