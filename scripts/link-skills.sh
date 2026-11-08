#!/bin/sh
# Symlink every ~/brain/skills/<name> into ~/.claude/skills/<name> on a machine.
# Usage: scripts/link-skills.sh <ssh-target|local>. Re-run after adding a skill; existing links are refreshed.
set -eu
[ $# -eq 1 ] || { echo "usage: $0 <ssh-target|local>" >&2; exit 2; }
script='set -eu; brain=${REMOTE_BRAIN_DIR:-$HOME/brain}; mkdir -p ~/.claude/skills; n=0
for d in "$brain"/skills/*/; do [ -d "$d" ] || continue; s=$(basename "$d")
  if [ -e ~/.claude/skills/"$s" ] && [ ! -L ~/.claude/skills/"$s" ]; then echo "skip $s: a real folder is in the way" >&2; continue; fi
  ln -sfn "${d%/}" ~/.claude/skills/"$s"; n=$((n+1)); done; echo "linked $n skills"'
if [ "$1" = local ]; then sh -c "$script"; else ssh "$1" "$script"; fi
