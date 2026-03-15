#!/usr/bin/env bash
# Wayfind — Tooling Enhancements Test Suite
# Tests for enhancements #8 (Cursor integration), #15 (backup visibility),
# #16 (versioned installer), and Issue #1 (install/upgrade flow).
#
# Usage: bash tests/test-enhancements-tooling.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
RESET='\033[0m'

pass() { echo -e "${GREEN}PASS${RESET} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${RESET} $1"; FAIL=$((FAIL + 1)); }

assert_file_exists() {
    local file="$1"
    local label="${2:-$file}"
    if [ -f "$file" ]; then
        pass "$label exists"
    else
        fail "$label does not exist (expected: $file)"
    fi
}

assert_file_contains() {
    local file="$1"
    local pattern="$2"
    local label="${3:-contains '$pattern'}"
    if grep -qF -- "$pattern" "$file" 2>/dev/null; then
        pass "$label"
    else
        fail "$label (pattern not found in $file)"
    fi
}

assert_file_contains_regex() {
    local file="$1"
    local pattern="$2"
    local label="${3:-matches '$pattern'}"
    if grep -qE "$pattern" "$file" 2>/dev/null; then
        pass "$label"
    else
        fail "$label (regex not matched in $file)"
    fi
}

echo ""
echo "Wayfind — Tooling Enhancements Test Suite"
echo "================================================"
echo ""

# ── Enhancement #8: Cursor Integration ────────────────────────────────────────

echo "Enhancement #8: Cursor specialization"
echo "--------------------------------------"

CURSOR_SPEC="$ROOT_DIR/specializations/cursor"

assert_file_exists "$CURSOR_SPEC/global-rule.mdc" \
    "specializations/cursor/global-rule.mdc"

assert_file_contains "$CURSOR_SPEC/global-rule.mdc" "alwaysApply: true" \
    "global-rule.mdc has alwaysApply: true"

assert_file_contains "$CURSOR_SPEC/global-rule.mdc" "Session Start (REQUIRED)" \
    "global-rule.mdc has session-start instructions"

assert_file_contains "$CURSOR_SPEC/global-rule.mdc" "Session End Triggers" \
    "global-rule.mdc has session-end triggers"

assert_file_contains "$CURSOR_SPEC/global-rule.mdc" "~/.ai-memory/global.md" \
    "global-rule.mdc references ~/.ai-memory/global.md"

assert_file_exists "$CURSOR_SPEC/repo-rule.mdc" \
    "specializations/cursor/repo-rule.mdc"

assert_file_contains "$CURSOR_SPEC/repo-rule.mdc" "alwaysApply: true" \
    "repo-rule.mdc has alwaysApply: true"

assert_file_contains "$CURSOR_SPEC/repo-rule.mdc" "REPO_NAME" \
    "repo-rule.mdc has REPO_NAME placeholder"

assert_file_exists "$CURSOR_SPEC/README.md" \
    "specializations/cursor/README.md"

assert_file_contains "$CURSOR_SPEC/README.md" "global-rule.mdc" \
    "README.md references global-rule.mdc"

assert_file_contains "$CURSOR_SPEC/README.md" "repo-rule.mdc" \
    "README.md references repo-rule.mdc"

assert_file_contains "$CURSOR_SPEC/README.md" "done for today" \
    "README.md documents session-end trigger phrases"

# setup.sh supports --repo argument
assert_file_contains "$ROOT_DIR/setup.sh" "--repo" \
    "setup.sh supports --repo argument"

assert_file_contains "$ROOT_DIR/setup.sh" "global-rule.mdc" \
    "setup.sh installs global-rule.mdc for cursor"

assert_file_contains "$ROOT_DIR/setup.sh" "repo-rule.mdc" \
    "setup.sh installs repo-rule.mdc for cursor"

echo ""

# ── Enhancement #15: Backup Failure Visibility ────────────────────────────────

echo "Enhancement #15: Backup failure visibility"
echo "------------------------------------------"

SESSION_END="$ROOT_DIR/backup/hooks/session-end.sh"
SESSION_START="$ROOT_DIR/backup/hooks/session-start.sh"

assert_file_exists "$SESSION_END" "backup/hooks/session-end.sh"
assert_file_exists "$SESSION_START" "backup/hooks/session-start.sh"

assert_file_contains "$SESSION_END" ".backup-last-push" \
    "session-end.sh writes .backup-last-push on success"

assert_file_contains "$SESSION_END" ".backup-last-error" \
    "session-end.sh writes .backup-last-error on failure"

assert_file_contains "$SESSION_END" "Backup push failed" \
    "session-end.sh shows error message on push failure"

assert_file_contains "$SESSION_END" "exit 1" \
    "session-end.sh exits non-zero on push failure"

# Ensure 2>/dev/null suppression is removed from the push command
if grep -qE "git push.*2>/dev/null" "$SESSION_END" 2>/dev/null; then
    fail "session-end.sh still suppresses push errors with 2>/dev/null"
else
    pass "session-end.sh does not suppress push errors with 2>/dev/null"
fi

assert_file_contains "$SESSION_START" ".backup-last-error" \
    "session-start.sh checks for .backup-last-error"

assert_file_contains "$SESSION_START" "last push FAILED" \
    "session-start.sh warns when last push failed"

# Issue #15: error sentinel cleared on push success
assert_file_contains "$SESSION_END" "rm -f" \
    "session-end clears .backup-last-error on success"

if grep -rq 'rm -f.*backup-last-error\|backup-last-error.*rm -f' "$SESSION_END" 2>/dev/null; then
    pass "session-end uses rm -f to clear .backup-last-error"
