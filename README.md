# claude-session-orchestrator

An MCP server that lets you manage **all your Claude Code sessions, on all your machines, from one place**. That place can be the Claude mobile app (including voice mode), claude.ai, or another Claude Code session.

Ask "how are my projects doing?" while you're away from the keyboard. Then start a session on your GPU box, approve a pending permission prompt, or read what a session did. You never open a terminal.

- **Sessions run in tmux** on your machines, reached over SSH (Tailscale works well). Each session starts with `--remote-control`, so it also shows up in the Claude app.
- **Hooks report state.** Claude Code's `Notification`, `Stop` and `SessionEnd` hooks tell the server which sessions are waiting for input or approval.
- **Shared memory.** A git repo of markdown notes ("the brain"), with shared knowledge and skills. It is injected into each new session through `CLAUDE.md`.
- **Local LLMs.** Small jobs can go to OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp, vLLM), with routing that never uses a laptop running on battery.
- **No model calls of its own.** The thinking stays in your Claude subscription; this server only forwards commands.

> Status: early (0.1). Tested end to end against Claude Code 2.1.319 on Linux. The macOS and multi-machine paths are covered by tests but have had little real-world use. Issues and PRs are welcome.

## How it works

```
 Claude app / voice ──HTTPS──▶ Cloudflare Tunnel + Access ──▶ orchestrator (/mcp) on an always-on "hub"
                                                                 │  SQLite: sessions, events, audit log
                                                                 │  ~/brain: shared memory (git)
                                                     SSH / local sh
                                          ┌──────────────────────┼──────────────────────┐
                                        hub                     gpu                   laptop
                                 tmux: cc-<project>-<id>   tmux: cc-…              tmux: cc-…
                                 claude --remote-control …
                                          └───── hooks POST /events (Bearer EVENTS_TOKEN) ─────┘
```

## Tools (22)

| Tool | What it does |
| --- | --- |
| `overview()` | One line per session, plus what is waiting on you. "How are my projects doing?" |
| `events_pending()` | Sessions waiting for your input or approval, oldest first |
| `machine_list()` / `machine_status(machine)` | Reachability, session count, laptop power (AC or battery); CPU, RAM, disk, GPU/VRAM, link type, LLM endpoints |
| `session_list(machine?)` | Status: `working`, `waiting_input`, `waiting_approval`, `idle` or `stopped` |
| `session_start(project, machine?, prompt?, remote_control=true, name?)` | Refreshes the shared context, then starts Claude Code in tmux |
| `session_read(session, mode=summary\|tail, lines)` | Last action, what it is waiting for, last error, files changed; or a cleaned tail of the output |
| `session_send(session, message)` | Types a message and presses Enter |
| `session_approve(session, yes\|no\|always)` | Answers the menu on screen (tool permissions, trust dialogs) |
| `session_interrupt(session)` / `session_stop(session, graceful\|kill, confirm?)` | Esc / `/exit`, or kill (kill needs `confirm=true`) |
| `memory_search` / `memory_read` / `memory_write` / `memory_append` / `memory_delete` | The brain; every write is a git commit, and delete needs `confirm=true` |
| `memory_link(project, shared_path)` / `project_context(project)` | Link shared knowledge to a project / get everything a session on that project should know |
| `llm_list()` / `llm_run(task, endpoint=auto, …)` | Local models with auto routing |
| `agent_run(agent, task)` / `agent_status(job_id)` | Local agents (HTTP or CLI) as background jobs |

Every result is JSON whose first field is a one-sentence `summary`, written for voice. Long diffs and logs are never dumped. Sessions can be named by project alias ("my app"), and every call goes into an audit log.

## Quick start

Requirements: Node ≥ 24, plus `tmux`, `git` and Claude Code on each machine you want to manage. You also need key-only SSH from the hub to the other machines. `jq` is needed on each machine for the hook installer.

```sh
git clone https://github.com/Nurhak/claude-session-orchestrator && cd claude-session-orchestrator
npm ci
cp config/machines.example.yaml config/machines.yaml   # your machines
cp config/projects.example.yaml config/projects.yaml   # your projects and their spoken aliases
cp config/llm.example.yaml config/llm.yaml             # optional: local models and agents
cp .env.example .env                                   # set EVENTS_TOKEN and MCP_TOKEN: openssl rand -hex 32 (chmod 600 .env)
npm start                                              # http://127.0.0.1:8787/mcp
```

Install the hooks on each machine. This adds `Notification`, `Stop` and `SessionEnd` hooks to `~/.claude/settings.json` and keeps your existing hooks. Each machine receives only its own token, derived from `EVENTS_TOKEN`, so it can report only its own sessions:

