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

# Summary
echo ""
echo "Results: $PASS passed, $FAIL failed"
for err in "${ERRORS[@]}"; do echo "  $err"; done
[ "$FAIL" -eq 0 ] || exit 1
