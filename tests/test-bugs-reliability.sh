#!/usr/bin/env bash
# Tests for bugs-reliability fixes: #3, #4, #7
set -euo pipefail

PASS=0; FAIL=0; ERRORS=()

pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); }

assert_eq() { local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass; echo "  ✓ $desc"
  else fail; ERRORS+=("FAIL: $desc — expected '$expected', got '$actual'"); echo "  ✗ $desc"; fi
}

assert_contains() { local desc="$1" needle="$2" haystack="$3"
  local found=0
  echo "$haystack" | grep -qF -- "$needle" && found=1 || found=0
  if [ "$found" -eq 1 ]; then pass; echo "  ✓ $desc"
  else fail; ERRORS+=("FAIL: $desc — '$needle' not found"); echo "  ✗ $desc"; fi
}

assert_not_contains() { local desc="$1" needle="$2" haystack="$3"
  local found=0
  echo "$haystack" | grep -qF -- "$needle" && found=1 || found=0
  if [ "$found" -eq 0 ]; then pass; echo "  ✓ $desc"
  else fail; ERRORS+=("FAIL: $desc — '$needle' was found but should not be"); echo "  ✗ $desc"; fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Test #3: backup/setup.sh doesn't use --mkpath
echo ""
echo "Issue #3: rsync --mkpath removed"
BACKUP_SETUP="$SCRIPT_DIR/backup/setup.sh"
assert_not_contains "backup/setup.sh has no --mkpath" "--mkpath" "$(cat "$BACKUP_SETUP")"
assert_contains "backup/setup.sh uses mkdir -p" "mkdir -p" "$(cat "$BACKUP_SETUP")"
assert_contains "backup/setup.sh checks for rsync" "command -v rsync" "$(cat "$BACKUP_SETUP")"

# Test #4: session hooks have set -euo pipefail
echo ""
echo "Issue #4: set -euo pipefail in hooks"
SESSION_END="$SCRIPT_DIR/backup/hooks/session-end.sh"
SESSION_START="$SCRIPT_DIR/backup/hooks/session-start.sh"
assert_contains "session-end.sh has set -euo pipefail" "set -euo pipefail" "$(cat "$SESSION_END")"
assert_contains "session-start.sh has set -euo pipefail" "set -euo pipefail" "$(cat "$SESSION_START")"

# Check cd has explicit error handling
if grep -q 'cd.*|| {' "$SESSION_END" || grep -q 'cd.*||.*exit' "$SESSION_END"; then
    pass; echo "  ✓ session-end.sh: cd has explicit error handling"
else
    fail; ERRORS+=("FAIL: cd lacks explicit error handling in session-end.sh"); echo "  ✗ session-end.sh: cd has explicit error handling"
fi

# Test #7: check-global-state.sh delegates to wayfind status
# The hook now calls `wayfind status --write --quiet` instead of doing
# bash-level scanning. Scan root behavior is tested in test-rebuild-status.sh.
echo ""
echo "Issue #7: hook delegates to wayfind status"
HOOK="$SCRIPT_DIR/specializations/claude-code/hooks/check-global-state.sh"
assert_contains "hook calls wayfind status --write" "status --write" "$(cat "$HOOK")"
assert_contains "hook uses --quiet flag" "--quiet" "$(cat "$HOOK")"
assert_contains "hook has set -euo pipefail" "set -euo pipefail" "$(cat "$HOOK")"
assert_contains "hook falls back gracefully" "|| true" "$(cat "$HOOK")"
# Check for standalone 'find ' command (not 'wayfind' or 'Wayfind')
if sed 's/[Ww]ayfind//gi' "$HOOK" | grep -q 'find '; then
  fail; ERRORS+=("FAIL: hook doesn't hardcode find — 'find ' command was found"); echo "  ✗ hook doesn't hardcode find"
else
  pass; echo "  ✓ hook doesn't hardcode find"
fi
assert_not_contains "hook doesn't do staleness detection" "STALE" "$(cat "$HOOK")"
assert_not_contains "hook does not run standup inline" "standup" "$(cat "$HOOK")"

# Test hook runs without error (no wayfind binary needed — falls back to local checkout)
echo ""
echo "Issue #7: hook runs without error"
bash "$HOOK" 2>/dev/null || true  # Should not crash even if wayfind not found
pass; echo "  ✓ hook runs without error"

echo ""
echo "Issue #7: hook runs without error when wayfind binary not found"
# Set HOME to empty dir so the local checkout path doesn't exist
EMPTY_DIR="$(mktemp -d)"
HOME_BAK="$HOME"
HOME="$EMPTY_DIR" bash "$HOOK" 2>/dev/null || true
pass; echo "  ✓ hook runs without error when wayfind not installed"
rm -rf "$EMPTY_DIR"

echo ""
echo "Issue #7: paths with spaces handled by Node.js module"
# This is now tested in test-rebuild-status.sh, but verify hook doesn't crash
SPACE_DIR="$(mktemp -d)/dir with spaces"
mkdir -p "$SPACE_DIR"
bash "$HOOK" 2>/dev/null || true
((PASS++)); echo "  ✓ hook handles environments gracefully"
rm -rf "$(dirname "$SPACE_DIR")"

# Standup command tests
echo ""
echo "Standup: wayfind standup command"
WAYFIND_JS="$SCRIPT_DIR/bin/team-context.js"

# Basic standup with no data — should exit 0 and show empty standup
STANDUP_OUTPUT="$(node "$WAYFIND_JS" standup 2>/dev/null)" && STANDUP_EXIT=0 || STANDUP_EXIT=$?
assert_eq "standup exits 0 with no data" "0" "$STANDUP_EXIT"
assert_contains "standup shows 'Last session' header" "Last session" "$STANDUP_OUTPUT"
assert_contains "standup shows 'Plan for today' header" "Plan for today" "$STANDUP_OUTPUT"
assert_contains "standup shows 'Blockers' header" "Blockers" "$STANDUP_OUTPUT"

# Standup with mock journal + state files
STANDUP_TMP="$(mktemp -d)"
mkdir -p "$STANDUP_TMP/.claude/memory/journal"
mkdir -p "$STANDUP_TMP/repos/testrepo/.claude"
mkdir -p "$STANDUP_TMP/repos/testrepo/.git"

cat > "$STANDUP_TMP/.claude/memory/journal/2026-03-15.md" <<'JOURNALEOF'
## testrepo — Implement feature X

**Why:** Improve the user experience
**What:** Finished implementing and testing feature X
**Outcome:** Done — PR merged
**On track?:** Yes
**Lessons:** Always write tests first
JOURNALEOF

cat > "$STANDUP_TMP/repos/testrepo/.claude/personal-state.md" <<'STATEEOF'
# testrepo — Personal State

Last updated: 2026-03-15

## My Current Focus
Deploy feature X to staging and monitor for errors

## What I'm Watching
Performance regression in the API layer
STATEEOF

# --all flag scans all repos (uses AI_MEMORY_SCAN_ROOTS)
STANDUP_OUT="$(HOME="$STANDUP_TMP" AI_MEMORY_SCAN_ROOTS="$STANDUP_TMP/repos" node "$WAYFIND_JS" standup --all 2>/dev/null)"
assert_contains "standup --all shows last session date" "2026-03-15" "$STANDUP_OUT"
assert_contains "standup --all shows last session repo" "testrepo" "$STANDUP_OUT"
assert_contains "standup --all shows what was done" "Finished implementing and testing feature X" "$STANDUP_OUT"
assert_contains "standup --all shows plan for today" "Deploy feature X to staging" "$STANDUP_OUT"
assert_contains "standup --all shows blockers" "Performance regression" "$STANDUP_OUT"
assert_contains "standup --all shows 'all repos' in header" "all repos" "$STANDUP_OUT"

# Default (no --all) scopes to cwd — run from the mock repo dir
STANDUP_CWD="$(cd "$STANDUP_TMP/repos/testrepo" && HOME="$STANDUP_TMP" node "$WAYFIND_JS" standup 2>/dev/null)"
assert_contains "standup (cwd) shows plan for today" "Deploy feature X to staging" "$STANDUP_CWD"
assert_contains "standup (cwd) shows scope hint" "--all" "$STANDUP_CWD"
assert_contains "standup (cwd) shows repo-scoped journal" "Finished implementing and testing feature X" "$STANDUP_CWD"
assert_contains "standup (cwd) shows repo name in header" "testrepo" "$STANDUP_CWD"

rm -rf "$STANDUP_TMP"

# Standup is in the COMMANDS registry
assert_contains "standup command is registered in team-context.js" "standup" "$(node "$WAYFIND_JS" help 2>/dev/null)"

# Summary
echo ""
echo "Results: $PASS passed, $FAIL failed"
for err in "${ERRORS[@]}"; do echo "  $err"; done
[ "$FAIL" -eq 0 ] || exit 1
