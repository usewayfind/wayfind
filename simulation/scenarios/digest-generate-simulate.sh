#!/usr/bin/env bash
# Scenario: digest-generate-simulate
# End-to-end test of digest generation with simulated LLM.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: digest-generate-simulate"
echo "===================================="

# Set up temp home
ORIG_HOME="$HOME"
TEST_HOME=$(mktemp -d)
export HOME="$TEST_HOME"
cleanup() { export HOME="$ORIG_HOME"; rm -rf "$TEST_HOME"; }
trap cleanup EXIT

# Enable simulation
export TEAM_CONTEXT_SIMULATE=1
export TEAM_CONTEXT_SIM_FIXTURES="$SIM_DIR/fixtures/signals/github"

# Pre-configure connectors.json with digest config
mkdir -p "$TEST_HOME/.claude/team-context"
cat > "$TEST_HOME/.claude/team-context/connectors.json" << 'EOF'
{
  "github": {
    "transport": "simulate",
    "repos": [{ "owner": "acme-corp", "repo": "event-service" }],
    "last_pull": null
  },
  "digest": {
    "llm": {
      "provider": "simulate",
      "model": "test",
      "api_key_env": null
    },
    "slack": {
      "webhook_url": "https://hooks.slack.com/services/T00/B00/test",
      "default_personas": ["engineering", "product"]
    },
    "lookback_days": 7,
    "configured_at": "2026-03-01T10:00:00Z"
  }
}
EOF

# Pre-create signal files (simulating a previous pull)
mkdir -p "$TEST_HOME/.claude/team-context/signals/github"
cp "$SIM_DIR/fixtures/signals/github/"*.json "$TEST_HOME/.claude/team-context/signals/github/" 2>/dev/null || true

# Create a summary signal file
cat > "$TEST_HOME/.claude/team-context/signals/github/2026-02-28-summary.md" << 'SIGNAL_EOF'
# GitHub Signals — Summary

**Period:** 2026-02-24 to 2026-02-28
**Repos:** 2

## Per-Repo Highlights

### acme-corp/event-service
- 3 PRs, 5 issues, 14 CI runs
- 1 PR potentially blocked (open >5 days)

## Summary
- 5 PRs across 2 repos
- 8 issues across 2 repos
- 20 CI runs, 2 failures (10% failure rate)
SIGNAL_EOF

# Create sample journal entries
mkdir -p "$TEST_HOME/.claude/memory/journal"

cat > "$TEST_HOME/.claude/memory/journal/2026-02-24.md" << 'JOURNAL_EOF'
## event-service — Config-as-Code QA Verification
**Why:** Verify config-as-code changes work correctly in QA environment
**What:** Tested all 7 fields in QA, found URL formatting issue, fixed in PR #2465.
**Outcome:** QA verified, ready for review
**On track?:** Focused
**Lessons:** Always test URL fields with special characters.
JOURNAL_EOF

cat > "$TEST_HOME/.claude/memory/journal/2026-02-25.md" << 'JOURNAL_EOF'
## Wayfind — GitHub Signal Connector
**Why:** Build the first signal channel connector
**What:** Implemented transport abstraction, GitHub API fetch, markdown generation.
**Outcome:** Pull command working with both gh CLI and HTTPS transports.
**On track?:** Yes, focused session.
**Lessons:** Separate transport from business logic early.
JOURNAL_EOF

cat > "$TEST_HOME/.claude/memory/journal/2026-02-26.md" << 'JOURNAL_EOF'
## analytics-service — Auth Overhaul
**Why:** Fix authentication for gold table queries
**What:** Overhauled auth module, added MI grants, tested overnight refresh.
**Outcome:** Auth working, MonthlyRefresh pre-flight passed.
**On track?:** Yes
**Lessons:** MI grants need explicit scope — don't rely on inherited permissions.
JOURNAL_EOF