else
    fail "session-end does not rm -f .backup-last-error (sentinel not cleared on success)"
fi

echo ""

# ── Enhancement #16: Versioned Installer ─────────────────────────────────────

echo "Enhancement #16: Versioned installer"
echo "-------------------------------------"

INSTALLER="$ROOT_DIR/install.sh"

assert_file_exists "$INSTALLER" "install.sh"

assert_file_contains "$INSTALLER" "TEAM_CONTEXT_VERSION" \
    "install.sh supports TEAM_CONTEXT_VERSION env var"

assert_file_contains "$INSTALLER" 'VERSION="${TEAM_CONTEXT_VERSION:-main}"' \
    "install.sh defaults VERSION to main"

assert_file_contains "$INSTALLER" "refs/tags/" \
    "install.sh uses tag URL for versioned installs"

assert_file_contains "$INSTALLER" "refs/heads/main" \
    "install.sh uses branch URL for main"

assert_file_contains "$INSTALLER" 'setup.sh" ]; then' \
    "install.sh verifies archive structure"

assert_file_contains "$INSTALLER" "Error: download failed" \
    "install.sh shows error on bad download"

assert_file_contains "$INSTALLER" "trap cleanup EXIT" \
    "install.sh cleans up temp dir on exit"

assert_file_exists "$ROOT_DIR/VERSIONS.md" \
    "VERSIONS.md exists"

assert_file_contains "$ROOT_DIR/VERSIONS.md" "TEAM_CONTEXT_VERSION" \
    "VERSIONS.md documents TEAM_CONTEXT_VERSION usage"

assert_file_contains "$ROOT_DIR/VERSIONS.md" "git tag -a" \
    "VERSIONS.md documents tagging process"

assert_file_contains "$ROOT_DIR/BOOTSTRAP_PROMPT.md" "TEAM_CONTEXT_VERSION" \
    "BOOTSTRAP_PROMPT.md documents version pinning"

echo ""

# ── Issue #1: Install/upgrade flow with version tracking ─────────────────────

echo "Issue #1: Install/upgrade flow with version tracking"
echo "----------------------------------------------------"

# install.sh has --force flag support
assert_file_contains "$INSTALLER" "--force" \
    "install.sh supports --force flag"

# install.sh detects existing installation via .wayfind-version
assert_file_contains "$INSTALLER" ".wayfind-version" \
    "install.sh checks .wayfind-version file"

# install.sh backs up existing kit before overwrite (uses mktemp)
assert_file_contains "$INSTALLER" "BACKUP_DIR" \
    "install.sh creates backup directory"

# install.sh has rollback on failure
assert_file_contains "$INSTALLER" "Restoring from backup" \
    "install.sh restores from backup on failure"

# install.sh shows same-version message
assert_file_contains "$INSTALLER" "Already installed" \
    "install.sh shows 'Already installed' for same version"

# install.sh shows upgrade message
assert_file_contains "$INSTALLER" "Upgrading from" \
    "install.sh shows upgrade message for different versions"

# setup.sh supports --version flag
assert_file_contains "$ROOT_DIR/setup.sh" "--version" \
    "setup.sh supports --version flag"

# setup.sh writes .wayfind-version after successful install
assert_file_contains "$ROOT_DIR/setup.sh" ".wayfind-version" \
    "setup.sh writes .wayfind-version file"

# setup.sh shows upgrade messaging
assert_file_contains "$ROOT_DIR/setup.sh" "TEAM_CONTEXT_OLD_VERSION" \
    "setup.sh reads TEAM_CONTEXT_OLD_VERSION env var"

assert_file_contains "$ROOT_DIR/setup.sh" "TEAM_CONTEXT_NEW_VERSION" \
    "setup.sh reads TEAM_CONTEXT_NEW_VERSION env var"

# bin/team-context.js has version command
assert_file_contains "$ROOT_DIR/bin/team-context.js" "version" \
    "team-context.js has version command"

assert_file_contains "$ROOT_DIR/bin/team-context.js" ".wayfind-version" \
    "team-context.js reads .wayfind-version file"

# Functional: setup.sh --version flag works (writes a temp version file, reads it)
MOCK_HOME_V="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME_V"' EXIT
mkdir -p "$MOCK_HOME_V/.claude/team-context"
echo "1.1.1" > "$MOCK_HOME_V/.claude/team-context/.wayfind-version"
VERSION_OUT="$(HOME="$MOCK_HOME_V" bash "$ROOT_DIR/setup.sh" --version 2>&1)" && VERSION_EXIT=0 || VERSION_EXIT=$?
if [ "$VERSION_EXIT" -eq 0 ] && echo "$VERSION_OUT" | grep -q "1.1.1"; then
    pass "setup.sh --version prints installed version"
else
    fail "setup.sh --version did not print expected version (output: $VERSION_OUT)"
fi

# Functional: setup.sh --version with no version file shows unknown
NO_VER_OUT="$(HOME="$MOCK_HOME_V/.nonexistent" bash "$ROOT_DIR/setup.sh" --version 2>&1)" && NO_VER_EXIT=0 || NO_VER_EXIT=$?
if echo "$NO_VER_OUT" | grep -qi "unknown"; then
    pass "setup.sh --version shows 'unknown' when no version file"
else
    fail "setup.sh --version did not show 'unknown' when no version file (output: $NO_VER_OUT)"
fi

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────

TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}All tests passed.${RESET}"
    exit 0
else
    echo -e "${RED}$FAIL test(s) failed.${RESET}"
    exit 1
fi
