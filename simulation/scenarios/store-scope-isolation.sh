#!/usr/bin/env bash
# Scenario: store-scope-isolation
# Full two-team isolation end-to-end: index, verify, trim injected contamination,
# and confirm that context bind correctly updates bound_repos in context.json.
# Models the real setup: a work team (org prefixes) and a personal team (user prefixes).
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: store-scope-isolation"
echo "================================="

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
JOURNAL_DIR="$MOCK_HOME/.claude/memory/journal"
REPOS_DIR="$MOCK_HOME/repos"
WORK_STORE="$WAYFIND_DIR/teams/work/content-store"
PERSONAL_STORE="$WAYFIND_DIR/teams/personal/content-store"

mkdir -p "$WAYFIND_DIR" "$JOURNAL_DIR" "$WORK_STORE" "$PERSONAL_STORE"
mkdir -p "$REPOS_DIR/work/api/.claude"
mkdir -p "$REPOS_DIR/personal/blog/.claude"

# Two teams: work (org prefix patterns) and personal (user prefix patterns)
cat > "$WAYFIND_DIR/context.json" <<EOF
{
  "teams": {
    "work": {
      "name": "Work Team",
      "path": "$MOCK_HOME/tc-work",
      "configured_at": "2026-01-01T00:00:00.000Z",
      "bound_repos": ["work/", "signals/", "home/alice"]
    },
    "personal": {
      "name": "Personal",
      "path": "$MOCK_HOME/tc-personal",
      "configured_at": "2026-01-01T00:00:00.000Z",
      "bound_repos": ["personal/", "old-name"]
    }
  },
  "default": "work"
}
EOF

cat > "$REPOS_DIR/work/api/.claude/wayfind.json" <<'EOF'
{"team_id":"work","bound_at":"2026-01-01T00:00:00.000Z"}
EOF
cat > "$REPOS_DIR/personal/blog/.claude/wayfind.json" <<'EOF'
{"team_id":"personal","bound_at":"2026-01-01T00:00:00.000Z"}
EOF

# Journal with entries spanning both teams, legacy names, signals, and unbound
cat > "$JOURNAL_DIR/2026-03-01-alice.md" <<'EOF'
**Author:** alice

## work/api — Rate limiting [decision]
**Why:** Protect free tier from abuse
**What:** Token bucket, 100 req/min per IP
**Outcome:** Deployed to prod
**On track?:** Yes
**Lessons:** rate-limiting, api

## work/infra — Deploy pipeline automation [decision]
**Why:** Reduce manual release steps
**What:** GitHub Actions with approval gates
**Outcome:** One-command deploys
**On track?:** Yes
**Lessons:** ci-cd, automation

## signals/github — PR activity [signal]
**Why:** Daily signal
**What:** 4 PRs merged, 2 reviews pending
**Outcome:** Captured
**On track?:** Yes
**Lessons:** signals

## home/alice — Reviewed architecture docs [decision]
**Why:** Keeping up with system design
**What:** Read new RFC for service mesh
**Outcome:** Notes filed
**On track?:** Yes
**Lessons:** architecture

## personal/blog — Switched to Eleventy [decision]
**Why:** Jekyll rebuild times too slow
**What:** Migrated 80 posts, new theme
**Outcome:** Build: 12s → 0.9s
**On track?:** Yes
**Lessons:** eleventy, ssg

## old-name — Legacy project cleanup [decision]
**Why:** Pre-rename repo entries exist
**What:** Archived old branches
**Outcome:** Repo clean
**On track?:** Yes
**Lessons:** cleanup

## unrelated/experiment — Rust parser [decision]
**Why:** Performance exploration
**What:** Rewrote a hot parser in Rust
**Outcome:** 20x faster
**On track?:** N/A
**Lessons:** rust
EOF

# ── Step 1: Index each store from its team's context ─────────────────────────

echo ""
echo "Step 1: Index each store from its team context"
echo "------------------------------------------------"

INDEX_EXIT=0
(cd "$REPOS_DIR/work/api" && $CLI reindex --journals-only \
    --dir "$JOURNAL_DIR" --store "$WORK_STORE" --no-embeddings 2>&1) || INDEX_EXIT=$?
if [ "$INDEX_EXIT" -eq 0 ]; then
    _pass "work store indexed successfully"
else
    _fail "work store indexed successfully" "exited $INDEX_EXIT"
fi

INDEX_EXIT=0
(cd "$REPOS_DIR/personal/blog" && $CLI reindex --journals-only \
    --dir "$JOURNAL_DIR" --store "$PERSONAL_STORE" --no-embeddings 2>&1) || INDEX_EXIT=$?
if [ "$INDEX_EXIT" -eq 0 ]; then
    _pass "personal store indexed successfully"
else
    _fail "personal store indexed successfully" "exited $INDEX_EXIT"
fi

# ── Step 2: Verify work store isolation ──────────────────────────────────────

echo ""
echo "Step 2: Verify work store isolation"
echo "--------------------------------------"

assert_file_exists "$WORK_STORE/index.json" "work store index created"
assert_file_contains "$WORK_STORE/index.json" "work/api" \
    "work store contains work/api entries"
assert_file_contains "$WORK_STORE/index.json" "work/infra" \
    "work store contains work/infra entries"
assert_file_contains "$WORK_STORE/index.json" "signals/github" \
    "work store contains signals/github entries (in scope)"
assert_file_contains "$WORK_STORE/index.json" "home/alice" \
    "work store contains home/alice entries (in scope)"
assert_file_not_contains "$WORK_STORE/index.json" "personal/blog" \
    "work store does NOT contain personal/blog"
