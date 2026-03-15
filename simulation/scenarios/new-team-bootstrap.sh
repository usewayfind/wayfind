#!/usr/bin/env bash
# Scenario: new-team-bootstrap
# Verify setup creates proper team structure and CLI commands work.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: new-team-bootstrap"
echo "============================="

# Set up isolated HOME
MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

# Run setup
bash "$KIT_DIR/setup.sh" --tool claude-code >/dev/null 2>&1

# Verify the setup created the expected structure for team usage
assert_dir_exists "$MOCK_HOME/.claude" "~/.claude exists"
assert_dir_exists "$MOCK_HOME/.claude/memory" "memory directory exists"
assert_dir_exists "$MOCK_HOME/.claude/memory/journal" "journal directory exists"
assert_dir_exists "$MOCK_HOME/.claude/commands" "commands directory exists"

# Verify team-related template exists in the kit
assert_file_exists "$KIT_DIR/templates/team-state.md" "team-state.md template exists"

# Verify init-team command was installed
assert_file_exists "$MOCK_HOME/.claude/commands/init-team.md" "/init-team command installed"

# Simulate creating a team context by copying team-state.md to a mock repo
MOCK_REPO="$(mktemp -d)"
mkdir -p "$MOCK_REPO/.claude"
cp "$KIT_DIR/templates/team-state.md" "$MOCK_REPO/.claude/team-state.md"

assert_file_exists "$MOCK_REPO/.claude/team-state.md" "team-state.md installed in repo"
assert_file_contains "$MOCK_REPO/.claude/team-state.md" "Architecture" "team-state.md has Architecture section"

# Verify the global state file has the Active Projects table structure
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "Active Projects" "global-state.md has Active Projects table"

# Verify wayfind CLI exists and shows help
CLI_OUTPUT=""
CLI_EXIT=0
CLI_OUTPUT=$(node "$KIT_DIR/bin/team-context.js" help 2>&1) || CLI_EXIT=$?
if [ "$CLI_EXIT" -eq 0 ]; then
    _pass "wayfind CLI help exits 0"
else
    _fail "wayfind CLI help exits 0" "exited $CLI_EXIT"
fi

if echo "$CLI_OUTPUT" | grep -qF "wayfind"; then
    _pass "CLI help output mentions wayfind"
else
    _fail "CLI help output mentions wayfind" "output: $CLI_OUTPUT"
fi

# Clean up mock repo
rm -rf "$MOCK_REPO"

print_results
[ "$FAIL" -eq 0 ]
