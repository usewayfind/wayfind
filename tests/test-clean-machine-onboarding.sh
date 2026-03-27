#!/usr/bin/env bash
# Test #113: Clean-machine onboarding simulation
#
# Simulates what happens when a new team member runs wayfind for the first
# time with no prior state. Uses a temp HOME to isolate from the dev env.
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

assert_not_contains() { local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — '$needle' should not be present"); echo "  ✗ $desc"
  else PASS=$((PASS+1)); echo "  ✓ $desc"; fi
}

assert_file_exists() { local desc="$1" file="$2"
  if [ -f "$file" ]; then PASS=$((PASS+1)); echo "  ✓ $desc"
  else FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — file not found: $file"); echo "  ✗ $desc"; fi
}

assert_dir_exists() { local desc="$1" dir="$2"
  if [ -d "$dir" ]; then PASS=$((PASS+1)); echo "  ✓ $desc"
  else FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — directory not found: $dir"); echo "  ✗ $desc"; fi
}

assert_exit_zero() { local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS+1)); echo "  ✓ $desc"
  else FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — command exited non-zero"); echo "  ✗ $desc"; fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WAYFIND="node $SCRIPT_DIR/bin/team-context.js"

# Create isolated HOME — simulates a clean machine
CLEAN_HOME=$(mktemp -d)
trap 'rm -rf "$CLEAN_HOME"' EXIT
export HOME="$CLEAN_HOME"

# Minimal git config (a real new machine would have this after git install)
git config --global user.email "test@example.com"
git config --global user.name "Test User"

# Create a fake git repo to run init against
FAKE_REPO=$(mktemp -d)
trap 'rm -rf "$CLEAN_HOME" "$FAKE_REPO"' EXIT
git init "$FAKE_REPO" --quiet
git -C "$FAKE_REPO" commit --allow-empty -m "init" --quiet

# ── Phase 1: Pre-install state ──────────────────────────────────────────────

echo ""
echo "Phase 1: Pre-install state (clean HOME)"

# Verify no prior state exists
assert_eq "No .claude dir exists" "false" "$([ -d "$CLEAN_HOME/.claude" ] && echo true || echo false)"

# ── Phase 2: wayfind version (no setup required) ────────────────────────────

echo ""
echo "Phase 2: Basic CLI works without setup"

OUT=$($WAYFIND version 2>&1 || true)
assert_contains "version command works" "." "$OUT"
assert_not_contains "version doesn't error" "Error" "$OUT"

OUT=$($WAYFIND help 2>&1 || true)
assert_contains "help command works" "wayfind" "$OUT"

# ── Phase 3: wayfind init (Claude Code) ─────────────────────────────────────

echo ""
echo "Phase 3: wayfind init --tool claude-code"

OUT=$(bash "$SCRIPT_DIR/setup.sh" --tool claude-code --dry-run 2>&1 || true)
assert_contains "init dry-run completes" "claude-code" "$OUT"
assert_not_contains "init doesn't crash" "Cannot find module" "$OUT"
assert_not_contains "init doesn't crash" "ENOENT" "$OUT"

# Run actual init (non-dry-run)
OUT=$(bash "$SCRIPT_DIR/setup.sh" --tool claude-code 2>&1 || true)
assert_dir_exists "~/.claude created" "$CLEAN_HOME/.claude"

# ── Phase 4: Post-init file structure ────────────────────────────────────────

echo ""
echo "Phase 4: Post-init file structure"

# Plugin hooks should be installed
if [ -d "$CLEAN_HOME/.claude/plugins" ] || [ -f "$CLEAN_HOME/.claude/hooks.json" ]; then
  PASS=$((PASS+1)); echo "  ✓ Plugin or hooks installed"
else
  # Check for legacy hook location
  if [ -d "$CLEAN_HOME/.claude/hooks" ]; then
    PASS=$((PASS+1)); echo "  ✓ Legacy hooks installed"
  else
    FAIL=$((FAIL+1)); ERRORS+=("FAIL: No hooks or plugin found after init"); echo "  ✗ Hooks or plugin installed"
  fi
fi

# ── Phase 5: wayfind doctor (should pass on fresh install) ───────────────────

echo ""
echo "Phase 5: Doctor on fresh install"

OUT=$($WAYFIND doctor 2>&1 || true)
assert_contains "doctor runs without crash" "Doctor" "$OUT"
# Doctor should NOT report catastrophic failures on a fresh install
assert_not_contains "doctor no ENOENT" "ENOENT" "$OUT"
assert_not_contains "doctor no Cannot find module" "Cannot find module" "$OUT"
assert_not_contains "doctor no stack trace" "at Object" "$OUT"

# ── Phase 6: Content store works without prior data ──────────────────────────

echo ""
echo "Phase 6: Content store on empty state"

OUT=$($WAYFIND insights 2>&1 || true)
assert_not_contains "insights doesn't crash on empty" "Error" "$OUT"
assert_not_contains "insights doesn't crash on empty" "ENOENT" "$OUT"

OUT=$($WAYFIND search-journals "test query" --text 2>&1 || true)
assert_not_contains "search doesn't crash on empty" "Cannot find module" "$OUT"

# ── Phase 7: Journal operations on empty state ───────────────────────────────

echo ""
echo "Phase 7: Journal commands on empty state"

# journal summary should handle no journals gracefully
OUT=$($WAYFIND journal 2>&1 || true)
assert_not_contains "journal doesn't crash on empty" "ENOENT" "$OUT"
assert_not_contains "journal doesn't crash on empty" "Cannot read" "$OUT"

# standup should handle no state files gracefully
OUT=$($WAYFIND standup 2>&1 || true)
assert_not_contains "standup doesn't crash on empty" "ENOENT" "$OUT"

# ── Phase 8: Digest without API key ─────────────────────────────────────────

echo ""
echo "Phase 8: Digest without API key"

# Unset any API key that might leak from parent env
unset ANTHROPIC_API_KEY 2>/dev/null || true
OUT=$($WAYFIND digest 2>&1 || true)
# Should fail gracefully, not crash
assert_not_contains "digest without key doesn't crash" "Cannot find module" "$OUT"
assert_not_contains "digest without key doesn't crash" "stack trace" "$OUT"

# ── Phase 9: Init in a git repo (simulating team member joining) ─────────────

echo ""
echo "Phase 9: Init-memory in a repo context"

# Simulate what /init-memory does — create state files in a repo
mkdir -p "$FAKE_REPO/.claude"
OUT=$(cd "$FAKE_REPO" && $WAYFIND doctor 2>&1 || true)
assert_not_contains "doctor works in repo context" "ENOENT" "$OUT"

# ── Results ──────────────────────────────────────────────────────────────────

echo ""
echo "================================"
if [ ${#ERRORS[@]} -gt 0 ]; then
  for err in "${ERRORS[@]}"; do echo "  $err"; done
fi
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "================================"

[ "$FAIL" -eq 0 ] || exit 1