# Copy journal fixtures from simulation directory if they exist
for f in "$SIM_DIR/fixtures/journals/"*.md; do
    [ -f "$f" ] && cp "$f" "$TEST_HOME/.claude/memory/journal/" 2>/dev/null || true
done

# ── Phase 1: Digest Generation ──────────────────────────────────────────────

echo ""
echo "Phase 1: Digest Generation"
echo "--------------------------"

# Run digest generation for engineering persona
echo "  Running digest generation (engineering)..."
GEN_OUTPUT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');

  const config = {
    llm: { provider: 'simulate', model: 'test' },
    slack: { webhook_url: 'https://hooks.slack.com/services/T00/B00/test' }
  };

  digest.generateDigest(config, ['engineering', 'product'], '2026-02-24')
    .then(result => {
      console.log('FILES:' + result.files.length);
      console.log('PERSONAS:' + result.personas.join(','));
      console.log('FROM:' + result.dateRange.from);
      console.log('TO:' + result.dateRange.to);
      result.files.forEach(f => console.log('FILE:' + f));
    })
    .catch(e => {
      console.error('ERROR:' + e.message);
      process.exit(1);
    });
" 2>&1) || true

echo ""
echo "  Generation output validation:"

# Verify output format
if echo "$GEN_OUTPUT" | grep -qF "PERSONAS:engineering,product"; then
    _pass "generation includes both personas"
else
    _fail "generation includes both personas" "Output: $GEN_OUTPUT"
fi

if echo "$GEN_OUTPUT" | grep -qF "FROM:2026-02-24"; then
    _pass "date range from is correct"
else
    _fail "date range from is correct" "Output: $GEN_OUTPUT"
fi

# Verify digest files were created
DIGESTS_DIR="$TEST_HOME/.claude/team-context/digests"
TODAY_DATE=$(date +%Y-%m-%d)

echo ""
echo "  Digest file validation:"

assert_dir_exists "$DIGESTS_DIR/engineering" "engineering persona directory exists"
assert_dir_exists "$DIGESTS_DIR/product" "product persona directory exists"
assert_file_exists "$DIGESTS_DIR/engineering/${TODAY_DATE}.md" "engineering digest file exists"
assert_file_exists "$DIGESTS_DIR/product/${TODAY_DATE}.md" "product digest file exists"
assert_file_exists "$DIGESTS_DIR/${TODAY_DATE}-combined.md" "combined digest file exists"

# Verify content structure
if [ -f "$DIGESTS_DIR/engineering/${TODAY_DATE}.md" ]; then
    assert_file_contains "$DIGESTS_DIR/engineering/${TODAY_DATE}.md" "Engineering Digest" "engineering digest has persona heading"
    assert_file_contains "$DIGESTS_DIR/engineering/${TODAY_DATE}.md" "Technical Debt" "engineering digest has content sections"
fi

if [ -f "$DIGESTS_DIR/${TODAY_DATE}-combined.md" ]; then
    assert_file_contains "$DIGESTS_DIR/${TODAY_DATE}-combined.md" "Engineering Digest" "combined file has engineering section"
    assert_file_contains "$DIGESTS_DIR/${TODAY_DATE}-combined.md" "Product Digest" "combined file has product section"
fi

# ── Phase 2: Slack Delivery ─────────────────────────────────────────────────

echo ""
echo "Phase 2: Slack Delivery (simulation mode)"
echo "------------------------------------------"

