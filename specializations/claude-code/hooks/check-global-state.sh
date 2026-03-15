#!/usr/bin/env bash
# Wayfind — Rebuild Active Projects + version check on session start.
# Rebuilds the Active Projects table from per-repo state files (idempotent,
# concurrent-safe), then checks if the installed version meets the team
# minimum configured in the team-context repo's wayfind.json.
#
# Install: copy to ~/.claude/hooks/check-global-state.sh
# Register: add to ~/.claude/settings.json (see settings.json in this directory)

set -euo pipefail

# Use local wayfind checkout if available, otherwise try npx
WAYFIND_BIN="$HOME/repos/greg/meridian/bin/team-context.js"
if [ -f "$WAYFIND_BIN" ]; then
    node "$WAYFIND_BIN" status --write --quiet 2>/dev/null || true
    node "$WAYFIND_BIN" check-version 2>/dev/null || true
elif command -v wayfind >/dev/null 2>&1; then
    wayfind status --write --quiet 2>/dev/null || true
    wayfind check-version 2>/dev/null || true
fi
