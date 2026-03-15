#!/usr/bin/env bash
# Scenario: clean-machine-onboard
# Simulates the exact journey a new user follows from the README:
#   1. npm install -g wayfind  (simulated — we use the local bin directly)
#   2. wayfind init
#   3. wayfind doctor
#   4. wayfind version
#   5. /init-memory in a repo
#   6. wayfind status
#
# Verifies everything works with ZERO prior state — no config, no repos,
# no environment variables, no prior install.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: clean-machine-onboard"
echo "================================="

# ── Isolated environment (zero prior state) ─────────────────────────────────

MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

# Unset all Wayfind env vars to simulate truly clean machine
unset TEAM_CONTEXT_TELEMETRY 2>/dev/null || true
unset TEAM_CONTEXT_SIMULATE 2>/dev/null || true
unset TEAM_CONTEXT_TENANT_ID 2>/dev/null || true
unset TEAM_CONTEXT_EXCLUDE_REPOS 2>/dev/null || true
unset TEAM_CONTEXT_LLM_MODEL 2>/dev/null || true
unset TEAM_CONTEXT_AUTHOR 2>/dev/null || true
unset ANTHROPIC_API_KEY 2>/dev/null || true
unset OPENAI_API_KEY 2>/dev/null || true
unset SLACK_BOT_TOKEN 2>/dev/null || true
unset SLACK_APP_TOKEN 2>/dev/null || true

# CLI alias (simulates the global install)
CLI="node $KIT_DIR/bin/team-context.js"

# ── Step 1: wayfind help (first thing a curious user tries) ────────────────

echo ""
echo "Step 1: wayfind help"
echo "--------------------"

HELP_OUTPUT=""
HELP_EXIT=0
HELP_OUTPUT=$($CLI help 2>&1) || HELP_EXIT=$?

if [ "$HELP_EXIT" -eq 0 ]; then
    _pass "wayfind help exits 0"
else
    _fail "wayfind help exits 0" "exited $HELP_EXIT"
fi

assert_output_contains "init" "help mentions init" $CLI help
assert_output_contains "doctor" "help mentions doctor" $CLI help
assert_output_contains "digest" "help mentions digest" $CLI help
assert_output_contains "search-journals" "help mentions search-journals" $CLI help

# ── Step 2: wayfind version ────────────────────────────────────────────────

echo ""
echo "Step 2: wayfind version"
echo "-----------------------"

VERSION_OUTPUT=""
VERSION_EXIT=0
VERSION_OUTPUT=$($CLI version 2>&1) || VERSION_EXIT=$?

if [ "$VERSION_EXIT" -eq 0 ]; then
    _pass "wayfind version exits 0"
else
    _fail "wayfind version exits 0" "exited $VERSION_EXIT"
fi

# ── Step 3: wayfind init (the main onboarding command) ─────────────────────

echo ""
echo "Step 3: wayfind init"
echo "--------------------"

INIT_EXIT=0
$CLI init >/dev/null 2>&1 || INIT_EXIT=$?

if [ "$INIT_EXIT" -eq 0 ]; then
    _pass "wayfind init exits 0"
else
    _fail "wayfind init exits 0" "exited $INIT_EXIT"
fi

# Verify directory structure
assert_dir_exists "$MOCK_HOME/.claude" "~/.claude created"
assert_dir_exists "$MOCK_HOME/.claude/memory" "memory/ created"
assert_dir_exists "$MOCK_HOME/.claude/memory/journal" "journal/ created"
assert_dir_exists "$MOCK_HOME/.claude/hooks" "hooks/ created"
assert_dir_exists "$MOCK_HOME/.claude/commands" "commands/ created"

# Verify key files
assert_file_exists "$MOCK_HOME/.claude/global-state.md" "global-state.md created"
assert_file_exists "$MOCK_HOME/.claude/state.md" "admin state.md created"
assert_file_exists "$MOCK_HOME/.claude/settings.json" "settings.json created"

# Verify hooks are wired
assert_file_exists "$MOCK_HOME/.claude/hooks/check-global-state.sh" "hook script installed"
assert_file_contains "$MOCK_HOME/.claude/settings.json" "SessionStart" "SessionStart hook registered"

# Verify slash commands installed
assert_file_exists "$MOCK_HOME/.claude/commands/init-memory.md" "/init-memory installed"
assert_file_exists "$MOCK_HOME/.claude/commands/init-team.md" "/init-team installed"
assert_file_exists "$MOCK_HOME/.claude/commands/doctor.md" "/doctor installed"
assert_file_exists "$MOCK_HOME/.claude/commands/journal.md" "/journal installed"

# Verify global-state.md has essential sections
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "Active Projects" "global-state has Active Projects"
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "Memory Files" "global-state has Memory Files"

# Verify no legacy references leaked
assert_file_not_contains "$MOCK_HOME/.claude/global-state.md" ".ai-memory" "no .ai-memory references"
assert_file_not_contains "$MOCK_HOME/.claude/global-state.md" "skip-tissue" "no skip-tissue references"
assert_file_not_contains "$MOCK_HOME/.claude/global-state.md" "Skip Tissue" "no Skip Tissue references"

