#!/usr/bin/env bash
# Tests for Slack bot module loading and basic exports.
# Direct command tests removed — the bot now uses LLM tool-use relay
# for all queries (no hand-rolled command router).
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

export TEAM_CONTEXT_SIMULATE=1

mkdir -p "$TEST_HOME/.claude/team-context/content-store"

echo ""
echo "Bot Module Exports"
echo "==================="
echo ""

# Test: module loads without error
LOAD_TEST=$(node -e "
  const bot = require('$REPO_ROOT/bin/slack-bot');
  console.log('LOADED');
  console.log('configure:' + typeof bot.configure);
  console.log('start:' + typeof bot.start);
  console.log('handleQuery:' + typeof bot.handleQuery);
  console.log('extractQuery:' + typeof bot.extractQuery);
  console.log('chunkMessage:' + typeof bot.chunkMessage);
  console.log('fetchThreadHistory:' + typeof bot.fetchThreadHistory);
  console.log('getConnectionStatus:' + typeof bot.getConnectionStatus);
" 2>&1)

if echo "$LOAD_TEST" | grep -q "LOADED"; then
  _pass "module loads without error"
else
  _fail "module loads without error" "Got: $LOAD_TEST"
fi

if echo "$LOAD_TEST" | grep -q "configure:function"; then
  _pass "exports configure()"
else
  _fail "exports configure()" "Got: $LOAD_TEST"
fi

if echo "$LOAD_TEST" | grep -q "start:function"; then
  _pass "exports start()"
else
  _fail "exports start()" "Got: $LOAD_TEST"
fi

if echo "$LOAD_TEST" | grep -q "handleQuery:function"; then
  _pass "exports handleQuery()"
else
  _fail "exports handleQuery()" "Got: $LOAD_TEST"
fi

if echo "$LOAD_TEST" | grep -q "extractQuery:function"; then
  _pass "exports extractQuery()"
else
  _fail "exports extractQuery()" "Got: $LOAD_TEST"
fi

if echo "$LOAD_TEST" | grep -q "chunkMessage:function"; then
  _pass "exports chunkMessage()"
else
  _fail "exports chunkMessage()" "Got: $LOAD_TEST"
fi

if echo "$LOAD_TEST" | grep -q "fetchThreadHistory:function"; then
  _pass "exports fetchThreadHistory()"
else
  _fail "exports fetchThreadHistory()" "Got: $LOAD_TEST"
fi

# Test: extractQuery strips bot mention
EXTRACT_TEST=$(node -e "
  const bot = require('$REPO_ROOT/bin/slack-bot');
  const r1 = bot.extractQuery('<@U123> what happened today', 'U123');
  console.log('R1:' + r1);
  const r2 = bot.extractQuery('@wayfind show me insights', null);
  console.log('R2:' + r2);
  const r3 = bot.extractQuery('<@U999> <@U123> hello', 'U123');
  console.log('R3:' + r3);
" 2>&1)

if echo "$EXTRACT_TEST" | grep -q "R1:what happened today"; then
  _pass "extractQuery strips bot mention"
else
  _fail "extractQuery strips bot mention" "Got: $EXTRACT_TEST"
fi

if echo "$EXTRACT_TEST" | grep -q "R2:show me insights"; then
  _pass "extractQuery strips @wayfind prefix"
else
  _fail "extractQuery strips @wayfind prefix" "Got: $EXTRACT_TEST"
fi

# Test: chunkMessage splits long text
CHUNK_TEST=$(node -e "
  const bot = require('$REPO_ROOT/bin/slack-bot');
  const short = bot.chunkMessage('hello', 100);
  console.log('SHORT:' + short.length);
  const long = bot.chunkMessage('a'.repeat(500), 100);
  console.log('LONG:' + long.length);
" 2>&1)

if echo "$CHUNK_TEST" | grep -q "SHORT:1"; then
  _pass "chunkMessage returns 1 chunk for short text"
else
  _fail "chunkMessage returns 1 chunk for short text" "Got: $CHUNK_TEST"
fi

if echo "$CHUNK_TEST" | grep -q "LONG:5"; then
  _pass "chunkMessage splits long text into multiple chunks"
else
  _fail "chunkMessage splits long text into multiple chunks" "Got: $CHUNK_TEST"
fi

echo ""
echo "================================"
echo -e "  Results: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET}"
echo "================================"

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}✗${RESET} $err"
  done
  exit 1
fi
