// Same tools over stdio, for Claude Code sessions on node2: claude mcp add orchestrator -- node /opt/session-orchestrator/src/stdio.ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { boot, mcpServer } from './server.ts';

await mcpServer(await boot()).connect(new StdioServerTransport());
