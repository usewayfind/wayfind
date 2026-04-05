#!/usr/bin/env bash
# Tests for Intercom connector module
set -euo pipefail

PASS=0; FAIL=0; ERRORS=()

assert_eq() { local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then PASS=$((PASS+1)); echo "  ✓ $desc"
  else FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — expected '$expected', got '$actual'"); echo "  ✗ $desc"; fi
}

assert_contains() { local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then PASS=$((PASS+1)); echo "  ✓ $desc"
  else FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — '$needle' not found"); echo "  ✗ $desc"; fi
}

assert_not_contains() { local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then FAIL=$((FAIL+1)); ERRORS+=("FAIL: $desc — '$needle' unexpectedly found"); echo "  ✗ $desc"
  else PASS=$((PASS+1)); echo "  ✓ $desc"; fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "Intercom Connector Tests"
echo "========================"

# Test: connector registry includes intercom
echo ""
echo "Registry:"
REGISTRY_TEST=$(node -e "
const reg = require('$SCRIPT_DIR/bin/connectors');
console.log(JSON.stringify(reg.list()));
console.log(reg.get('intercom') !== null ? 'HAS_INTERCOM' : 'NO_INTERCOM');
" 2>&1)
assert_contains "registry lists intercom" "intercom" "$REGISTRY_TEST"
assert_contains "registry.get('intercom') returns connector" "HAS_INTERCOM" "$REGISTRY_TEST"

# Test: intercom module loads and exports expected functions
echo ""
echo "Module exports:"
MODULE_TEST=$(node -e "
const intercom = require('$SCRIPT_DIR/bin/connectors/intercom');
console.log(typeof intercom.configure === 'function' ? 'HAS_CONFIGURE' : 'NO_CONFIGURE');
console.log(typeof intercom.pull === 'function' ? 'HAS_PULL' : 'NO_PULL');
console.log(typeof intercom.summarize === 'function' ? 'HAS_SUMMARIZE' : 'NO_SUMMARIZE');
" 2>&1)
assert_contains "exports configure()" "HAS_CONFIGURE" "$MODULE_TEST"
assert_contains "exports pull()" "HAS_PULL" "$MODULE_TEST"
assert_contains "exports summarize()" "HAS_SUMMARIZE" "$MODULE_TEST"

# Test: simulation pull
echo ""
echo "Simulated Pull:"

TEST_HOME=$(mktemp -d)
ORIG_HOME="$HOME"
export HOME="$TEST_HOME"

cleanup() {
    export HOME="$ORIG_HOME"
    rm -rf "$TEST_HOME"
}
trap cleanup EXIT

# Pre-configure
mkdir -p "$TEST_HOME/.claude/team-context"
cat > "$TEST_HOME/.claude/team-context/connectors.json" << 'CONNEOF'
{
  "intercom": {
    "transport": "https",
    "token": "fake-token",
    "tag_filter": null,
    "last_pull": null
  }
}
CONNEOF

export TEAM_CONTEXT_SIMULATE=1
export TEAM_CONTEXT_SIM_FIXTURES="$SCRIPT_DIR/simulation/fixtures/signals/intercom"

PULL_OUTPUT=$(node "$SCRIPT_DIR/bin/team-context.js" pull intercom --since 2026-02-20 2>&1) || true
assert_contains "pull output shows Conversations" "Conversations:" "$PULL_OUTPUT"
assert_contains "pull output shows Open" "Open:" "$PULL_OUTPUT"

# Check signal file was created
TODAY_DATE=$(date +%Y-%m-%d)
SIGNAL_FILE="$TEST_HOME/.claude/team-context/signals/intercom/${TODAY_DATE}.md"
if [ -f "$SIGNAL_FILE" ]; then
    PASS=$((PASS+1)); echo "  ✓ signal file created"
    SIGNAL_CONTENT=$(cat "$SIGNAL_FILE")
    assert_contains "signal file has Volume section" "## Volume" "$SIGNAL_CONTENT"
    assert_contains "signal file has Top Tags section" "## Top Tags" "$SIGNAL_CONTENT"
    assert_contains "signal file has Summary section" "## Summary" "$SIGNAL_CONTENT"
    assert_contains "signal file has conversation count" "conversations" "$SIGNAL_CONTENT"
    assert_contains "signal file has Intercom Signals title" "# Intercom Signals" "$SIGNAL_CONTENT"
else
    FAIL=$((FAIL+1)); ERRORS+=("FAIL: signal file not created at $SIGNAL_FILE"); echo "  ✗ signal file created"
fi

# Test: privacy — no raw customer content in signal files
echo ""
echo "Privacy:"
if [ -f "$SIGNAL_FILE" ]; then
    SIGNAL_CONTENT=$(cat "$SIGNAL_FILE")
    # Fixture conversations don't contain customer messages in output
    assert_not_contains "no raw customer messages in signal" "I can't log in" "$SIGNAL_CONTENT"
    assert_not_contains "no customer names in signal" "customer" "$SIGNAL_CONTENT"
fi

# Test: tag analysis
echo ""
echo "Analysis:"
ANALYSIS_TEST=$(TEAM_CONTEXT_SIMULATE=1 TEAM_CONTEXT_SIM_FIXTURES="$SCRIPT_DIR/simulation/fixtures/signals/intercom" node -e "
const intercom = require('$SCRIPT_DIR/bin/connectors/intercom');

async function test() {
    const config = { token: 'fake', tag_filter: null };
    const result = await intercom.pull(config, '2026-02-20');
    console.log('TOTAL:' + result.counts.conversations);
    console.log('OPEN:' + result.counts.open);
    console.log('TAGS:' + result.counts.tags);
    console.log('FILES:' + result.files.length);
}
test().catch(e => { console.error(e.message); process.exit(1); });
" 2>&1)
assert_contains "simulation returns conversations" "TOTAL:8" "$ANALYSIS_TEST"
assert_contains "simulation counts open conversations" "OPEN:2" "$ANALYSIS_TEST"
assert_contains "simulation counts tags" "TAGS:" "$ANALYSIS_TEST"
assert_contains "simulation creates files" "FILES:1" "$ANALYSIS_TEST"

# Test: tag filtering
echo ""
echo "Tag Filtering:"
TAG_FILTER_TEST=$(TEAM_CONTEXT_SIMULATE=1 TEAM_CONTEXT_SIM_FIXTURES="$SCRIPT_DIR/simulation/fixtures/signals/intercom" node -e "
const intercom = require('$SCRIPT_DIR/bin/connectors/intercom');

async function test() {
    // Only include conversations tagged 'enterprise'
    const config = { token: 'fake', tag_filter: ['enterprise'] };
    const result = await intercom.pull(config, '2026-02-20');
    console.log('FILTERED_COUNT:' + result.counts.conversations);
}
test().catch(e => { console.error(e.message); process.exit(1); });
" 2>&1)
assert_contains "tag filter reduces conversation count" "FILTERED_COUNT:3" "$TAG_FILTER_TEST"

# Test: summarize extracts Summary section
echo ""
echo "Summarize:"
if [ -f "$SIGNAL_FILE" ]; then
    SUMMARIZE_TEST=$(node -e "
const intercom = require('$SCRIPT_DIR/bin/connectors/intercom');
const summary = intercom.summarize('$SIGNAL_FILE');
if (summary) {
    console.log('HAS_SUMMARY');
    if (summary.includes('conversations')) console.log('HAS_CONVERSATIONS');
} else {
    console.log('NO_SUMMARY');
}
" 2>&1)
    assert_contains "summarize extracts summary" "HAS_SUMMARY" "$SUMMARIZE_TEST"
    assert_contains "summary mentions conversations" "HAS_CONVERSATIONS" "$SUMMARIZE_TEST"
fi

# Test: signals command shows intercom
echo ""
echo "Signals Command:"
SIGNALS_OUTPUT=$(node "$SCRIPT_DIR/bin/team-context.js" signals 2>&1) || true
assert_contains "signals shows intercom" "intercom" "$SIGNALS_OUTPUT"
assert_contains "signals shows transport" "https" "$SIGNALS_OUTPUT"

# Test: last_pull is updated after pull
echo ""
echo "Config update:"
LAST_PULL=$(node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$TEST_HOME/.claude/team-context/connectors.json', 'utf8'));
console.log(config.intercom.last_pull !== null ? 'UPDATED' : 'NULL');
" 2>&1)
assert_eq "last_pull updated after pull" "UPDATED" "$LAST_PULL"

# Note: intent classification and signal search tests removed — the bot now uses
# LLM tool-use relay for intent classification instead of keyword heuristics.

# Summary
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "${#ERRORS[@]}" -gt 0 ]; then
    for err in "${ERRORS[@]}"; do
        echo "  $err"
    done
fi
[ "$FAIL" -eq 0 ]
