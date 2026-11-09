# Session Orchestrator

Manage all your Claude Code sessions, on all your machines, from one place in Claude. Ask what is waiting for you, read what a session did, approve or decline its permission prompts, send it instructions, and start or stop sessions. All of this works by chat or by voice on the Claude mobile app.

## What this plugin contains

- **One skill**, `manage-sessions`. It teaches Claude how to use the tools well: check pending items first, read before approving, approve only on your explicit decision, and confirm before stopping or deleting anything.
- **One remote MCP connector:** `https://claude-session-orchestrator.nurhakaltin.workers.dev/mcp`.

The plugin runs no local commands, hooks or scripts, and it reads no credentials from your machine.

## What it connects to and sends

When you use the connector, Claude sends tool calls (for example "list sessions" or "start a session for project X with this prompt") to the hosted service above. You sign in to it with GitHub or Google. The service relays each call over an encrypted WebSocket to **your own agent**: a small open-source program you run on your own always-on machine, which drives Claude Code in tmux there and on your other machines over SSH.

The hosted service does not store tool arguments or results, and never sees your SSH keys, code or notes. See the [privacy policy](https://claude-session-orchestrator.nurhakaltin.workers.dev/privacy).

## Install

In Claude Code:

```
/plugin install session-orchestrator --marketplace Nurhak/claude-session-orchestrator
```

In the Claude app, find Session Orchestrator in the directory once it is listed.

## Setup

1. Install this plugin and connect the Session Orchestrator connector. Sign in with GitHub or Google.
2. Open the [dashboard](https://claude-session-orchestrator.nurhakaltin.workers.dev/dashboard), create an agent token, and follow the shown command to start the agent on your machine. Source and full documentation: [github.com/Nurhak/claude-session-orchestrator](https://github.com/Nurhak/claude-session-orchestrator).
3. Ask Claude: "How are my projects doing?"

## License

MIT
