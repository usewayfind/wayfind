#!/usr/bin/env bash
# Tests for digest modules (slack.js, digest.js)
# Covers: markdown-to-mrkdwn conversion, signal collection, journal collection,
#         prompt building, digest generation, and Slack delivery in simulation mode.
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

# Enable simulation mode for all tests
export TEAM_CONTEXT_SIMULATE=1
export TEAM_CONTEXT_SIM_FIXTURES="$REPO_ROOT/simulation/fixtures/signals/github"

# ── Markdown to mrkdwn conversion ───────────────────────────────────────────

echo ""
echo "Markdown to mrkdwn conversion"
echo "=============================="

echo ""
echo "Test: markdownToMrkdwn converts bold"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  console.log(slack.markdownToMrkdwn('This is **bold** text'));
")
if echo "$RESULT" | grep -qF '*bold*'; then
    _pass "bold conversion"
else
    _fail "bold conversion" "Expected *bold* in: $RESULT"
fi

echo ""
echo "Test: markdownToMrkdwn converts h1 heading"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  console.log(slack.markdownToMrkdwn('# Heading'));
")
if echo "$RESULT" | grep -qF '*Heading*'; then
    _pass "h1 heading conversion"
else
    _fail "h1 heading conversion" "Expected *Heading* in: $RESULT"
fi

echo ""
echo "Test: markdownToMrkdwn converts h2 heading"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  console.log(slack.markdownToMrkdwn('## Sub Heading'));
")
if echo "$RESULT" | grep -qF '*Sub Heading*'; then
    _pass "h2 heading conversion"
else
    _fail "h2 heading conversion" "Expected *Sub Heading* in: $RESULT"
fi

echo ""
echo "Test: markdownToMrkdwn converts h3 heading"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  console.log(slack.markdownToMrkdwn('### Third Level'));
")
if echo "$RESULT" | grep -qF '*Third Level*'; then
    _pass "h3 heading conversion"
else
    _fail "h3 heading conversion" "Expected *Third Level* in: $RESULT"
fi

echo ""
echo "Test: markdownToMrkdwn converts links"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  console.log(slack.markdownToMrkdwn('Click [here](https://example.com) for more'));
")
if echo "$RESULT" | grep -qF '<https://example.com|here>'; then
    _pass "link conversion"
else
    _fail "link conversion" "Expected <https://example.com|here> in: $RESULT"
fi

echo ""
echo "Test: markdownToMrkdwn converts list items"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  console.log(slack.markdownToMrkdwn('- first item'));
")
if echo "$RESULT" | grep -q "first item"; then
    # Check that dash was replaced with bullet
    if echo "$RESULT" | grep -qF "$(printf '\xe2\x80\xa2') first item"; then
        _pass "list item conversion"
    else
        _fail "list item conversion" "Expected bullet character in: $RESULT"
    fi
else
    _fail "list item conversion" "Expected 'first item' in: $RESULT"
fi

echo ""
echo "Test: markdownToMrkdwn handles multiple conversions in same string"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  console.log(slack.markdownToMrkdwn('# Title\n\nThis is **bold** and [a link](http://x.com)\n\n- item one'));
")
if echo "$RESULT" | grep -qF '*Title*' && echo "$RESULT" | grep -qF '*bold*' && echo "$RESULT" | grep -qF '<http://x.com|a link>'; then
    _pass "multiple conversions in same string"
else
    _fail "multiple conversions in same string" "Missing expected conversions in: $RESULT"
fi

echo ""
echo "Test: markdownToMrkdwn preserves code blocks"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  const input = 'Before\n\`\`\`\nconst x = **bold**;\n\`\`\`\nAfter **real**';
  console.log(slack.markdownToMrkdwn(input));
")
if echo "$RESULT" | grep -qF 'const x = **bold**'; then
    _pass "code blocks preserved"
else
    _fail "code blocks preserved" "Code block content was modified in: $RESULT"
fi

echo ""
echo "Test: markdownToMrkdwn strips horizontal rules"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  console.log(slack.markdownToMrkdwn('Above\n---\nBelow'));
")
if echo "$RESULT" | grep -qF '---'; then
    _fail "horizontal rule stripping" "--- still present in: $RESULT"
