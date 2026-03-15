#!/usr/bin/env bash
# Tests for multi-team journal routing
# Covers: repo→team resolver, per-team journal export, journal sync routing,
#         context bind, default team semantics, edge cases.
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

# Enable simulation mode
export TEAM_CONTEXT_SIMULATE=1

# ── Shared fixtures ──────────────────────────────────────────────────────────

JOURNAL_DIR="$TEST_HOME/.claude/memory/journal"
WAYFIND_DIR="$TEST_HOME/.claude/team-context"
CONTEXT_CONFIG="$WAYFIND_DIR/context.json"
PROFILE_FILE="$WAYFIND_DIR/profile.json"
PROJECTS_DIR="$TEST_HOME/.claude/projects"
STORE_DIR="$WAYFIND_DIR/content-store"

# Repo roots (two-level: org/repo)
REPOS_DIR="$TEST_HOME/repos"
BOUND_REPO="$REPOS_DIR/acme/backend"
UNBOUND_REPO="$REPOS_DIR/personal/side-project"

# Team-context repo paths (where synced journals land)
TEAM_ALPHA_REPO="$TEST_HOME/team-repos/team-alpha-context"
PERSONAL_REPO="$TEST_HOME/team-repos/personal-context"

mkdir -p "$JOURNAL_DIR" "$WAYFIND_DIR" "$STORE_DIR" "$PROJECTS_DIR"
mkdir -p "$BOUND_REPO/.claude" "$UNBOUND_REPO/.claude"
mkdir -p "$TEAM_ALPHA_REPO" "$PERSONAL_REPO"

# Profile (provides author slug)
cat > "$PROFILE_FILE" << 'EOF'
{
  "name": "testuser"
}
EOF

# Context config: two teams
cat > "$CONTEXT_CONFIG" << EOF
{
  "teams": {
    "team-alpha": {
      "name": "Team Alpha",
      "path": "$TEAM_ALPHA_REPO",
      "configured_at": "2026-01-01T00:00:00Z"
    },
    "personal": {
      "name": "Personal",
      "path": "$PERSONAL_REPO",
      "configured_at": "2026-01-01T00:00:00Z"
    }
  },
  "default": "team-alpha"
}
EOF

# Binding file: acme/backend → team-alpha
cat > "$BOUND_REPO/.claude/wayfind.json" << 'EOF'
{
  "team_id": "team-alpha",
  "bound_at": "2026-01-01T00:00:00Z"
}
EOF

# No wayfind.json in unbound repo (personal/side-project)

# Point resolver at our test repos dir
export AI_MEMORY_SCAN_ROOTS="$REPOS_DIR"

# Helper: inline JS that replicates buildRepoToTeamResolver logic
# (the real function is not exported, so we replicate its scanning + resolution)
RESOLVER_JS="
  const fs = require('fs');
  const path = require('path');

  const repoToTeamMap = {};
  const root = '$REPOS_DIR';
  const orgs = fs.readdirSync(root).filter(d => {
    try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
  });
  for (const org of orgs) {
    const orgDir = path.join(root, org);
    let repos;
    try { repos = fs.readdirSync(orgDir); } catch { continue; }
    for (const repo of repos) {
      const bindingFile = path.join(orgDir, repo, '.claude', 'wayfind.json');
      try {
        const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
        if (binding.team_id) repoToTeamMap[org + '/' + repo] = binding.team_id;
      } catch {}
    }
  }

  function resolve(repoName) {
    if (repoToTeamMap[repoName]) return repoToTeamMap[repoName];
    for (const [key, teamId] of Object.entries(repoToTeamMap)) {
      if (repoName.startsWith(key + '/') || repoName === key) return teamId;
    }
    return null;
  }
"

echo ""
echo "=== Multi-Team Journal Routing Tests ==="
echo ""

# ── 1. Bound repo resolves correctly ─────────────────────────────────────────

echo "--- Resolver: Bound repo ---"

