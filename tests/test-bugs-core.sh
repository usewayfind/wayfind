#!/usr/bin/env bash
# Tests for bugs-core fixes: #1, #2, #5, #6
set -euo pipefail

PASS=0; FAIL=0; ERRORS=()

assert_eq() { local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then PASS=$((PASS+1)); echo "  ✓ $desc"
  else FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — expected '$expected', got '$actual'"); echo "  ✗ $desc"; fi
}

assert_contains() { local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then PASS=$((PASS+1)); echo "  ✓ $desc"
  else FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — '$needle' not found"); echo "  ✗ $desc"; fi
}

assert_file_exists() { local desc="$1" file="$2"
  if [ -f "$file" ]; then PASS=$((PASS+1)); echo "  ✓ $desc"
  else FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — file not found: $file"); echo "  ✗ $desc"; fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Test #6: .gitattributes exists
echo ""
echo "Issue #6: .gitattributes"
assert_file_exists ".gitattributes exists" "$SCRIPT_DIR/.gitattributes"
if [ -f "$SCRIPT_DIR/.gitattributes" ]; then
  assert_contains ".gitattributes has *.sh eol=lf" "*.sh" "$(cat "$SCRIPT_DIR/.gitattributes")"
fi

# Test #5: argument parsing
echo ""
echo "Issue #5: --tool argument parsing"
# Test --tool=claude-code (= form)
OUT=$(bash "$SCRIPT_DIR/setup.sh" --tool=claude-code --dry-run 2>&1 || true)
assert_contains "--tool=value form works" "claude-code" "$OUT"

# Test --tool claude-code (space form)
OUT=$(bash "$SCRIPT_DIR/setup.sh" --tool claude-code --dry-run 2>&1 || true)
assert_contains "--tool value form works" "claude-code" "$OUT"

# Behavioral test — capture output and verify no interactive prompt
echo ""
echo "Issue #5: --tool space form behavioral"
OUT=$(echo "" | bash "$SCRIPT_DIR/setup.sh" --tool claude-code --dry-run 2>&1 || true)
assert_contains "--tool space form outputs claude-code (not prompt)" "claude-code" "$OUT"

# Test #1: sed substitution eliminates all .ai-memory references
echo ""
echo "Issue #1: sed substitution coverage"
TEMPLATE="$SCRIPT_DIR/templates/global.md"
RESULT=$(sed \
    -e 's|~/.ai-memory/|~/.claude/|g' \
    -e 's|\.ai-memory/state\.md|.claude/state.md|g' \
    "$TEMPLATE")
REMAINING=$(echo "$RESULT" | grep -c "ai-memory" 2>/dev/null || true)
REMAINING="${REMAINING:-0}"
assert_eq "no .ai-memory references remain after sed" "0" "$REMAINING"

# Test #2: setup.sh has Python merge logic for settings.json with error handling
echo ""
echo "Issue #2: settings.json merge"
assert_contains "setup.sh has python3 merge" "python3" "$(cat "$SCRIPT_DIR/setup.sh")"
assert_contains "setup.sh has setdefault" "setdefault" "$(cat "$SCRIPT_DIR/setup.sh")"
assert_contains "setup.sh has atomic temp file write" "TMP_SETTINGS" "$(cat "$SCRIPT_DIR/setup.sh")"
assert_contains "setup.sh has fallback warn on failure" "Could not auto-merge" "$(cat "$SCRIPT_DIR/setup.sh")"

# Summary
echo ""
echo "Results: $PASS passed, $FAIL failed"
for err in "${ERRORS[@]}"; do echo "  $err"; done
[ "$FAIL" -eq 0 ] || exit 1
