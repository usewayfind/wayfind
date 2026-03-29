#!/usr/bin/env bash
# Scenario: store-scope-indexing
# Verifies that indexJournals() respects bound_repos from context.json:
# entries from out-of-scope repos are skipped, and each team's store only
# accumulates entries for its own repos.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: store-scope-indexing"
echo "================================"

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
ACME_STORE="$WAYFIND_DIR/teams/acme/content-store"
PERSONAL_STORE="$WAYFIND_DIR/teams/personal/content-store"

mkdir -p "$WAYFIND_DIR" "$JOURNAL_DIR" "$ACME_STORE" "$PERSONAL_STORE"
mkdir -p "$REPOS_DIR/acme/api/.claude"
mkdir -p "$REPOS_DIR/personal/blog/.claude"

cat > "$WAYFIND_DIR/context.json" <<EOF
{
  "teams": {
    "acme": {
      "name": "Acme Corp",
      "path": "$MOCK_HOME/tc-acme",
      "configured_at": "2026-01-01T00:00:00.000Z",
      "bound_repos": ["acme/"]
    },
    "personal": {
      "name": "Personal",
      "path": "$MOCK_HOME/tc-personal",
      "configured_at": "2026-01-01T00:00:00.000Z",
      "bound_repos": ["personal/"]
    }
  },
  "default": "acme"
}
EOF

cat > "$REPOS_DIR/acme/api/.claude/wayfind.json" <<'EOF'
{"team_id":"acme","bound_at":"2026-01-01T00:00:00.000Z"}
EOF
cat > "$REPOS_DIR/personal/blog/.claude/wayfind.json" <<'EOF'
{"team_id":"personal","bound_at":"2026-01-01T00:00:00.000Z"}
EOF

# Mixed journal: entries from both teams + an unscoped repo
cat > "$JOURNAL_DIR/2026-01-15-alice.md" <<'EOF'
**Author:** alice

## acme/api — Add JWT authentication [decision]
**Why:** API needs auth before launch
**What:** Implemented JWT middleware with 1-hour expiry
**Outcome:** All endpoints protected
**On track?:** Yes
**Lessons:** jwt, auth

## acme/frontend — Dark mode toggle [decision]
**Why:** Beta user feedback
**What:** CSS variables + localStorage persistence
**Outcome:** Ships in v1.2
**On track?:** Yes
**Lessons:** css-variables, theming

## personal/blog — Set up RSS feed [decision]
**Why:** Readers want a subscription option
**What:** Generated feed.xml via plugin
**Outcome:** Feed live at /feed.xml
**On track?:** Yes
**Lessons:** rss, eleventy

## unscoped/experiment — Try new bundler [decision]
**Why:** Exploring build tools
**What:** Benchmarked esbuild vs vite
**Outcome:** esbuild 3x faster
**On track?:** N/A
**Lessons:** esbuild
EOF

assert_file_exists "$JOURNAL_DIR/2026-01-15-alice.md" "mixed journal created (4 entries: 2 acme, 1 personal, 1 unscoped)"

# ── Step 1: Index from acme context ──────────────────────────────────────────

echo ""
echo "Step 1: Index from acme context"
echo "---------------------------------"

INDEX_EXIT=0
(cd "$REPOS_DIR/acme/api" && $CLI reindex --journals-only \
    --dir "$JOURNAL_DIR" \
    --store "$ACME_STORE" \
    --no-embeddings 2>&1) || INDEX_EXIT=$?

if [ "$INDEX_EXIT" -eq 0 ]; then
    _pass "reindex from acme context exits 0"
else
    _fail "reindex from acme context exits 0" "exited $INDEX_EXIT"
fi

assert_file_exists "$ACME_STORE/index.json" "acme store index created"
assert_file_contains "$ACME_STORE/index.json" "acme/api" "acme store contains acme/api entries"
assert_file_contains "$ACME_STORE/index.json" "acme/frontend" "acme store contains acme/frontend entries"
assert_file_not_contains "$ACME_STORE/index.json" "personal/blog" "acme store does NOT contain personal/blog"
assert_file_not_contains "$ACME_STORE/index.json" "unscoped/experiment" "acme store does NOT contain unscoped/experiment"

ACME_COUNT=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$ACME_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)
if [ "$ACME_COUNT" -eq 2 ] 2>/dev/null; then
    _pass "acme store has exactly 2 entries (not 4)"
