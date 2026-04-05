#!/usr/bin/env bash
# Tests for content store module (bin/content-store.js)
# Covers: journal parsing, content hashing, incremental indexing, semantic search,
#         full-text search, metadata queries, insights, CLI integration, edge cases.
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

# Create journal fixtures
JOURNAL_DIR="$TEST_HOME/.claude/memory/journal"
STORE_DIR="$TEST_HOME/.claude/team-context/content-store"
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
## Wayfind — Digest engine and Slack delivery
**Why:** Complete the PLG vertical slice
**What:** Built 3 new modules (llm.js, digest.js, slack.js)
**Outcome:** Full vertical slice working end-to-end
**On track?:** Yes — focused session
**Lessons:** Wave 1 parallel agents work well for independent modules

## analytics-infrastructure — Monthly refresh fixes
**Why:** Fix overnight refresh failures
**What:** Fixed VECTOR column chain-break and timeout issues
**Outcome:** Monthly refresh working, root causes fixed
**On track?:** Yes — methodical post-mortem
**Lessons:** Queue retry behavior is dangerous with swap operations
EOF

cat > "$JOURNAL_DIR/2026-02-26.md" << 'EOF'
## Wayfind — Code review and bug fixes
**Why:** Review digest engine code quality
**What:** Swarmed 5 parallel review agents, fixed 11 bugs
**Outcome:** v1.3.0 released, real digests delivered to Slack
**On track?:** Drifted slightly into scope creep on Slack formatting
**Lessons:** 5-agent parallel review catches different bug classes
EOF

# ── 1. Journal parsing ─────────────────────────────────────────────────────

echo ""
echo "1. Journal parsing"
echo "==================="

echo ""
echo "Test: parseJournalFile extracts multiple entries"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const result = cs.parseJournalFile('$JOURNAL_DIR/2026-02-24.md');
  console.log('DATE:' + result.date);
  console.log('COUNT:' + result.entries.length);
")
if echo "$RESULT" | grep -qF "DATE:2026-02-24" && echo "$RESULT" | grep -qF "COUNT:2"; then
    _pass "multi-entry parsing"
else
    _fail "multi-entry parsing" "Expected date=2026-02-24 count=2, got: $RESULT"
fi

echo ""
echo "Test: parseJournalFile extracts correct fields"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const result = cs.parseJournalFile('$JOURNAL_DIR/2026-02-24.md');
  const e = result.entries[0];
  console.log('REPO:' + e.repo);
  console.log('TITLE:' + e.title);
  console.log('WHY:' + e.fields.why);
  console.log('WHAT:' + (e.fields.what || '').substring(0, 30));
")
if echo "$RESULT" | grep -qF "REPO:Wayfind" && echo "$RESULT" | grep -qF "TITLE:Implement signal connectors" && echo "$RESULT" | grep -qF "WHY:Build the first signal channel"; then
    _pass "field extraction"
else
    _fail "field extraction" "Unexpected fields: $RESULT"
fi

echo ""
echo "Test: isDrifted detects drift"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  console.log('DRIFTED:' + cs.isDrifted({ onTrack: 'Drifted slightly into scope creep' }));
  console.log('NOT_DRIFTED:' + cs.isDrifted({ onTrack: 'Yes — focused session' }));
")
if echo "$RESULT" | grep -qF "DRIFTED:true" && echo "$RESULT" | grep -qF "NOT_DRIFTED:false"; then
    _pass "drift detection"
else
    _fail "drift detection" "Expected true/false, got: $RESULT"
fi

echo ""
echo "Test: isDrifted handles negation"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  console.log(cs.isDrifted({ onTrack: 'No drift at all, stayed focused' }));
")
if echo "$RESULT" | grep -qF "false"; then
    _pass "drift negation"
else
    _fail "drift negation" "Expected false for 'No drift', got: $RESULT"
fi

echo ""
echo "Test: generateEntryId is stable"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const id1 = cs.generateEntryId('2026-02-24', 'Wayfind', 'Test');
  const id2 = cs.generateEntryId('2026-02-24', 'Wayfind', 'Test');
  console.log('MATCH:' + (id1 === id2));
  console.log('LEN:' + id1.length);
")
if echo "$RESULT" | grep -qF "MATCH:true" && echo "$RESULT" | grep -qF "LEN:12"; then
    _pass "stable entry IDs"
else
    _fail "stable entry IDs" "IDs not stable: $RESULT"
fi

echo ""
echo "Test: parseJournalFile handles empty file"
touch "$JOURNAL_DIR/2026-01-01.md"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const result = cs.parseJournalFile('$JOURNAL_DIR/2026-01-01.md');
  console.log('COUNT:' + result.entries.length);
")
if echo "$RESULT" | grep -qF "COUNT:0"; then
    _pass "empty file handling"
else
    _fail "empty file handling" "Expected 0 entries, got: $RESULT"
fi

echo ""
echo "Test: extractTags extracts repo and title words"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const tags = cs.extractTags({ repo: 'Wayfind', title: 'Implement signal connectors', fields: {} });
  console.log(tags.join(','));
")
if echo "$RESULT" | grep -q "wayfind" && echo "$RESULT" | grep -q "signal"; then
    _pass "tag extraction"
else
    _fail "tag extraction" "Expected wayfind,signal in tags, got: $RESULT"
fi

# ── 2. Content hashing ─────────────────────────────────────────────────────

echo ""
echo "2. Content hashing"
echo "==================="

