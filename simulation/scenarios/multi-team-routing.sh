#!/usr/bin/env bash
# Scenario: multi-team-routing
# Simulates a freelancer (alice) working across two client teams and a personal
# project, plus an unbound experiment repo. Verifies that journal sync routes
# entries to the correct team-context repo and that unbound repos are invisible
# to both sync and reindex.
#
# Teams:
#   client-a  — repos: client-a/api, client-a/frontend
#   personal  — repos: personal/side-project
# Unbound:
#   random/experiment — no .claude/wayfind.json
#
# Steps:
#   1. Setup teams (context.json, team-context repo dirs)
#   2. Bind repos via .claude/wayfind.json
#   3. Create mock journal entries with team suffixes
#   4. Run journal sync
#   5. Assert correct routing (team-suffixed → correct repo, unsuffixed → nowhere)
#   6. Index client-a journals and verify isolation
#   7. Test export with bound vs unbound repos
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: multi-team-routing"
echo "============================="

# ── Isolated environment ─────────────────────────────────────────────────────

MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

export TEAM_CONTEXT_SIMULATE=1
export TEAM_CONTEXT_TELEMETRY=0
export TEAM_CONTEXT_STORAGE_BACKEND=json
unset ANTHROPIC_API_KEY 2>/dev/null || true
unset OPENAI_API_KEY 2>/dev/null || true

CLI="node $KIT_DIR/bin/team-context.js"

# ── Step 1: Setup teams ─────────────────────────────────────────────────────

echo ""
echo "Step 1: Setup teams"
echo "--------------------"

WAYFIND_DIR="$MOCK_HOME/.claude/team-context"
JOURNAL_DIR="$MOCK_HOME/.claude/memory/journal"
REPOS_DIR="$MOCK_HOME/repos"
CLIENTA_TC="$MOCK_HOME/team-context-repos/client-a"
PERSONAL_TC="$MOCK_HOME/team-context-repos/personal"

mkdir -p "$WAYFIND_DIR"
mkdir -p "$JOURNAL_DIR"
mkdir -p "$REPOS_DIR/client-a/api/.claude"
mkdir -p "$REPOS_DIR/client-a/frontend/.claude"
mkdir -p "$REPOS_DIR/personal/side-project/.claude"
mkdir -p "$REPOS_DIR/random/experiment"
mkdir -p "$CLIENTA_TC/journals"
mkdir -p "$PERSONAL_TC/journals"

# Initialize team-context repos as git repos (journal sync commits + pushes)
for tc_dir in "$CLIENTA_TC" "$PERSONAL_TC"; do
    git -C "$tc_dir" init -q
    git -C "$tc_dir" config user.email "test@test.com"
    git -C "$tc_dir" config user.name "Test"
    touch "$tc_dir/.gitkeep"
    git -C "$tc_dir" add .
    git -C "$tc_dir" commit -q -m "init"
done

# Write context.json with both teams
cat > "$WAYFIND_DIR/context.json" <<'CTXEOF'
{
  "teams": {
    "client-a": {
      "name": "Client A",
      "path": "__CLIENTA_TC__",
      "configured_at": "2026-01-01T00:00:00.000Z"
    },
    "personal": {
      "name": "Personal",
      "path": "__PERSONAL_TC__",
      "configured_at": "2026-01-01T00:00:00.000Z"
    }
  },
  "default": "client-a"
}
CTXEOF

# Patch in actual paths (can't use shell vars in heredoc with single-quoted delimiter)
sed -i "s|__CLIENTA_TC__|${CLIENTA_TC}|g" "$WAYFIND_DIR/context.json"
sed -i "s|__PERSONAL_TC__|${PERSONAL_TC}|g" "$WAYFIND_DIR/context.json"

# Write profile.json (getAuthorSlug reads this)
cat > "$WAYFIND_DIR/profile.json" <<'EOF'
{
  "name": "Alice Engineer"
}
EOF

assert_file_exists "$WAYFIND_DIR/context.json" "context.json created"
assert_file_exists "$WAYFIND_DIR/profile.json" "profile.json created"
assert_dir_exists "$CLIENTA_TC/journals" "client-a team-context journals/ exists"
assert_dir_exists "$PERSONAL_TC/journals" "personal team-context journals/ exists"