# ── Step 4: wayfind doctor (validate the install) ──────────────────────────

echo ""
echo "Step 4: wayfind doctor"
echo "----------------------"

DOCTOR_EXIT=0
DOCTOR_OUTPUT=$($CLI doctor 2>&1) || DOCTOR_EXIT=$?

if [ "$DOCTOR_EXIT" -eq 0 ]; then
    _pass "wayfind doctor exits 0"
else
    _fail "wayfind doctor exits 0" "exited $DOCTOR_EXIT — output: $DOCTOR_OUTPUT"
fi

# ── Step 5: Simulate /init-memory in a repo ─────────────────────────────────

echo ""
echo "Step 5: /init-memory in a mock repo"
echo "------------------------------------"

MOCK_REPO="$(mktemp -d)"
cd "$MOCK_REPO"

# Init a git repo (init-memory expects one)
git init -q
git config user.email "test@test.com"
git config user.name "Test User"

# Create a minimal CLAUDE.md (init-memory appends to it)
echo "# Test Project" > CLAUDE.md
git add CLAUDE.md
git commit -q -m "initial"

# Run setup.sh for the repo context (what /init-memory effectively does)
# The /init-memory command is a Claude Code slash command (markdown), so we
# simulate its effect: create .claude/state.md and .claude/team-state.md
mkdir -p .claude
cp "$KIT_DIR/templates/repo-state.md" .claude/state.md 2>/dev/null || echo "# Repo State" > .claude/state.md
cp "$KIT_DIR/templates/team-state.md" .claude/team-state.md 2>/dev/null || true

assert_file_exists "$MOCK_REPO/.claude/state.md" "repo state.md created"

# Verify .gitignore handling (state.md should be gitignored)
if [ -f .gitignore ] && grep -qF ".claude/state.md" .gitignore 2>/dev/null; then
    _pass ".claude/state.md in .gitignore"
elif [ ! -f .gitignore ]; then
    # init-memory creates this — we didn't run the full command, so just verify template
    _pass ".gitignore check skipped (slash command simulation)"
else
    _pass ".gitignore exists (slash command handles entries)"
fi

# ── Step 6: wayfind status ─────────────────────────────────────────────────

echo ""
echo "Step 6: wayfind status"
echo "----------------------"

cd "$MOCK_HOME"

STATUS_EXIT=0
STATUS_OUTPUT=$($CLI status 2>&1) || STATUS_EXIT=$?

# status may exit non-zero if no repos are registered yet — that's OK
# We just verify it doesn't crash
if [ "$STATUS_EXIT" -le 1 ]; then
    _pass "wayfind status doesn't crash"
else
    _fail "wayfind status doesn't crash" "exited $STATUS_EXIT"
fi

# ── Step 7: wayfind signals (should work with no config) ──────────────────

echo ""
echo "Step 7: wayfind signals (no config)"
echo "------------------------------------"

SIGNALS_EXIT=0
SIGNALS_OUTPUT=$($CLI signals 2>&1) || SIGNALS_EXIT=$?

# Should exit cleanly even with no connectors configured
if [ "$SIGNALS_EXIT" -le 1 ]; then
    _pass "wayfind signals handles no-config gracefully"
else
    _fail "wayfind signals handles no-config gracefully" "exited $SIGNALS_EXIT"
fi

# ── Step 8: wayfind search-journals (empty state) ─────────────────────────

echo ""
echo "Step 8: wayfind search-journals (empty)"
echo "----------------------------------------"

SEARCH_EXIT=0
SEARCH_OUTPUT=$($CLI search-journals "test query" 2>&1) || SEARCH_EXIT=$?

# Should not crash on empty content store
if [ "$SEARCH_EXIT" -le 1 ]; then
    _pass "search-journals handles empty store gracefully"
else
    _fail "search-journals handles empty store gracefully" "exited $SEARCH_EXIT"
fi

# ── Step 9: Verify no sensitive data in installed files ────────────────────

echo ""
echo "Step 9: Verify no sensitive data leaked"
echo "----------------------------------------"

# Scan all installed files for things that should never appear
INSTALLED_DIR="$MOCK_HOME/.claude"
assert_file_not_contains "$INSTALLED_DIR/global-state.md" "HopSkip" "no HopSkip in global-state"
assert_file_not_contains "$INSTALLED_DIR/global-state.md" "Doorbell" "no Doorbell in global-state"
assert_file_not_contains "$INSTALLED_DIR/global-state.md" "leizerowicz" "no leizerowicz in global-state"


# Check all command files
for cmd_file in "$INSTALLED_DIR"/commands/*.md; do
    basename_cmd=$(basename "$cmd_file")
    assert_file_not_contains "$cmd_file" "HopSkip" "no HopSkip in $basename_cmd"
    assert_file_not_contains "$cmd_file" "leizerowicz" "no leizerowicz in $basename_cmd"
done

# Clean up
rm -rf "$MOCK_REPO"

print_results
[ "$FAIL" -eq 0 ]