echo ""
echo "Test: contentHash is deterministic"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const h1 = cs.contentHash('hello world');
  const h2 = cs.contentHash('hello world');
  console.log('MATCH:' + (h1 === h2));
")
if echo "$RESULT" | grep -qF "MATCH:true"; then
    _pass "deterministic hash"
else
    _fail "deterministic hash" "Hashes don't match: $RESULT"
fi

echo ""
echo "Test: different content produces different hash"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const h1 = cs.contentHash('hello world');
  const h2 = cs.contentHash('hello world!');
  console.log('DIFFERENT:' + (h1 !== h2));
")
if echo "$RESULT" | grep -qF "DIFFERENT:true"; then
    _pass "different content different hash"
else
    _fail "different content different hash" "Hashes should differ: $RESULT"
fi

echo ""
echo "Test: contentHash returns 16 char hex"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const h = cs.contentHash('test');
  console.log('LEN:' + h.length);
  console.log('HEX:' + /^[0-9a-f]+$/.test(h));
")
if echo "$RESULT" | grep -qF "LEN:16" && echo "$RESULT" | grep -qF "HEX:true"; then
    _pass "hash format"
else
    _fail "hash format" "Expected 16 char hex, got: $RESULT"
fi

# ── 3. Incremental indexing ─────────────────────────────────────────────────

echo ""
echo "3. Incremental indexing"
echo "========================"

echo ""
echo "Test: indexJournals creates store files"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({
    journalDir: '$JOURNAL_DIR',
    storePath: '$STORE_DIR',
  }).then(stats => {
    console.log(JSON.stringify(stats));
  }).catch(err => {
    console.log('ERROR:' + err.message);
  });
")
if echo "$RESULT" | grep -qF '"entryCount"'; then
    _pass "indexJournals creates index"
else
    _fail "indexJournals creates index" "Unexpected result: $RESULT"
fi

