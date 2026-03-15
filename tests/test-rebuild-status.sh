#!/usr/bin/env bash
# Tests for rebuild-status module (bin/rebuild-status.js)
# Covers: state file scanning, header-variant parsing, table generation,
#         global-state.md splicing, idempotency, edge cases.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/.." && pwd)"

PASS=0
FAIL=0
ERRORS=()

# Colors
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

# Create fixture repos with various header styles
REPOS_ROOT="$TEST_HOME/repos"
mkdir -p "$REPOS_ROOT/org/alpha/.claude"
mkdir -p "$REPOS_ROOT/org/beta/.claude"
mkdir -p "$REPOS_ROOT/org/gamma/.claude"
mkdir -p "$REPOS_ROOT/greg/delta/.claude"
mkdir -p "$REPOS_ROOT/greg/epsilon/.claude"

# alpha: "Current Status" + "What's Next" (most common pattern)
cat > "$REPOS_ROOT/org/alpha/.claude/state.md" << 'EOF'
# Alpha — Project State

Last updated: 2026-03-01

## Current Status
Function App LIVE, **25 gold tables**. MonthlyRefresh ran 3/1.

## What's Next
1. Deploy extraction pipeline
2. Remove scale-out=1
EOF

# beta: "Current State" + "What's Next" (analytics-infra style)
cat > "$REPOS_ROOT/org/beta/.claude/state.md" << 'EOF'
# Beta — Repo State

Last updated: 2026-02-28

## Current State
- **Function App deployed** to production
- Change feed triggers running (all confirmed)

## What's Next
1. Add DiskANN index
EOF

# gamma: team-state.md with "Current Sprint Focus" (Wayfind style)
cat > "$REPOS_ROOT/org/gamma/.claude/team-state.md" << 'EOF'
# Gamma — Team State

Last updated: 2026-03-02

## Architecture & Key Decisions
Plain markdown files, no database.

## Current Sprint Focus
v1.3.0 released. GitHub signal connector, digest engine shipped.

## Shared Gotchas
Worktree paths get deeply nested.
EOF

# delta: "Current Focus" + "Next Session"
cat > "$REPOS_ROOT/greg/delta/.claude/state.md" << 'EOF'
# Delta

Last updated: 2026-02-25

## Current Focus
6-month content plan COMPLETE. Newsletter outlined.

## Next Session
1. Write Issue #1
2. Register Beehiiv
EOF

# epsilon: personal-state.md exists alongside team-state.md
cat > "$REPOS_ROOT/greg/epsilon/.claude/team-state.md" << 'EOF'
# Epsilon — Team State

Last updated: 2026-03-02

## Current Status
v1.4.0 content store + dogfood live.

## What's Next
Run first wayfind digest. Set up Monday cron.
EOF

cat > "$REPOS_ROOT/greg/epsilon/.claude/personal-state.md" << 'EOF'
# Epsilon — Personal State

Last updated: 2026-03-02

## My Current Focus
Digest quality tuning.
EOF

# Create a global-state.md fixture
mkdir -p "$TEST_HOME/.claude"
cat > "$TEST_HOME/.claude/global-state.md" << 'EOF'
# Global State — Index

Last updated: 2026-02-28

## Preferences
- Greg prefers parallel execution

## Active Projects

| Project | Repo | Status | Next |
|---------|------|--------|------|
| Old Project | ~/repos/old | Old status | Old next |

## Memory Files (load on demand)

| File | When to load | Summary |
|------|-------------|---------|
| `example.md` | example keywords | Example summary |

## Session Protocol

**Start:**
1. Read this file
EOF

# ── 1. scanStateFiles ─────────────────────────────────────────────────────

echo ""
echo "1. scanStateFiles"
echo "─────────────────"

RESULT=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const files = rs.scanStateFiles(['$REPOS_ROOT']);
console.log(JSON.stringify(files.map(f => ({
  repo: f.repoDir.replace('$TEST_HOME', '~'),
  file: require('path').basename(f.stateFile),
  hasPersonal: !!f.personalStateFile
}))));
")