else
    _fail "acme store has exactly 2 entries" "got $ACME_COUNT"
fi

# ── Step 2: Index from personal context ──────────────────────────────────────

echo ""
echo "Step 2: Index from personal context"
echo "--------------------------------------"

INDEX_EXIT=0
(cd "$REPOS_DIR/personal/blog" && $CLI reindex --journals-only \
    --dir "$JOURNAL_DIR" \
    --store "$PERSONAL_STORE" \
    --no-embeddings 2>&1) || INDEX_EXIT=$?

if [ "$INDEX_EXIT" -eq 0 ]; then
    _pass "reindex from personal context exits 0"
else
    _fail "reindex from personal context exits 0" "exited $INDEX_EXIT"
fi

assert_file_exists "$PERSONAL_STORE/index.json" "personal store index created"
assert_file_contains "$PERSONAL_STORE/index.json" "personal/blog" "personal store contains personal/blog entries"
assert_file_not_contains "$PERSONAL_STORE/index.json" "acme/api" "personal store does NOT contain acme/api"
assert_file_not_contains "$PERSONAL_STORE/index.json" "acme/frontend" "personal store does NOT contain acme/frontend"
assert_file_not_contains "$PERSONAL_STORE/index.json" "unscoped/experiment" "personal store does NOT contain unscoped/experiment"

PERSONAL_COUNT=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$PERSONAL_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)
if [ "$PERSONAL_COUNT" -eq 1 ] 2>/dev/null; then
    _pass "personal store has exactly 1 entry (not 4)"
else
    _fail "personal store has exactly 1 entry" "got $PERSONAL_COUNT"
fi

# ── Step 3: Re-index is idempotent — no contamination accumulates ─────────────

echo ""
echo "Step 3: Re-index is idempotent (contamination does not accumulate)"
echo "--------------------------------------------------------------------"

(cd "$REPOS_DIR/acme/api" && $CLI reindex --journals-only \
    --dir "$JOURNAL_DIR" \
    --store "$ACME_STORE" \
    --no-embeddings 2>&1) >/dev/null

ACME_COUNT2=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$ACME_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)
if [ "$ACME_COUNT2" -eq 2 ] 2>/dev/null; then
    _pass "acme store still exactly 2 entries after second index run"
else
    _fail "acme store still exactly 2 entries after second index run" "got $ACME_COUNT2"
fi

assert_file_not_contains "$ACME_STORE/index.json" "personal/blog" \
    "personal/blog still absent from acme store after re-index"

# ── Step 4: No bound_repos = indexes everything (backward compatible) ─────────

echo ""
echo "Step 4: No bound_repos = indexes all entries (backward compatible)"
echo "--------------------------------------------------------------------"

OPEN_STORE="$WAYFIND_DIR/teams/open/content-store"
mkdir -p "$OPEN_STORE"

# Temporarily add a team without bound_repos
python3 -c "
import json
with open('$WAYFIND_DIR/context.json') as f:
    ctx = json.load(f)
ctx['teams']['open'] = {'name': 'Open', 'path': '$MOCK_HOME/tc-open', 'configured_at': '2026-01-01T00:00:00.000Z'}
with open('$WAYFIND_DIR/context.json', 'w') as f:
    json.dump(ctx, f, indent=2)
" 2>/dev/null

mkdir -p "$REPOS_DIR/open/repo/.claude"
cat > "$REPOS_DIR/open/repo/.claude/wayfind.json" <<'EOF'
{"team_id":"open","bound_at":"2026-01-01T00:00:00.000Z"}
EOF

(cd "$REPOS_DIR/open/repo" && $CLI reindex --journals-only \
    --dir "$JOURNAL_DIR" \
    --store "$OPEN_STORE" \
    --no-embeddings 2>&1) >/dev/null

OPEN_COUNT=$(node -e "
const cs = require('$KIT_DIR/bin/content-store.js');
process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
const idx = cs.loadIndex('$OPEN_STORE');
console.log(Object.keys(idx.entries || {}).length);
" 2>/dev/null)
if [ "$OPEN_COUNT" -eq 4 ] 2>/dev/null; then
    _pass "team without bound_repos indexes all 4 entries (backward compatible)"
else
    _fail "team without bound_repos indexes all 4 entries" "got $OPEN_COUNT"
fi

print_results
[ "$FAIL" -eq 0 ]
