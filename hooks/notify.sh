#!/bin/sh
# Claude Code Notification/Stop/SessionEnd hook: forwards the hook JSON to the orchestrator's /events.
# Config (written by scripts/install-hooks.sh): ORCH_URL and ORCH_MACHINE in cc-orchestrator.env, and this
# machine's own token in cc-orchestrator.hdr (0600). The token is read by curl from that file, never put
# on the command line, so other local users cannot see it in ps.
. "$HOME/.config/cc-orchestrator.env" 2>/dev/null
[ -n "$TMUX" ] || exit 0
session=$(tmux display-message -p '#S' 2>/dev/null)
case "$session" in cc-*) ;; *) exit 0 ;; esac
# Never block Claude Code: short timeout, ignore failures.
curl -fsS -m 3 -X POST -H "@$HOME/.config/cc-orchestrator.hdr" -H 'Content-Type: application/json' \
  --data-binary @- "$ORCH_URL/events?session=$session&machine=$ORCH_MACHINE" >/dev/null 2>&1
exit 0
