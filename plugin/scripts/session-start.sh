#!/usr/bin/env bash
# Wayfind plugin — SessionStart hook
# Rebuilds the Active Projects index and checks for version updates.
# Runs on every session start via the plugin hook system.

set -euo pipefail

# Find wayfind binary
WAYFIND="$(command -v wayfind 2>/dev/null || echo "")"
if [ -z "$WAYFIND" ]; then
  # Try common local checkout paths
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
  # No CLI available — plugin still works for skills, just no automation
  echo "[wayfind] CLI not found. Skills work, but install the CLI for full features: npm install -g wayfind" >&2
  exit 0
fi

# Pull latest team-context in the background so this session sees
# other engineers' recent work without blocking session start
$WAYFIND context pull --quiet --background 2>/dev/null || true

# Rebuild Active Projects table (idempotent, concurrent-safe)
$WAYFIND status --write --quiet 2>/dev/null || true

# Check if installed version meets team minimum
$WAYFIND check-version 2>/dev/null || true
