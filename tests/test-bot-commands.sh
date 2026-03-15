#!/usr/bin/env bash
# Tests for Slack bot direct commands (help, members, version, insights, etc.)
# These commands run without LLM synthesis — pure data lookups.
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

# Create journal fixtures for insights
JOURNAL_DIR="$TEST_HOME/.claude/memory/journal"
STORE_DIR="$TEST_HOME/.claude/team-context/content-store"
mkdir -p "$JOURNAL_DIR" "$STORE_DIR"

cat > "$JOURNAL_DIR/2026-03-10.md" << 'EOF'
## Wayfind — Bot commands implementation
**Why:** Add CLI parity to the Slack bot
**What:** Implemented direct commands: help, members, version, insights
**Outcome:** Bot can now answer team queries without LLM
**On track?:** Yes
**Lessons:** Keep bot commands simple and fast
EOF

# Index journals so insights have data
node -e "
const cs = require('$REPO_ROOT/bin/content-store');
cs.indexJournals({ journalDir: '$JOURNAL_DIR', storePath: '$STORE_DIR', noEmbeddings: true })
  .then(r => console.log('Indexed:', r.entryCount, 'entries'));
"

# Create team-context with members
TEAM_DIR="$TEST_HOME/team-context"
MEMBERS_DIR="$TEAM_DIR/members"
mkdir -p "$MEMBERS_DIR"

cat > "$MEMBERS_DIR/greg.json" << 'EOF'
{
  "name": "Greg Leizerowicz",
  "wayfind_version": "1.8.29",
  "last_active": "2026-03-13T10:00:00Z",
  "personas": ["engineering", "product"],
  "slack_id": "U060N14JE4Q"
}
EOF

cat > "$MEMBERS_DIR/nick.json" << 'EOF'
{
  "name": "Nick Weber",
  "wayfind_version": "1.8.27",
  "last_active": "2026-03-12T15:00:00Z",
  "personas": ["engineering"]
}
EOF

export TEAM_CONTEXT_TEAM_CONTEXT_DIR="$TEAM_DIR"

# Create signal channel fixtures
SIGNALS_DIR="$TEST_HOME/.claude/team-context/signals"
mkdir -p "$SIGNALS_DIR/github" "$SIGNALS_DIR/intercom"
echo "# GitHub signals" > "$SIGNALS_DIR/github/2026-03-10.md"
echo "# Intercom signals" > "$SIGNALS_DIR/intercom/2026-03-10.md"
export TEAM_CONTEXT_SIGNALS_DIR="$SIGNALS_DIR"

echo ""
echo "Bot Direct Commands"
echo "==================="
echo ""

# ── Test handleDirectCommand via Node ─────────────────────────────────────

run_command() {
  local query="$1"
  node -e "
    const bot = require('$REPO_ROOT/bin/slack-bot');
    const config = { store_path: '$STORE_DIR', team_context_dir: '$TEAM_DIR' };
    const result = bot.handleDirectCommand('$query', config);
    if (result === null) {
      console.log('__NULL__');
    } else {
      console.log(result);
    }
  " 2>/dev/null
}

# help
echo "Phase 1: Help command"

RESULT=$(run_command "help")
if echo "$RESULT" | grep -q "Wayfind Bot"; then
  _pass "help returns bot help text"
else
  _fail "help returns bot help text" "Got: $RESULT"
fi

RESULT=$(run_command "?")
if echo "$RESULT" | grep -q "Commands"; then
  _pass "? is an alias for help"
else
  _fail "? is an alias for help" "Got: $RESULT"
fi

RESULT=$(run_command "commands")
if echo "$RESULT" | grep -q "members"; then
  _pass "commands lists available commands"
else
  _fail "commands lists available commands" "Got: $RESULT"
fi

# version
echo ""
echo "Phase 2: Version command"

RESULT=$(run_command "version")
if echo "$RESULT" | grep -q "Wayfind v"; then
  _pass "version returns version string"
else
  _fail "version returns version string" "Got: $RESULT"
fi

# members
echo ""
echo "Phase 3: Members command"

RESULT=$(run_command "members")
if echo "$RESULT" | grep -q "Greg Leizerowicz"; then
  _pass "members shows Greg"
else
  _fail "members shows Greg" "Got: $RESULT"
fi

if echo "$RESULT" | grep -q "Nick Weber"; then
  _pass "members shows Nick"
else
  _fail "members shows Nick" "Got: $RESULT"
fi

if echo "$RESULT" | grep -q "v1.8.29"; then
  _pass "members shows Greg's version"
else
  _fail "members shows Greg's version" "Got: $RESULT"
fi

if echo "$RESULT" | grep -q "v1.8.27"; then
  _pass "members shows Nick's version"
else
  _fail "members shows Nick's version" "Got: $RESULT"
fi

RESULT=$(run_command "team members")
if echo "$RESULT" | grep -q "Team Members"; then
  _pass "team members alias works"
else
  _fail "team members alias works" "Got: $RESULT"
fi

# Natural language version queries should route to members
RESULT=$(run_command "what version is Nick on")
if echo "$RESULT" | grep -q "Nick Weber"; then
  _pass "what version is Nick on routes to members"
else
  _fail "what version is Nick on routes to members" "Got: $RESULT"
fi

# insights
echo ""
echo "Phase 4: Insights command"

RESULT=$(run_command "insights")
if echo "$RESULT" | grep -q "Journal Insights"; then
  _pass "insights returns insights header"
else
  _fail "insights returns insights header" "Got: $RESULT"
fi

if echo "$RESULT" | grep -q "Total sessions"; then
  _pass "insights shows session count"
else
  _fail "insights shows session count" "Got: $RESULT"
fi

# digest scores (no feedback data, should say so)
echo ""
echo "Phase 5: Digest scores command"

RESULT=$(run_command "digest scores")
if echo "$RESULT" | grep -q "No digest feedback\|Digest Feedback"; then
  _pass "digest scores returns feedback or no-data message"
else
  _fail "digest scores returns feedback or no-data message" "Got: $RESULT"
fi

RESULT=$(run_command "scores")
if echo "$RESULT" | grep -q "No digest feedback\|Digest Feedback"; then
  _pass "scores shorthand works"
else
  _fail "scores shorthand works" "Got: $RESULT"
fi

# signals
echo ""
echo "Phase 6: Signals command"

RESULT=$(run_command "signals")
if echo "$RESULT" | grep -q "Signal Channels"; then
  _pass "signals returns channel list"
else
  _fail "signals returns channel list" "Got: $RESULT"
fi

if echo "$RESULT" | grep -q "github"; then
  _pass "signals shows github channel"
else
  _fail "signals shows github channel" "Got: $RESULT"
fi

if echo "$RESULT" | grep -q "intercom"; then
  _pass "signals shows intercom channel"
else
  _fail "signals shows intercom channel" "Got: $RESULT"
fi

# Non-commands should return null (fall through to LLM)
echo ""
echo "Phase 7: Non-commands fall through"

RESULT=$(run_command "what did the team work on yesterday")
if [ "$RESULT" = "__NULL__" ]; then
  _pass "regular query returns null (falls through)"
else
  _fail "regular query returns null (falls through)" "Got: $RESULT"
fi

RESULT=$(run_command "tell me about the architecture decisions")
if [ "$RESULT" = "__NULL__" ]; then
  _pass "decision trail query returns null (falls through)"
else
  _fail "decision trail query returns null (falls through)" "Got: $RESULT"
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
