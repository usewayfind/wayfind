#!/usr/bin/env bash
# Scenario: fresh-install
# Clean machine, run setup.sh, verify everything lands correctly.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: fresh-install"
echo "========================"

# Set up isolated HOME
MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

# Run setup (non-interactive, claude-code)
bash "$KIT_DIR/setup.sh" --tool claude-code >/dev/null 2>&1

# Verify directories
assert_dir_exists "$MOCK_HOME/.claude" "~/.claude directory created"
assert_dir_exists "$MOCK_HOME/.claude/memory" "~/.claude/memory directory created"
assert_dir_exists "$MOCK_HOME/.claude/memory/journal" "~/.claude/memory/journal directory created"
assert_dir_exists "$MOCK_HOME/.claude/hooks" "~/.claude/hooks directory created"
assert_dir_exists "$MOCK_HOME/.claude/commands" "~/.claude/commands directory created"

# Verify key files
assert_file_exists "$MOCK_HOME/.claude/global-state.md" "global-state.md created"
assert_file_exists "$MOCK_HOME/.claude/state.md" "admin state.md created"
assert_file_exists "$MOCK_HOME/.claude/settings.json" "settings.json created"
assert_file_exists "$MOCK_HOME/.claude/hooks/check-global-state.sh" "hook script installed"
assert_file_exists "$MOCK_HOME/.claude/commands/init-memory.md" "/init-memory command installed"
assert_file_exists "$MOCK_HOME/.claude/commands/doctor.md" "/doctor command installed"

# Verify settings.json has hook registered
assert_file_contains "$MOCK_HOME/.claude/settings.json" "check-global-state" "hook registered in settings.json"
assert_file_contains "$MOCK_HOME/.claude/settings.json" "SessionStart" "SessionStart hook present"

# Verify global-state.md was transformed (no .ai-memory references)
assert_file_not_contains "$MOCK_HOME/.claude/global-state.md" ".ai-memory" "global-state.md has no .ai-memory references"

# Verify doctor.sh exits 0 against this environment
DOCTOR_EXIT=0
bash "$KIT_DIR/doctor.sh" >/dev/null 2>&1 || DOCTOR_EXIT=$?
if [ "$DOCTOR_EXIT" -eq 0 ]; then
    _pass "doctor.sh exits 0 on fresh install"
else
    _fail "doctor.sh exits 0 on fresh install" "exited $DOCTOR_EXIT"
fi

print_results
[ "$FAIL" -eq 0 ]
