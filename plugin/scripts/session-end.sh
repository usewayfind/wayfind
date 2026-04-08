#!/usr/bin/env bash
# Wayfind plugin — Stop hook
# Persists the session: splits journal files by team suffix, then syncs to
# team-context repo. No LLM calls — fast, reliable, durability only.
#
# Heavy work (reindex, embeddings, context shift detection) is handled by
# the container on a schedule, or by the session-start hook for solo users.

set -euo pipefail

# Skip for worker agents in multi-agent swarms.
if [ "${TEAM_CONTEXT_SKIP_EXPORT:-}" = "1" ]; then
  exit 0
fi

# Find wayfind binary
WAYFIND="$(command -v wayfind 2>/dev/null || echo "")"
if [ -z "$WAYFIND" ]; then
  for candidate in \
    "$HOME/repos/wayfind/bin/team-context.js"; do
    if [ -f "$candidate" ]; then
      WAYFIND="node $candidate"
      break
    fi
  done
fi

if [ -z "$WAYFIND" ]; then
  exit 0
fi

# Split any unsuffixed journal files by team (fast, filesystem only)
$WAYFIND journal split >/dev/null 2>&1 || true

# Sync journals to team-context repo — the durability guarantee.
# Runs synchronously so the push completes before the hook exits.
$WAYFIND journal sync 2>/dev/null || true
