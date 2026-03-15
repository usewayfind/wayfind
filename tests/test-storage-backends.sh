#!/usr/bin/env bash
# Tests for storage backend abstraction (bin/storage/)
# Covers: JSON backend, SQLite backend, backend selector, JSON→SQLite migration
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

ORIG_HOME="$HOME"
TEST_HOME=$(mktemp -d)
export HOME="$TEST_HOME"
cleanup() { export HOME="$ORIG_HOME"; rm -rf "$TEST_HOME"; }
trap cleanup EXIT

export TEAM_CONTEXT_SIMULATE=1

# Create journal fixtures
JOURNAL_DIR="$TEST_HOME/.claude/memory/journal"
mkdir -p "$JOURNAL_DIR"

cat > "$JOURNAL_DIR/2026-02-24.md" << 'EOF'
## Wayfind — Implement signal connectors
**Why:** Build the first signal channel connector
**What:** Implemented full GitHub connector via 3 parallel agents
**Outcome:** GitHub signal connector fully operational
**On track?:** Yes — plan executed cleanly
**Lessons:** Parallel agent merge requires integration testing

## Admin — Weekly planning
**Why:** Plan the week ahead
**What:** Reviewed backlog, prioritized items
**Outcome:** Plan set for the week
**On track?:** Focused session
**Lessons:** Keep planning sessions under 30 minutes
EOF

cat > "$JOURNAL_DIR/2026-02-25.md" << 'EOF'
## Wayfind — Digest engine
**Why:** Complete the PLG vertical slice
**What:** Built 3 new modules
**Outcome:** Full vertical slice working
**On track?:** Yes
**Lessons:** Parallel agents work well
EOF

# ── 1. JSON Backend ──────────────────────────────────────────────────────────

echo ""
echo "1. JSON Backend"
echo "================"

JSON_STORE="$TEST_HOME/json-store"

echo ""
echo "Test: JSON backend creates files"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=json node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({ journalDir: '$JOURNAL_DIR', storePath: '$JSON_STORE' }).then(stats => {
    console.log('COUNT:' + stats.entryCount);
  });
")
if echo "$RESULT" | grep -qF "COUNT:3"; then
    _pass "JSON backend indexes 3 entries"
else
    _fail "JSON backend indexes 3 entries" "Got: $RESULT"
fi

if [ -f "$JSON_STORE/index.json" ]; then
    _pass "JSON backend creates index.json"
else
    _fail "JSON backend creates index.json" "File not found"
fi

echo ""
echo "Test: JSON backend search works"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=json node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const results = cs.searchText('signal connectors', { storePath: '$JSON_STORE', journalDir: '$JOURNAL_DIR' });
  console.log('COUNT:' + results.length);
")
if echo "$RESULT" | grep -q "COUNT:[1-9]"; then
    _pass "JSON backend searchText"
else
    _fail "JSON backend searchText" "Got: $RESULT"
fi

echo ""
echo "Test: JSON backend getBackendType"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=json node -e "
  const { getBackend, getBackendType } = require('$REPO_ROOT/bin/storage');
  getBackend('$JSON_STORE');
  console.log('TYPE:' + getBackendType('$JSON_STORE'));
")
if echo "$RESULT" | grep -qF "TYPE:json"; then
    _pass "JSON backend type is 'json'"
else
    _fail "JSON backend type is 'json'" "Got: $RESULT"
fi

# ── 2. SQLite Backend ────────────────────────────────────────────────────────

echo ""
echo "2. SQLite Backend"
echo "=================="

# Check if better-sqlite3 is available
SQLITE_AVAILABLE=false
if node -e "require('better-sqlite3')" 2>/dev/null; then
    SQLITE_AVAILABLE=true
fi

if [ "$SQLITE_AVAILABLE" = "false" ]; then
    echo "  (skipping SQLite tests — better-sqlite3 not installed)"
else

SQLITE_STORE="$TEST_HOME/sqlite-store"

echo ""
echo "Test: SQLite backend creates DB"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=sqlite node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({ journalDir: '$JOURNAL_DIR', storePath: '$SQLITE_STORE' }).then(stats => {
    console.log('COUNT:' + stats.entryCount);
  });
")
if echo "$RESULT" | grep -qF "COUNT:3"; then
    _pass "SQLite backend indexes 3 entries"
else
    _fail "SQLite backend indexes 3 entries" "Got: $RESULT"
fi

if [ -f "$SQLITE_STORE/content-store.db" ]; then
    _pass "SQLite backend creates content-store.db"
else
    _fail "SQLite backend creates content-store.db" "File not found"
fi

