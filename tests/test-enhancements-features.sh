#!/usr/bin/env bash
# Wayfind — Test Suite for Feature Enhancements (#11, #12, #13)
# Tests:
#   - doctor.sh exits 0 in a valid mock environment
#   - uninstall.sh removes files correctly (temp dir mock)
#   - setup.sh --update flag is accepted without error (dry-run)
#   - templates/team-state.md and templates/personal-state.md exist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; RESET='\033[0m'
PASS=0
FAIL=0

pass() { echo -e "${GREEN}PASS${RESET} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${RESET} $1"; FAIL=$((FAIL + 1)); }

# ── Setup: temporary HOME override ────────────────────────────────────────────

MOCK_HOME="$(mktemp -d)"
# Trap is updated later when UNINSTALL_HOME is created
trap 'rm -rf "$MOCK_HOME"' EXIT

# Populate a minimal mock ~/.claude environment
mkdir -p "$MOCK_HOME/.claude/hooks"
mkdir -p "$MOCK_HOME/.claude/commands"
mkdir -p "$MOCK_HOME/.claude/memory/journal"
mkdir -p "$MOCK_HOME/.claude/team-context"

# Mock global-state.md with a recent date
TODAY="$(date +%Y-%m-%d)"
cat > "$MOCK_HOME/.claude/global-state.md" <<EOF
# Global State
Last updated: $TODAY
EOF

# Mock settings.json with hook registered
cat > "$MOCK_HOME/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/check-global-state.sh"
          }
        ]
      }
    ]
  }
}
EOF

# Mock hook script
cat > "$MOCK_HOME/.claude/hooks/check-global-state.sh" <<'EOF'
#!/usr/bin/env bash
# Mock hook for testing
exit 0
EOF
chmod +x "$MOCK_HOME/.claude/hooks/check-global-state.sh"

# Copy doctor.sh into mock team-context
cp "$KIT_DIR/doctor.sh" "$MOCK_HOME/.claude/team-context/doctor.sh"
chmod +x "$MOCK_HOME/.claude/team-context/doctor.sh"

echo ""
echo "Wayfind — Feature Enhancement Tests"
echo "═════════════════════════════════════════"

# ── Test 1: templates/team-state.md exists ────────────────────────────────────

echo ""
echo "Enhancement #11: team-state / personal-state split"

if [ -f "$KIT_DIR/templates/team-state.md" ]; then
    pass "templates/team-state.md exists"
else
    fail "templates/team-state.md not found"
fi

if [ -f "$KIT_DIR/templates/personal-state.md" ]; then
    pass "templates/personal-state.md exists"
else
    fail "templates/personal-state.md not found"
fi

# team-state.md should contain the expected sections
if grep -q "Architecture & Key Decisions" "$KIT_DIR/templates/team-state.md"; then
    pass "team-state.md contains 'Architecture & Key Decisions' section"
else
    fail "team-state.md missing expected content"
fi

# personal-state.md should mention gitignored
if grep -q "gitignored" "$KIT_DIR/templates/personal-state.md"; then
    pass "personal-state.md mentions it is gitignored"
else
    fail "personal-state.md missing gitignored note"
fi

# init-memory.md should reference team-state.md
if grep -q "team-state.md" "$KIT_DIR/specializations/claude-code/commands/init-memory.md"; then
    pass "init-memory.md references team-state.md"
else
    fail "init-memory.md does not reference team-state.md"
fi

# init-memory.md should reference personal-state.md
if grep -q "personal-state.md" "$KIT_DIR/specializations/claude-code/commands/init-memory.md"; then
    pass "init-memory.md references personal-state.md"
else
    fail "init-memory.md does not reference personal-state.md"
fi

# gitignore block in init-memory.md should NOT contain state.md (old entry)
# and SHOULD contain personal-state.md
if grep -A5 'gitignore' "$KIT_DIR/specializations/claude-code/commands/init-memory.md" | grep -q "personal-state.md"; then
    pass "init-memory.md gitignore block contains personal-state.md"
else
    fail "init-memory.md gitignore block missing personal-state.md"
fi