else
    _pass "horizontal rule stripping"
fi

echo ""
echo "Test: markdownToMrkdwn handles empty input"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  console.log(JSON.stringify(slack.markdownToMrkdwn('')));
")
if echo "$RESULT" | grep -qF '""'; then
    _pass "empty input returns empty string"
else
    _fail "empty input returns empty string" "Expected empty string, got: $RESULT"
fi

# ── Signal collection ────────────────────────────────────────────────────────

echo ""
echo "Signal collection"
echo "================="

echo ""
echo "Test: collectSignals returns empty string when no signals dir"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  console.log(JSON.stringify(digest.collectSignals('2026-01-01', '$TEST_HOME/nonexistent')));
")
if echo "$RESULT" | grep -qF '""'; then
    _pass "collectSignals empty when no dir"
else
    _fail "collectSignals empty when no dir" "Expected empty string, got: $RESULT"
fi

echo ""
echo "Test: collectSignals finds summary files"
# Set up signal fixtures
mkdir -p "$TEST_HOME/.claude/team-context/signals/github"
cat > "$TEST_HOME/.claude/team-context/signals/github/2026-02-28-summary.md" << 'SIGEOF'
# GitHub Signals -- Summary

**Period:** 2026-02-24 to 2026-02-28
**Repos:** 2

## Summary
- 5 PRs across 2 repos
- 8 issues across 2 repos
SIGEOF

RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const result = digest.collectSignals('2026-02-24', '$TEST_HOME/.claude/team-context/signals');
  console.log(result);
")
if echo "$RESULT" | grep -qF "5 PRs across 2 repos"; then
    _pass "collectSignals finds summary files"
else
    _fail "collectSignals finds summary files" "Expected summary content in result"
fi

echo ""
echo "Test: collectSignals filters by date"
cat > "$TEST_HOME/.claude/team-context/signals/github/2026-01-15-summary.md" << 'SIGEOF'
# Old Summary
Old content that should be filtered out.
SIGEOF

RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const result = digest.collectSignals('2026-02-01', '$TEST_HOME/.claude/team-context/signals');
  console.log(result);
")
if echo "$RESULT" | grep -qF "Old content"; then
    _fail "collectSignals filters by date" "Old content should have been filtered"
else
    _pass "collectSignals filters by date"
fi

echo ""
echo "Test: collectSignals prefers summaries over repo files"
# Create per-repo file for same date range
mkdir -p "$TEST_HOME/.claude/team-context/signals/github/TestOrg/TestRepo"
cat > "$TEST_HOME/.claude/team-context/signals/github/TestOrg/TestRepo/2026-02-28.md" << 'SIGEOF'
# TestOrg/TestRepo -- GitHub Signals
Per-repo content that should not appear when summary exists.
SIGEOF

RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const result = digest.collectSignals('2026-02-24', '$TEST_HOME/.claude/team-context/signals');
  console.log(result);
")
if echo "$RESULT" | grep -qF "Per-repo content"; then
    _fail "collectSignals prefers summaries" "Per-repo content shown when summary exists"
else
    _pass "collectSignals prefers summaries"
fi

# ── Journal collection ───────────────────────────────────────────────────────

echo ""
echo "Journal collection"
echo "=================="

echo ""
echo "Test: collectJournals returns empty string when no journal dir"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  console.log(JSON.stringify(digest.collectJournals('2026-01-01', '$TEST_HOME/no-such-journal')));
")
if echo "$RESULT" | grep -qF '""'; then
    _pass "collectJournals empty when no dir"
else
    _fail "collectJournals empty when no dir" "Expected empty string, got: $RESULT"
fi

echo ""
echo "Test: collectJournals finds and concatenates journal files"
mkdir -p "$TEST_HOME/.claude/memory/journal"
cat > "$TEST_HOME/.claude/memory/journal/2026-02-25.md" << 'JEOF'
## Wayfind -- Feature work
**Why:** Build the digest engine
**What:** Implemented collectSignals
**Outcome:** Working
JEOF
cat > "$TEST_HOME/.claude/memory/journal/2026-02-26.md" << 'JEOF'
## Wayfind -- More features
**Why:** Add Slack delivery
**What:** Built slack.js
**Outcome:** Delivered
JEOF

RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const result = digest.collectJournals('2026-02-24', '$TEST_HOME/.claude/memory/journal');
  console.log(result);
")
if echo "$RESULT" | grep -qF "digest engine" && echo "$RESULT" | grep -qF "Slack delivery"; then
    _pass "collectJournals concatenates files"
else
    _fail "collectJournals concatenates files" "Expected both journal entries in result"
fi

echo ""
echo "Test: collectJournals filters by date"
cat > "$TEST_HOME/.claude/memory/journal/2026-01-10.md" << 'JEOF'
## OldRepo -- Ancient work
**Why:** Something old
**What:** Old things
JEOF

RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const result = digest.collectJournals('2026-02-20', '$TEST_HOME/.claude/memory/journal');
  console.log(result);
")
if echo "$RESULT" | grep -qF "Ancient work"; then
    _fail "collectJournals filters by date" "Old journal entry should be filtered out"
else
    _pass "collectJournals filters by date"
fi

# ── Prompt building ──────────────────────────────────────────────────────────

echo ""
echo "Prompt building"
echo "==============="

echo ""
echo "Test: buildPrompt returns system and user parts"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const prompt = digest.buildPrompt('engineering', 'signal data here', 'journal data here', { from: '2026-02-24', to: '2026-02-28' });
  console.log('HAS_SYSTEM:' + (prompt.system.length > 0));
  console.log('HAS_USER:' + (prompt.user.length > 0));
")
if echo "$RESULT" | grep -qF "HAS_SYSTEM:true" && echo "$RESULT" | grep -qF "HAS_USER:true"; then
    _pass "buildPrompt returns system and user"
else
    _fail "buildPrompt returns system and user" "Expected both parts, got: $RESULT"
fi

echo ""
echo "Test: buildPrompt includes signal content in user message"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const prompt = digest.buildPrompt('engineering', 'UNIQUE_SIGNAL_MARKER', 'journal content', { from: '2026-02-24', to: '2026-02-28' });
  console.log(prompt.user);
")
if echo "$RESULT" | grep -qF "UNIQUE_SIGNAL_MARKER"; then
    _pass "buildPrompt includes signal content"
else
    _fail "buildPrompt includes signal content" "Signal content not found in user message"
fi

echo ""
echo "Test: buildPrompt handles missing persona template"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  try {
    digest.buildPrompt('nonexistent-persona', 'signals', 'journals', { from: '2026-02-24', to: '2026-02-28' });
    console.log('NO_ERROR');
  } catch (e) {
    console.log('ERROR:' + e.message);
  }
")
if echo "$RESULT" | grep -qF "ERROR:" && echo "$RESULT" | grep -qi "not found"; then
    _pass "buildPrompt throws for missing persona"
else
    _fail "buildPrompt throws for missing persona" "Expected error for nonexistent persona, got: $RESULT"
fi

# ── Slack delivery (simulation mode) ────────────────────────────────────────

echo ""
echo "Slack delivery (simulation mode)"
echo "================================="

echo ""
echo "Test: deliver in simulate mode writes JSON file"
RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  slack.deliver(
    'https://hooks.slack.com/services/T00/B00/test',
    '# Test Digest\n\nSome content here.',
    'engineering',
    { from: '2026-02-24', to: '2026-02-28' }
  ).then(r => {
    console.log('OK:' + r.ok);
    console.log('PERSONA:' + r.persona);
  }).catch(e => {
    console.log('ERROR:' + e.message);
  });
")
if echo "$RESULT" | grep -qF "OK:true" && echo "$RESULT" | grep -qF "PERSONA:engineering"; then
    _pass "deliver returns success in simulate mode"
else
    _fail "deliver returns success in simulate mode" "Unexpected result: $RESULT"
fi