echo ""
echo "Test: SQLite DB file permissions"
PERMS=$(stat -c '%a' "$SQLITE_STORE/content-store.db" 2>/dev/null || echo "unknown")
if [ "$PERMS" = "600" ]; then
    _pass "SQLite DB permissions 600"
else
    _fail "SQLite DB permissions 600" "Expected 600, got: $PERMS"
fi

echo ""
echo "Test: SQLite backend search works"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=sqlite node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const results = cs.searchText('signal connectors', { storePath: '$SQLITE_STORE', journalDir: '$JOURNAL_DIR' });
  console.log('COUNT:' + results.length);
")
if echo "$RESULT" | grep -q "COUNT:[1-9]"; then
    _pass "SQLite backend searchText"
else
    _fail "SQLite backend searchText" "Got: $RESULT"
fi

echo ""
echo "Test: SQLite backend getBackendType"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=sqlite node -e "
  const { getBackend, getBackendType, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  getBackend('$SQLITE_STORE');
  console.log('TYPE:' + getBackendType('$SQLITE_STORE'));
")
if echo "$RESULT" | grep -qF "TYPE:sqlite"; then
    _pass "SQLite backend type is 'sqlite'"
else
    _fail "SQLite backend type is 'sqlite'" "Got: $RESULT"
fi

echo ""
echo "Test: SQLite WAL mode enabled"
RESULT=$(node -e "
  const Database = require('better-sqlite3');
  const db = new Database('$SQLITE_STORE/content-store.db', { readonly: true });
  const mode = db.pragma('journal_mode', { simple: true });
  console.log('MODE:' + mode);
  db.close();
")
if echo "$RESULT" | grep -qF "MODE:wal"; then
    _pass "SQLite WAL mode"
else
    _fail "SQLite WAL mode" "Got: $RESULT"
fi

echo ""
echo "Test: SQLite schema version"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=sqlite node -e "
  const { getBackend, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const b = getBackend('$SQLITE_STORE');
  console.log('VERSION:' + b.getSchemaVersion());
")
if echo "$RESULT" | grep -qF "VERSION:1"; then
    _pass "SQLite schema version is 1"
else
    _fail "SQLite schema version is 1" "Got: $RESULT"
fi

# ── 3. Migration: JSON → SQLite ─────────────────────────────────────────────

echo ""
echo "3. JSON → SQLite Migration"
echo "==========================="

MIGRATION_STORE="$TEST_HOME/migration-store"
mkdir -p "$MIGRATION_STORE"

echo ""
echo "Test: index with JSON first, then migrate to SQLite"
# Step 1: Index with JSON
TEAM_CONTEXT_STORAGE_BACKEND=json TEAM_CONTEXT_SIMULATE=1 node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({ journalDir: '$JOURNAL_DIR', storePath: '$MIGRATION_STORE' }).then(stats => {
    console.log('JSON_COUNT:' + stats.entryCount);
  });
"

JSON_COUNT=$(TEAM_CONTEXT_STORAGE_BACKEND=json node -e "
  const { getBackend, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const index = getBackend('$MIGRATION_STORE').loadIndex();
  console.log(index ? index.entryCount : 0);
")

# Step 2: Switch to SQLite — should auto-migrate
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=sqlite node -e "
  const { getBackend, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const b = getBackend('$MIGRATION_STORE');
  const index = b.loadIndex();
  console.log('SQLITE_COUNT:' + index.entryCount);
" 2>&1)

SQLITE_COUNT=$(echo "$RESULT" | grep -oP 'SQLITE_COUNT:\K\d+' || echo "0")
if [ "$SQLITE_COUNT" = "$JSON_COUNT" ] && [ "$SQLITE_COUNT" -gt 0 ]; then
    _pass "migration preserves entry count ($SQLITE_COUNT entries)"
else
    _fail "migration preserves entry count" "JSON=$JSON_COUNT, SQLite=$SQLITE_COUNT"
fi

if echo "$RESULT" | grep -qF "Migrated"; then
    _pass "migration logged to stderr"
else
    _fail "migration logged to stderr" "No migration message found"
fi

echo ""
echo "Test: migration is idempotent"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=sqlite node -e "
  const { getBackend, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const b = getBackend('$MIGRATION_STORE');
  const index = b.loadIndex();
  console.log('COUNT:' + index.entryCount);
" 2>&1)
SECOND_COUNT=$(echo "$RESULT" | grep -oP 'COUNT:\K\d+' || echo "0")
if [ "$SECOND_COUNT" = "$SQLITE_COUNT" ]; then
    _pass "idempotent migration (same count: $SECOND_COUNT)"
else
    _fail "idempotent migration" "First=$SQLITE_COUNT, Second=$SECOND_COUNT"
fi

# Should NOT print migration message again
if echo "$RESULT" | grep -qF "Migrated"; then
    _fail "no double migration" "Migration ran again"
else
    _pass "no double migration"
fi

echo ""
echo "Test: JSON files preserved after migration"
if [ -f "$MIGRATION_STORE/index.json" ]; then
    _pass "index.json preserved"
else
    _fail "index.json preserved" "File deleted"
fi

echo ""
echo "Test: content hashes match after migration"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=sqlite node -e "
  const { getBackend, clearCache } = require('$REPO_ROOT/bin/storage');
  const JsonBackend = require('$REPO_ROOT/bin/storage/json-backend');
  clearCache();

  const jsonB = new JsonBackend('$MIGRATION_STORE');
  jsonB.open();
  const jsonIndex = jsonB.loadIndex();

  clearCache();
  const sqliteB = getBackend('$MIGRATION_STORE');
  const sqliteIndex = sqliteB.loadIndex();

  let match = true;
  for (const [id, entry] of Object.entries(jsonIndex.entries)) {
    const sqlEntry = sqliteIndex.entries[id];
    if (!sqlEntry || sqlEntry.contentHash !== entry.contentHash) {
      match = false;
      console.log('MISMATCH:' + id);
    }
  }
  console.log('HASHES_MATCH:' + match);
")
if echo "$RESULT" | grep -qF "HASHES_MATCH:true"; then
    _pass "content hashes match"
else
    _fail "content hashes match" "Got: $RESULT"
fi

# ── 4. Rollback to JSON ──────────────────────────────────────────────────────

echo ""
echo "4. Rollback to JSON"
echo "===================="

echo ""
echo "Test: can switch back to JSON after migration"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=json node -e "
  const { getBackend, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const b = getBackend('$MIGRATION_STORE');
  const index = b.loadIndex();
  console.log('COUNT:' + (index ? index.entryCount : 0));
")
if echo "$RESULT" | grep -q "COUNT:[1-9]"; then
    _pass "rollback to JSON works"
else
    _fail "rollback to JSON works" "Got: $RESULT"
fi

# ── 5. Backend comparison ────────────────────────────────────────────────────

echo ""
echo "5. Backend output comparison"
echo "============================="

echo ""
echo "Test: insights output identical on both backends"
JSON_INSIGHTS=$(TEAM_CONTEXT_STORAGE_BACKEND=json node -e "
  const { clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const i = cs.extractInsights({ storePath: '$MIGRATION_STORE' });
  console.log(JSON.stringify({ total: i.totalSessions, drift: i.driftRate, repos: Object.keys(i.repoActivity).sort() }));
")
SQLITE_INSIGHTS=$(TEAM_CONTEXT_STORAGE_BACKEND=sqlite node -e "
  const { clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const i = cs.extractInsights({ storePath: '$MIGRATION_STORE' });
  console.log(JSON.stringify({ total: i.totalSessions, drift: i.driftRate, repos: Object.keys(i.repoActivity).sort() }));
")
if [ "$JSON_INSIGHTS" = "$SQLITE_INSIGHTS" ]; then
    _pass "insights output identical"
else
    _fail "insights output identical" "JSON=$JSON_INSIGHTS, SQLite=$SQLITE_INSIGHTS"
fi

fi # end SQLITE_AVAILABLE check

# ── 6. Auto-detection ────────────────────────────────────────────────────────

echo ""
echo "6. Auto-detection"
echo "=================="

echo ""
echo "Test: auto-detects available backend"
RESULT=$(node -e "
  const { getBackend, getBackendType, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const store = '$TEST_HOME/auto-store';
  getBackend(store);
  console.log('TYPE:' + getBackendType(store));
" 2>/dev/null)
if echo "$RESULT" | grep -qE "TYPE:(json|sqlite)"; then
    _pass "auto-detection works"
else
    _fail "auto-detection works" "Got: $RESULT"
fi

echo ""
echo "Test: clearCache closes backends"
RESULT=$(node -e "
  const { getBackend, getBackendType, clearCache } = require('$REPO_ROOT/bin/storage');
  const store = '$TEST_HOME/clear-store';
  getBackend(store);
  clearCache();
  console.log('TYPE:' + getBackendType(store));
")
if echo "$RESULT" | grep -qF "TYPE:null"; then
    _pass "clearCache clears backends"
else
    _fail "clearCache clears backends" "Got: $RESULT"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "================================"
echo "  Results: $PASS passed, $FAIL failed"
if [ ${#ERRORS[@]} -gt 0 ]; then
    for err in "${ERRORS[@]}"; do
        echo -e "    ${RED}$err${RESET}"
    done
fi
echo "================================"
[ "$FAIL" -eq 0 ]
