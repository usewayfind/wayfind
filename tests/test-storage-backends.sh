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

# ── 7. Backend fallback behavior ─────────────────────────────────────────────

echo ""
echo "7. Backend fallback behavior"
echo "============================="

if [ "$SQLITE_AVAILABLE" = "true" ]; then

echo ""
echo "Test: SQLite available → SQLite is used (auto-detect)"
RESULT=$(node -e "
  const { getBackend, getBackendType, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const store = '$TEST_HOME/fallback-auto-store';
  getBackend(store);
  const type = getBackendType(store);
  console.log('TYPE:' + type);
")
if echo "$RESULT" | grep -qF "TYPE:sqlite"; then
    _pass "auto-detect selects SqliteBackend when better-sqlite3 installed"
else
    _fail "auto-detect selects SqliteBackend when better-sqlite3 installed" "Got: $RESULT"
fi

echo ""
echo "Test: Backend type reported correctly after getBackend()"
FALLBACK_TYPE_STORE="$TEST_HOME/type-report-store"
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=sqlite node -e "
  const { getBackend, getBackendType, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  getBackend('$FALLBACK_TYPE_STORE');
  console.log('SQLITE_TYPE:' + getBackendType('$FALLBACK_TYPE_STORE'));
")
if echo "$RESULT" | grep -qF "SQLITE_TYPE:sqlite"; then
    _pass "getBackendType returns 'sqlite' for SqliteBackend"
else
    _fail "getBackendType returns 'sqlite' for SqliteBackend" "Got: $RESULT"
fi
RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=json node -e "
  const { getBackend, getBackendType, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  getBackend('$FALLBACK_TYPE_STORE');
  console.log('JSON_TYPE:' + getBackendType('$FALLBACK_TYPE_STORE'));
")
if echo "$RESULT" | grep -qF "JSON_TYPE:json"; then
    _pass "getBackendType returns 'json' for JsonBackend"
else
    _fail "getBackendType returns 'json' for JsonBackend" "Got: $RESULT"
fi

fi # end SQLITE_AVAILABLE for fallback tests (part 1)

echo ""
echo "Test: SQLite .open() fails → warning logged + JSON fallback"
CORRUPT_STORE="$TEST_HOME/corrupt-store"
mkdir -p "$CORRUPT_STORE"
# Create a corrupt .db file that better-sqlite3 cannot open
echo "NOT_A_SQLITE_DATABASE" > "$CORRUPT_STORE/content-store.db"
chmod 444 "$CORRUPT_STORE/content-store.db"

RESULT=$(node -e "
  const { getBackend, getBackendType, getBackendInfo, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  // Unset forced backend so auto-detect runs
  delete process.env.TEAM_CONTEXT_STORAGE_BACKEND;
  const b = getBackend('$CORRUPT_STORE');
  console.log('TYPE:' + getBackendType('$CORRUPT_STORE'));
  const info = getBackendInfo('$CORRUPT_STORE');
  console.log('FALLBACK:' + (info ? info.fallback : 'n/a'));
" 2>"$TEST_HOME/corrupt-stderr.txt")
STDERR_OUT=$(cat "$TEST_HOME/corrupt-stderr.txt")

if echo "$STDERR_OUT" | grep -qi "warning\|fall"; then
    _pass "SQLite failure logs warning to stderr"
else
    _fail "SQLite failure logs warning to stderr" "stderr: $STDERR_OUT"
fi
if echo "$RESULT" | grep -qF "TYPE:json"; then
    _pass "SQLite failure falls back to JsonBackend"
else
    _fail "SQLite failure falls back to JsonBackend" "Got: $RESULT"
fi
# Verify operations still work on the fallback backend
RESULT=$(node -e "
  const { getBackend, clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  delete process.env.TEAM_CONTEXT_STORAGE_BACKEND;
  const b = getBackend('$CORRUPT_STORE');
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({ journalDir: '$JOURNAL_DIR', storePath: '$CORRUPT_STORE' }).then(stats => {
    console.log('COUNT:' + stats.entryCount);
  });
" 2>/dev/null)
if echo "$RESULT" | grep -q "COUNT:[1-9]"; then
    _pass "fallback JSON backend operations work"
else
    _fail "fallback JSON backend operations work" "Got: $RESULT"
fi

echo ""
echo "Test: Signal entries survive backend consistency"
SIGNAL_STORE="$TEST_HOME/signal-store"
SIGNALS_DIR="$TEST_HOME/signals"
mkdir -p "$SIGNALS_DIR/github"

cat > "$SIGNALS_DIR/github/2026-03-01.md" << 'SIGEOF'
# GitHub Activity Summary
## Pull Requests
- PR #42 merged: Add caching layer
## Issues
- Issue #55 opened: Performance regression
SIGEOF

cat > "$SIGNALS_DIR/github/2026-03-02.md" << 'SIGEOF'
# GitHub Activity Summary
## Pull Requests
- PR #43 merged: Fix auth timeout
SIGEOF

RESULT=$(TEAM_CONTEXT_STORAGE_BACKEND=json node -e "
  const { clearCache } = require('$REPO_ROOT/bin/storage');
  clearCache();
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexSignals({ signalsDir: '$SIGNALS_DIR', storePath: '$SIGNAL_STORE' }).then(() => {
    clearCache();
    const { getBackend } = require('$REPO_ROOT/bin/storage');
    process.env.TEAM_CONTEXT_STORAGE_BACKEND = 'json';
    const b = getBackend('$SIGNAL_STORE');
    const index = b.loadIndex();
    const entries = Object.values(index.entries);
    const signalEntries = entries.filter(e => e.source === 'signal');
    console.log('SIGNAL_COUNT:' + signalEntries.length);
    console.log('TOTAL_ENTRIES:' + entries.length);
    // Verify each signal entry has the right source
    const allSignal = signalEntries.every(e => e.source === 'signal');
    console.log('ALL_SIGNAL:' + allSignal);
  });
")
SIGNAL_COUNT=$(echo "$RESULT" | grep -oP 'SIGNAL_COUNT:\K\d+' || echo "0")
if [ "$SIGNAL_COUNT" = "2" ]; then
    _pass "signal entries present with source:'signal' (count: $SIGNAL_COUNT)"
else
    _fail "signal entries present with source:'signal'" "Expected 2 signal entries, got: $SIGNAL_COUNT. Output: $RESULT"
fi
if echo "$RESULT" | grep -qF "ALL_SIGNAL:true"; then
    _pass "all signal entries have source:'signal'"
else
    _fail "all signal entries have source:'signal'" "Got: $RESULT"
fi

# ── 8. SQLite schema migration (pre-v2.0.29) ───────────────────────────────

echo ""
echo "8. SQLite schema migration (pre-v2.0.29)"
echo "=========================================="

if [ "$SQLITE_AVAILABLE" = "true" ]; then

MIGRATE_STORE="$TEST_HOME/migrate-schema-store"
mkdir -p "$MIGRATE_STORE"

echo ""
echo "Test: migration adds columns and indexes to pre-v2.0.29 database"
RESULT=$(node -e "
  const Database = require('better-sqlite3');
  const path = require('path');
  const fs = require('fs');

  const storePath = '$MIGRATE_STORE';
  const dbPath = path.join(storePath, 'content-store.db');

  // 1. Create a database with the OLD schema (no quality_score, distill_tier,
  //    distilled_from, distilled_at columns — mimics pre-v2.0.29).
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(\`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      repo TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT DEFAULT 'journal',
      user TEXT DEFAULT '',
      drifted INTEGER DEFAULT 0,
      content_hash TEXT NOT NULL,
      content_length INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      has_embedding INTEGER DEFAULT 0,
      has_reasoning INTEGER DEFAULT 0,
      has_alternatives INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_date ON decisions(date);
    CREATE INDEX IF NOT EXISTS idx_decisions_repo ON decisions(repo);
    CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source);
    CREATE INDEX IF NOT EXISTS idx_decisions_user ON decisions(user);
    INSERT INTO metadata (key, value) VALUES ('schema_version', '1');
  \`);

  // 2. Insert rows into the old-schema decisions table.
  const now = Date.now();
  db.prepare(\`
    INSERT INTO decisions (id, date, repo, title, source, user, drifted,
      content_hash, content_length, tags, has_embedding, has_reasoning,
      has_alternatives, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  \`).run('dec-001', '2026-01-15', 'my-repo', 'Use Redis for caching', 'journal', 'alice', 0,
    'abc123', 42, '[\"caching\"]', 0, 1, 0, now, now);
  db.prepare(\`
    INSERT INTO decisions (id, date, repo, title, source, user, drifted,
      content_hash, content_length, tags, has_embedding, has_reasoning,
      has_alternatives, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  \`).run('dec-002', '2026-01-16', 'my-repo', 'Switch to TypeScript', 'conversation', 'bob', 1,
    'def456', 88, '[\"typescript\",\"migration\"]', 1, 0, 1, now, now);
  db.prepare(\`
    INSERT INTO decisions (id, date, repo, title, source, user, drifted,
      content_hash, content_length, tags, has_embedding, has_reasoning,
      has_alternatives, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  \`).run('dec-003', '2026-01-17', 'other-repo', 'Add rate limiting', 'journal', 'alice', 0,
    'ghi789', 55, '[]', 0, 0, 0, now, now);

  // Verify old schema lacks the new columns.
  const colsBefore = db.prepare('PRAGMA table_info(decisions)').all().map(c => c.name);
  const missingBefore = !colsBefore.includes('quality_score')
    && !colsBefore.includes('distill_tier')
    && !colsBefore.includes('distilled_from')
    && !colsBefore.includes('distilled_at');
  console.log('MISSING_BEFORE:' + missingBefore);

  db.close();

  // 3. Open via SqliteBackend — this should trigger migration.
  const SqliteBackend = require('$REPO_ROOT/bin/storage/sqlite-backend');
  const backend = new SqliteBackend(storePath);
  backend.open();

  // 4. Verify the new columns exist.
  const colsAfter = backend.db.prepare('PRAGMA table_info(decisions)').all().map(c => c.name);
  console.log('HAS_QUALITY_SCORE:' + colsAfter.includes('quality_score'));
  console.log('HAS_DISTILL_TIER:' + colsAfter.includes('distill_tier'));
  console.log('HAS_DISTILLED_FROM:' + colsAfter.includes('distilled_from'));
  console.log('HAS_DISTILLED_AT:' + colsAfter.includes('distilled_at'));

  // 5. Verify existing data is intact.
  const rows = backend.db.prepare('SELECT * FROM decisions ORDER BY id').all();
  console.log('ROW_COUNT:' + rows.length);

  const r1 = rows.find(r => r.id === 'dec-001');
  const r2 = rows.find(r => r.id === 'dec-002');
  const r3 = rows.find(r => r.id === 'dec-003');
  console.log('R1_TITLE:' + (r1 ? r1.title : 'MISSING'));
  console.log('R1_HASH:' + (r1 ? r1.content_hash : 'MISSING'));
  console.log('R1_REASONING:' + (r1 ? r1.has_reasoning : 'MISSING'));
  console.log('R2_TITLE:' + (r2 ? r2.title : 'MISSING'));
  console.log('R2_DRIFTED:' + (r2 ? r2.drifted : 'MISSING'));
  console.log('R2_TAGS:' + (r2 ? r2.tags : 'MISSING'));
  console.log('R3_REPO:' + (r3 ? r3.repo : 'MISSING'));

  // Verify new columns have correct defaults on old rows.
  console.log('R1_QUALITY:' + (r1 ? r1.quality_score : 'MISSING'));
  console.log('R1_TIER:' + (r1 ? r1.distill_tier : 'MISSING'));
  console.log('R1_FROM:' + (r1 ? r1.distilled_from : 'MISSING'));
  console.log('R1_AT:' + (r1 ? r1.distilled_at : 'MISSING'));

  // 6. Verify indexes were created.
  const indexes = backend.db.prepare(\"SELECT name FROM sqlite_master WHERE type='index'\").all().map(r => r.name);
  console.log('HAS_IDX_QUALITY:' + indexes.includes('idx_decisions_quality'));
  console.log('HAS_IDX_TIER:' + indexes.includes('idx_decisions_tier'));

  // Verify loadIndex round-trip works on migrated DB.
  const index = backend.loadIndex();
  console.log('LOAD_COUNT:' + index.entryCount);
  const entry1 = index.entries['dec-001'];
  console.log('ENTRY1_TITLE:' + (entry1 ? entry1.title : 'MISSING'));
  console.log('ENTRY1_QUALITY:' + (entry1 ? entry1.qualityScore : 'MISSING'));
  console.log('ENTRY1_TIER:' + (entry1 ? entry1.distillTier : 'MISSING'));

  backend.close();
")

# Column existence checks
if echo "$RESULT" | grep -qF "MISSING_BEFORE:true"; then
    _pass "old schema lacks new columns before migration"
else
    _fail "old schema lacks new columns before migration" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "HAS_QUALITY_SCORE:true"; then
    _pass "migration adds quality_score column"
else
    _fail "migration adds quality_score column" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "HAS_DISTILL_TIER:true"; then
    _pass "migration adds distill_tier column"
else
    _fail "migration adds distill_tier column" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "HAS_DISTILLED_FROM:true"; then
    _pass "migration adds distilled_from column"
else
    _fail "migration adds distilled_from column" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "HAS_DISTILLED_AT:true"; then
    _pass "migration adds distilled_at column"
else
    _fail "migration adds distilled_at column" "Got: $RESULT"
fi

# Data integrity checks
if echo "$RESULT" | grep -qF "ROW_COUNT:3"; then
    _pass "all 3 rows survived migration"
else
    _fail "all 3 rows survived migration" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "R1_TITLE:Use Redis for caching"; then
    _pass "row 1 title intact"
else
    _fail "row 1 title intact" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "R1_HASH:abc123"; then
    _pass "row 1 content_hash intact"
else
    _fail "row 1 content_hash intact" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "R1_REASONING:1"; then
    _pass "row 1 has_reasoning intact"
else
    _fail "row 1 has_reasoning intact" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "R2_TITLE:Switch to TypeScript"; then
    _pass "row 2 title intact"
else
    _fail "row 2 title intact" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "R2_DRIFTED:1"; then
    _pass "row 2 drifted flag intact"
else
    _fail "row 2 drifted flag intact" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF 'R2_TAGS:["typescript","migration"]'; then
    _pass "row 2 tags intact"
else
    _fail "row 2 tags intact" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "R3_REPO:other-repo"; then
    _pass "row 3 repo intact"
else
    _fail "row 3 repo intact" "Got: $RESULT"
fi

# New column defaults on old rows
if echo "$RESULT" | grep -qF "R1_QUALITY:0"; then
    _pass "quality_score defaults to 0"
else
    _fail "quality_score defaults to 0" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "R1_TIER:raw"; then
    _pass "distill_tier defaults to 'raw'"
else
    _fail "distill_tier defaults to 'raw'" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "R1_FROM:null"; then
    _pass "distilled_from defaults to null"
else
    _fail "distilled_from defaults to null" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "R1_AT:null"; then
    _pass "distilled_at defaults to null"
else
    _fail "distilled_at defaults to null" "Got: $RESULT"
fi

# Index checks
if echo "$RESULT" | grep -qF "HAS_IDX_QUALITY:true"; then
    _pass "idx_decisions_quality index created"
else
    _fail "idx_decisions_quality index created" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "HAS_IDX_TIER:true"; then
    _pass "idx_decisions_tier index created"
else
    _fail "idx_decisions_tier index created" "Got: $RESULT"
fi

# loadIndex round-trip
if echo "$RESULT" | grep -qF "LOAD_COUNT:3"; then
    _pass "loadIndex returns 3 entries after migration"
else
    _fail "loadIndex returns 3 entries after migration" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "ENTRY1_TITLE:Use Redis for caching"; then
    _pass "loadIndex entry title correct after migration"
else
    _fail "loadIndex entry title correct after migration" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "ENTRY1_QUALITY:0"; then
    _pass "loadIndex entry qualityScore correct after migration"
else
    _fail "loadIndex entry qualityScore correct after migration" "Got: $RESULT"
fi
if echo "$RESULT" | grep -qF "ENTRY1_TIER:raw"; then
    _pass "loadIndex entry distillTier correct after migration"
else
    _fail "loadIndex entry distillTier correct after migration" "Got: $RESULT"
fi

else
    echo "  (skipping schema migration tests — better-sqlite3 not installed)"
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