```sh
scripts/install-hooks.sh local hub http://127.0.0.1:8787
scripts/install-hooks.sh me@gpu gpu http://hub:8787
```

Use it from Claude Code right away:

```sh
claude mcp add -s user --transport http orchestrator http://127.0.0.1:8787/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

To use it from the Claude app or voice mode, publish `/mcp` through a Cloudflare Tunnel with Access in front, then add it as a custom connector. [deploy/README.md](deploy/README.md) covers that, plus systemd, skills, and Claude Code sessions as clients.

## Configuration

- `machines.yaml`: `id`, `ssh_host`, `user`, `os` (`linux` or `macos`), `projects_root`, `local: true` for the hub itself, and an optional `claude_cmd`.
- `projects.yaml`: `id`, spoken `aliases`, default `machine`, `path`, and `shared` brain paths to always include.
- `llm.yaml`: `endpoints` (`id`, `machine`, `url` including `/v1`, `model`, `ctx`, `requires_ac`), `routing.order`, and `agents` (`url` or `cmd`).
- `.env`: `EVENTS_TOKEN`, `MCP_TOKEN`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `PORT`, `HOST`, `DB_PATH`, `CONFIG_DIR`, `BRAIN_DIR`, `REMOTE_BRAIN_DIR`, `BRAIN_PUSH`, `LLM_TIMEOUT_S`.

### Shared memory layout

```
~/brain/                    git repo on the hub (BRAIN_DIR), created on first start
  index.md                  your map of projects, tags and relations
  shared/<topic>/           cross-project knowledge: deployment, branding, infra…
  projects/<p>/*.md         project notes and decisions
  projects/<p>/links.md     shared paths linked with memory_link
  projects/<p>/log.md       one entry per ended session
  projects/<p>/context.md   generated at session_start (gitignored)
  skills/<name>/            shared Claude Code skills; scripts/link-skills.sh symlinks them into ~/.claude/skills
```

At `session_start`, `context.md` is rebuilt from the project's notes, its linked shared files and related skills. It is copied to the target machine, and the project's `CLAUDE.md` gets `@…/context.md` once. On a project's first start, Claude Code asks "Allow external CLAUDE.md file imports?", and you can answer with `session_approve`.

## Security model

- **No caller is trusted by network address.** Every `/mcp` request needs `Authorization: Bearer $MCP_TOKEN` (Claude Code, scripts) or a valid Cloudflare Access JWT (the Claude app through the tunnel). The JWT is checked for its signature against your team's Access certs, plus its audience (`CF_ACCESS_AUD`), issuer and expiry. Loopback gets no exception, because every process on the host shares it and a DNS-rebinding web page arrives from it.
- **`/events`** needs the sending machine's own token, `HMAC-SHA256(EVENTS_TOKEN, machine-id)`. A machine can only report sessions that belong to it. On every machine the hook script reads the token from a 0600 file, never from its command line.
- There is no general "run a shell command" tool; only the tools above. Every argument is shell-quoted, session names are validated, and tmux targets match session names exactly.
- Destructive actions (`session_stop kill`, `memory_delete`) need `confirm=true`. Brain paths can't escape the repo, even through symlinks, or touch `.git`.
- Use a dedicated, key-only SSH user. Secrets live in `.env`, which is gitignored; keep it `chmod 600`.
- Security fixes are tracked in the commit history, with a regression test for each. The project was audited with [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill).

## Development

```sh
npm test            # unit tests + end-to-end: real HTTP server, private tmux server, fake claude, fake OpenAI endpoint
npm run typecheck
```

The TypeScript runs directly on Node (type stripping); there is no build step. `src/summarize.ts` reads Claude Code's terminal UI with regexes. When Claude Code changes its wording, add a captured pane to `test/fixtures/` and adjust it.

## Design notes and limits

- **Stateless MCP over HTTP.** Each request gets a fresh server, and all state lives in SQLite (`node:sqlite`).
- **Status** comes from hooks first. The pane is a fallback for prompts that fire no hook, and it only overrides on clear signals.
- **Approving prompts:** numbered menus get the digit, and unnumbered dialogs get arrow keys plus Enter, based on the menu read off the screen.
- **Laptop power:** nothing ever wakes a sleeping laptop. A Mac on battery counts as unavailable for `requires_ac` endpoints.
- **Planned:** push notifications for pending approvals, and embedding search over the brain.

## License

[MIT](LICENSE)