COUNT=$(echo "$RESULT" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).length)")
if [ "$COUNT" -eq 5 ]; then
  _pass "Found all 5 repos"
else
  _fail "Found all 5 repos" "Expected 5, got $COUNT"
fi

# Check that gamma uses team-state.md (preferred over state.md)
GAMMA_FILE=$(echo "$RESULT" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const g = d.find(f => f.repo.includes('gamma'));
console.log(g ? g.file : 'not found');
")
if [ "$GAMMA_FILE" = "team-state.md" ]; then
  _pass "Prefers team-state.md over state.md"
else
  _fail "Prefers team-state.md over state.md" "Got: $GAMMA_FILE"
fi

# Check personal state detection
EPSILON_PERSONAL=$(echo "$RESULT" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const e = d.find(f => f.repo.includes('epsilon'));
console.log(e ? e.hasPersonal : 'not found');
")
if [ "$EPSILON_PERSONAL" = "true" ]; then
  _pass "Detects personal-state.md"
else
  _fail "Detects personal-state.md" "Got: $EPSILON_PERSONAL"
fi

# ── 2. parseStateFile — header variants ───────────────────────────────────

echo ""
echo "2. parseStateFile — header variants"
echo "────────────────────────────────────"

# Alpha: Current Status
ALPHA=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('$REPOS_ROOT/org/alpha/.claude/state.md');
console.log(JSON.stringify(r));
")

ALPHA_PROJECT=$(echo "$ALPHA" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).project)")
if [ "$ALPHA_PROJECT" = "Alpha" ]; then
  _pass "Parses project name from H1 (before dash)"
else
  _fail "Parses project name from H1 (before dash)" "Got: $ALPHA_PROJECT"
fi

ALPHA_STATUS=$(echo "$ALPHA" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status)")
if echo "$ALPHA_STATUS" | grep -q "Function App LIVE"; then
  _pass "Parses 'Current Status' header"
else
  _fail "Parses 'Current Status' header" "Got: $ALPHA_STATUS"
fi

ALPHA_NEXT=$(echo "$ALPHA" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).next)")
if echo "$ALPHA_NEXT" | grep -q "Deploy extraction"; then
  _pass "Parses 'What's Next' header"
else
  _fail "Parses 'What's Next' header" "Got: $ALPHA_NEXT"
fi

ALPHA_UPDATED=$(echo "$ALPHA" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).updated)")
if [ "$ALPHA_UPDATED" = "2026-03-01" ]; then
  _pass "Extracts 'Last updated' date"
else
  _fail "Extracts 'Last updated' date" "Got: $ALPHA_UPDATED"
fi

# Beta: Current State
BETA_STATUS=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('$REPOS_ROOT/org/beta/.claude/state.md');
console.log(r.status);
")
if echo "$BETA_STATUS" | grep -q "Function App deployed"; then
  _pass "Parses 'Current State' header"
else
  _fail "Parses 'Current State' header" "Got: $BETA_STATUS"
fi

# Gamma: Current Sprint Focus
GAMMA_STATUS=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('$REPOS_ROOT/org/gamma/.claude/team-state.md');
console.log(r.status);
")
if echo "$GAMMA_STATUS" | grep -q "v1.3.0 released"; then
  _pass "Parses 'Current Sprint Focus' header"
else
  _fail "Parses 'Current Sprint Focus' header" "Got: $GAMMA_STATUS"
fi

# Delta: Current Focus + Next Session
DELTA=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('$REPOS_ROOT/greg/delta/.claude/state.md');
console.log(JSON.stringify(r));
")

DELTA_STATUS=$(echo "$DELTA" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status)")
if echo "$DELTA_STATUS" | grep -q "content plan COMPLETE"; then
  _pass "Parses 'Current Focus' header"
else
  _fail "Parses 'Current Focus' header" "Got: $DELTA_STATUS"
fi

DELTA_NEXT=$(echo "$DELTA" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).next)")
if echo "$DELTA_NEXT" | grep -q "Write Issue"; then
  _pass "Parses 'Next Session' header"