# Verify the JSON file was written
SLACK_FILE="$TEST_HOME/.claude/team-context/digests/2026-02-28-slack-engineering.json"
if [ -f "$SLACK_FILE" ]; then
    _pass "deliver wrote Slack payload JSON file"
else
    _fail "deliver wrote Slack payload JSON file" "File not found: $SLACK_FILE"
fi

# Verify payload structure
if [ -f "$SLACK_FILE" ]; then
    PAYLOAD=$(node -e "
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync('$SLACK_FILE', 'utf8'));
      console.log('HAS_TEXT:' + (typeof data.text === 'string'));
      console.log('HAS_EMOJI:' + data.text.includes(':wrench:'));
      console.log('HAS_LABEL:' + data.text.includes('Engineering Digest'));
    ")
    if echo "$PAYLOAD" | grep -qF "HAS_TEXT:true" && echo "$PAYLOAD" | grep -qF "HAS_EMOJI:true" && echo "$PAYLOAD" | grep -qF "HAS_LABEL:true"; then
        _pass "Slack payload has correct structure"
    else
        _fail "Slack payload has correct structure" "Missing fields in payload: $PAYLOAD"
    fi
fi

echo ""
echo "Test: deliverAll processes multiple personas"
# Create per-persona digest files
mkdir -p "$TEST_HOME/.claude/team-context/digests/engineering"
mkdir -p "$TEST_HOME/.claude/team-context/digests/product"
cat > "$TEST_HOME/.claude/team-context/digests/engineering/2026-02-28.md" << 'DEOF'
# Engineering Digest

Test engineering digest content.
DEOF
cat > "$TEST_HOME/.claude/team-context/digests/product/2026-02-28.md" << 'DEOF'
# Product Digest

Test product digest content.
DEOF

RESULT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');
  const digestResult = {
    files: [],
    personas: ['engineering', 'product'],
    dateRange: { from: '2026-02-24', to: '2026-02-28' }
  };
  slack.deliverAll(
    'https://hooks.slack.com/services/T00/B00/test',
    digestResult,
    ['engineering', 'product']
  ).then(results => {
    console.log('COUNT:' + results.length);
    results.forEach(r => console.log('RESULT:' + r.ok + ':' + r.persona));
  }).catch(e => {
    console.log('ERROR:' + e.message);
  });
" 2>&1) || true
if echo "$RESULT" | grep -qF "COUNT:2" && echo "$RESULT" | grep -qF "RESULT:true:engineering" && echo "$RESULT" | grep -qF "RESULT:true:product"; then
    _pass "deliverAll processes multiple personas"
else
    _fail "deliverAll processes multiple personas" "Unexpected result: $RESULT"
fi

# Verify both Slack payload files were written
ENG_SLACK="$TEST_HOME/.claude/team-context/digests/2026-02-28-slack-engineering.json"
PROD_SLACK="$TEST_HOME/.claude/team-context/digests/2026-02-28-slack-product.json"
if [ -f "$ENG_SLACK" ] && [ -f "$PROD_SLACK" ]; then
    _pass "deliverAll wrote payload files for both personas"
else
    _fail "deliverAll wrote payload files for both personas" "Missing files: eng=$ENG_SLACK prod=$PROD_SLACK"
fi

# ── collectFromStore ──────────────────────────────────────────────────────────

echo ""
echo "collectFromStore"
echo "================="

# Set up an indexed store for collectFromStore tests
STORE_JOURNAL_DIR="$TEST_HOME/store-journals"
STORE_DIR="$TEST_HOME/store-test"
mkdir -p "$STORE_JOURNAL_DIR"
mkdir -p "$STORE_DIR"

cat > "$STORE_JOURNAL_DIR/2026-02-25-greg.md" << 'JEOF'
## Wayfind — Digest engine work
**Why:** Build the digest pipeline
**What:** Implemented collectFromStore
**Outcome:** Working end-to-end
**On track?:** Yes — focused
**Lessons:** Store-based collection is cleaner
JEOF

cat > "$STORE_JOURNAL_DIR/2026-02-26-nick.md" << 'JEOF'
## ReportService — Fix exports
**Why:** PDF exports broken
**What:** Fixed rendering pipeline
**Outcome:** Exports working
**On track?:** Yes
**Lessons:** Test with real data
JEOF

