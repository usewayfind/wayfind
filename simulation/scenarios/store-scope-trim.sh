#!/usr/bin/env bash
# Scenario: store-scope-trim
# Verifies trimStore() removes out-of-scope entries from a contaminated store,
# leaving only entries matching bound_repos patterns. Also verifies idempotency
# and correct error handling when preconditions are not met.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: store-scope-trim"
echo "============================"

MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

export TEAM_CONTEXT_SIMULATE=1
export TEAM_CONTEXT_TELEMETRY=0
export TEAM_CONTEXT_STORAGE_BACKEND=json
unset ANTHROPIC_API_KEY 2>/dev/null || true
unset OPENAI_API_KEY 2>/dev/null || true

CLI="node $KIT_DIR/bin/team-context.js"

# ── Setup ─────────────────────────────────────────────────────────────────────

WAYFIND_DIR="$MOCK_HOME/.claude/team-context"
REPOS_DIR="$MOCK_HOME/repos"
ACME_STORE="$WAYFIND_DIR/teams/acme/content-store"

mkdir -p "$WAYFIND_DIR" "$ACME_STORE"
mkdir -p "$REPOS_DIR/acme/api/.claude"

cat > "$WAYFIND_DIR/context.json" <<EOF
{
  "teams": {
    "acme": {
      "name": "Acme Corp",
      "path": "$MOCK_HOME/tc-acme",
      "configured_at": "2026-01-01T00:00:00.000Z",
      "bound_repos": ["acme/"]
    }
  },
  "default": "acme"
}
EOF

cat > "$REPOS_DIR/acme/api/.claude/wayfind.json" <<'EOF'
{"team_id":"acme","bound_at":"2026-01-01T00:00:00.000Z"}
EOF

# ── Step 1: Pre-populate store with mixed entries (contaminated baseline) ─────

echo ""
echo "Step 1: Pre-populate store with contaminated entries"
echo "------------------------------------------------------"

# Write 5 entries directly into the store: 2 in-scope (acme/), 3 out-of-scope
python3 -c "
import json, hashlib, time

def make_entry(repo, title):
    content = f'{repo} — {title}'
    return {
        'date': '2026-01-15',
        'repo': repo,
        'title': title,
        'user': 'alice',
        'drifted': False,
        'contentHash': hashlib.md5(content.encode()).hexdigest(),
        'contentLength': len(content),
        'tags': [],
        'hasEmbedding': False,
        'hasReasoning': False,
        'hasAlternatives': False,
        'qualityScore': 1
    }

entries = {
    'acme-api-auth':    make_entry('acme/api', 'Add JWT authentication'),
    'acme-api-rate':    make_entry('acme/api', 'Rate limiting'),
    'foreign-note':     make_entry('foreign/other', 'Personal experiment notes'),
    'signals-gh':       make_entry('signals/github', 'Daily PR activity'),
    'unbound-work':     make_entry('unbound/project', 'Unrelated work'),
}

idx = {
    'version': '2.0.0',
    'lastUpdated': '2026-01-15T00:00:00.000Z',
    'entryCount': len(entries),
    'entries': entries
}

with open('$ACME_STORE/index.json', 'w') as f:
    json.dump(idx, f, indent=2)
print('wrote', len(entries), 'entries')
" 2>/dev/null

PRE_COUNT=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$ACME_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)

if [ "$PRE_COUNT" -eq 5 ] 2>/dev/null; then
    _pass "store pre-populated with 5 mixed entries (contaminated baseline)"
else
    _fail "store pre-populated with 5 mixed entries" "got $PRE_COUNT"
fi

assert_file_contains "$ACME_STORE/index.json" "foreign/other" \
    "foreign/other present in store before trim"
assert_file_contains "$ACME_STORE/index.json" "signals/github" \
    "signals/github present in store before trim"
assert_file_contains "$ACME_STORE/index.json" "unbound/project" \
    "unbound/project present in store before trim"

# ── Step 2: Run store trim ────────────────────────────────────────────────────

echo ""
echo "Step 2: Run store trim"
echo "------------------------"

TRIM_OUTPUT=""
TRIM_EXIT=0
TRIM_OUTPUT=$((cd "$REPOS_DIR/acme/api" && $CLI store trim acme) 2>&1) || TRIM_EXIT=$?

if [ "$TRIM_EXIT" -eq 0 ]; then
    _pass "store trim exits 0"
else
    _fail "store trim exits 0" "exited $TRIM_EXIT — $TRIM_OUTPUT"
fi

if echo "$TRIM_OUTPUT" | grep -qF "Kept:"; then
    _pass "trim output includes kept count"
else
    _fail "trim output includes kept count" "no 'Kept:' in: $TRIM_OUTPUT"
fi

if echo "$TRIM_OUTPUT" | grep -qF "Removed:"; then
    _pass "trim output includes removed count"
else
    _fail "trim output includes removed count" "no 'Removed:' in: $TRIM_OUTPUT"
fi

# ── Step 3: Verify trim result ────────────────────────────────────────────────

echo ""
echo "Step 3: Verify trim result"
echo "----------------------------"

POST_COUNT=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$ACME_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)

if [ "$POST_COUNT" -eq 2 ] 2>/dev/null; then
    _pass "store trimmed from 5 to 2 entries (acme/ only)"