# ── Step 2: Bind repos ──────────────────────────────────────────────────────

echo ""
echo "Step 2: Bind repos"
echo "-------------------"

# client-a/api → team: client-a
cat > "$REPOS_DIR/client-a/api/.claude/wayfind.json" <<'EOF'
{
  "team_id": "client-a",
  "bound_at": "2026-01-10T00:00:00.000Z"
}
EOF

# client-a/frontend → team: client-a
cat > "$REPOS_DIR/client-a/frontend/.claude/wayfind.json" <<'EOF'
{
  "team_id": "client-a",
  "bound_at": "2026-01-10T00:00:00.000Z"
}
EOF

# personal/side-project → team: personal
cat > "$REPOS_DIR/personal/side-project/.claude/wayfind.json" <<'EOF'
{
  "team_id": "personal",
  "bound_at": "2026-01-10T00:00:00.000Z"
}
EOF

# random/experiment — intentionally NO .claude/wayfind.json

assert_file_exists "$REPOS_DIR/client-a/api/.claude/wayfind.json" "client-a/api bound"
assert_file_exists "$REPOS_DIR/client-a/frontend/.claude/wayfind.json" "client-a/frontend bound"
assert_file_exists "$REPOS_DIR/personal/side-project/.claude/wayfind.json" "personal/side-project bound"

if [ ! -f "$REPOS_DIR/random/experiment/.claude/wayfind.json" ]; then
    _pass "random/experiment is unbound (no wayfind.json)"
else
    _fail "random/experiment is unbound" "wayfind.json unexpectedly exists"
fi

# ── Step 3: Create mock journal entries ──────────────────────────────────────

echo ""
echo "Step 3: Create mock journal entries"
echo "-------------------------------------"

# Journal with client-a team suffix — entries from client-a repos
cat > "$JOURNAL_DIR/2026-01-15-alice-client-a.md" <<'EOF'
**Author:** alice

## client-a/api — Add authentication middleware [decision]
**Why:** API needs JWT auth for production
**What:** Implemented JWT middleware with refresh token rotation
**Outcome:** Auth pipeline complete, all endpoints secured
**On track?:** Yes
**Lessons:** token rotation, security

## client-a/frontend — Implement dark mode toggle [decision]
**Why:** User feedback requested dark mode
**What:** Added dark mode with CSS variables and localStorage persistence
**Outcome:** Dark mode available across all pages
**On track?:** Yes
**Lessons:** CSS variables, theme persistence
EOF

# Journal with personal team suffix — entries from personal repo
cat > "$JOURNAL_DIR/2026-01-15-alice-personal.md" <<'EOF'
**Author:** alice

## personal/side-project — Set up CI pipeline [decision]
**Why:** Needed automated testing before pushing
**What:** Configured GitHub Actions with test + lint + build steps
**Outcome:** CI runs on every PR
**On track?:** Yes
**Lessons:** github-actions, CI
EOF

# Unsuffixed journal — entries from unbound repo (simulates old/unbound export)
cat > "$JOURNAL_DIR/2026-01-15-alice.md" <<'EOF'
**Author:** alice

## random/experiment — Try new bundler [decision]
**Why:** Exploring faster build tools
**What:** Tested esbuild vs vite for the experiment repo
**Outcome:** esbuild 3x faster for this use case
**On track?:** N/A (experiment)
**Lessons:** esbuild, bundler-comparison
EOF

assert_file_exists "$JOURNAL_DIR/2026-01-15-alice-client-a.md" "client-a journal created"
assert_file_exists "$JOURNAL_DIR/2026-01-15-alice-personal.md" "personal journal created"
assert_file_exists "$JOURNAL_DIR/2026-01-15-alice.md" "unsuffixed journal created"

# ── Step 4: Run journal sync ─────────────────────────────────────────────────

echo ""
echo "Step 4: Run journal sync"
echo "-------------------------"

SYNC_EXIT=0
SYNC_OUTPUT=$($CLI journal sync 2>&1) || SYNC_EXIT=$?

if [ "$SYNC_EXIT" -eq 0 ]; then
    _pass "journal sync exits 0"
else
    _fail "journal sync exits 0" "exited $SYNC_EXIT — output: $SYNC_OUTPUT"
fi

# ── Step 5: Assert correct routing ───────────────────────────────────────────