echo "  Running Slack delivery..."
DELIVER_OUTPUT=$(node -e "
  const slack = require('$REPO_ROOT/bin/slack.js');

  const digestResult = {
    files: [],
    personas: ['engineering', 'product'],
    dateRange: { from: '2026-02-24', to: '${TODAY_DATE}' }
  };

  slack.deliverAll(
    'https://hooks.slack.com/services/T00/B00/test',
    digestResult,
    ['engineering', 'product']
  ).then(results => {
    console.log('COUNT:' + results.length);
    results.forEach(r => console.log('DELIVERED:' + r.persona + ':' + r.ok));
  }).catch(e => {
    console.error('ERROR:' + e.message);
    process.exit(1);
  });
" 2>&1) || true

echo ""
echo "  Slack delivery validation:"

if echo "$DELIVER_OUTPUT" | grep -qF "COUNT:2"; then
    _pass "deliverAll returned 2 results"
else
    _fail "deliverAll returned 2 results" "Output: $DELIVER_OUTPUT"
fi

if echo "$DELIVER_OUTPUT" | grep -qF "DELIVERED:engineering:true"; then
    _pass "engineering delivery succeeded"
else
    _fail "engineering delivery succeeded" "Output: $DELIVER_OUTPUT"
fi

if echo "$DELIVER_OUTPUT" | grep -qF "DELIVERED:product:true"; then
    _pass "product delivery succeeded"
else
    _fail "product delivery succeeded" "Output: $DELIVER_OUTPUT"
fi

# Verify Slack payload JSON files were written
ENG_SLACK="$DIGESTS_DIR/${TODAY_DATE}-slack-engineering.json"
PROD_SLACK="$DIGESTS_DIR/${TODAY_DATE}-slack-product.json"

assert_file_exists "$ENG_SLACK" "engineering Slack payload file exists"
assert_file_exists "$PROD_SLACK" "product Slack payload file exists"

if [ -f "$ENG_SLACK" ]; then
    assert_json_valid "$ENG_SLACK" "engineering Slack payload is valid JSON"
    assert_file_contains "$ENG_SLACK" ":wrench:" "engineering payload has wrench emoji"
    assert_file_contains "$ENG_SLACK" "Engineering Digest" "engineering payload has persona label"
fi

if [ -f "$PROD_SLACK" ]; then
    assert_json_valid "$PROD_SLACK" "product Slack payload is valid JSON"
    assert_file_contains "$PROD_SLACK" ":dart:" "product payload has dart emoji"
    assert_file_contains "$PROD_SLACK" "Product Digest" "product payload has persona label"
fi

# ── Phase 3: Signal Collection Validation ────────────────────────────────────

echo ""
echo "Phase 3: Signal & Journal Collection"
echo "-------------------------------------"

COLLECT_OUTPUT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  const signals = digest.collectSignals('2026-02-24');
  const journals = digest.collectJournals('2026-02-24');
  console.log('SIGNAL_LEN:' + signals.length);
  console.log('JOURNAL_LEN:' + journals.length);
  console.log('HAS_GITHUB:' + signals.includes('github'));
  console.log('HAS_JOURNAL:' + (journals.length > 0));
")

if echo "$COLLECT_OUTPUT" | grep -qF "HAS_GITHUB:true"; then
    _pass "signals include github channel"
else
    _fail "signals include github channel" "Output: $COLLECT_OUTPUT"
fi

if echo "$COLLECT_OUTPUT" | grep -qF "HAS_JOURNAL:true"; then
    _pass "journals were collected"
else
    _fail "journals were collected" "Output: $COLLECT_OUTPUT"
fi

# Verify signal content includes summary data
SIGNAL_CONTENT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  console.log(digest.collectSignals('2026-02-24'));
")

if echo "$SIGNAL_CONTENT" | grep -qF "5 PRs across 2 repos"; then
    _pass "signal content includes summary statistics"
else
    _fail "signal content includes summary statistics" "Summary stats not found"
fi

# Verify journal content includes session entries
JOURNAL_CONTENT=$(node -e "
  const digest = require('$REPO_ROOT/bin/digest.js');
  console.log(digest.collectJournals('2026-02-24'));
")

if echo "$JOURNAL_CONTENT" | grep -qF "Config-as-Code"; then
    _pass "journal content includes session entries"
else
    _fail "journal content includes session entries" "Session entries not found"
fi

# ── Results ──────────────────────────────────────────────────────────────────

print_results
[ "$FAIL" -eq 0 ]
