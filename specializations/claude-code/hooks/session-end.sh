#!/usr/bin/env bash
# Wayfind session-end hook
# Runs incremental conversation indexing with journal export after each session.
# Extracted decisions get written to the journal directory so they sync via git
# and the container's journal indexer picks them up.
#
# Performance target: <5s for the common case (no new conversations to process).

set -euo pipefail

# Skip export for worker agents in multi-agent swarms.
# Set TEAM_CONTEXT_SKIP_EXPORT=1 when spawning worker agents so only the
# orchestrator's decisions flow into the journal.
if [ "${TEAM_CONTEXT_SKIP_EXPORT:-${MERIDIAN_SKIP_EXPORT:-}}" = "1" ]; then
  exit 0
fi

# Find wayfind binary
WAYFIND="$(command -v wayfind 2>/dev/null || echo "")"
if [ -z "$WAYFIND" ]; then
  # Try npx
  if command -v npx &>/dev/null; then
    WAYFIND="npx --yes wayfind"
  else
    exit 0
  fi
fi

# ── Fast path: skip reindex if no conversation files changed ──────────────────
# The full reindex pipeline (load store, scan transcripts, hash check, LLM calls)
# has a ~2-3s baseline cost even when nothing changed. This filesystem check
# short-circuits in <50ms for the common case.
LAST_RUN_FILE="$HOME/.claude/team-context/.last-reindex"
if [ -f "$LAST_RUN_FILE" ]; then
  CHANGED=$(find "$HOME/.claude/projects" -name "*.jsonl" -newer "$LAST_RUN_FILE" 2>/dev/null | head -1)
  if [ -z "$CHANGED" ]; then
    # No conversation files changed — skip expensive reindex, just sync journals
    $WAYFIND journal sync 2>/dev/null &
    exit 0
  fi
fi

# Run incremental reindex (conversations only — journals are handled by the journal write itself)
# --conversations-only: skip journals (just written by the session, no need to re-index)
# --export: write extracted decisions as journal entries for git sync
# --detect-shifts: auto-update state files when significant context shifts are detected
# --write-stats: write session stats JSON for status line display
$WAYFIND reindex --conversations-only --export --detect-shifts --write-stats 2>/dev/null || true

# Update the marker so the next session's fast-path check works
mkdir -p "$HOME/.claude/team-context"
touch "$LAST_RUN_FILE"

# Sync authored journals to team-context repo (commit + push) — backgrounded
# so the session can exit immediately. Git push is the slowest part (~1-3s).
$WAYFIND journal sync 2>/dev/null &