# Index the journals
node -e "
  const cs = require('$REPO_ROOT/bin/content-store.js');
  cs.indexJournals({
    journalDir: '$STORE_JOURNAL_DIR',
    storePath: '$STORE_DIR',
    embeddings: false,
  }).then(() => {});
"

echo ""
echo "Test: collectFromStore returns journal entries from indexed store"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const result = digest.collectFromStore('2026-02-24', {
    storePath: '$STORE_DIR',
    journalDir: '$STORE_JOURNAL_DIR',
  });
  console.log('COUNT:' + result.entryCount);
  console.log('HAS_JOURNALS:' + (result.journals.length > 0));
")
if echo "$RESULT" | grep -q "COUNT:[1-9]" && echo "$RESULT" | grep -qF "HAS_JOURNALS:true"; then
    _pass "collectFromStore returns journal entries"
else
    _fail "collectFromStore returns journal entries" "Expected entries, got: $RESULT"
fi

echo ""
echo "Test: collectFromStore includes author attribution"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const result = digest.collectFromStore('2026-02-24', {
    storePath: '$STORE_DIR',
    journalDir: '$STORE_JOURNAL_DIR',
  });
  console.log(result.journals);
")
if echo "$RESULT" | grep -qF "Author: greg" || echo "$RESULT" | grep -qF "Author: nick"; then
    _pass "collectFromStore includes author attribution"
else
    _fail "collectFromStore includes author attribution" "Expected Author: in output, got: $RESULT"
fi

echo ""
echo "Test: collectFromStore falls back to empty when store is not indexed"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const result = digest.collectFromStore('2026-02-24', {
    storePath: '$TEST_HOME/nonexistent-store',
  });
  console.log('COUNT:' + result.entryCount);
  console.log('JOURNALS_EMPTY:' + (result.journals === ''));
  console.log('SIGNALS_EMPTY:' + (result.signals === ''));
")
if echo "$RESULT" | grep -qF "COUNT:0" && echo "$RESULT" | grep -qF "JOURNALS_EMPTY:true" && echo "$RESULT" | grep -qF "SIGNALS_EMPTY:true"; then
    _pass "collectFromStore empty for non-indexed store"
else
    _fail "collectFromStore empty for non-indexed store" "Expected empty results, got: $RESULT"
fi

# ── Feedback-driven digest learning ──────────────────────────────────────────

echo ""
echo "Feedback-driven digest learning"
echo "================================"

FEEDBACK_STORE="$TEST_HOME/feedback-store"
mkdir -p "$FEEDBACK_STORE"

echo ""
echo "Test: buildFeedbackContext returns empty when no feedback"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest');
  const ctx = digest.buildFeedbackContext('unified', { storePath: '$FEEDBACK_STORE' });
  console.log('EMPTY:' + (ctx === ''));
")
if echo "$RESULT" | grep -qF "EMPTY:true"; then
    _pass "no feedback returns empty"
else
    _fail "no feedback returns empty" "Got: $RESULT"
fi

echo ""
echo "Test: buildFeedbackContext with reactions only"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store');
  cs.recordDigestDelivery({ date: '2026-03-14', persona: 'unified', channel: 'C1', ts: '100.200', storePath: '$FEEDBACK_STORE' });
  cs.recordDigestReaction({ messageTs: '100.200', reaction: 'rocket', delta: 1, storePath: '$FEEDBACK_STORE' });
  cs.recordDigestReaction({ messageTs: '100.200', reaction: 'fire', delta: 1, storePath: '$FEEDBACK_STORE' });
  const digest = require('$REPO_ROOT/bin/digest');
  const ctx = digest.buildFeedbackContext('unified', { storePath: '$FEEDBACK_STORE' });
  console.log('HAS_POSITIVE:' + ctx.includes('Positive signals'));
  console.log('HAS_NEGATIVE:' + ctx.includes('Concerns'));
  console.log('HAS_HEADER:' + ctx.includes('Digest Preferences'));