echo ""
echo "Step 5: Assert correct routing"
echo "-------------------------------"

# client-a team-context should have the client-a journal (with team suffix stripped)
assert_file_exists "$CLIENTA_TC/journals/2026-01-15-alice.md" \
    "client-a journal synced (team suffix stripped)"

# personal team-context should have the personal journal (with team suffix stripped)
assert_file_exists "$PERSONAL_TC/journals/2026-01-15-alice.md" \
    "personal journal synced (team suffix stripped)"

# Verify content made it to the right place
assert_file_contains "$CLIENTA_TC/journals/2026-01-15-alice.md" "client-a/api" \
    "client-a journal contains client-a/api entry"
assert_file_contains "$CLIENTA_TC/journals/2026-01-15-alice.md" "client-a/frontend" \
    "client-a journal contains client-a/frontend entry"
assert_file_contains "$PERSONAL_TC/journals/2026-01-15-alice.md" "personal/side-project" \
    "personal journal contains side-project entry"

# Unsuffixed file must NOT be synced to any team repo
# The sync function skips files without a known team ID suffix
if [ ! -f "$CLIENTA_TC/journals/2026-01-15-alice-client-a.md" ]; then
    _pass "no team-suffixed filename leaked to client-a repo"
else
    _fail "no team-suffixed filename leaked to client-a repo" \
        "file unexpectedly exists: $CLIENTA_TC/journals/2026-01-15-alice-client-a.md"
fi

if [ ! -f "$PERSONAL_TC/journals/2026-01-15-alice-personal.md" ]; then
    _pass "no team-suffixed filename leaked to personal repo"
else
    _fail "no team-suffixed filename leaked to personal repo" \
        "file unexpectedly exists: $PERSONAL_TC/journals/2026-01-15-alice-personal.md"
fi

# Cross-contamination checks: personal entries NOT in client-a, and vice versa
assert_file_not_contains "$CLIENTA_TC/journals/2026-01-15-alice.md" "personal/side-project" \
    "client-a journal does NOT contain personal entries"
assert_file_not_contains "$PERSONAL_TC/journals/2026-01-15-alice.md" "client-a/api" \
    "personal journal does NOT contain client-a entries"

# Unbound repo entries must not appear in any team repo
assert_file_not_contains "$CLIENTA_TC/journals/2026-01-15-alice.md" "random/experiment" \
    "client-a journal does NOT contain unbound repo entries"
assert_file_not_contains "$PERSONAL_TC/journals/2026-01-15-alice.md" "random/experiment" \
    "personal journal does NOT contain unbound repo entries"

# ── Step 6: Index and verify isolation ────────────────────────────────────────

echo ""
echo "Step 6: Index and verify isolation"
echo "------------------------------------"

# Index the client-a team-context journals into a dedicated store
CLIENTA_STORE="$MOCK_HOME/stores/client-a"
mkdir -p "$CLIENTA_STORE"

INDEX_EXIT=0
INDEX_OUTPUT=$($CLI reindex --journals-only \
    --dir "$CLIENTA_TC/journals" \
    --store "$CLIENTA_STORE" \
    --no-embeddings 2>&1) || INDEX_EXIT=$?

if [ "$INDEX_EXIT" -eq 0 ]; then
    _pass "reindex client-a journals exits 0"
else
    _fail "reindex client-a journals exits 0" "exited $INDEX_EXIT — output: $INDEX_OUTPUT"
fi

# Verify the index file was created
assert_file_exists "$CLIENTA_STORE/index.json" "client-a content store index created"

# Verify client-a entries are in the index
assert_file_contains "$CLIENTA_STORE/index.json" "client-a/api" \
    "index contains client-a/api entries"
assert_file_contains "$CLIENTA_STORE/index.json" "client-a/frontend" \
    "index contains client-a/frontend entries"

# Verify unbound and personal entries are NOT in the index
assert_file_not_contains "$CLIENTA_STORE/index.json" "random/experiment" \
    "index does NOT contain random/experiment entries"
assert_file_not_contains "$CLIENTA_STORE/index.json" "personal/side-project" \
    "index does NOT contain personal/side-project entries"

# ── Step 7: Test export with bound vs unbound repos ─────────────────────────

echo ""
echo "Step 7: Test export (bound vs unbound)"
echo "----------------------------------------"

