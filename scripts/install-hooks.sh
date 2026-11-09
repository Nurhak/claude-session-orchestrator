#!/bin/sh
# Usage: scripts/install-hooks.sh <ssh-target> <machine-id> <orch-url>
# Example: scripts/install-hooks.sh me@gpu gpu http://hub:8787
# Needs EVENTS_TOKEN in the environment (or in .env), node here, and jq + curl >= 7.55 on the target.
# The target only receives its own per-machine token, HMAC-SHA256(EVENTS_TOKEN, machine-id).
set -eu
[ $# -eq 3 ] || { echo "usage: $0 <ssh-target> <machine-id> <orch-url>" >&2; exit 2; }
target=$1 machine=$2 url=$3
[ -f .env ] && . ./.env
: "${EVENTS_TOKEN:?set EVENTS_TOKEN}"
here=$(dirname "$0")/..
[ -n "$(printf %s "$machine" | tr -d 'a-z0-9-')" ] && { echo "machine id must match [a-z0-9-]+" >&2; exit 2; }
# Derive the machine token in node with EVENTS_TOKEN passed via the environment, never argv.
tok=$(EVENTS_TOKEN="$EVENTS_TOKEN" node -e 'process.stdout.write(require("crypto").createHmac("sha256", process.env.EVENTS_TOKEN).update(process.argv[1]).digest("hex"))' "$machine")
# Files are created under umask 077 in the same command, so they are never world-readable.
if [ "$target" = local ]; then sh_() { sh -c "$1"; }; cp_() { sh -c "umask 077; cat > $1"; }
else sh_() { ssh "$target" "$1"; }; cp_() { ssh "$target" "umask 077; cat > $1"; }; fi

sh_ 'mkdir -p ~/.claude/hooks ~/.config && command -v jq >/dev/null || { echo "jq missing on target" >&2; exit 1; }'
cp_ '~/.claude/hooks/cc-orchestrator-notify.sh' < "$here/hooks/notify.sh"
printf 'ORCH_URL=%s\nORCH_MACHINE=%s\n' "$url" "$machine" | cp_ '~/.config/cc-orchestrator.env'
printf 'Authorization: Bearer %s\n' "$tok" | cp_ '~/.config/cc-orchestrator.hdr'
sh_ 'chmod 700 ~/.claude/hooks/cc-orchestrator-notify.sh; chmod 600 ~/.config/cc-orchestrator.env ~/.config/cc-orchestrator.hdr
f=~/.claude/settings.json; [ -f "$f" ] || echo "{}" > "$f"
h="{\"type\":\"command\",\"command\":\"$HOME/.claude/hooks/cc-orchestrator-notify.sh\"}"
jq --argjson h "$h" ".hooks.Notification = ((.hooks.Notification // []) | map(select(.hooks[0].command != \$h.command)) + [{hooks:[\$h]}])
  | .hooks.Stop = ((.hooks.Stop // []) | map(select(.hooks[0].command != \$h.command)) + [{hooks:[\$h]}])
  | .hooks.SessionEnd = ((.hooks.SessionEnd // []) | map(select(.hooks[0].command != \$h.command)) + [{hooks:[\$h]}])" "$f" > "$f.tmp" && mv "$f.tmp" "$f"'
echo "hooks installed on $machine"