else
  _fail "Parses 'Next Session' header" "Got: $DELTA_NEXT"
fi

# Delta: H1 without dash
DELTA_PROJECT=$(echo "$DELTA" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).project)")
if [ "$DELTA_PROJECT" = "Delta" ]; then
  _pass "Parses H1 without dash suffix"
else
  _fail "Parses H1 without dash suffix" "Got: $DELTA_PROJECT"
fi

# ── 3. parseStateFile — truncation ────────────────────────────────────────

echo ""
echo "3. parseStateFile — truncation"
echo "──────────────────────────────"

# Create a fixture with a very long status paragraph
mkdir -p "$REPOS_ROOT/org/longstatus/.claude"
cat > "$REPOS_ROOT/org/longstatus/.claude/state.md" << 'EOF'
# LongStatus — State

Last updated: 2026-03-01

## Current Status
This is a very long status paragraph that goes on and on and on about many things that happened during the sprint including deployments, bug fixes, performance improvements, and documentation updates that were completed.
EOF

LONG_STATUS=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('$REPOS_ROOT/org/longstatus/.claude/state.md');
console.log(r.status.length);
")
if [ "$LONG_STATUS" -le 120 ]; then
  _pass "Truncates status to <=120 chars"
else
  _fail "Truncates status to <=120 chars" "Got length: $LONG_STATUS"
fi

# ── 4. buildStatusTable ──────────────────────────────────────────────────

echo ""
echo "4. buildStatusTable"
echo "───────────────────"

TABLE=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const entries = [
  { project: 'Alpha', repo: '~/repos/org/alpha', updated: '2026-03-01', status: 'Live', next: 'Deploy' },
  { project: 'Beta', repo: '~/repos/org/beta', updated: '2026-02-28', status: 'Dev', next: 'Test' },
];
console.log(rs.buildStatusTable(entries));
")

# Check header row
if echo "$TABLE" | head -1 | grep -q "| Project | Repo | Updated | Status | Next |"; then
  _pass "Table has correct header"
else
  _fail "Table has correct header" "Got: $(echo "$TABLE" | head -1)"
fi

# Check separator row
if echo "$TABLE" | sed -n '2p' | grep -q "|---------|------|---------|--------|------|"; then
  _pass "Table has separator row"
else
  _fail "Table has separator row" "Got: $(echo "$TABLE" | sed -n '2p')"
fi

# Check sort order (most recent first)
FIRST_DATA=$(echo "$TABLE" | sed -n '3p')
if echo "$FIRST_DATA" | grep -q "Alpha"; then
  _pass "Sorts by date descending (most recent first)"
else
  _fail "Sorts by date descending" "First data row: $FIRST_DATA"
fi

# Check row count
ROW_COUNT=$(echo "$TABLE" | wc -l)
if [ "$ROW_COUNT" -eq 4 ]; then
  _pass "Table has header + separator + 2 data rows"
else
  _fail "Table has correct row count" "Expected 4 lines, got $ROW_COUNT"
fi

# ── 5. buildStatusTable — pipe escaping ──────────────────────────────────

echo ""
echo "5. buildStatusTable — pipe escaping"
echo "────────────────────────────────────"

TABLE_PIPE=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const entries = [
  { project: 'Test', repo: '~/repos/test', updated: '2026-03-01', status: 'A | B done', next: 'X | Y' },
];
console.log(rs.buildStatusTable(entries));
")

if echo "$TABLE_PIPE" | grep -qF 'A \| B done'; then
  _pass "Escapes pipe characters in status"
else
  _fail "Escapes pipe characters in status" "Got: $(echo "$TABLE_PIPE" | tail -1)"
fi

# ── 6. updateGlobalState — splice ────────────────────────────────────────

echo ""
echo "6. updateGlobalState — splice into global-state.md"
echo "───────────────────────────────────────────────────"

NEW_TABLE="| Project | Repo | Updated | Status | Next |
|---------|------|---------|--------|------|
| NewProj | ~/repos/new | 2026-03-02 | Active | Ship it |"

