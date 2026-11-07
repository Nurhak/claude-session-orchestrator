#!/bin/sh
# Usage: scripts/install-hooks.sh <ssh-target> <machine-id> <orch-url>
# Example: scripts/install-hooks.sh me@gpu gpu http://node2:8787
# Needs EVENTS_TOKEN in the environment (or in .env) and jq on the target.
set -eu
[ $# -eq 3 ] || { echo "usage: $0 <ssh-target> <machine-id> <orch-url>" >&2; exit 2; }
target=$1 machine=$2 url=$3
[ -f .env ] && . ./.env
: "${EVENTS_TOKEN:?set EVENTS_TOKEN}"
here=$(dirname "$0")/..
if [ "$target" = local ]; then sh_() { sh -c "$1"; }; cp_() { sh -c "cat > $1"; }
else sh_() { ssh "$target" "$1"; }; cp_() { ssh "$target" "cat > $1"; }; fi

sh_ 'mkdir -p ~/.claude/hooks ~/.config && command -v jq >/dev/null || { echo "jq missing on target" >&2; exit 1; }'
cp_ '~/.claude/hooks/cc-orchestrator-notify.sh' < "$here/hooks/notify.sh"
printf 'ORCH_URL=%s\nEVENTS_TOKEN=%s\nORCH_MACHINE=%s\n' "$url" "$EVENTS_TOKEN" "$machine" | cp_ '~/.config/cc-orchestrator.env'
sh_ 'chmod 700 ~/.claude/hooks/cc-orchestrator-notify.sh; chmod 600 ~/.config/cc-orchestrator.env
f=~/.claude/settings.json; [ -f "$f" ] || echo "{}" > "$f"
h="{\"type\":\"command\",\"command\":\"$HOME/.claude/hooks/cc-orchestrator-notify.sh\"}"
jq --argjson h "$h" ".hooks.Notification = ((.hooks.Notification // []) | map(select(.hooks[0].command != \$h.command)) + [{hooks:[\$h]}])
  | .hooks.Stop = ((.hooks.Stop // []) | map(select(.hooks[0].command != \$h.command)) + [{hooks:[\$h]}])" "$f" > "$f.tmp" && mv "$f.tmp" "$f"'
echo "hooks installed on $machine"
