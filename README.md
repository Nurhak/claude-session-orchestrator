# Session Orchestrator MCP

One MCP server that manages every Claude Code session on all your machines (macbook, node2, gpu) from a single Claude voice session. It also holds a shared brain (notes, shared knowledge, skills) and hands small jobs to local models. It never calls Claude itself; it forwards commands over SSH + tmux. Spec: https://claude.ai/artifact/54hCBwJuwFQeA6dZurUMca

## Status

| Phase (spec §9) | State |
| --- | --- |
| 1. Core: config, `machine_*`, `session_*`, `overview` | done, tested |
| 2. Events: hooks, `/events`, `events_pending` | done, tested |
| 3. Publishing: Tunnel + Access, connector, voice test | files and steps in [`deploy/`](deploy/README.md); needs your Cloudflare and Claude accounts |
| 4. Shared memory: brain repo, `memory_*`, `project_context`, `context.md`, session logs, skill symlinks | done, tested |
| 5. Local LLM: `llm_list`, `llm_run`, routing, `agent_run`, `agent_status` | done, tested against a fake OpenAI endpoint |
| 6. Later: push notifications, embedding search | not in scope (spec: "İleride") |

## Tools (22)

| Tool | What it does |
| --- | --- |
| `machine_list()` | Reachable or not, cc-session count, MacBook power (ac/battery) |
| `machine_status(machine)` | CPU, load, RAM, disk, GPU/VRAM, ethernet/wifi, LLM endpoints up/down |
| `session_list(machine?)` | Sessions with status `working`, `waiting_input`, `waiting_approval`, `idle` or `stopped` |
| `session_start(project, machine?, prompt?, remote_control=true, name?)` | Refreshes `context.md`, then starts `claude --remote-control [prompt]` in tmux |
| `session_read(session, mode, lines)` | `summary`: last_action, waiting_for, last_error, changed_files_count. `tail`: cleaned text |
| `session_send` / `session_approve(yes, no, always)` / `session_interrupt` | Type a message, answer a permission prompt, press Esc |
| `session_stop(session, graceful/kill, confirm?)` | Writes the session log, then `/exit` or kill (kill needs `confirm=true`) |
| `events_pending()` / `overview()` | What is waiting on you / one line per session |
| `memory_search(query, scope?)` | ripgrep search (falls back to grep) |
| `memory_read` / `memory_write` / `memory_append` / `memory_delete(confirm)` | Brain files; every write is a git commit |
| `memory_link(project, shared_path)` | Adds the path to `projects/<p>/links.md` |
| `project_context(project)` | Notes + linked shared files + related skills, in one package |
| `llm_list()` / `llm_run(task, endpoint="auto", model?, max_tokens?, system?)` | Local OpenAI-compatible models |
| `agent_run(agent, task)` / `agent_status(job_id)` | Local agents over HTTP or CLI, run as background jobs |

Every result is JSON whose first field is a one-sentence `summary` for voice (spec §8). Wherever a tool takes `session`, you can pass the full name (`cc-halfsaid-a1b2`) or a project id or alias, as long as that project has one running session. Every call goes into the SQLite `audit` table.

## Quick start

```sh
npm ci
cp config/machines.example.yaml config/machines.yaml    # also projects.yaml, llm.yaml
cp .env.example .env                                    # EVENTS_TOKEN, MCP_TOKEN
npm start                                               # http://127.0.0.1:8787/mcp
npm test && npm run typecheck
```

Needs Node ≥ 22.18 (runs the TypeScript directly) and `tmux` on every machine. Production setup: [deploy/README.md](deploy/README.md).

## Shared memory layout

```
~/brain/                    git repo on node2 (BRAIN_DIR), created on first start
  index.md                  projects, tags and relations (written by you)
  shared/<topic>/           cross-project knowledge: deployment, branding, mobile, infra
  projects/<p>/*.md         project notes and decisions
  projects/<p>/links.md     shared paths linked by memory_link
  projects/<p>/log.md       one entry per ended session
  projects/<p>/context.md   generated at session_start, gitignored
  skills/<name>/            shared Claude Code skills, symlinked by scripts/link-skills.sh
```

## Assumptions

- **SQLite is Node's built-in `node:sqlite`**, not `better-sqlite3`: same SQL, no native build.
- **Stateless MCP over HTTP.** Each request gets a fresh server, and all state lives in SQLite.
- **`/mcp` auth:** loopback callers are trusted, because that is cloudflared behind Cloudflare Access. Anyone else must send `Authorization: Bearer $MCP_TOKEN`. `/events` always needs `EVENTS_TOKEN`.
- **Starting sessions:** `claude --remote-control "<prompt>"`, with the first prompt passed as an argument. You can change the binary per machine with `claude_cmd`.
- **Approve keys:** `1` = yes, `2` = always, `Esc` = no. This matches the current Claude Code permission prompt.
- **Status:** the `Notification`, `Stop` and `SessionEnd` hooks set it (spec §13). The pane regex overrides only when it clearly sees a prompt in the last 8 lines, or `esc to interrupt`.
- **Session log:** "when the session ends" means `session_stop`, or the `SessionEnd` hook. `Stop` fires after every turn, so it would be too noisy. The entry is built from the pane (last action, files changed, last error), not written by an LLM.
- **context.md delivery:** it is generated on node2 and copied over SSH to `~/brain/projects/<p>/context.md` on the target machine (`REMOTE_BRAIN_DIR`). That works whichever sync method you pick, so it is gitignored. `CLAUDE.md` gets `@<that path>` once.
- **Links:** `memory_link` writes to `projects/<p>/links.md`, and `shared:` in projects.yaml also counts. `index.md` is left to you.
- **"Related skills":** skills whose `skills/<name>` path is linked to the project. All other skill names are listed too.
- **LLM routing:** the endpoints in `routing.order` are tried in order. An endpoint is skipped when it is down, when the task needs more context than it has (about 3.5 characters per token), or when it is `requires_ac` and its machine is on battery or asleep. Idle endpoints go before busy ones, where busy means a request is in flight from this server. Nothing ever wakes the Mac.
- **Agents (open question):** `url` agents get `POST {"task","job_id"}` and the response body is the result. `cmd` agents get the task on stdin and stdout is the result. Jobs still running when the server restarts are marked failed.
- **Open questions** (spec §10) stay in config: Mac RAM goes into the `mac-large` model choice, the agent type is `url`/`cmd`, and brain sync is `BRAIN_PUSH=1` for git push after each commit (or Syncthing outside this app).

## Risks

- The TUI parsing in `src/summarize.ts` is regex-based. Re-check it whenever the Claude Code UI wording changes.
- Phase 3 (Cloudflare Access with Claude's connector OAuth) and the voice flow have not been tested end to end.