else
    _fail "store trimmed to 2 entries" "got $POST_COUNT (expected 2)"
fi

assert_file_contains "$ACME_STORE/index.json" "acme/api" \
    "acme/api entries retained after trim"
assert_file_not_contains "$ACME_STORE/index.json" "foreign/other" \
    "foreign/other removed by trim"
assert_file_not_contains "$ACME_STORE/index.json" "signals/github" \
    "signals/github removed by trim"
assert_file_not_contains "$ACME_STORE/index.json" "unbound/project" \
    "unbound/project removed by trim"

assert_json_valid "$ACME_STORE/index.json" "index.json is valid JSON after trim"

# ── Step 4: Idempotency ───────────────────────────────────────────────────────

echo ""
echo "Step 4: Idempotency — second trim produces identical result"
echo "------------------------------------------------------------"

(cd "$REPOS_DIR/acme/api" && $CLI store trim acme 2>&1) >/dev/null

POST2_COUNT=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$ACME_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)

if [ "$POST2_COUNT" -eq 2 ] 2>/dev/null; then
    _pass "second trim leaves same 2 entries (idempotent)"
else
    _fail "second trim leaves same 2 entries" "got $POST2_COUNT"
fi

assert_file_contains "$ACME_STORE/index.json" "acme/api" \
    "acme/api still present after second trim"
assert_file_not_contains "$ACME_STORE/index.json" "foreign/other" \
    "foreign/other still absent after second trim"

# ── Step 5: Prefix vs exact pattern matching ──────────────────────────────────

echo ""
echo "Step 5: Pattern matching — prefix and exact"
echo "----------------------------------------------"

# Add entries for exact-match test (signals/ as exact, not prefix)
python3 -c "
import json
with open('$ACME_STORE/index.json') as f:
    idx = json.load(f)
# signals is an exact entry, signals/github is a sub-entry
idx['entries']['sig-exact'] = {
    'date': '2026-01-16', 'repo': 'signals', 'title': 'exact signals entry',
    'user': 'alice', 'drifted': False, 'contentHash': 'sig1', 'contentLength': 20,
    'tags': [], 'hasEmbedding': False, 'hasReasoning': False, 'hasAlternatives': False, 'qualityScore': 1
}
idx['entries']['sig-sub'] = {
    'date': '2026-01-16', 'repo': 'signals/github', 'title': 'sub signals entry',
    'user': 'alice', 'drifted': False, 'contentHash': 'sig2', 'contentLength': 20,
    'tags': [], 'hasEmbedding': False, 'hasReasoning': False, 'hasAlternatives': False, 'qualityScore': 1
}
idx['entryCount'] = len(idx['entries'])
with open('$ACME_STORE/index.json', 'w') as f:
    json.dump(idx, f, indent=2)
" 2>/dev/null

# Update context.json to include both exact and prefix patterns
python3 -c "
import json
with open('$WAYFIND_DIR/context.json') as f:
    ctx = json.load(f)
ctx['teams']['acme']['bound_repos'] = ['acme/', 'signals']
with open('$WAYFIND_DIR/context.json', 'w') as f:
    json.dump(ctx, f, indent=2)
" 2>/dev/null

(cd "$REPOS_DIR/acme/api" && $CLI store trim acme 2>&1) >/dev/null

# 'signals' (exact) should match 'signals' but NOT 'signals/github'
assert_file_contains "$ACME_STORE/index.json" '"signals"' \
    "exact pattern 'signals' matches exact repo name"
assert_file_not_contains "$ACME_STORE/index.json" "signals/github" \
    "exact pattern 'signals' does NOT match 'signals/github' (not a prefix)"

# ── Step 6: Error cases ───────────────────────────────────────────────────────

echo ""
echo "Step 6: Error cases"
echo "---------------------"

# Unknown team ID
UNKNOWN_EXIT=0
(cd "$REPOS_DIR/acme/api" && $CLI store trim no-such-team 2>&1) >/dev/null || UNKNOWN_EXIT=$?
if [ "$UNKNOWN_EXIT" -ne 0 ]; then
    _pass "store trim exits non-zero for unknown team ID"
else
    _fail "store trim exits non-zero for unknown team ID" "expected non-zero, got 0"
fi

# Team with no bound_repos
python3 -c "
import json
with open('$WAYFIND_DIR/context.json') as f:
    ctx = json.load(f)
ctx['teams']['empty-team'] = {'name': 'Empty', 'path': '$MOCK_HOME/tc-empty', 'configured_at': '2026-01-01T00:00:00.000Z'}
with open('$WAYFIND_DIR/context.json', 'w') as f:
    json.dump(ctx, f, indent=2)
" 2>/dev/null

EMPTY_EXIT=0
(cd "$REPOS_DIR/acme/api" && $CLI store trim empty-team 2>&1) >/dev/null || EMPTY_EXIT=$?
if [ "$EMPTY_EXIT" -ne 0 ]; then
    _pass "store trim exits non-zero when team has no bound_repos"
else
    _fail "store trim exits non-zero when team has no bound_repos" "expected non-zero, got 0"
fi

print_results
[ "$FAIL" -eq 0 ]
