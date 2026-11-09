# Deploying on hub (phase 3)

These steps need your accounts (Cloudflare, Claude), so they were not run from this repo. Each step ends with a check.

## 1. Install the service

```sh
sudo useradd -r -m -d /opt/session-orchestrator orchestrator   # or reuse your user and edit the unit
sudo -u orchestrator git clone https://github.com/Nurhak/claude-session-orchestrator /opt/session-orchestrator
cd /opt/session-orchestrator && sudo -u orchestrator npm ci --omit=dev
sudo -u orchestrator cp .env.example .env    # set EVENTS_TOKEN and MCP_TOKEN: openssl rand -hex 32
sudo -u orchestrator cp config/machines.example.yaml config/machines.yaml   # and projects.yaml, llm.yaml
sudo cp deploy/orchestrator.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now orchestrator
```

Check: `curl -s localhost:8787/health` prints `ok`. `journalctl -u orchestrator` shows `session-orchestrator on http://…/mcp`.

The `orchestrator` user needs key-only SSH to gpu and macbook (`ssh -o BatchMode=yes gpu true` must work as that user) and a git identity for the brain repo.

## 2. Hooks and skills on every machine

```sh
scripts/install-hooks.sh local hub http://127.0.0.1:8787
scripts/install-hooks.sh orchestrator@gpu gpu http://hub:8787
scripts/install-hooks.sh orchestrator@macbook macbook http://hub:8787
scripts/link-skills.sh orchestrator@gpu    # once the brain is synced there; same for macbook, local
```

For gpu and macbook to reach `/events`, set `HOST=0.0.0.0` (or hub's Tailscale IP) in `.env`. Every `/mcp` client needs `Authorization: Bearer $MCP_TOKEN`, local ones included. The one exception is the tunnel, which uses the Cloudflare Access JWT (step 3).

Check: start a session, wait for a permission prompt, and `events_pending` shows it within 10 s.

## 3. Cloudflare Tunnel + Access

```sh
cloudflared tunnel login
cloudflared tunnel create session-orchestrator
# edit deploy/cloudflared.yml: hostname, credentials-file path
sudo cp deploy/cloudflared.yml /etc/cloudflared/config.yml && sudo cloudflared service install
```

In Cloudflare Zero Trust, add a self-hosted Access application for the hostname with one Allow policy: your email only. Copy the application's **Audience (AUD) tag** into `.env` as `CF_ACCESS_AUD`, and your team domain (`<team>.cloudflareaccess.com`) as `CF_ACCESS_TEAM_DOMAIN`. The server then accepts tunnel requests only when they carry a valid `Cf-Access-Jwt-Assertion`. Without these two values, tunnel requests are rejected. Claude connects to remote MCP servers with OAuth, so turn on Access's OAuth/MCP support for that application, so the connector's login goes through Access. Check the current Cloudflare docs for "MCP server" under Access before relying on this. Cloudflare's UI changes, and this step could not be tested from here.

Check: `curl -i https://<hostname>/mcp` without logging in returns a redirect or 401 from Cloudflare, never a response from this server. The only other path the tunnel exposes is the 404 fallback.

## 4. Claude connector + voice test

In Claude, open Settings → Connectors → Add custom connector and enter `https://<hostname>/mcp`. Log in through Access.

Voice checklist:

1. "How are my projects doing?" → `overview` answers in one go.
2. "Start a new session for myapp on the GPU, have it …" → the session shows up as a Remote Control card in the Claude app.
3. Make a session ask for permission → "anything waiting?" → "approve it".
4. Put the Mac on battery and let it sleep → a Mac tool returns "macbook is unreachable…" within 5 s.
5. `memory_write` to `shared/deployment/...`, link it, start a session → it is in that session's `context.md`.
6. `llm_run` with auto → GPU. Stop Ollama on gpu → it falls back to the Mac only when the Mac is on AC.
7. Every call shows up in `sqlite3 $DB_PATH 'select * from audit order by id desc limit 20'`.

## Claude Code sessions as clients

So a session can say "have the local model summarize this log":

```sh
# on hub (stdio, same DB and brain)
claude mcp add orchestrator -s user -e CONFIG_DIR=/opt/session-orchestrator/config \
  -e DB_PATH=/var/lib/session-orchestrator/orchestrator.db -- node /opt/session-orchestrator/src/stdio.ts
# on gpu / macbook (HTTP over Tailscale)
claude mcp add orchestrator -s user --transport http http://hub:8787/mcp --header "Authorization: Bearer $MCP_TOKEN"
```
