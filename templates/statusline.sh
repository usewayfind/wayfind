#!/usr/bin/env bash
# Wayfind status line for Claude Code
# Shows Wayfind-specific data: decision quality from last session.
# Installed by: wayfind init / wayfind update

input=$(cat)

STATS_FILE="$HOME/.claude/team-context/session-stats.json"

if [ -f "$STATS_FILE" ] && command -v jq &>/dev/null; then
  DECISIONS=$(jq -r '.decisions // 0' "$STATS_FILE" 2>/dev/null)
  RICH=$(jq -r '.rich // 0' "$STATS_FILE" 2>/dev/null)
  THIN=$(jq -r '.thin // 0' "$STATS_FILE" 2>/dev/null)
  DATE=$(jq -r '.session_date // ""' "$STATS_FILE" 2>/dev/null)
  if [ "$DECISIONS" -gt 0 ] 2>/dev/null; then
    echo "Wayfind | last: ${DECISIONS} decisions (${RICH} rich, ${THIN} thin) ${DATE}"
  else
    echo "Wayfind"
  fi
else
  echo "Wayfind"
fi