# Verify store was created (files for JSON, DB for SQLite)
RESULT=$(node -e "
  const { getBackend } = require('$REPO_ROOT/bin/storage');
  const b = getBackend('$STORE_DIR');
  const index = b.loadIndex();
  console.log('HAS_INDEX:' + (index !== null));
  const emb = b.loadEmbeddings();
  console.log('HAS_EMB:' + (typeof emb === 'object'));
")
if echo "$RESULT" | grep -qF "HAS_INDEX:true"; then
    _pass "store index created"
else
    _fail "store index created" "Index not found"
fi
if echo "$RESULT" | grep -qF "HAS_EMB:true"; then
    _pass "store embeddings created"
else
    _fail "store embeddings created" "Embeddings not found"
fi

echo ""
echo "Test: index has v2 schema"
RESULT=$(node -e "
  const { getBackend } = require('$REPO_ROOT/bin/storage');
  const index = getBackend('$STORE_DIR').loadIndex();
  console.log('VERSION:' + index.version);
  console.log('COUNT:' + index.entryCount);
  console.log('HAS_ENTRIES:' + (typeof index.entries === 'object'));
")
if echo "$RESULT" | grep -qF "VERSION:2.0.0" && echo "$RESULT" | grep -qF "HAS_ENTRIES:true"; then
    _pass "v2 schema"
else
    _fail "v2 schema" "Unexpected schema: $RESULT"
fi

echo ""
echo "Test: entries have correct fields"
RESULT=$(node -e "
  const { getBackend } = require('$REPO_ROOT/bin/storage');
  const index = getBackend('$STORE_DIR').loadIndex();
  const first = Object.values(index.entries)[0];
  console.log('HAS_DATE:' + (typeof first.date === 'string'));
  console.log('HAS_REPO:' + (typeof first.repo === 'string'));
  console.log('HAS_HASH:' + (typeof first.contentHash === 'string'));
  console.log('HAS_TAGS:' + Array.isArray(first.tags));
  console.log('HAS_EMBEDDING:' + (typeof first.hasEmbedding === 'boolean'));
")
if echo "$RESULT" | grep -qF "HAS_DATE:true" && echo "$RESULT" | grep -qF "HAS_HASH:true" && echo "$RESULT" | grep -qF "HAS_TAGS:true"; then
    _pass "entry field structure"
else
    _fail "entry field structure" "Missing fields: $RESULT"
fi

echo ""
echo "Test: second indexing skips unchanged entries"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({
    journalDir: '$JOURNAL_DIR',
    storePath: '$STORE_DIR',
  }).then(stats => {
    console.log('NEW:' + stats.newEntries);
    console.log('UPDATED:' + stats.updatedEntries);
    console.log('SKIPPED:' + stats.skippedEntries);
  }).catch(err => {
    console.log('ERROR:' + err.message);
  });
")
if echo "$RESULT" | grep -qF "NEW:0" && echo "$RESULT" | grep -qF "UPDATED:0"; then
    _pass "incremental skip unchanged"
else
    _fail "incremental skip unchanged" "Expected 0 new/updated, got: $RESULT"
fi

echo ""
echo "Test: modified entry gets re-indexed"
# Modify a journal file
cat >> "$JOURNAL_DIR/2026-02-24.md" << 'APPEND'

## Wayfind — Extra session added
**Why:** Test incremental detection
**What:** Added a new entry
**Outcome:** Should be detected as new
**On track?:** Yes
**Lessons:** Incremental indexing works
APPEND

RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({
    journalDir: '$JOURNAL_DIR',
    storePath: '$STORE_DIR',
  }).then(stats => {
    console.log('NEW:' + stats.newEntries);
    console.log('TOTAL:' + stats.entryCount);
  }).catch(err => {
    console.log('ERROR:' + err.message);
  });
")
if echo "$RESULT" | grep -qF "NEW:1"; then
    _pass "detects new entry"
else
    _fail "detects new entry" "Expected 1 new, got: $RESULT"
fi

echo ""
echo "Test: stale entry cleanup"
# Remove a journal file entirely
rm "$JOURNAL_DIR/2026-01-01.md"
# Create a temp file then remove it to force stale detection
cat > "$JOURNAL_DIR/2026-01-15.md" << 'EOF'
## TestRepo — Temporary entry
**Why:** Will be removed
**What:** Nothing
**Outcome:** N/A
**On track?:** Yes
**Lessons:** None
EOF

# Index with the temp file
node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({ journalDir: '$JOURNAL_DIR', storePath: '$STORE_DIR' }).then(() => {});
" 2>/dev/null

# Remove it and re-index
rm "$JOURNAL_DIR/2026-01-15.md"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({ journalDir: '$JOURNAL_DIR', storePath: '$STORE_DIR' }).then(stats => {
    console.log('REMOVED:' + stats.removedEntries);
  });
")
if echo "$RESULT" | grep -q "REMOVED:[1-9]"; then
    _pass "stale entry cleanup"
else
    _fail "stale entry cleanup" "Expected >0 removed, got: $RESULT"
fi

# ── 4. Semantic search ──────────────────────────────────────────────────────

echo ""
echo "4. Semantic search (simulation mode)"
echo "======================================"

echo ""
echo "Test: searchJournals returns results with scores"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.searchJournals('signal connectors', { storePath: '$STORE_DIR' }).then(results => {
    console.log('COUNT:' + results.length);
    if (results.length > 0) {
      console.log('HAS_SCORE:' + (typeof results[0].score === 'number'));
      console.log('HAS_ENTRY:' + (typeof results[0].entry === 'object'));
    }
  });
")
if echo "$RESULT" | grep -q "COUNT:[1-9]" && echo "$RESULT" | grep -qF "HAS_SCORE:true"; then
    _pass "semantic search returns results"
else
    _fail "semantic search returns results" "Unexpected: $RESULT"
fi

echo ""
echo "Test: searchJournals results are sorted by score"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.searchJournals('digest engine slack', { storePath: '$STORE_DIR' }).then(results => {
    let sorted = true;
    for (let i = 1; i < results.length; i++) {
      if (results[i].score > results[i-1].score) sorted = false;
    }
    console.log('SORTED:' + sorted);
  });
")
if echo "$RESULT" | grep -qF "SORTED:true"; then
    _pass "results sorted by score"
else
    _fail "results sorted by score" "Results not sorted: $RESULT"
fi

echo ""
echo "Test: searchJournals respects limit"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.searchJournals('wayfind', { storePath: '$STORE_DIR', limit: 2 }).then(results => {
    console.log('COUNT:' + results.length);
  });
")
if echo "$RESULT" | grep -qF "COUNT:2"; then
    _pass "search respects limit"
else
    _fail "search respects limit" "Expected 2, got: $RESULT"
fi

echo ""
echo "Test: searchJournals respects repo filter"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.searchJournals('fixes', { storePath: '$STORE_DIR', repo: 'analytics-infrastructure' }).then(results => {
    const allMatch = results.every(r => r.entry.repo === 'analytics-infrastructure');
    console.log('ALL_MATCH:' + allMatch);
  });
")
if echo "$RESULT" | grep -qF "ALL_MATCH:true"; then
    _pass "search respects repo filter"
else
    _fail "search respects repo filter" "Filter not applied: $RESULT"
fi

# ── 5. Full-text fallback ──────────────────────────────────────────────────

echo ""
echo "5. Full-text search"
echo "===================="

echo ""
echo "Note: searchText tests removed — text search replaced by semantic + browse fallback"

# ── 6. Metadata query ──────────────────────────────────────────────────────

echo ""
echo "6. Metadata query"
echo "=================="

echo ""
echo "Test: queryMetadata returns all entries"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const results = cs.queryMetadata({ storePath: '$STORE_DIR' });
  console.log('COUNT:' + results.length);
")
ENTRY_COUNT=$(echo "$RESULT" | grep -oP 'COUNT:\K\d+')
if [ "$ENTRY_COUNT" -gt 0 ]; then
    _pass "queryMetadata returns entries"
else
    _fail "queryMetadata returns entries" "Expected >0, got: $RESULT"
fi

echo ""
echo "Test: queryMetadata filters by repo"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const results = cs.queryMetadata({ storePath: '$STORE_DIR', repo: 'Wayfind' });
  const allMatch = results.every(r => r.entry.repo === 'Wayfind');
  console.log('ALL_MATCH:' + allMatch);
  console.log('COUNT:' + results.length);
")
if echo "$RESULT" | grep -qF "ALL_MATCH:true" && echo "$RESULT" | grep -q "COUNT:[1-9]"; then
    _pass "metadata repo filter"
else
    _fail "metadata repo filter" "Filter not applied: $RESULT"
fi

echo ""
echo "Test: queryMetadata filters by drift"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const drifted = cs.queryMetadata({ storePath: '$STORE_DIR', drifted: true });
  const notDrifted = cs.queryMetadata({ storePath: '$STORE_DIR', drifted: false });
  console.log('DRIFTED:' + drifted.length);
  console.log('NOT_DRIFTED:' + notDrifted.length);
  // All drifted entries should have drifted=true
  const allDrifted = drifted.every(r => r.entry.drifted === true);
  console.log('ALL_DRIFTED:' + allDrifted);
")
if echo "$RESULT" | grep -qF "ALL_DRIFTED:true"; then
    _pass "metadata drift filter"
else
    _fail "metadata drift filter" "Filter not applied: $RESULT"
fi

echo ""
echo "Test: queryMetadata filters by date"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const results = cs.queryMetadata({ storePath: '$STORE_DIR', since: '2026-02-25' });
  const allAfter = results.every(r => r.entry.date >= '2026-02-25');
  console.log('ALL_AFTER:' + allAfter);
  console.log('COUNT:' + results.length);
")
if echo "$RESULT" | grep -qF "ALL_AFTER:true" && echo "$RESULT" | grep -q "COUNT:[1-9]"; then
    _pass "metadata date filter"
else
    _fail "metadata date filter" "Filter not applied: $RESULT"
fi

# ── 7. Insights ─────────────────────────────────────────────────────────────

echo ""
echo "7. Insights"
echo "============"

echo ""
echo "Test: extractInsights returns total sessions"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const insights = cs.extractInsights({ storePath: '$STORE_DIR' });
  console.log('TOTAL:' + insights.totalSessions);
")
TOTAL=$(echo "$RESULT" | grep -oP 'TOTAL:\K\d+')
if [ "$TOTAL" -gt 0 ]; then
    _pass "total sessions count"
else
    _fail "total sessions count" "Expected >0, got: $RESULT"
fi

echo ""
echo "Test: extractInsights computes drift rate"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const insights = cs.extractInsights({ storePath: '$STORE_DIR' });
  console.log('RATE:' + insights.driftRate);
  console.log('IS_NUMBER:' + (typeof insights.driftRate === 'number'));
")
if echo "$RESULT" | grep -qF "IS_NUMBER:true"; then
    _pass "drift rate computation"
else
    _fail "drift rate computation" "Not a number: $RESULT"
fi

echo ""
echo "Test: extractInsights returns repo activity"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const insights = cs.extractInsights({ storePath: '$STORE_DIR' });
  console.log('HAS_WAYFIND:' + ('Wayfind' in insights.repoActivity));
  console.log('REPOS:' + Object.keys(insights.repoActivity).length);
")
if echo "$RESULT" | grep -qF "HAS_WAYFIND:true"; then
    _pass "repo activity"
else
    _fail "repo activity" "Missing Wayfind in repo activity: $RESULT"
fi

echo ""
echo "Test: extractInsights returns tag frequency"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const insights = cs.extractInsights({ storePath: '$STORE_DIR' });
  const tagCount = Object.keys(insights.tagFrequency).length;
  console.log('TAG_COUNT:' + tagCount);
")
TAG_COUNT=$(echo "$RESULT" | grep -oP 'TAG_COUNT:\K\d+')
if [ "$TAG_COUNT" -gt 0 ]; then
    _pass "tag frequency"
else
    _fail "tag frequency" "Expected >0 tags, got: $RESULT"
fi

echo ""
echo "Test: extractInsights returns timeline"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const insights = cs.extractInsights({ storePath: '$STORE_DIR' });
  console.log('TIMELINE:' + insights.timeline.length);
  if (insights.timeline.length > 0) {
    console.log('HAS_DATE:' + (typeof insights.timeline[0].date === 'string'));
    console.log('HAS_SESSIONS:' + (typeof insights.timeline[0].sessions === 'number'));
  }
")
if echo "$RESULT" | grep -q "TIMELINE:[1-9]" && echo "$RESULT" | grep -qF "HAS_DATE:true"; then
    _pass "timeline data"
else
    _fail "timeline data" "Missing timeline: $RESULT"
fi

# ── 8. CLI integration ──────────────────────────────────────────────────────

echo ""
echo "8. CLI integration"
echo "==================="

echo ""
echo "Test: index-journals command runs"
RESULT=$(node "$REPO_ROOT/bin/team-context.js" index-journals --dir "$JOURNAL_DIR" --store "$STORE_DIR" 2>&1) || true
if echo "$RESULT" | grep -qF "Indexed:" && echo "$RESULT" | grep -qF "entries"; then
    _pass "index-journals CLI command"
else
    _fail "index-journals CLI command" "Unexpected output: $RESULT"
fi

echo ""
echo "Test: search-journals command runs (text mode)"
RESULT=$(node "$REPO_ROOT/bin/team-context.js" search-journals "signal" --text --store "$STORE_DIR" 2>&1) || true
if echo "$RESULT" | grep -qF "result" || echo "$RESULT" | grep -qF "Found"; then
    _pass "search-journals CLI text mode"
else
    _fail "search-journals CLI text mode" "Unexpected output: $RESULT"
fi

echo ""
echo "Test: insights command runs (text)"
RESULT=$(node "$REPO_ROOT/bin/team-context.js" insights --store "$STORE_DIR" 2>&1) || true
if echo "$RESULT" | grep -qF "Total sessions" || echo "$RESULT" | grep -qF "Journal Insights"; then
    _pass "insights CLI text output"
else
    _fail "insights CLI text output" "Unexpected output: $RESULT"
fi

echo ""
echo "Test: insights command runs (JSON)"
RESULT=$(node "$REPO_ROOT/bin/team-context.js" insights --json --store "$STORE_DIR" 2>&1) || true
if echo "$RESULT" | grep -qF '"totalSessions"'; then
    _pass "insights CLI JSON output"
else
    _fail "insights CLI JSON output" "Unexpected output: $RESULT"
fi

# ── 9. Edge cases ───────────────────────────────────────────────────────────

echo ""
echo "9. Edge cases"
echo "=============="

echo ""
echo "Test: malformed entry (no repo separator)"
cat > "$JOURNAL_DIR/2026-01-02.md" << 'EOF'
## Just a plain heading without separator
**Why:** Test malformed
EOF

RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const result = cs.parseJournalFile('$JOURNAL_DIR/2026-01-02.md');
  console.log('COUNT:' + result.entries.length);
")
if echo "$RESULT" | grep -qF "COUNT:0"; then
    _pass "malformed entry skipped"
else
    _fail "malformed entry skipped" "Expected 0 entries, got: $RESULT"
fi

echo ""
echo "Test: missing store directory"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const results = cs.queryMetadata({ storePath: '$TEST_HOME/nonexistent-store' });
  console.log('COUNT:' + results.length);
")
if echo "$RESULT" | grep -qF "COUNT:0"; then
    _pass "missing store returns empty"
else
    _fail "missing store returns empty" "Expected empty results: $RESULT"
fi

echo ""
echo "Test: searchJournals with no index returns empty"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.searchJournals('anything', { storePath: '$TEST_HOME/no-such-store' }).then(results => {
    console.log('COUNT:' + results.length);
  });
")
if echo "$RESULT" | grep -qF "COUNT:0"; then
    _pass "searchJournals no index returns empty"
else
    _fail "searchJournals no index returns empty" "Expected empty: $RESULT"
fi

echo ""
echo "Test: file permissions are restricted"
# Check whichever file exists: index.json (JSON backend) or content-store.db (SQLite)
STORE_FILE=""
if [ -f "$STORE_DIR/index.json" ]; then
    STORE_FILE="$STORE_DIR/index.json"
elif [ -f "$STORE_DIR/content-store.db" ]; then
    STORE_FILE="$STORE_DIR/content-store.db"
fi
if [ -n "$STORE_FILE" ]; then
    PERMS=$(stat -c '%a' "$STORE_FILE" 2>/dev/null || stat -f '%Lp' "$STORE_FILE" 2>/dev/null || echo "unknown")
    if [ "$PERMS" = "600" ]; then
        _pass "file permissions 600"
    else
        _fail "file permissions 600" "Expected 600, got: $PERMS"
    fi
else
    _fail "file permissions 600" "No store file found"
fi

# Clean up test malformed file
rm -f "$JOURNAL_DIR/2026-01-02.md"

# ── 10. Author attribution ────────────────────────────────────────────────────

echo ""
echo "10. Author attribution"
echo "======================="

# Create authored journal fixtures
cat > "$JOURNAL_DIR/2026-03-01-greg.md" << 'EOF'
## Wayfind — Author attribution feature
**Why:** Enable per-person journal filtering
**What:** Added author field to journal entries
**Outcome:** Authors are now tracked
**On track?:** Yes — focused
**Lessons:** Filename-based author works well
EOF

cat > "$JOURNAL_DIR/2026-03-01-nick.md" << 'EOF'
## ReportService — Fix PDF generation
**Why:** PDF exports were broken
**What:** Fixed template rendering pipeline
**Outcome:** PDFs generate correctly now
**On track?:** Yes — clean fix
**Lessons:** Always test with real data
EOF

cat > "$JOURNAL_DIR/2026-03-02.md" << 'EOF'
**Author:** april
## Wayfind — Product context review
**Why:** Review product positioning
**What:** Updated positioning docs
**Outcome:** Docs refreshed
**On track?:** Yes
**Lessons:** Keep docs current

**Author:** nick
## SellingService — API refactor
**Why:** Clean up legacy endpoints
**What:** Refactored 3 endpoints
**Outcome:** Cleaner API surface
**On track?:** Drifted into extra cleanup
**Lessons:** Scope refactors tightly
EOF

echo ""
echo "Test: parseJournalFile extracts author from filename"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const result = cs.parseJournalFile('$JOURNAL_DIR/2026-03-01-greg.md');
  console.log('DATE:' + result.date);
  console.log('COUNT:' + result.entries.length);
  console.log('AUTHOR:' + result.entries[0].author);
")
if echo "$RESULT" | grep -qF "DATE:2026-03-01" && echo "$RESULT" | grep -qF "AUTHOR:greg"; then
    _pass "author from filename"
else
    _fail "author from filename" "Expected author=greg, got: $RESULT"
fi

echo ""
echo "Test: parseJournalFile extracts author from **Author:** line"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const result = cs.parseJournalFile('$JOURNAL_DIR/2026-03-02.md');
  console.log('COUNT:' + result.entries.length);
  console.log('AUTHOR0:' + result.entries[0].author);
  console.log('AUTHOR1:' + result.entries[1].author);
")
if echo "$RESULT" | grep -qF "AUTHOR0:april" && echo "$RESULT" | grep -qF "AUTHOR1:nick"; then
    _pass "author from content line"
else
    _fail "author from content line" "Expected april/nick, got: $RESULT"
fi

echo ""
echo "Test: **Author:** in content overrides filename author"
cat > "$JOURNAL_DIR/2026-03-03-greg.md" << 'EOF'
**Author:** sean
## Wayfind — Override test
**Why:** Test override
**What:** Testing
**Outcome:** Done
**On track?:** Yes
**Lessons:** None
EOF
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const result = cs.parseJournalFile('$JOURNAL_DIR/2026-03-03-greg.md');
  console.log('AUTHOR:' + result.entries[0].author);
")
if echo "$RESULT" | grep -qF "AUTHOR:sean"; then
    _pass "content author overrides filename"
else
    _fail "content author overrides filename" "Expected sean, got: $RESULT"
fi
rm -f "$JOURNAL_DIR/2026-03-03-greg.md"

echo ""
echo "Test: defaultAuthor option works for plain date files"
AUTHOR_STORE="$TEST_HOME/author-store"
mkdir -p "$AUTHOR_STORE"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({
    journalDir: '$JOURNAL_DIR',
    storePath: '$AUTHOR_STORE',
    embeddings: false,
    defaultAuthor: 'fallback-user',
  }).then(() => {
    const { getBackend } = require('$REPO_ROOT/bin/storage');
    const index = getBackend('$AUTHOR_STORE').loadIndex();
    const entries = Object.values(index.entries);
    const plainEntry = entries.find(e => e.date === '2026-02-24');
    const authoredEntry = entries.find(e => e.date === '2026-03-01' && e.user === 'greg');
    console.log('PLAIN_USER:' + (plainEntry ? plainEntry.user : 'NOT_FOUND'));
    console.log('AUTHORED_USER:' + (authoredEntry ? authoredEntry.user : 'NOT_FOUND'));
  });
")
if echo "$RESULT" | grep -qF "PLAIN_USER:fallback-user" && echo "$RESULT" | grep -qF "AUTHORED_USER:greg"; then
    _pass "defaultAuthor fallback"
else
    _fail "defaultAuthor fallback" "Expected fallback-user/greg, got: $RESULT"
fi

echo ""
echo "Test: buildContent includes author"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const content = cs.buildContent({
    repo: 'TestRepo', title: 'Test', date: '2026-01-01', author: 'greg',
    fields: { why: 'testing' }
  });
  console.log(content);
")
if echo "$RESULT" | grep -qF "Author: greg"; then
    _pass "buildContent includes author"
else
    _fail "buildContent includes author" "Expected Author: greg in content, got: $RESULT"
fi

echo ""
echo "Test: buildContent omits author when empty"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const content = cs.buildContent({
    repo: 'TestRepo', title: 'Test', date: '2026-01-01', author: '',
    fields: { why: 'testing' }
  });
  console.log(content);
")
if echo "$RESULT" | grep -qF "Author:"; then
    _fail "buildContent omits empty author" "Should not contain Author: when empty, got: $RESULT"
else
    _pass "buildContent omits empty author"
fi

echo ""
echo "Test: applyFilters filters by user"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const entry = { repo: 'Test', date: '2026-01-01', user: 'greg', drifted: false };
  const pass1 = cs.applyFilters(entry, { user: 'greg' });
  const pass2 = cs.applyFilters(entry, { user: 'nick' });
  const pass3 = cs.applyFilters(entry, { user: 'Greg' });
  const pass4 = cs.applyFilters(entry, {});
  console.log('MATCH:' + pass1);
  console.log('NO_MATCH:' + pass2);
  console.log('CASE_INSENSITIVE:' + pass3);
  console.log('NO_FILTER:' + pass4);
")
if echo "$RESULT" | grep -qF "MATCH:true" && echo "$RESULT" | grep -qF "NO_MATCH:false" && echo "$RESULT" | grep -qF "CASE_INSENSITIVE:true" && echo "$RESULT" | grep -qF "NO_FILTER:true"; then
    _pass "applyFilters user filter"
else
    _fail "applyFilters user filter" "Unexpected filter results: $RESULT"
fi

echo ""
echo "Test: indexJournals stores user in index"
RESULT=$(node -e "
  const { getBackend } = require('$REPO_ROOT/bin/storage');
  const index = getBackend('$AUTHOR_STORE').loadIndex();
  const entries = Object.values(index.entries);
  const gregEntry = entries.find(e => e.user === 'greg');
  const nickEntry = entries.find(e => e.user === 'nick');
  const aprilEntry = entries.find(e => e.user === 'april');
  console.log('GREG:' + (gregEntry ? gregEntry.repo : 'NOT_FOUND'));
  console.log('NICK:' + (nickEntry ? nickEntry.repo : 'NOT_FOUND'));
  console.log('APRIL:' + (aprilEntry ? aprilEntry.repo : 'NOT_FOUND'));
")
if echo "$RESULT" | grep -qF "GREG:Wayfind" && echo "$RESULT" | grep -q "NICK:" && echo "$RESULT" | grep -qF "APRIL:Wayfind"; then
    _pass "user stored in index"
else
    _fail "user stored in index" "Expected greg/nick/april entries, got: $RESULT"
fi

echo ""
echo "Test: queryMetadata filters by author"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const results = cs.queryMetadata({ storePath: '$AUTHOR_STORE', user: 'greg' });
  console.log('COUNT:' + results.length);
  const allGreg = results.every(r => r.entry.user === 'greg');
  console.log('ALL_GREG:' + allGreg);
")
if echo "$RESULT" | grep -q "COUNT:[1-9]"; then
    _pass "queryMetadata filters by author"
else
    _fail "queryMetadata filters by author" "Expected results for greg, got: $RESULT"
fi

echo ""
echo "Test: getEntryContent returns author in content for authored files"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const { getBackend } = require('$REPO_ROOT/bin/storage');
  const index = getBackend('$AUTHOR_STORE').loadIndex();
  const gregEntryId = Object.keys(index.entries).find(id => index.entries[id].user === 'greg');
  if (!gregEntryId) { console.log('NO_GREG_ENTRY'); process.exit(0); }
  const content = cs.getEntryContent(gregEntryId, { storePath: '$AUTHOR_STORE', journalDir: '$JOURNAL_DIR' });
  console.log('HAS_CONTENT:' + (content !== null));
  if (content) console.log('HAS_AUTHOR:' + content.includes('Author: greg'));
")
if echo "$RESULT" | grep -qF "HAS_CONTENT:true" && echo "$RESULT" | grep -qF "HAS_AUTHOR:true"; then
    _pass "getEntryContent includes author"
else
    _fail "getEntryContent includes author" "Expected author in content, got: $RESULT"
fi

# Clean up author test fixtures
rm -f "$JOURNAL_DIR/2026-03-01-greg.md" "$JOURNAL_DIR/2026-03-01-nick.md" "$JOURNAL_DIR/2026-03-02.md"

# ── 11. Signal entry content retrieval ────────────────────────────────────────

echo ""
echo "11. Signal entry content retrieval"
echo "===================================="

# Create signal fixtures and index them
SIGNALS_DIR="$TEST_HOME/.claude/team-context/signals"
mkdir -p "$SIGNALS_DIR/github"
cat > "$SIGNALS_DIR/github/2026-02-28.md" << 'EOF'
# GitHub Signals — 2026-02-28

## PRs
- PR #123: Fix auth bug (merged)
- PR #124: Add caching layer (open)

## Issues
- Issue #456: Performance degradation reported
EOF

cat > "$SIGNALS_DIR/github/2026-02-28-summary.md" << 'EOF'
# GitHub Summary — 2026-02-28

5 PRs merged, 3 issues closed across 2 repos.
EOF

SIGNAL_STORE="$TEST_HOME/signal-store"
mkdir -p "$SIGNAL_STORE"

echo ""
echo "Test: indexSignals indexes signal files"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexSignals({
    signalsDir: '$SIGNALS_DIR',
    storePath: '$SIGNAL_STORE',
    embeddings: false,
  }).then(stats => {
    console.log('FILES:' + stats.fileCount);
    console.log('NEW:' + stats.newEntries);
  }).catch(err => {
    console.log('ERROR:' + err.message);
  });
")
if echo "$RESULT" | grep -q "FILES:[1-9]" && echo "$RESULT" | grep -q "NEW:[1-9]"; then
    _pass "indexSignals creates entries"
else
    _fail "indexSignals creates entries" "Unexpected: $RESULT"
fi

echo ""
echo "Test: getEntryContent retrieves signal content"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const { getBackend } = require('$REPO_ROOT/bin/storage');
  const index = getBackend('$SIGNAL_STORE').loadIndex();
  // Find a signal entry
  const signalEntry = Object.entries(index.entries).find(([id, e]) => e.source === 'signal');
  if (!signalEntry) { console.log('NO_SIGNAL_ENTRY'); process.exit(0); }
  const [id, entry] = signalEntry;
  const content = cs.getEntryContent(id, {
    storePath: '$SIGNAL_STORE',
    signalsDir: '$SIGNALS_DIR',
  });
  console.log('HAS_CONTENT:' + (content !== null && content.length > 0));
  if (content) console.log('IS_SIGNAL:' + (content.includes('GitHub') || content.includes('PRs')));
")
if echo "$RESULT" | grep -qF "HAS_CONTENT:true" && echo "$RESULT" | grep -qF "IS_SIGNAL:true"; then
    _pass "getEntryContent retrieves signal content"
else
    _fail "getEntryContent retrieves signal content" "Expected signal content, got: $RESULT"
fi

echo ""
echo "Test: getEntryContent returns null for missing signal file"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  const content = cs.getEntryContent('nonexistent-id', {
    storePath: '$SIGNAL_STORE',
    signalsDir: '$SIGNALS_DIR',
  });
  console.log('IS_NULL:' + (content === null));
")
if echo "$RESULT" | grep -qF "IS_NULL:true"; then
    _pass "getEntryContent null for missing signal"
else
    _fail "getEntryContent null for missing signal" "Expected null, got: $RESULT"
fi

# ── Section 12: Repo exclusion (TEAM_CONTEXT_EXCLUDE_REPOS) ──────────────────────
echo ""
echo "Section 12: Repo exclusion"

# Create journals with mixed repos
EXCLUDE_JDIR="$TEST_HOME/exclude-journals"
mkdir -p "$EXCLUDE_JDIR"
EXCLUDE_STORE="$TEST_HOME/exclude-store"
mkdir -p "$EXCLUDE_STORE"

cat > "$EXCLUDE_JDIR/2026-03-10-greg.md" << 'JEOF'
## wayfind — worked on digest pipeline
**Why:** Improve digest quality
**What:** Refactored collectFromStore

## browser-app-v2 — fixed search bug
**Why:** Users reported broken search
**What:** Fixed query param encoding

## personal-project — random stuff
**Why:** Fun
**What:** Tinkered
JEOF

# Each test runs in a fresh node process so TEAM_CONTEXT_EXCLUDE_REPOS is parsed fresh

# Index WITHOUT exclusion
RESULT=$(TEAM_CONTEXT_EXCLUDE_REPOS="" TEAM_CONTEXT_SIMULATE=1 node -e "
  const cs = require('./bin/content-store');
  cs.indexJournals({ journalDir: '$EXCLUDE_JDIR', storePath: '$EXCLUDE_STORE', embeddings: false })
    .then(r => console.log('COUNT:' + r.entryCount));
")
if echo "$RESULT" | grep -qF "COUNT:3"; then
    _pass "no exclusion indexes all 3 entries"
else
    _fail "no exclusion indexes all 3 entries" "Expected 3, got: $RESULT"
fi

# Re-index WITH exclusion (fresh store, fresh node process)
EXCLUDE_STORE2="$TEST_HOME/exclude-store2"
mkdir -p "$EXCLUDE_STORE2"
RESULT=$(TEAM_CONTEXT_EXCLUDE_REPOS="wayfind,personal-project" TEAM_CONTEXT_SIMULATE=1 node -e "
  const cs = require('./bin/content-store');
  cs.indexJournals({ journalDir: '$EXCLUDE_JDIR', storePath: '$EXCLUDE_STORE2', embeddings: false })
    .then(r => console.log('COUNT:' + r.entryCount));
")
if echo "$RESULT" | grep -qF "COUNT:1"; then
    _pass "exclusion filters out wayfind and personal-project"
else
    _fail "exclusion filters out wayfind and personal-project" "Expected 1, got: $RESULT"
fi

# Query with exclusion active — index all 3 (no exclusion), then query should filter
EXCLUDE_STORE3="$TEST_HOME/exclude-store3"
mkdir -p "$EXCLUDE_STORE3"
RESULT=$(TEAM_CONTEXT_EXCLUDE_REPOS="wayfind" TEAM_CONTEXT_SIMULATE=1 node -e "
  const cs = require('./bin/content-store');
  // Index all 3 first (EXCLUDE_REPOS is 'wayfind' but we override at index by re-requiring)
  // Actually EXCLUDE_REPOS='wayfind' is set, so wayfind will be excluded at index too.
  // We need to index without exclusion first, then query with exclusion.
  // Use a two-step: index all, then query with exclusion.
  process.exit(0);
")
# Step 1: index all entries (no exclusion)
TEAM_CONTEXT_EXCLUDE_REPOS="" TEAM_CONTEXT_SIMULATE=1 node -e "
  const cs = require('./bin/content-store');
  cs.indexJournals({ journalDir: '$EXCLUDE_JDIR', storePath: '$EXCLUDE_STORE3', embeddings: false })
    .then(() => console.log('INDEXED'));
"
# Step 2: query with exclusion
RESULT=$(TEAM_CONTEXT_EXCLUDE_REPOS="wayfind" TEAM_CONTEXT_SIMULATE=1 node -e "
  const cs = require('./bin/content-store');
  const entries = cs.queryMetadata({ storePath: '$EXCLUDE_STORE3' });
  const repos = entries.map(e => e.entry.repo);
  console.log('HAS_WAYFIND:' + repos.includes('wayfind'));
  console.log('HAS_BROWSER:' + repos.includes('browser-app-v2'));
")
if echo "$RESULT" | grep -qF "HAS_WAYFIND:false" && echo "$RESULT" | grep -qF "HAS_BROWSER:true"; then
    _pass "queryMetadata excludes wayfind entries"
else
    _fail "queryMetadata excludes wayfind entries" "Got: $RESULT"
fi

# ── Section 12b: Repo allowlist (TEAM_CONTEXT_INCLUDE_REPOS) ──────────────────
echo ""
echo "Section 12b: Repo allowlist (TEAM_CONTEXT_INCLUDE_REPOS)"
echo "=========================================================="

# Test: INCLUDE_REPOS empty = include all
RESULT=$(TEAM_CONTEXT_INCLUDE_REPOS="" TEAM_CONTEXT_EXCLUDE_REPOS="" TEAM_CONTEXT_SIMULATE=1 node -e "
  const cs = require('./bin/content-store');
  console.log(cs.isRepoExcluded('anything/repo') ? 'excluded' : 'included');
")
if [ "$RESULT" = "included" ]; then
    _pass "empty INCLUDE_REPOS includes all"
else
    _fail "empty INCLUDE_REPOS includes all" "Expected 'included', got: $RESULT"
fi

# Test: INCLUDE_REPOS set = only matching repos pass
RESULT=$(TEAM_CONTEXT_INCLUDE_REPOS="AcmeCorp/*,Frontend/*" TEAM_CONTEXT_EXCLUDE_REPOS="" TEAM_CONTEXT_SIMULATE=1 node -e "
  const cs = require('./bin/content-store');
  const results = [
    cs.isRepoExcluded('AcmeCorp/research') ? 'excluded' : 'included',
    cs.isRepoExcluded('Frontend/MVP') ? 'excluded' : 'included',
    cs.isRepoExcluded('greg/wayfind') ? 'excluded' : 'included',
    cs.isRepoExcluded('greg/tools') ? 'excluded' : 'included',
  ];
  console.log(results.join(','));
")
if [ "$RESULT" = "included,included,excluded,excluded" ]; then
    _pass "INCLUDE_REPOS with wildcards"
else
    _fail "INCLUDE_REPOS with wildcards" "Expected 'included,included,excluded,excluded', got: $RESULT"
fi

# Test: INCLUDE_REPOS takes priority over EXCLUDE_REPOS
RESULT=$(TEAM_CONTEXT_INCLUDE_REPOS="AcmeCorp/*" TEAM_CONTEXT_EXCLUDE_REPOS="research" TEAM_CONTEXT_SIMULATE=1 node -e "
  const cs = require('./bin/content-store');
  console.log(cs.isRepoExcluded('AcmeCorp/research') ? 'excluded' : 'included');
")
if [ "$RESULT" = "included" ]; then
    _pass "INCLUDE_REPOS overrides EXCLUDE_REPOS"
else
    _fail "INCLUDE_REPOS overrides EXCLUDE_REPOS" "Expected 'included', got: $RESULT"
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
