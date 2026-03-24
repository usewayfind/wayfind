#!/usr/bin/env bash
# Wayfind plugin — Stop hook
# Runs incremental conversation indexing with journal export after each session.
# Extracted decisions get written to the journal directory so they sync via git
# and the container's journal indexer picks them up.
#
# Performance target: <5s for the common case (no new conversations to process).

set -euo pipefail

# Skip export for worker agents in multi-agent swarms.
# Set TEAM_CONTEXT_SKIP_EXPORT=1 when spawning worker agents so only the
# orchestrator's decisions flow into the journal.
if [ "${TEAM_CONTEXT_SKIP_EXPORT:-}" = "1" ]; then
  exit 0
fi

# Find wayfind binary
WAYFIND="$(command -v wayfind 2>/dev/null || echo "")"
if [ -z "$WAYFIND" ]; then
  for candidate in \
    "$HOME/repos/greg/wayfind/bin/team-context.js" \
    "$HOME/repos/wayfind/bin/team-context.js"; do
    if [ -f "$candidate" ]; then
      WAYFIND="node $candidate"
      break
    fi
  done
fi

if [ -z "$WAYFIND" ]; then
  echo "[wayfind] CLI not found — decision extraction skipped. Install: npm install -g wayfind" >&2
  exit 0
fi

# ── Fast path: skip reindex if no conversation files changed ──────────────────
LAST_RUN_FILE="$HOME/.claude/team-context/.last-reindex"
if [ -f "$LAST_RUN_FILE" ]; then
  CHANGED=$(find "$HOME/.claude/projects" -name "*.jsonl" -newer "$LAST_RUN_FILE" -print -quit 2>/dev/null)
  if [ -z "$CHANGED" ]; then
    # No conversation files changed — skip expensive reindex, just sync journals
    $WAYFIND journal sync 2>/dev/null &
    exit 0
  fi
fi

# Run incremental reindex
$WAYFIND reindex --conversations-only --export --detect-shifts --write-stats 2>/dev/null || true

# Update the marker so the next session's fast-path check works
mkdir -p "$HOME/.claude/team-context"
touch "$LAST_RUN_FILE"

# Sync authored journals to team-context repo (backgrounded)
$WAYFIND journal sync 2>/dev/null &