# CLAUDE.md-repo-fragment.md should reference both files
if grep -q "team-state.md" "$KIT_DIR/specializations/claude-code/CLAUDE.md-repo-fragment.md"; then
    pass "CLAUDE.md-repo-fragment.md references team-state.md"
else
    fail "CLAUDE.md-repo-fragment.md does not reference team-state.md"
fi

if grep -q "personal-state.md" "$KIT_DIR/specializations/claude-code/CLAUDE.md-repo-fragment.md"; then
    pass "CLAUDE.md-repo-fragment.md references personal-state.md"
else
    fail "CLAUDE.md-repo-fragment.md does not reference personal-state.md"
fi

# setup.sh should have the team/personal split comment
if grep -q "team/personal split" "$KIT_DIR/setup.sh"; then
    pass "setup.sh has team/personal split comment"
else
    fail "setup.sh missing team/personal split comment"
fi

# ── Test 2: doctor.sh ─────────────────────────────────────────────────────────

echo ""
echo "Enhancement #12: doctor command"

if [ -f "$KIT_DIR/doctor.sh" ]; then
    pass "doctor.sh exists"
else
    fail "doctor.sh not found"
    echo "  Cannot run further doctor tests."
fi

if [ -f "$KIT_DIR/specializations/claude-code/commands/doctor.md" ]; then
    pass "specializations/claude-code/commands/doctor.md exists"
else
    fail "doctor.md command not found"
fi

# Run doctor.sh against mock HOME — should exit 0 with no issues
DOCTOR_OUTPUT="$(HOME="$MOCK_HOME" bash "$MOCK_HOME/.claude/team-context/doctor.sh" 2>&1)" && DOCTOR_EXIT=0 || DOCTOR_EXIT=$?

if [ "$DOCTOR_EXIT" -eq 0 ]; then
    pass "doctor.sh exits 0 with valid mock environment"
else
    fail "doctor.sh exited $DOCTOR_EXIT with valid mock environment"
    echo "  Output: $DOCTOR_OUTPUT"
fi

# doctor.sh should report the hook as registered
if echo "$DOCTOR_OUTPUT" | grep -q "SessionStart hook registered"; then
    pass "doctor.sh reports hook registration correctly"
else
    fail "doctor.sh did not report hook registration"
fi

# doctor.sh should report global-state.md exists
if echo "$DOCTOR_OUTPUT" | grep -q "global-state.md exists"; then
    pass "doctor.sh reports global-state.md correctly"
else
    fail "doctor.sh did not report global-state.md"
fi

# ── Test 3: uninstall.sh ──────────────────────────────────────────────────────

echo ""
echo "Enhancement #13: uninstall.sh and --update flag"

if [ -f "$KIT_DIR/uninstall.sh" ]; then
    pass "uninstall.sh exists"
else
    fail "uninstall.sh not found"
fi

# Set up a fresh mock for uninstall testing
UNINSTALL_HOME="$(mktemp -d)"
# Combine both cleanup entries in a single trap
trap 'rm -rf "$MOCK_HOME" "$UNINSTALL_HOME"' EXIT

mkdir -p "$UNINSTALL_HOME/.claude/hooks"
mkdir -p "$UNINSTALL_HOME/.claude/commands"

# Create files that uninstall.sh should remove
touch "$UNINSTALL_HOME/.claude/hooks/check-global-state.sh"
touch "$UNINSTALL_HOME/.claude/commands/init-memory.md"
touch "$UNINSTALL_HOME/.claude/commands/doctor.md"
mkdir -p "$UNINSTALL_HOME/.claude/team-context"
touch "$UNINSTALL_HOME/.claude/team-context/doctor.sh"

# Create settings.json with hook entry
cat > "$UNINSTALL_HOME/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/check-global-state.sh"
          }
        ]
      }
    ]
  }
}
EOF

# Create memory files that must NOT be removed
mkdir -p "$UNINSTALL_HOME/.claude/memory"
echo "# Important memory" > "$UNINSTALL_HOME/.claude/memory/important.md"
echo "# Global state" > "$UNINSTALL_HOME/.claude/global-state.md"