")
if echo "$RESULT" | grep -qF "HAS_POSITIVE:true" && echo "$RESULT" | grep -qF "HAS_NEGATIVE:false" && echo "$RESULT" | grep -qF "HAS_HEADER:true"; then
    _pass "reactions only — positive detected"
else
    _fail "reactions only — positive detected" "Got: $RESULT"
fi

echo ""
echo "Test: buildFeedbackContext with text feedback only"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store');
  cs.recordDigestFeedbackText({ messageTs: '100.200', user: 'U1', text: 'Need more infra details', storePath: '$FEEDBACK_STORE' });
  const digest = require('$REPO_ROOT/bin/digest');
  const ctx = digest.buildFeedbackContext('unified', { storePath: '$FEEDBACK_STORE' });
  console.log('HAS_QUOTE:' + ctx.includes('Need more infra details'));
")
if echo "$RESULT" | grep -qF "HAS_QUOTE:true"; then
    _pass "text feedback included"
else
    _fail "text feedback included" "Got: $RESULT"
fi

echo ""
echo "Test: buildFeedbackContext with negative reactions"
RESULT=$(node -e "
  const cs = require('$REPO_ROOT/bin/content-store');
  cs.recordDigestReaction({ messageTs: '100.200', reaction: 'thinking_face', delta: 1, storePath: '$FEEDBACK_STORE' });
  cs.recordDigestReaction({ messageTs: '100.200', reaction: '-1', delta: 1, storePath: '$FEEDBACK_STORE' });
  const digest = require('$REPO_ROOT/bin/digest');
  const ctx = digest.buildFeedbackContext('unified', { storePath: '$FEEDBACK_STORE' });
  console.log('HAS_CONCERNS:' + ctx.includes('Concerns'));
")
if echo "$RESULT" | grep -qF "HAS_CONCERNS:true"; then
    _pass "negative reactions detected"
else
    _fail "negative reactions detected" "Got: $RESULT"
fi

echo ""
echo "Test: buildFeedbackContext respects maxChars cap"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest');
  const ctx = digest.buildFeedbackContext('unified', { storePath: '$FEEDBACK_STORE', maxChars: 100 });
  console.log('LEN:' + ctx.length);
  console.log('CAPPED:' + (ctx.length <= 100));
")
if echo "$RESULT" | grep -qF "CAPPED:true"; then
    _pass "maxChars cap enforced"
else
    _fail "maxChars cap enforced" "Got: $RESULT"
fi

echo ""
echo "Test: buildFeedbackContext filters by persona"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest');
  const ctx = digest.buildFeedbackContext('engineering', { storePath: '$FEEDBACK_STORE' });
  console.log('EMPTY:' + (ctx === ''));
")
if echo "$RESULT" | grep -qF "EMPTY:true"; then
    _pass "persona filter excludes non-matching"
else
    _fail "persona filter excludes non-matching" "Got: $RESULT"
fi

echo ""
echo "Test: feedback injected into buildPrompt when present"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest');
  const { user } = digest.buildPrompt('unified', 'signals', 'journals',
    { from: '2026-03-14', to: '2026-03-15' }, { storePath: '$FEEDBACK_STORE' });
  console.log('HAS_SECTION:' + user.includes('Digest Preferences'));
")
if echo "$RESULT" | grep -qF "HAS_SECTION:true"; then
    _pass "feedback section in prompt"
else
    _fail "feedback section in prompt" "Got: $RESULT"
fi

echo ""
echo "Test: no feedback section when store is empty"
EMPTY_STORE="$TEST_HOME/empty-feedback-store"
mkdir -p "$EMPTY_STORE"
RESULT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest');
  const { user } = digest.buildPrompt('unified', 'signals', 'journals',
    { from: '2026-03-14', to: '2026-03-15' }, { storePath: '$EMPTY_STORE' });
  console.log('NO_SECTION:' + !user.includes('Digest Preferences'));
")
if echo "$RESULT" | grep -qF "NO_SECTION:true"; then
    _pass "no feedback section when empty"
else
    _fail "no feedback section when empty" "Got: $RESULT"
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
