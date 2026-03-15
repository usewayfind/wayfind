#!/usr/bin/env bash
# Tests for Notion connector module
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
echo "Notion Connector Tests"
echo "======================"

# ── Registry ─────────────────────────────────────────────────────────────────

echo ""
echo "Registry:"

REGISTRY_TEST=$(node -e "
const reg = require('$SCRIPT_DIR/bin/connectors');
console.log(JSON.stringify(reg.list()));
console.log(reg.get('notion') !== null ? 'HAS_NOTION' : 'NO_NOTION');
" 2>&1)
assert_contains "registry lists notion" "notion" "$REGISTRY_TEST"
assert_contains "registry.get('notion') returns connector" "HAS_NOTION" "$REGISTRY_TEST"

# ── Module exports ───────────────────────────────────────────────────────────

echo ""
echo "Module exports:"

EXPORTS_TEST=$(node -e "
const notion = require('$SCRIPT_DIR/bin/connectors/notion');
console.log('HAS_CONFIGURE:' + (typeof notion.configure === 'function'));
console.log('HAS_PULL:' + (typeof notion.pull === 'function'));
console.log('HAS_SUMMARIZE:' + (typeof notion.summarize === 'function'));
" 2>&1)
assert_contains "exports configure()" "HAS_CONFIGURE:true" "$EXPORTS_TEST"
assert_contains "exports pull()" "HAS_PULL:true" "$EXPORTS_TEST"
assert_contains "exports summarize()" "HAS_SUMMARIZE:true" "$EXPORTS_TEST"

# ── Simulated pull ───────────────────────────────────────────────────────────

echo ""
echo "Simulated Pull:"

ORIG_HOME="$HOME"
TEST_HOME=$(mktemp -d)
export HOME="$TEST_HOME"
cleanup() { export HOME="$ORIG_HOME"; rm -rf "$TEST_HOME"; }
trap cleanup EXIT

mkdir -p "$TEST_HOME/.claude/team-context"
cat > "$TEST_HOME/.claude/team-context/connectors.json" << 'CONNEOF'
{
  "notion": {
    "transport": "https",
    "token": "ntn_simulated",
    "databases": ["db-bugs"],
    "last_pull": null
  }
}
CONNEOF

export TEAM_CONTEXT_SIMULATE=1
export TEAM_CONTEXT_SIM_NOTION_FIXTURES="$SCRIPT_DIR/simulation/fixtures/signals/notion"

PULL_OUTPUT=$(node "$SCRIPT_DIR/bin/team-context.js" pull notion --since 2026-02-20 2>&1) || true
assert_contains "pull output shows Pages" "Pages:" "$PULL_OUTPUT"

# Check signal file was created
TODAY_DATE=$(date +%Y-%m-%d)
SIGNAL_FILE="$TEST_HOME/.claude/team-context/signals/notion/${TODAY_DATE}.md"
if [ -f "$SIGNAL_FILE" ]; then
    PASS=$((PASS+1)); echo "  ✓ signal file created"
    SIGNAL_CONTENT=$(cat "$SIGNAL_FILE")
    assert_contains "signal file has Volume section" "## Volume" "$SIGNAL_CONTENT"
    assert_contains "signal file has Recently Updated Pages section" "## Recently Updated Pages" "$SIGNAL_CONTENT"
    assert_contains "signal file has Summary section" "## Summary" "$SIGNAL_CONTENT"
    assert_contains "signal file has Notion Signals title" "# Notion Signals" "$SIGNAL_CONTENT"
    assert_contains "signal file has page count" "pages updated" "$SIGNAL_CONTENT"
else
    FAIL=$((FAIL+1)); ERRORS+=("FAIL: signal file not created at $SIGNAL_FILE"); echo "  ✗ signal file created"
fi

# ── Page title extraction ────────────────────────────────────────────────────

echo ""
echo "Page Data:"

PAGE_TEST=$(node -e "
const fs = require('fs');
const content = fs.readFileSync('$SIGNAL_FILE', 'utf8');
console.log('HAS_ROADMAP:' + content.includes('Q2 2026 Product Roadmap'));
console.log('HAS_AUTH:' + content.includes('Auth Migration Design Spec'));
console.log('HAS_RETRO:' + content.includes('Sprint 14 Retrospective'));
console.log('HAS_PRICING:' + content.includes('Pricing Strategy v2'));
" 2>&1)
assert_contains "signal has roadmap page" "HAS_ROADMAP:true" "$PAGE_TEST"
assert_contains "signal has auth spec page" "HAS_AUTH:true" "$PAGE_TEST"
assert_contains "signal has retro page" "HAS_RETRO:true" "$PAGE_TEST"
assert_contains "signal has pricing page" "HAS_PRICING:true" "$PAGE_TEST"

# ── Editor attribution ───────────────────────────────────────────────────────

echo ""
echo "Editor Attribution:"

EDITOR_TEST=$(node -e "
const fs = require('fs');
const content = fs.readFileSync('$SIGNAL_FILE', 'utf8');
console.log('HAS_APRIL:' + content.includes('April'));
console.log('HAS_NICK:' + content.includes('Nick'));
console.log('HAS_GREG:' + content.includes('Greg'));
console.log('HAS_CONTRIBUTORS:' + content.includes('Top Contributors'));
" 2>&1)
assert_contains "signal shows April" "HAS_APRIL:true" "$EDITOR_TEST"
assert_contains "signal shows Nick" "HAS_NICK:true" "$EDITOR_TEST"
assert_contains "signal shows Greg" "HAS_GREG:true" "$EDITOR_TEST"
assert_contains "signal has Top Contributors" "HAS_CONTRIBUTORS:true" "$EDITOR_TEST"

# ── Database entries ─────────────────────────────────────────────────────────

echo ""
echo "Database Entries:"

DB_TEST=$(node -e "
const fs = require('fs');
const content = fs.readFileSync('$SIGNAL_FILE', 'utf8');
console.log('HAS_DB_SECTION:' + content.includes('Database Entry Status'));
console.log('HAS_IN_PROGRESS:' + content.includes('In Progress'));
console.log('HAS_DONE:' + content.includes('Done'));
console.log('HAS_DB_ENTRIES:' + content.includes('database entries'));
" 2>&1)
assert_contains "signal has database status section" "HAS_DB_SECTION:true" "$DB_TEST"
assert_contains "signal shows In Progress status" "HAS_IN_PROGRESS:true" "$DB_TEST"
assert_contains "signal shows Done status" "HAS_DONE:true" "$DB_TEST"
assert_contains "signal mentions database entries" "HAS_DB_ENTRIES:true" "$DB_TEST"

# ── Comments ─────────────────────────────────────────────────────────────────

echo ""
echo "Comments:"

COMMENT_TEST=$(node -e "
const fs = require('fs');
const content = fs.readFileSync('$SIGNAL_FILE', 'utf8');
console.log('HAS_DISCUSSIONS:' + content.includes('Active Discussions'));
console.log('HAS_COMMENT_COUNT:' + content.includes('new comment'));
" 2>&1)
assert_contains "signal has Active Discussions section" "HAS_DISCUSSIONS:true" "$COMMENT_TEST"
assert_contains "signal shows comment counts" "HAS_COMMENT_COUNT:true" "$COMMENT_TEST"

# ── Summarize ────────────────────────────────────────────────────────────────

echo ""
echo "Summarize:"

SUMMARIZE_TEST=$(node -e "
const notion = require('$SCRIPT_DIR/bin/connectors/notion');
const summary = notion.summarize('$SIGNAL_FILE');
console.log('HAS_SUMMARY:' + (summary !== null));
console.log('SUMMARY_TEXT:' + summary);
" 2>&1)
assert_contains "summarize extracts summary" "HAS_SUMMARY:true" "$SUMMARIZE_TEST"
assert_contains "summary mentions pages" "pages updated" "$SUMMARIZE_TEST"

# ── Signals command ──────────────────────────────────────────────────────────

echo ""
echo "Signals Command:"

SIGNALS_OUTPUT=$(node "$SCRIPT_DIR/bin/team-context.js" signals 2>&1) || true
assert_contains "signals shows notion" "notion" "$SIGNALS_OUTPUT"

# ── Config update ────────────────────────────────────────────────────────────

echo ""
echo "Config update:"

CONFIG_TEST=$(node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$TEST_HOME/.claude/team-context/connectors.json', 'utf8'));
console.log('LAST_PULL:' + (config.notion.last_pull !== null ? 'UPDATED' : 'NULL'));
" 2>&1)
assert_contains "last_pull updated after pull" "LAST_PULL:UPDATED" "$CONFIG_TEST"

# ── Privacy ──────────────────────────────────────────────────────────────────

echo ""
echo "Privacy:"

if [ -f "$SIGNAL_FILE" ]; then
  PRIVACY_CONTENT=$(cat "$SIGNAL_FILE")
  # Signal files should not contain raw page content or comment text
  assert_not_contains "no raw comment text in signal" "Updated timeline for auth migration" "$PRIVACY_CONTENT"
  assert_not_contains "no raw comment text in signal" "Dependency on new token service" "$PRIVACY_CONTENT"
fi

# ── pull --all includes notion ───────────────────────────────────────────────

echo ""
echo "Pull --all:"

PULL_ALL=$(node "$SCRIPT_DIR/bin/team-context.js" pull --all --since 2026-02-20 2>&1) || true
assert_contains "pull --all includes notion" "Pulling notion" "$PULL_ALL"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "${#ERRORS[@]}" -gt 0 ]; then
    for err in "${ERRORS[@]}"; do
        echo "  $err"
    done
fi
[ "$FAIL" -eq 0 ]