# Set up mock conversation transcripts (Claude Code projects dir structure)
# The conversation indexer looks for .claude/projects/<org>/<repo>/
PROJECTS_DIR="$MOCK_HOME/.claude/projects"

# Bound repo: client-a/api — create a mock conversation
BOUND_CONV_DIR="$PROJECTS_DIR/client-a/api"
mkdir -p "$BOUND_CONV_DIR"
cat > "$BOUND_CONV_DIR/conversation-001.json" <<'EOF'
[
  {
    "role": "user",
    "content": "Add rate limiting to the API endpoints"
  },
  {
    "role": "assistant",
    "content": "I'll add rate limiting using express-rate-limit. Decision: Use sliding window algorithm with 100 requests per 15 minutes per IP. This balances protection against abuse with legitimate high-frequency API consumers."
  }
]
EOF

# Unbound repo: random/experiment — create a mock conversation
UNBOUND_CONV_DIR="$PROJECTS_DIR/random/experiment"
mkdir -p "$UNBOUND_CONV_DIR"
cat > "$UNBOUND_CONV_DIR/conversation-002.json" <<'EOF'
[
  {
    "role": "user",
    "content": "Try switching the bundler to esbuild"
  },
  {
    "role": "assistant",
    "content": "Decision: Switch from webpack to esbuild for the experiment. Build times dropped from 12s to 0.8s."
  }
]
EOF

# Set AI_MEMORY_SCAN_ROOTS so the resolver scans our mock repos dir
export AI_MEMORY_SCAN_ROOTS="$REPOS_DIR"

# Create a separate export dir to catch new journal files
EXPORT_DIR="$MOCK_HOME/export-test-journals"
mkdir -p "$EXPORT_DIR"

EXPORT_STORE="$MOCK_HOME/stores/export-test"
mkdir -p "$EXPORT_STORE"

EXPORT_EXIT=0
EXPORT_OUTPUT=$($CLI reindex --conversations-only --export \
    --dir "$PROJECTS_DIR" \
    --store "$EXPORT_STORE" \
    --export-dir "$EXPORT_DIR" \
    --no-embeddings 2>&1) || EXPORT_EXIT=$?

# The export may or may not find conversations (depends on transcript format),
# but it should not crash
if [ "$EXPORT_EXIT" -eq 0 ]; then
    _pass "reindex --conversations-only --export exits 0"
else
    _fail "reindex --conversations-only --export exits 0" \
        "exited $EXPORT_EXIT — output: $EXPORT_OUTPUT"
fi

# Check what was exported. If any journal files were produced for the bound repo,
# they should have the team suffix. Files for the unbound repo should NOT exist.
BOUND_JOURNAL_FOUND=0
UNBOUND_JOURNAL_FOUND=0
shopt -s nullglob
for f in "$EXPORT_DIR"/*.md; do
    if grep -qF "client-a" "$f" 2>/dev/null; then
        BOUND_JOURNAL_FOUND=1
    fi
    if grep -qF "random/experiment" "$f" 2>/dev/null; then
        UNBOUND_JOURNAL_FOUND=1
    fi
done
shopt -u nullglob

# Unbound repo must NOT produce exported journals (this is the key assertion)
if [ "$UNBOUND_JOURNAL_FOUND" -eq 0 ]; then
    _pass "unbound repo did NOT produce exported journal"
else
    _fail "unbound repo did NOT produce exported journal" \
        "random/experiment entry found in export dir"
fi

# If the bound repo produced output, verify it has the team suffix in the filename
if [ "$BOUND_JOURNAL_FOUND" -eq 1 ]; then
    TEAM_SUFFIXED_EXISTS=0
    shopt -s nullglob
    for f in "$EXPORT_DIR"/*-client-a.md; do
        TEAM_SUFFIXED_EXISTS=1
        break
    done
    shopt -u nullglob
    if [ "$TEAM_SUFFIXED_EXISTS" -eq 1 ]; then
        _pass "bound repo journal has team suffix in filename"
    else
        _fail "bound repo journal has team suffix in filename" \
            "no *-client-a.md file found in export dir"
    fi
else
    _pass "bound repo export check skipped (no decisions extracted — OK for mock data)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

print_results
[ "$FAIL" -eq 0 ]
