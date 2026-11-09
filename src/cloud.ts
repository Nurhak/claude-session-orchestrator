// Agent mode: dial out to the hosted front door and serve its tool calls with the local tools.
// Nothing listens publicly; the cloud can only call the same tools a local MCP client could.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export async function connectCloud(makeServer: () => McpServer, url: string, token: string) {
  const u = new URL(url);
  // The token must never travel in clear text: plain ws:// only for a local test server.
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
    throw new Error('ORCH_CLOUD_URL must be wss:// (ws:// only for localhost)');
  }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await makeServer().connect(serverSide);
  const client = new Client({ name: 'cloud-relay', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();

  let delay = 1000;
  const open = () => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as never);
    let lastPong = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    ws.onopen = () => {
      delay = 1000;
      lastPong = Date.now();
      ws.send(JSON.stringify({ type: 'hello', tools }));
      timer = setInterval(() => {
        if (Date.now() - lastPong > 75_000) return ws.close(); // dead link: reconnect
        ws.send('ping');
      }, 30_000);
      console.log(`cloud: connected to ${u.host}, ${tools.length} tools advertised`);
    };
    ws.onmessage = async (ev) => {
      const data = String(ev.data);
      if (data === 'pong') { lastPong = Date.now(); return; }
      let msg: { type?: string; id?: string; name?: string; args?: Record<string, unknown> };
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type !== 'call' || typeof msg.id !== 'string' || typeof msg.name !== 'string') return;
      let result;
      try {
        result = await client.callTool({ name: msg.name, arguments: msg.args ?? {} });
      } catch (e) {
        result = { content: [{ type: 'text', text: JSON.stringify({ summary: `Tool failed: ${(e as Error).message}` }) }], isError: true };
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
    };
    ws.onclose = (ev) => {
      clearInterval(timer);
      if (ev.code === 4001) return console.error('cloud: agent token revoked; not reconnecting. Create a new token in the dashboard.');
      if (ev.code === 4000) return console.error('cloud: another agent connected with this account; this one stops.');
      console.error(`cloud: disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ''}); retrying in ${delay / 1000}s`);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 60_000);
    };
    ws.onerror = () => {}; // onclose follows and handles the retry
  };
  open();
}