node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
rs.updateGlobalState('$TEST_HOME/.claude/global-state.md', \`$NEW_TABLE\`);
"

UPDATED=$(cat "$TEST_HOME/.claude/global-state.md")

# Preferences section preserved
if echo "$UPDATED" | grep -q "Greg prefers parallel execution"; then
  _pass "Preserves Preferences section"
else
  _fail "Preserves Preferences section" "Section missing"
fi

# Active Projects replaced
if echo "$UPDATED" | grep -q "NewProj"; then
  _pass "Inserts new Active Projects table"
else
  _fail "Inserts new Active Projects table" "NewProj not found"
fi

# Old data removed
if echo "$UPDATED" | grep -q "Old Project"; then
  _fail "Removes old Active Projects rows" "Old Project still present"
else
  _pass "Removes old Active Projects rows"
fi

# Memory Files section preserved
if echo "$UPDATED" | grep -q "Memory Files"; then
  _pass "Preserves Memory Files section"
else
  _fail "Preserves Memory Files section" "Section missing"
fi

# Session Protocol preserved
if echo "$UPDATED" | grep -q "Session Protocol"; then
  _pass "Preserves Session Protocol section"
else
  _fail "Preserves Session Protocol section" "Section missing"
fi

# AUTO-GENERATED comment added
if echo "$UPDATED" | grep -q "AUTO-GENERATED"; then
  _pass "Adds AUTO-GENERATED comment"
else
  _fail "Adds AUTO-GENERATED comment" "Comment missing"
fi

# Last updated date refreshed
TODAY=$(date +%Y-%m-%d)
if echo "$UPDATED" | grep -q "Last updated: $TODAY"; then
  _pass "Updates 'Last updated' date to today"
else
  _fail "Updates 'Last updated' date to today" "Date not updated to $TODAY"
fi

# ── 7. Idempotency ──────────────────────────────────────────────────────

echo ""
echo "7. Idempotency"
echo "──────────────"

# Run updateGlobalState twice with same data
node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
rs.updateGlobalState('$TEST_HOME/.claude/global-state.md', \`$NEW_TABLE\`);
"
FIRST=$(cat "$TEST_HOME/.claude/global-state.md")

node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
rs.updateGlobalState('$TEST_HOME/.claude/global-state.md', \`$NEW_TABLE\`);
"
SECOND=$(cat "$TEST_HOME/.claude/global-state.md")

if [ "$FIRST" = "$SECOND" ]; then
  _pass "Two consecutive runs produce identical output"
else
  _fail "Two consecutive runs produce identical output" "Files differ"
fi

# ── 8. CLI integration ──────────────────────────────────────────────────

echo ""
echo "8. CLI integration"
echo "──────────────────"

# wayfind status (default: print)
export AI_MEMORY_SCAN_ROOTS="$REPOS_ROOT"
CLI_OUTPUT=$(node "$REPO_ROOT/bin/team-context.js" status 2>&1 || true)
if echo "$CLI_OUTPUT" | grep -q "Cross-project status"; then
  _pass "wayfind status prints table"
else
  _fail "wayfind status prints table" "Output: $CLI_OUTPUT"
fi

# wayfind status --json
JSON_OUTPUT=$(node "$REPO_ROOT/bin/team-context.js" status --json 2>&1 || true)
if echo "$JSON_OUTPUT" | node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))" 2>/dev/null; then
  _pass "wayfind status --json returns valid JSON"
else
  _fail "wayfind status --json returns valid JSON" "Invalid JSON output"
fi

# wayfind status --write
node "$REPO_ROOT/bin/team-context.js" status --write 2>&1 || true
GLOBAL_AFTER=$(cat "$TEST_HOME/.claude/global-state.md")
if echo "$GLOBAL_AFTER" | grep -q "Alpha"; then
  _pass "wayfind status --write rebuilds Active Projects"
else
  _fail "wayfind status --write rebuilds Active Projects" "Alpha not found in global-state.md"
fi

# wayfind status --write --quiet (no output)
QUIET_OUTPUT=$(node "$REPO_ROOT/bin/team-context.js" status --write --quiet 2>&1 || true)
if [ -z "$QUIET_OUTPUT" ]; then
  _pass "wayfind status --write --quiet produces no output"
else
  _fail "wayfind status --write --quiet produces no output" "Got: $QUIET_OUTPUT"
fi

# ── 9. Edge cases ────────────────────────────────────────────────────────

echo ""
echo "9. Edge cases"
echo "─────────────"

# Empty file
mkdir -p "$REPOS_ROOT/org/empty/.claude"
echo "" > "$REPOS_ROOT/org/empty/.claude/state.md"
EMPTY_RESULT=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('$REPOS_ROOT/org/empty/.claude/state.md');
console.log(r === null ? 'null' : 'not null');
")
if [ "$EMPTY_RESULT" = "null" ]; then
  _pass "Returns null for empty state file"
else
  _fail "Returns null for empty state file" "Got: $EMPTY_RESULT"
fi

# Missing file
MISSING_RESULT=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('/nonexistent/path/state.md');
console.log(r === null ? 'null' : 'not null');
")
if [ "$MISSING_RESULT" = "null" ]; then
  _pass "Returns null for missing file"
else
  _fail "Returns null for missing file" "Got: $MISSING_RESULT"
fi

# No status section
mkdir -p "$REPOS_ROOT/org/nostatus/.claude"
cat > "$REPOS_ROOT/org/nostatus/.claude/state.md" << 'EOF'
# NoStatus — State

Last updated: 2026-03-01

## Random Section
Some content here.
EOF

NOSTATUS=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('$REPOS_ROOT/org/nostatus/.claude/state.md');
console.log(r.status);
")
if [ -z "$NOSTATUS" ]; then
  _pass "Returns empty string when no status header matches"
else
  _fail "Returns empty string when no status header matches" "Got: $NOSTATUS"
fi

# Scan with non-existent root
NOSCAN=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const files = rs.scanStateFiles(['/nonexistent/root']);
console.log(files.length);
")
if [ "$NOSCAN" = "0" ]; then
  _pass "scanStateFiles handles non-existent roots gracefully"
else
  _fail "scanStateFiles handles non-existent roots gracefully" "Got: $NOSCAN"
fi

# ── 10. extractSection — multi-line ──────────────────────────────────────

echo ""
echo "10. extractSection — multi-line paragraphs"
echo "───────────────────────────────────────────"

mkdir -p "$REPOS_ROOT/org/multiline/.claude"
cat > "$REPOS_ROOT/org/multiline/.claude/state.md" << 'EOF'
# Multiline — State

Last updated: 2026-03-01

## Current Status
First line of status.
Second line of status.
Third line of status.

## What's Next
1. First step
2. Second step
3. Third step

## Other Section
Not this.
EOF

MULTI_STATUS=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('$REPOS_ROOT/org/multiline/.claude/state.md');
console.log(r.status);
")
if echo "$MULTI_STATUS" | grep -q "First line.*Second line.*Third line"; then
  _pass "Joins multi-line paragraph into single line"
else
  _fail "Joins multi-line paragraph into single line" "Got: $MULTI_STATUS"
fi

MULTI_NEXT=$(node -e "
const rs = require('$REPO_ROOT/bin/rebuild-status.js');
const r = rs.parseStateFile('$REPOS_ROOT/org/multiline/.claude/state.md');
console.log(r.next);
")
if echo "$MULTI_NEXT" | grep -q "First step"; then
  _pass "Extracts first paragraph from numbered list"
else
  _fail "Extracts first paragraph from numbered list" "Got: $MULTI_NEXT"
fi

# ── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════"
echo -e "  ${GREEN}PASS: $PASS${RESET}  ${RED}FAIL: $FAIL${RESET}"
echo "════════════════════════════════════════"

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "Failures:"
  for e in "${ERRORS[@]}"; do
    echo -e "  ${RED}✗${RESET} $e"
  done
fi

echo ""
exit "$FAIL"
