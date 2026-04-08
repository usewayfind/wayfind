#!/usr/bin/env bash
# Wayfind plugin — SessionStart hook
# Pulls team context, indexes last session's conversations (solo mode only),
# rebuilds the Active Projects index, then prompts for the session goal.
#
# Runs synchronously so the user sees what Wayfind is doing before they type.
# Solo mode: no container_endpoint configured — reindex runs here instead of
# in a background container.

set -euo pipefail

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
  echo "[wayfind] CLI not found — install for full features: npm install -g wayfind" >&2
  exit 0
fi

echo ""
echo "  ── Wayfind ────────────────────────────────────────"

# Pull latest team context (synchronous — start with fresh state)
echo ""
$WAYFIND context pull 2>/dev/null || true

# Detect solo mode: no container_endpoint means no background container running reindex
CONTEXT_JSON="${WAYFIND_DIR:-$HOME/.claude/team-context}/context.json"
HAS_CONTAINER=false
if [ -f "$CONTEXT_JSON" ] && grep -q '"container_endpoint"' "$CONTEXT_JSON" 2>/dev/null; then
  HAS_CONTAINER=true
fi

# Solo mode: index last session's conversations now
# Teams rely on the container's scheduled reindex instead.
if [ "$HAS_CONTAINER" = "false" ]; then
  LAST_RUN_FILE="${WAYFIND_DIR:-$HOME/.claude/team-context}/.last-reindex"
  SHOULD_REINDEX=true

  if [ -f "$LAST_RUN_FILE" ]; then
    CHANGED=$(find "$HOME/.claude/projects" -name "*.jsonl" -newer "$LAST_RUN_FILE" -print -quit 2>/dev/null)
    if [ -z "$CHANGED" ]; then
      SHOULD_REINDEX=false
    fi
  fi

  if [ "$SHOULD_REINDEX" = "true" ]; then
    echo ""
    echo "  Indexing last session's conversations..."
    echo ""
    $WAYFIND reindex --conversations-only --export --write-stats 2>/dev/null || true
    mkdir -p "${WAYFIND_DIR:-$HOME/.claude/team-context}"
    touch "$LAST_RUN_FILE"
  fi
fi

# Rebuild Active Projects index (writes to global-state.md)
$WAYFIND status --write --quiet 2>/dev/null || true

# Version check — silent unless outdated
$WAYFIND check-version 2>/dev/null || true

echo ""
echo "  What's the goal for this session?"
echo "  ───────────────────────────────────────────────────"
echo ""