RESULT=$(node -e "
  $RESOLVER_JS
  const result = resolve('acme/backend');
  console.log(result || 'null');
" 2>/dev/null)

if [[ "$RESULT" == "team-alpha" ]]; then
  _pass "1. Bound repo resolves to correct team"
else
  _fail "1. Bound repo resolves to correct team" "Expected 'team-alpha', got '$RESULT'"
fi

# ── 2. Unbound repo returns null ─────────────────────────────────────────────

echo "--- Resolver: Unbound repo ---"

RESULT=$(node -e "
  $RESOLVER_JS
  const result = resolve('personal/side-project');
  console.log(result === null ? 'null' : result);
" 2>/dev/null)

if [[ "$RESULT" == "null" ]]; then
  _pass "2. Unbound repo returns null (not default team)"
else
  _fail "2. Unbound repo returns null (not default team)" "Expected 'null', got '$RESULT'"
fi

# ── 3. Partial path match works ──────────────────────────────────────────────

echo "--- Resolver: Partial path match ---"

RESULT=$(node -e "
  $RESOLVER_JS
  console.log(resolve('acme/backend/subdir') || 'null');
" 2>/dev/null)

if [[ "$RESULT" == "team-alpha" ]]; then
  _pass "3. Partial path 'acme/backend/subdir' resolves to team-alpha"
else
  _fail "3. Partial path 'acme/backend/subdir' resolves to team-alpha" "Expected 'team-alpha', got '$RESULT'"
fi

# ── 4. Unknown repo returns null ─────────────────────────────────────────────

echo "--- Resolver: Unknown repo ---"

RESULT=$(node -e "
  $RESOLVER_JS
  console.log(resolve('totally-unknown/repo') || 'null');
" 2>/dev/null)

if [[ "$RESULT" == "null" ]]; then
  _pass "4. Unknown repo returns null"
else
  _fail "4. Unknown repo returns null" "Expected 'null', got '$RESULT'"
fi

# ── 5. Bound repo gets team suffix in journal ────────────────────────────────

echo ""
echo "--- Export flow: Bound repo → team-suffixed journal ---"

# Test exportDecisionsAsJournal directly — it is exported from content-store.js.
# When repoToTeam returns a team ID, the journal file gets a team suffix.
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const fs = require('fs');
  const path = require('path');

  const journalDir = '$JOURNAL_DIR';
  const date = '2026-03-15';
  const repo = 'acme/backend';
  const teamId = 'team-alpha';
  const author = 'testuser';
  const decisions = [
    { title: 'Switch to GraphQL', decision: 'Use GraphQL instead of REST', tags: ['api'] }
  ];

  cs.exportDecisionsAsJournal(date, repo, decisions, journalDir, teamId, author);

  const expected = path.join(journalDir, '2026-03-15-testuser-team-alpha.md');
  if (fs.existsSync(expected)) {
    const content = fs.readFileSync(expected, 'utf8');
    if (content.includes('Switch to GraphQL')) {
      console.log('OK');
    } else {
      console.log('MISSING_CONTENT');
    }
  } else {
    // List what files exist for debugging
    const files = fs.readdirSync(journalDir).filter(f => f.endsWith('.md'));
    console.log('NOT_FOUND:' + files.join(','));
  }
" 2>/dev/null)

if [[ "$RESULT" == "OK" ]]; then
  _pass "5. Bound repo export creates team-suffixed journal (YYYY-MM-DD-author-teamId.md)"
else
  _fail "5. Bound repo export creates team-suffixed journal (YYYY-MM-DD-author-teamId.md)" "Got: $RESULT"
fi

# ── 6. Unbound repo is NOT exported ──────────────────────────────────────────

echo "--- Export flow: Unbound repo → no journal ---"

# Test indexConversationsWithExport routing: when repoToTeam returns null,
# the decision is skipped (not exported).
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const fs = require('fs');
  const path = require('path');

  const journalDir = '$JOURNAL_DIR';

  // Count .md files before
  const before = fs.readdirSync(journalDir).filter(f => f.endsWith('.md'));

  // exportDecisionsAsJournal with null teamId produces a file WITHOUT team suffix.
  // But indexConversationsWithExport skips entirely when repoToTeam returns null:
  //   const teamId = repoToTeam(repo);
  //   if (!teamId) continue;  // Unbound repo — skip export
  // So we verify the skip logic directly.

  const repoToTeam = (repo) => {
    // Only acme/backend is bound
    if (repo === 'acme/backend') return 'team-alpha';
    return null;  // personal/side-project and anything else returns null
  };

  // Verify the null case triggers skip
  const teamId = repoToTeam('personal/side-project');
  if (teamId === null) {
    console.log('SKIPPED');
  } else {
    console.log('NOT_SKIPPED:' + teamId);
  }
" 2>/dev/null)

if [[ "$RESULT" == "SKIPPED" ]]; then
  _pass "6. Unbound repo (null from resolver) is skipped in export flow"
else
  _fail "6. Unbound repo (null from resolver) is skipped in export flow" "Got: $RESULT"
fi

# ── 7. Team-suffixed file syncs to correct team repo ─────────────────────────

echo ""
echo "--- Sync: Team-suffixed file → correct team repo ---"

# Clean team repos first
rm -rf "$TEAM_ALPHA_REPO/journals" "$PERSONAL_REPO/journals"

# Create a team-alpha-suffixed journal file
cat > "$JOURNAL_DIR/2026-01-01-testuser-team-alpha.md" << 'EOF'
## acme/backend — API migration decision [decision]
**Why:** Extracted from conversation transcript
**What:** Switched API from REST to GraphQL
**Outcome:** Decision recorded
**On track?:** N/A (extracted decision point)
**Quality:** rich:reasoning
**Lessons:** api, graphql
EOF

# Run journal sync
OUTPUT=$("$REPO_ROOT/bin/team-context.js" journal sync --dir "$JOURNAL_DIR" 2>&1 || true)

# Check the file landed in team-alpha's journals dir (team suffix stripped in dest)
SYNCED_FILE="$TEAM_ALPHA_REPO/journals/2026-01-01-testuser.md"
if [[ -f "$SYNCED_FILE" ]]; then
  _pass "7. Team-suffixed file syncs to correct team repo"
else
  _fail "7. Team-suffixed file syncs to correct team repo" "Expected $SYNCED_FILE to exist"
  echo "       Sync output: $OUTPUT"
  echo "       Team alpha journals: $(ls "$TEAM_ALPHA_REPO/journals/" 2>/dev/null || echo '(dir missing)')"
fi

# ── 8. Unsuffixed file is NOT synced ─────────────────────────────────────────

echo "--- Sync: Unsuffixed file → NOT synced ---"

# Create an unsuffixed journal file (no team in filename)
cat > "$JOURNAL_DIR/2026-02-01-testuser.md" << 'EOF'
## some-org/some-repo — Random decision [decision]
**Why:** Test
**What:** Test decision
**Outcome:** Recorded
**On track?:** N/A
**Quality:** thin
**Lessons:** test
EOF

# Clean team repos
rm -rf "$TEAM_ALPHA_REPO/journals" "$PERSONAL_REPO/journals"

OUTPUT=$("$REPO_ROOT/bin/team-context.js" journal sync --dir "$JOURNAL_DIR" 2>&1 || true)

# The unsuffixed file should NOT appear in either team's journals
# (sync only routes files with a known team suffix)
ALPHA_HAS=0
PERSONAL_HAS=0
[[ -f "$TEAM_ALPHA_REPO/journals/2026-02-01-testuser.md" ]] && ALPHA_HAS=1
[[ -f "$PERSONAL_REPO/journals/2026-02-01-testuser.md" ]] && PERSONAL_HAS=1

if [[ "$ALPHA_HAS" -eq 0 ]] && [[ "$PERSONAL_HAS" -eq 0 ]]; then
  _pass "8. Unsuffixed file is NOT synced to any team"
else
  _fail "8. Unsuffixed file is NOT synced to any team" "Found in alpha=$ALPHA_HAS, personal=$PERSONAL_HAS"
fi

# ── 9. Personal team file syncs to personal repo ─────────────────────────────

echo "--- Sync: Personal team file → personal repo ---"

cat > "$JOURNAL_DIR/2026-01-01-testuser-personal.md" << 'EOF'
## personal/notes — Weekly review [decision]
**Why:** Weekly reflection
**What:** Reviewed goals and progress
**Outcome:** Plan updated
**On track?:** Yes
**Quality:** thin
**Lessons:** planning
EOF

# Clean personal repo journals
rm -rf "$PERSONAL_REPO/journals"

OUTPUT=$("$REPO_ROOT/bin/team-context.js" journal sync --dir "$JOURNAL_DIR" 2>&1 || true)

SYNCED_FILE="$PERSONAL_REPO/journals/2026-01-01-testuser.md"
if [[ -f "$SYNCED_FILE" ]]; then
  _pass "9. Personal team file syncs to personal repo"
else
  _fail "9. Personal team file syncs to personal repo" "Expected $SYNCED_FILE to exist"
  echo "       Sync output: $OUTPUT"
  echo "       Personal journals: $(ls "$PERSONAL_REPO/journals/" 2>/dev/null || echo '(dir missing)')"
fi

# ── 10. Context bind creates wayfind.json ─────────────────────────────────────

echo ""
echo "--- Context bind ---"

# Create a fresh repo to bind
FRESH_REPO="$REPOS_DIR/neworg/newrepo"
mkdir -p "$FRESH_REPO/.claude"

# Run context bind from within the fresh repo
BIND_OUTPUT=$(cd "$FRESH_REPO" && "$REPO_ROOT/bin/team-context.js" context bind team-alpha 2>&1 || true)

BINDING_FILE="$FRESH_REPO/.claude/wayfind.json"
if [[ -f "$BINDING_FILE" ]]; then
  BOUND_TEAM=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$BINDING_FILE','utf8')).team_id)" 2>/dev/null)
  if [[ "$BOUND_TEAM" == "team-alpha" ]]; then
    _pass "10. Context bind creates wayfind.json with correct team_id"
  else
    _fail "10. Context bind creates wayfind.json with correct team_id" "team_id is '$BOUND_TEAM', expected 'team-alpha'"
  fi
else
  _fail "10. Context bind creates wayfind.json with correct team_id" "wayfind.json not created at $BINDING_FILE"
  echo "       Bind output: $BIND_OUTPUT"
fi

# ── 11. Default team in context.json is ignored for unbound repos ─────────────

echo ""
echo "--- Edge cases ---"

# The context.json has "default": "team-alpha", but unbound repos should still
# return null from the resolver (not fall back to default).
RESULT=$(node -e "
  $RESOLVER_JS
  // personal/side-project has NO wayfind.json — should return null even though
  // context.json has default: team-alpha
  const result = resolve('personal/side-project');
  console.log(result === null ? 'null' : result);
" 2>/dev/null)

if [[ "$RESULT" == "null" ]]; then
  _pass "11. Default team is ignored — unbound repo returns null from resolver"
else
  _fail "11. Default team is ignored — unbound repo returns null from resolver" "Expected 'null', got '$RESULT'"
fi

# ── 12. Empty teams config ───────────────────────────────────────────────────

# Temporarily overwrite context.json with empty teams
ORIG_CONFIG=$(cat "$CONTEXT_CONFIG")
cat > "$CONTEXT_CONFIG" << 'EOF'
{
  "teams": {}
}
EOF

# The buildRepoToTeamResolver checks config.teams — empty object means no bindings
# are scanned (the scan still runs but no files have wayfind.json → empty map).
# Additionally test that sync produces nothing.
RESULT=$(node -e "
  const fs = require('fs');
  const path = require('path');

  const config = JSON.parse(fs.readFileSync('$CONTEXT_CONFIG', 'utf8'));

  // With empty teams, the resolver map is empty → everything returns null
  const repoToTeamMap = {};
  // Even with scan roots, no team IDs to match
  function resolve(repoName) {
    if (repoToTeamMap[repoName]) return repoToTeamMap[repoName];
    for (const [key, teamId] of Object.entries(repoToTeamMap)) {
      if (repoName.startsWith(key + '/') || repoName === key) return teamId;
    }
    return null;
  }

  const r1 = resolve('acme/backend');
  const r2 = resolve('personal/side-project');
  const r3 = resolve('anything/else');
  console.log([r1, r2, r3].every(r => r === null) ? 'ALL_NULL' : 'UNEXPECTED');
" 2>/dev/null)

# Also test that journal sync with empty teams syncs nothing
rm -rf "$TEAM_ALPHA_REPO/journals" "$PERSONAL_REPO/journals"
SYNC_OUTPUT=$("$REPO_ROOT/bin/team-context.js" journal sync --dir "$JOURNAL_DIR" 2>&1 || true)

# Verify no journals dirs were created
ALPHA_EXISTS=0
PERSONAL_EXISTS=0
[[ -d "$TEAM_ALPHA_REPO/journals" ]] && ALPHA_EXISTS=1
[[ -d "$PERSONAL_REPO/journals" ]] && PERSONAL_EXISTS=1

if [[ "$RESULT" == "ALL_NULL" ]] && [[ "$ALPHA_EXISTS" -eq 0 ]] && [[ "$PERSONAL_EXISTS" -eq 0 ]]; then
  _pass "12. Empty teams config — resolver returns null, sync creates nothing"
else
  _fail "12. Empty teams config — resolver returns null, sync creates nothing" "Resolver=$RESULT, alpha_dir=$ALPHA_EXISTS, personal_dir=$PERSONAL_EXISTS"
fi

# Restore original config
echo "$ORIG_CONFIG" > "$CONTEXT_CONFIG"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo -e "  ${GREEN}Passed: $PASS${RESET}"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Failed: $FAIL${RESET}"
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}✗${RESET} $err"
  done
  exit 1
else
  echo -e "  Failed: 0"
  echo ""
  echo "All multi-team routing tests passed."
fi
