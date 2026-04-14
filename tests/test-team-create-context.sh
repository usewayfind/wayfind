#!/usr/bin/env bash
# Tests for issue #185: wayfind team create must write context.json
# Asserts that after `wayfind team create`, context.json is written with
# the correct structure: teams.<id>.{path, name, configured_at} and default.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/.." && pwd)"

PASS=0
FAIL=0
ERRORS=()

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
RESET='\033[0m'

_pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${RESET} $1"; }
_fail() { FAIL=$((FAIL + 1)); ERRORS+=("$1: $2"); echo -e "  ${RED}FAIL${RESET} $1"; echo -e "       ${YELLOW}$2${RESET}"; }

# Setup temp home
ORIG_HOME="$HOME"
TEST_HOME=$(mktemp -d)
export HOME="$TEST_HOME"
cleanup() { export HOME="$ORIG_HOME"; rm -rf "$TEST_HOME"; }
trap cleanup EXIT

WAYFIND_DIR="$TEST_HOME/.claude/team-context"
CONTEXT_CONFIG="$WAYFIND_DIR/context.json"

mkdir -p "$WAYFIND_DIR"

# Enable simulation mode so team-context.js doesn't need real services
export TEAM_CONTEXT_SIMULATE=1

echo ""
echo "=== Issue #185: team create writes context.json ==="
echo ""

# ── Test 1: context.json is created after team create ────────────────────────

echo "--- team create writes context.json ---"

# Run team create with simulated input (team name via stdin)
CREATE_OUTPUT=$(echo "Test Team" | "$REPO_ROOT/bin/team-context.js" team create 2>&1) && CREATE_EXIT=0 || CREATE_EXIT=$?

if [[ "$CREATE_EXIT" -eq 0 ]]; then
  _pass "1. team create exits 0"
else
  _fail "1. team create exits 0" "Exited $CREATE_EXIT. Output: $CREATE_OUTPUT"
fi

if [[ -f "$CONTEXT_CONFIG" ]]; then
  _pass "2. context.json exists after team create"
else
  _fail "2. context.json exists after team create" "File not found: $CONTEXT_CONFIG"
fi

# ── Test 2: context.json has correct structure ────────────────────────────────

echo "--- context.json structure ---"

if [[ -f "$CONTEXT_CONFIG" ]]; then
  # Verify teams key exists and has exactly one entry
  TEAM_COUNT=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$CONTEXT_CONFIG', 'utf8'));
    console.log(d.teams ? Object.keys(d.teams).length : 0);
  " 2>/dev/null)

  if [[ "$TEAM_COUNT" == "1" ]]; then
    _pass "3. context.json has exactly one team entry"
  else
    _fail "3. context.json has exactly one team entry" "Expected 1 team, got $TEAM_COUNT"
  fi

  # Verify default is set
  HAS_DEFAULT=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$CONTEXT_CONFIG', 'utf8'));
    console.log(d.default ? 'yes' : 'no');
  " 2>/dev/null)

  if [[ "$HAS_DEFAULT" == "yes" ]]; then
    _pass "4. context.json has 'default' field set"
  else
    _fail "4. context.json has 'default' field set" "Missing 'default' field"
  fi

  # Verify the team entry has required fields: path, name, configured_at
  FIELDS_OK=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$CONTEXT_CONFIG', 'utf8'));
    const teamId = Object.keys(d.teams)[0];
    const team = d.teams[teamId];
    const hasPath = typeof team.path === 'string' && team.path.length > 0;
    const hasName = typeof team.name === 'string' && team.name.length > 0;
    const hasConfiguredAt = typeof team.configured_at === 'string' && team.configured_at.length > 0;
    console.log(hasPath && hasName && hasConfiguredAt ? 'ok' : 'missing');
  " 2>/dev/null)

  if [[ "$FIELDS_OK" == "ok" ]]; then
    _pass "5. Team entry has path, name, and configured_at fields"
  else
    _fail "5. Team entry has path, name, and configured_at fields" "One or more required fields missing"
  fi

  # Verify path is the WAYFIND_DIR (local path, not a remote repo)
  PATH_VALUE=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$CONTEXT_CONFIG', 'utf8'));
    const teamId = Object.keys(d.teams)[0];
    console.log(d.teams[teamId].path);
  " 2>/dev/null)

  # Path should contain the expected wayfind dir segment
  if echo "$PATH_VALUE" | grep -q "team-context"; then
    _pass "6. Team entry path points to team-context directory"
  else
    _fail "6. Team entry path points to team-context directory" "Expected path containing 'team-context', got: $PATH_VALUE"
  fi

  # Verify default matches the team ID in teams
  DEFAULT_MATCHES=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$CONTEXT_CONFIG', 'utf8'));
    const teamId = Object.keys(d.teams)[0];
    console.log(d.default === teamId ? 'yes' : 'no');
  " 2>/dev/null)

  if [[ "$DEFAULT_MATCHES" == "yes" ]]; then
    _pass "7. context.json 'default' matches the team ID in teams"
  else
    _fail "7. context.json 'default' matches the team ID in teams" "default does not match team ID"
  fi

  # Verify team name matches what was provided
  NAME_VALUE=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$CONTEXT_CONFIG', 'utf8'));
    const teamId = Object.keys(d.teams)[0];
    console.log(d.teams[teamId].name);
  " 2>/dev/null)

  if [[ "$NAME_VALUE" == "Test Team" ]]; then
    _pass "8. Team entry name matches the name provided to team create"
  else
    _fail "8. Team entry name matches the name provided to team create" "Expected 'Test Team', got '$NAME_VALUE'"
  fi
else
  # context.json missing — fail remaining structure tests
  _fail "3. context.json has exactly one team entry" "context.json not found — cannot check structure"
  _fail "4. context.json has 'default' field set" "context.json not found"
  _fail "5. Team entry has path, name, and configured_at fields" "context.json not found"
  _fail "6. Team entry path points to team-context directory" "context.json not found"
  _fail "7. context.json 'default' matches the team ID in teams" "context.json not found"
  _fail "8. Team entry name matches the name provided to team create" "context.json not found"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo -e "  ${GREEN}Passed: $PASS${RESET}"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Failed: $FAIL${RESET}"
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}x${RESET} $err"
  done
  exit 1
else
  echo -e "  Failed: 0"
  echo ""
  echo "All team-create context.json tests passed."
fi
