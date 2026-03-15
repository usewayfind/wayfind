#!/usr/bin/env bash
# Scenario: upgrade-version
# Install, simulate old version, run setup --update, verify upgrade path.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: upgrade-version"
echo "=========================="

# Set up isolated HOME
MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

# First install
bash "$KIT_DIR/setup.sh" --tool claude-code >/dev/null 2>&1

# Simulate an older version by writing a .wayfind-version file
mkdir -p "$MOCK_HOME/.claude/team-context"
echo "0.9.0" > "$MOCK_HOME/.claude/team-context/.wayfind-version"

# Get current version from package.json
CURRENT_VERSION=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['version'])" "$KIT_DIR/package.json" 2>/dev/null || echo "unknown")

# Run setup.sh --update (the actual upgrade path, not manual copy)
TEAM_CONTEXT_OLD_VERSION="0.9.0" TEAM_CONTEXT_NEW_VERSION="$CURRENT_VERSION" \
    bash "$KIT_DIR/setup.sh" --tool claude-code --update >/dev/null 2>&1

# Verify the version file was updated
assert_file_exists "$MOCK_HOME/.claude/team-context/.wayfind-version" "version file exists after upgrade"

VERSION_CONTENT=$(cat "$MOCK_HOME/.claude/team-context/.wayfind-version" 2>/dev/null || echo "")
if [ "$VERSION_CONTENT" = "$CURRENT_VERSION" ]; then
    _pass "version file contains current version ($CURRENT_VERSION)"
else
    _fail "version file contains current version" "expected '$CURRENT_VERSION', got '$VERSION_CONTENT'"
fi

# Verify setup still created/preserved the right structure
assert_file_exists "$MOCK_HOME/.claude/global-state.md" "global-state.md exists after upgrade"
assert_file_exists "$MOCK_HOME/.claude/settings.json" "settings.json exists after upgrade"
assert_file_exists "$MOCK_HOME/.claude/hooks/check-global-state.sh" "hook script present after upgrade"
assert_file_exists "$MOCK_HOME/.claude/commands/init-memory.md" "/init-memory command present after upgrade"

# Run doctor against the upgraded install
DOCTOR_EXIT=0
bash "$KIT_DIR/doctor.sh" >/dev/null 2>&1 || DOCTOR_EXIT=$?
if [ "$DOCTOR_EXIT" -eq 0 ]; then
    _pass "doctor.sh passes after upgrade"
else
    _fail "doctor.sh passes after upgrade" "exited $DOCTOR_EXIT"
fi

print_results
[ "$FAIL" -eq 0 ]
