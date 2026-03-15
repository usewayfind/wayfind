#!/usr/bin/env bash
# Scenario: github-pull-simulate
# End-to-end test of GitHub signal pull with simulated transport.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: github-pull-simulate"
echo "================================"

# Set up temp home for isolation
ORIG_HOME="$HOME"
TEST_HOME=$(mktemp -d)
export HOME="$TEST_HOME"

cleanup() {
    export HOME="$ORIG_HOME"
    rm -rf "$TEST_HOME"
}
trap cleanup EXIT

# Pre-configure connectors.json so pull doesn't need interactive input
mkdir -p "$TEST_HOME/.claude/team-context"
cat > "$TEST_HOME/.claude/team-context/connectors.json" << 'EOF'
{
  "github": {
    "transport": "simulate",
    "token": null,
    "repos": [
      { "owner": "HopSkipInc", "repo": "EventSubscriptionService" },
      { "owner": "HopSkipInc", "repo": "AnalyticsService" }
    ],
    "configured_at": "2026-03-01T10:00:00Z",
    "last_pull": null
  }
}
EOF

# Run simulated pull
echo ""
echo "  Running simulated pull..."
export TEAM_CONTEXT_SIMULATE=1
export TEAM_CONTEXT_SIM_FIXTURES="$SIM_DIR/fixtures/signals/github"

OUTPUT=$(node "$REPO_ROOT/bin/team-context.js" pull github --since 2026-02-20 2>&1) || true

echo ""
echo "  Pull output validation:"

# Verify output mentions repos
if echo "$OUTPUT" | grep -qF "HopSkipInc"; then
    _pass "output mentions org name"
else
    _fail "output mentions org name" "HopSkipInc not found in output"
fi

if echo "$OUTPUT" | grep -qF "repo(s)"; then
    _pass "output shows repo count"
else
    _fail "output shows repo count" "repo(s) not found in output"
fi

if echo "$OUTPUT" | grep -qF "Issues:"; then
    _pass "output shows issue count"
else
    _fail "output shows issue count" "Issues: not found in output"
fi

if echo "$OUTPUT" | grep -qF "PRs:"; then
    _pass "output shows PR count"
else
    _fail "output shows PR count" "PRs: not found in output"
fi

if echo "$OUTPUT" | grep -qF "CI runs:"; then
    _pass "output shows CI run count"
else
    _fail "output shows CI run count" "CI runs: not found in output"
fi

# Verify signal files were written (file named by today's date, not since date)
echo ""
echo "  Signal file validation:"
SIGNALS_DIR="$TEST_HOME/.claude/team-context/signals/github"
TODAY_DATE=$(date +%Y-%m-%d)

# Check per-repo files exist
assert_file_exists "$SIGNALS_DIR/HopSkipInc/EventSubscriptionService/${TODAY_DATE}.md" "EventSubscriptionService signal file exists"
assert_file_exists "$SIGNALS_DIR/HopSkipInc/AnalyticsService/${TODAY_DATE}.md" "AnalyticsService signal file exists"

# Check rollup summary exists
assert_file_exists "$SIGNALS_DIR/${TODAY_DATE}-summary.md" "rollup summary file exists"

# Verify markdown content structure
if [ -f "$SIGNALS_DIR/HopSkipInc/EventSubscriptionService/${TODAY_DATE}.md" ]; then
    SIGNAL_FILE="$SIGNALS_DIR/HopSkipInc/EventSubscriptionService/${TODAY_DATE}.md"
    assert_file_contains "$SIGNAL_FILE" "## Pull Requests" "signal file has PR section"
    assert_file_contains "$SIGNAL_FILE" "## Issues" "signal file has Issues section"
    assert_file_contains "$SIGNAL_FILE" "## CI/CD" "signal file has CI/CD section"
    assert_file_contains "$SIGNAL_FILE" "## Summary" "signal file has Summary section"
fi

if [ -f "$SIGNALS_DIR/${TODAY_DATE}-summary.md" ]; then
    assert_file_contains "$SIGNALS_DIR/${TODAY_DATE}-summary.md" "Summary" "rollup has Summary section"
fi

# Verify connectors.json was updated with last_pull
echo ""
echo "  Config update validation:"
LAST_PULL=$(python3 -c "
import json
with open('$TEST_HOME/.claude/team-context/connectors.json') as f:
    data = json.load(f)
print(data.get('github', {}).get('last_pull', 'null'))
" 2>/dev/null || echo "null")
if [ "$LAST_PULL" != "null" ]; then
    _pass "last_pull was updated in connectors.json"
else
    _fail "last_pull was updated in connectors.json" "last_pull is still null"
fi

# Test 'wayfind signals' command
echo ""
echo "  Signals command:"
SIGNALS_OUTPUT=$(node "$REPO_ROOT/bin/team-context.js" signals 2>&1) || true
if echo "$SIGNALS_OUTPUT" | grep -qF "github"; then
    _pass "signals command shows github channel"
else
    _fail "signals command shows github channel" "github not found in output"
fi

if echo "$SIGNALS_OUTPUT" | grep -qF "repo(s)"; then
    _pass "signals command shows repo count"
else
    _fail "signals command shows repo count" "repo(s) not found in output"
fi

print_results
[ "$FAIL" -eq 0 ]