# Run uninstall.sh non-interactively (pipe 'y' to confirm)
UNINSTALL_OUTPUT="$(echo "y" | HOME="$UNINSTALL_HOME" bash "$KIT_DIR/uninstall.sh" 2>&1)" && UNINSTALL_EXIT=0 || UNINSTALL_EXIT=$?

if [ "$UNINSTALL_EXIT" -eq 0 ]; then
    pass "uninstall.sh exits 0"
else
    fail "uninstall.sh exited $UNINSTALL_EXIT"
    echo "  Output: $UNINSTALL_OUTPUT"
fi

# Verify hook was removed
if [ ! -f "$UNINSTALL_HOME/.claude/hooks/check-global-state.sh" ]; then
    pass "uninstall.sh removed check-global-state.sh"
else
    fail "uninstall.sh did not remove check-global-state.sh"
fi

# Verify commands were removed
if [ ! -f "$UNINSTALL_HOME/.claude/commands/init-memory.md" ]; then
    pass "uninstall.sh removed init-memory.md"
else
    fail "uninstall.sh did not remove init-memory.md"
fi

if [ ! -f "$UNINSTALL_HOME/.claude/commands/doctor.md" ]; then
    pass "uninstall.sh removed doctor.md"
else
    fail "uninstall.sh did not remove doctor.md"
fi

# Verify team-context directory was removed
if [ ! -d "$UNINSTALL_HOME/.claude/team-context" ]; then
    pass "uninstall.sh removed team-context directory"
else
    fail "uninstall.sh did not remove team-context directory"
fi

# Verify memory files were NOT removed
if [ -f "$UNINSTALL_HOME/.claude/memory/important.md" ]; then
    pass "uninstall.sh preserved memory files"
else
    fail "uninstall.sh deleted memory files (should not have)"
fi

if [ -f "$UNINSTALL_HOME/.claude/global-state.md" ]; then
    pass "uninstall.sh preserved global-state.md"
else
    fail "uninstall.sh deleted global-state.md (should not have)"
fi

# Verify hook was removed from settings.json
if python3 -c "import json,sys; d=json.load(open('$UNINSTALL_HOME/.claude/settings.json')); sys.exit(0 if 'hooks' not in d or 'SessionStart' not in d.get('hooks',{}) else 1)" 2>/dev/null; then
    pass "uninstall.sh removed hook entry from settings.json"
else
    fail "uninstall.sh did not remove hook from settings.json"
fi

# Test --update flag on setup.sh (dry-run mode, no actual file writes)
UPDATE_OUTPUT="$(bash "$KIT_DIR/setup.sh" --tool claude-code --update --dry-run 2>&1)" && UPDATE_EXIT=0 || UPDATE_EXIT=$?

if [ "$UPDATE_EXIT" -eq 0 ]; then
    pass "setup.sh --update --dry-run exits 0"
else
    fail "setup.sh --update --dry-run exited $UPDATE_EXIT"
    echo "  Output: $UPDATE_OUTPUT"
fi

if echo "$UPDATE_OUTPUT" | grep -q "Update mode"; then
    pass "setup.sh --update shows 'Update mode' message"
else
    fail "setup.sh --update did not show 'Update mode' message"
fi

# ── Test 4: doctor.sh runs all checks even when multiple fail ─────────────────

echo ""
echo "Issue #12: doctor.sh runs all checks even when multiple fail"
BROKEN_HOME="$(mktemp -d)"
# Run doctor against a home dir with nothing installed
OUTPUT=$(HOME="$BROKEN_HOME" bash "$SCRIPT_DIR/../doctor.sh" 2>&1 || true)
# Should contain the summary line (proves it ran to completion)
if echo "$OUTPUT" | grep -q "issue(s) found"; then
    pass "doctor.sh runs to completion despite failures"
else
    fail "doctor.sh runs to completion despite failures"
    echo "  Output: $OUTPUT"
fi
rm -rf "$BROKEN_HOME"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "═════════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}All tests passed${RESET}"
    exit 0
else
    echo -e "${RED}$FAIL test(s) failed${RESET}"
    exit 1
fi
