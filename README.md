# Session Orchestrator MCP

One MCP server that manages every Claude Code session on all your machines (macbook, node2, gpu) from a single Claude voice session. It never calls a model; it only forwards commands over SSH + tmux. Spec: https://claude.ai/artifact/54hCBwJuwFQeA6dZurUMca

## Status

| Phase (spec §9) | State |
| --- | --- |
| 1. Core: config, `machine_*`, `session_*`, `overview` | done |
| 2. Events: hooks, `/events`, `events_pending` | done |
| 3. Publishing: Cloudflare Tunnel + Access, custom connector | config files in `deploy/`; not deployed or voice-tested yet |
| 4. Shared memory (`memory_*`, `project_context`, `context.md`) | not started |
| 5. Local LLM (`llm_*`, `agent_*`) | not started (`machine_status` already reports whether `llm.yaml` endpoints are up) |

## Tools

| Tool | What it does |
| --- | --- |
| `machine_list()` | Reachable or not, cc-session count, MacBook power (ac/battery) |
| `machine_status(machine)` | CPU, load, RAM, disk, GPU/VRAM (`nvidia-smi`), ethernet/wifi, LLM endpoints up/down |
| `session_list(machine?)` | Sessions with status `working`, `waiting_input`, `waiting_approval`, `idle` or `stopped` |
| `session_start(project, machine?, prompt?, remote_control=true, name?)` | New tmux session running `claude --remote-control [prompt]` |
| `session_read(session, mode, lines)` | `summary`: last_action, waiting_for, last_error, changed_files_count. `tail`: cleaned text |
| `session_send(session, message)` | Types the message, then Enter |
| `session_approve(session, yes/no/always)` | Answers the permission prompt (keys `1` / `Esc` / `2`) |
| `session_interrupt(session)` | Esc |
| `session_stop(session, graceful/kill, confirm?)` | `/exit`, or kill the tmux session (needs `confirm=true`) |
| `events_pending()` | What is waiting on you, oldest first |
| `overview()` | One line per session + pending items |

Every result is JSON whose first field is a one-sentence `summary` for voice. Wherever a tool takes `session`, you can pass the full name (`cc-halfsaid-a1b2`) or a project id or alias, as long as that project has exactly one running session.

## Setup (on node2)

```sh
npm ci
cp config/machines.example.yaml config/machines.yaml   # edit
cp config/projects.example.yaml config/projects.yaml   # edit
cp .env.example .env                                   # set EVENTS_TOKEN (openssl rand -hex 32)
npm start                                              # http://127.0.0.1:8787/mcp
```

Needs Node ≥ 22.18 (runs the TypeScript directly, no build step), plus `tmux` on every machine and key-only SSH from node2 to the others.

Install the hooks on each machine (needs `jq` on the target):

```sh
scripts/install-hooks.sh local node2 http://127.0.0.1:8787
scripts/install-hooks.sh orchestrator@gpu gpu http://node2:8787
scripts/install-hooks.sh orchestrator@macbook macbook http://node2:8787
```

To let the other machines reach `/events`, set `HOST` to node2's Tailscale IP. Then `/mcp` is also open to your tailnet with no auth (see Risks). The Cloudflare Tunnel in `deploy/cloudflared.yml` publishes only `/mcp`. Put an Access policy on it before you add it as a connector. The systemd unit is in `deploy/orchestrator.service`.

Mac: `sudo pmset -c sleep 0 displaysleep 10`, turn on Remote Login, and start Tailscale at login.

## Tests

`npm test` runs unit tests (quoting, TUI parsing, hook mapping, config) and an end-to-end test. The end-to-end test runs the real HTTP server, a private tmux server and a fake `claude`, and goes start → send → permission prompt → hook → `events_pending` → approve → Stop hook → kill. It also checks that an unreachable Mac fails within 5 s.

## Assumptions

- **SQLite uses Node's built-in `node:sqlite`, not `better-sqlite3`.** Same SQL, no native build.
- **Stateless MCP over HTTP.** Each request gets a fresh server, and all state lives in SQLite.
- **`claude --remote-control "<prompt>"`** starts the session, with the first prompt passed as an argument rather than typed. You can change the binary per machine with `claude_cmd` in `machines.yaml`.
- **Approve keys:** `1` = yes, `2` = always, `Esc` = no. This matches Claude Code's current permission prompt.
- **Status:** hooks set it (spec §13). The pane regex only overrides when it clearly sees a prompt in the last 8 lines, or `esc to interrupt`. Sessions that vanish from tmux become `stopped`. A `cc-*` session the orchestrator did not start is adopted, and its project is read from its name.
- **Hooks** POST the raw hook JSON to `/events?session=<tmux name>&machine=<id>` with `Authorization: Bearer $EVENTS_TOKEN`. They time out after 3 s and never block Claude Code.
- **Phase 4 not done yet**, so `session_start` does not yet write `context.md` or the `CLAUDE.md` import line.
- The open questions (spec §10: Mac RAM, agent framework, git vs Syncthing) stay as config values for phases 4–5.

## Risks

- The TUI parsing (`src/summarize.ts`) is regex-based and will need updating when Claude Code's wording changes.
- With `HOST` on the Tailscale IP, anyone on your tailnet can call `/mcp`. If that matters, add a bearer token on `/mcp` too.