assert_file_not_contains "$WORK_STORE/index.json" "old-name" \
    "work store does NOT contain old-name (personal team)"
assert_file_not_contains "$WORK_STORE/index.json" "unrelated/experiment" \
    "work store does NOT contain unrelated/experiment"

WORK_COUNT=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$WORK_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)
if [ "$WORK_COUNT" -eq 4 ] 2>/dev/null; then
    _pass "work store has exactly 4 entries (work/, signals/, home/alice)"
else
    _fail "work store has exactly 4 entries" "got $WORK_COUNT"
fi

# ── Step 3: Verify personal store isolation ───────────────────────────────────

echo ""
echo "Step 3: Verify personal store isolation"
echo "-----------------------------------------"

assert_file_exists "$PERSONAL_STORE/index.json" "personal store index created"
assert_file_contains "$PERSONAL_STORE/index.json" "personal/blog" \
    "personal store contains personal/blog entries"
assert_file_contains "$PERSONAL_STORE/index.json" "old-name" \
    "personal store contains old-name entries (exact match)"
assert_file_not_contains "$PERSONAL_STORE/index.json" "work/api" \
    "personal store does NOT contain work/api"
assert_file_not_contains "$PERSONAL_STORE/index.json" "signals/github" \
    "personal store does NOT contain signals/github"
assert_file_not_contains "$PERSONAL_STORE/index.json" "home/alice" \
    "personal store does NOT contain home/alice"
assert_file_not_contains "$PERSONAL_STORE/index.json" "unrelated/experiment" \
    "personal store does NOT contain unrelated/experiment"

PERSONAL_COUNT=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$PERSONAL_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)
if [ "$PERSONAL_COUNT" -eq 2 ] 2>/dev/null; then
    _pass "personal store has exactly 2 entries (personal/ + old-name)"
else
    _fail "personal store has exactly 2 entries" "got $PERSONAL_COUNT"
fi

# The unrelated/experiment entry is in neither store
TOTAL=$((WORK_COUNT + PERSONAL_COUNT))
if [ "$TOTAL" -eq 6 ] 2>/dev/null; then
    _pass "unrelated/experiment is in neither store (6 of 7 entries indexed total)"
else
    _fail "6 of 7 entries indexed across both stores" "total across both: $TOTAL"
fi

# ── Step 4: context bind updates bound_repos ─────────────────────────────────

echo ""
echo "Step 4: context bind updates bound_repos"
echo "------------------------------------------"

mkdir -p "$REPOS_DIR/work/payments/.claude"

BIND_EXIT=0
BIND_OUTPUT=$((cd "$REPOS_DIR/work/payments" && $CLI context bind work) 2>&1) || BIND_EXIT=$?

if [ "$BIND_EXIT" -eq 0 ]; then
    _pass "context bind exits 0"
else
    _fail "context bind exits 0" "exited $BIND_EXIT — $BIND_OUTPUT"
fi

# wayfind.json created in the new repo
assert_file_exists "$REPOS_DIR/work/payments/.claude/wayfind.json" \
    "wayfind.json created in new repo"

# bound_repos updated in context.json
assert_file_contains "$WAYFIND_DIR/context.json" "work/payments" \
    "context.json updated with work/payments after bind"

# Binding again should be idempotent (no duplicate added)
(cd "$REPOS_DIR/work/payments" && $CLI context bind work 2>&1) >/dev/null

BIND_COUNT=$(python3 -c "
import json
with open('$WAYFIND_DIR/context.json') as f:
    ctx = json.load(f)
repos = ctx['teams']['work'].get('bound_repos', [])
print(repos.count('work/payments'))
" 2>/dev/null)

if [ "$BIND_COUNT" -eq 1 ] 2>/dev/null; then
    _pass "work/payments appears exactly once in bound_repos (no duplicate on re-bind)"
else
    _fail "work/payments appears exactly once in bound_repos" "got count: $BIND_COUNT"
fi

# ── Step 5: trim removes injected contamination ───────────────────────────────

echo ""
echo "Step 5: trim removes injected contamination"
echo "----------------------------------------------"

# Simulate contamination by directly injecting a foreign entry into work store
python3 -c "
import json
with open('$WORK_STORE/index.json') as f:
    idx = json.load(f)
idx['entries']['injected-contam'] = {
    'date': '2026-03-01', 'repo': 'personal/blog',
    'title': 'injected contamination', 'user': 'test',
    'drifted': False, 'contentHash': 'fake', 'contentLength': 30,
    'tags': [], 'hasEmbedding': False, 'hasReasoning': False,
    'hasAlternatives': False, 'qualityScore': 1
}
idx['entryCount'] = len(idx['entries'])
with open('$WORK_STORE/index.json', 'w') as f:
    json.dump(idx, f, indent=2)
" 2>/dev/null

assert_file_contains "$WORK_STORE/index.json" "injected contamination" \
    "contamination successfully injected into work store"

TRIM_EXIT=0
(cd "$REPOS_DIR/work/api" && $CLI store trim work 2>&1) >/dev/null || TRIM_EXIT=$?

if [ "$TRIM_EXIT" -eq 0 ]; then
    _pass "store trim exits 0"
else
    _fail "store trim exits 0" "exited $TRIM_EXIT"
fi

assert_file_not_contains "$WORK_STORE/index.json" "injected contamination" \
    "contamination removed by trim"

POST_COUNT=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$WORK_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)

if [ "$POST_COUNT" -eq 4 ] 2>/dev/null; then
    _pass "work store restored to 4 entries after contamination trim"
else
    _fail "work store restored to 4 entries after contamination trim" "got $POST_COUNT"
fi

print_results
[ "$FAIL" -eq 0 ]
