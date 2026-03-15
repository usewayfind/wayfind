#!/usr/bin/env bash
# Scenario: reinstall-preserve-state
# Install, write custom state, reinstall, verify state preserved.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: reinstall-preserve-state"
echo "===================================="

# Set up isolated HOME
MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

# First install
bash "$KIT_DIR/setup.sh" --tool claude-code >/dev/null 2>&1

# Write custom content to global-state.md
cat > "$MOCK_HOME/.claude/global-state.md" <<'EOF'
# Global State — Index

Last updated: 2026-02-28

## Preferences

### Working style
- Direct, no filler
- Always review before sending

## Active Projects

| Project | Repo | Status | Next |
|---------|------|--------|------|
| Wayfind | ~/repos/meridian | Building sim harness | Finish scenarios |

## Custom Section

This is custom content that must survive reinstall.
EOF

# Create a custom memory file
mkdir -p "$MOCK_HOME/.claude/memory"
cat > "$MOCK_HOME/.claude/memory/custom-topic.md" <<'EOF'
# Custom Topic

Important cross-session context that must not be lost.
EOF

# Reinstall (same command)
bash "$KIT_DIR/setup.sh" --tool claude-code >/dev/null 2>&1

# Verify custom content survived
assert_file_exists "$MOCK_HOME/.claude/global-state.md" "global-state.md still exists after reinstall"
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "Custom Section" "custom section preserved in global-state.md"
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "survive reinstall" "custom content preserved in global-state.md"
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "Building sim harness" "active projects preserved"

# Verify custom memory file survived
assert_file_exists "$MOCK_HOME/.claude/memory/custom-topic.md" "custom memory file preserved"
assert_file_contains "$MOCK_HOME/.claude/memory/custom-topic.md" "must not be lost" "custom memory file content preserved"

# Verify hook and settings still work
assert_file_exists "$MOCK_HOME/.claude/settings.json" "settings.json still exists"
assert_file_contains "$MOCK_HOME/.claude/settings.json" "check-global-state" "hook still registered"

# Verify doctor still passes
DOCTOR_EXIT=0
bash "$KIT_DIR/doctor.sh" >/dev/null 2>&1 || DOCTOR_EXIT=$?
if [ "$DOCTOR_EXIT" -eq 0 ]; then
    _pass "doctor.sh still passes after reinstall"
else
    _fail "doctor.sh still passes after reinstall" "exited $DOCTOR_EXIT"
fi

print_results
[ "$FAIL" -eq 0 ]
