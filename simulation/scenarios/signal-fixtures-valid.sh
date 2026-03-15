#!/usr/bin/env bash
# Scenario: signal-fixtures-valid
# Validate all fixture files are valid JSON with expected structure.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: signal-fixtures-valid"
echo "================================"

FIXTURES="$SIM_DIR/fixtures/signals"

# ── Support tickets ──────────────────────────────────────────────────────────

echo ""
echo "  Support tickets:"
TICKETS="$FIXTURES/support/tickets.json"
assert_json_valid "$TICKETS" "tickets.json is valid JSON"
assert_json_array_not_empty "$TICKETS" "tickets.json is non-empty array"
assert_json_fields_present "$TICKETS" "id,created_at,subject,status,tags,messages" "tickets have required fields"

# Verify at least one ticket has each status
STATUSES=$(python3 -c "
import json
with open('$TICKETS') as f:
    data = json.load(f)
statuses = set(t['status'] for t in data)
print(','.join(sorted(statuses)))
" 2>/dev/null || echo "")
if echo "$STATUSES" | grep -q "resolved"; then
    _pass "tickets include 'resolved' status"
else
    _fail "tickets include 'resolved' status" "statuses found: $STATUSES"
fi

# ── CRM contacts ─────────────────────────────────────────────────────────────

echo ""
echo "  CRM contacts:"
CONTACTS="$FIXTURES/crm/contacts.json"
assert_json_valid "$CONTACTS" "contacts.json is valid JSON"
assert_json_array_not_empty "$CONTACTS" "contacts.json is non-empty array"
assert_json_fields_present "$CONTACTS" "id,company,health_score,nps_score,last_activity,lifecycle_stage,signals" "contacts have required fields"

# Verify health scores are numeric and in range
SCORE_CHECK=$(python3 -c "
import json
with open('$CONTACTS') as f:
    data = json.load(f)
for c in data:
    if not isinstance(c['health_score'], (int, float)) or c['health_score'] < 0 or c['health_score'] > 100:
        print(f'INVALID: {c[\"id\"]} has health_score {c[\"health_score\"]}')
        exit(0)
print('OK')
" 2>/dev/null || echo "ERROR")
if [ "$SCORE_CHECK" = "OK" ]; then
    _pass "all health scores are valid (0-100)"
else
    _fail "all health scores are valid (0-100)" "$SCORE_CHECK"
fi

# ── CI/CD workflows ──────────────────────────────────────────────────────────

echo ""
echo "  CI/CD workflows:"
WORKFLOWS="$FIXTURES/cicd/workflows.json"
assert_json_valid "$WORKFLOWS" "workflows.json is valid JSON"
assert_json_array_not_empty "$WORKFLOWS" "workflows.json is non-empty array"
assert_json_fields_present "$WORKFLOWS" "id,name,status,created_at,branch" "workflows have required fields"

# Verify mix of success and failure
CONCLUSIONS=$(python3 -c "
import json
with open('$WORKFLOWS') as f:
    data = json.load(f)
conclusions = set(w['conclusion'] for w in data if w['conclusion'] is not None)
print(','.join(sorted(conclusions)))
" 2>/dev/null || echo "")
if echo "$CONCLUSIONS" | grep -q "success" && echo "$CONCLUSIONS" | grep -q "failure"; then
    _pass "workflows include both success and failure conclusions"
else
    _fail "workflows include both success and failure conclusions" "found: $CONCLUSIONS"
fi

# ── Chat decisions ────────────────────────────────────────────────────────────

echo ""
echo "  Chat decisions:"
DECISIONS="$FIXTURES/chat/decisions.json"
assert_json_valid "$DECISIONS" "decisions.json is valid JSON"
assert_json_array_not_empty "$DECISIONS" "decisions.json is non-empty array"
assert_json_fields_present "$DECISIONS" "channel,topic,messages,decision,date" "decisions have required fields"

# Verify each decision has at least 2 messages
MSG_CHECK=$(python3 -c "
import json
with open('$DECISIONS') as f:
    data = json.load(f)
for d in data:
    if len(d['messages']) < 2:
        print(f'INVALID: \"{d[\"topic\"]}\" has only {len(d[\"messages\"])} message(s)')
        exit(0)
print('OK')
" 2>/dev/null || echo "ERROR")
if [ "$MSG_CHECK" = "OK" ]; then
    _pass "all decisions have at least 2 messages"
else
    _fail "all decisions have at least 2 messages" "$MSG_CHECK"
fi

# ── GitHub signals ───────────────────────────────────────────────────────────

echo ""
echo "  GitHub issues:"
GH_ISSUES="$FIXTURES/github/issues.json"
assert_json_valid "$GH_ISSUES" "issues.json is valid JSON"
assert_json_array_not_empty "$GH_ISSUES" "issues.json is non-empty array"
assert_json_fields_present "$GH_ISSUES" "id,number,title,state,created_at,user,labels" "issues have required fields"

# Verify no issues have pull_request key (those are PRs, not issues)
PR_KEY_CHECK=$(python3 -c "
import json
with open('$GH_ISSUES') as f:
    data = json.load(f)
for issue in data:
    if 'pull_request' in issue:
        print(f'INVALID: issue #{issue[\"number\"]} has pull_request key')
        exit(0)
print('OK')
" 2>/dev/null || echo "ERROR")
if [ "$PR_KEY_CHECK" = "OK" ]; then
    _pass "no issues have pull_request key"
else
    _fail "no issues have pull_request key" "$PR_KEY_CHECK"
fi

echo ""
echo "  GitHub pull requests:"
GH_PRS="$FIXTURES/github/pull_requests.json"
assert_json_valid "$GH_PRS" "pull_requests.json is valid JSON"
assert_json_array_not_empty "$GH_PRS" "pull_requests.json is non-empty array"
assert_json_fields_present "$GH_PRS" "id,number,title,state,created_at,user,head,base" "PRs have required fields"

# Verify mix of states
PR_STATES=$(python3 -c "
import json
with open('$GH_PRS') as f:
    data = json.load(f)
states = set()
for pr in data:
    if pr.get('merged_at'):
        states.add('merged')
    else:
        states.add(pr['state'])
print(','.join(sorted(states)))
" 2>/dev/null || echo "")
if echo "$PR_STATES" | grep -q "merged" && echo "$PR_STATES" | grep -q "open"; then
    _pass "PRs include both open and merged states"
else
    _fail "PRs include both open and merged states" "found: $PR_STATES"
fi

echo ""
echo "  GitHub workflow runs:"
GH_RUNS="$FIXTURES/github/workflow_runs.json"
assert_json_valid "$GH_RUNS" "workflow_runs.json is valid JSON"

# Check it has workflow_runs array (GitHub wraps in object)
RUNS_CHECK=$(python3 -c "
import json
with open('$GH_RUNS') as f:
    data = json.load(f)
if 'workflow_runs' not in data:
    print('MISSING_KEY')
elif not isinstance(data['workflow_runs'], list):
    print('NOT_ARRAY')
elif len(data['workflow_runs']) == 0:
    print('EMPTY')
else:
    print('OK')
" 2>/dev/null || echo "ERROR")
if [ "$RUNS_CHECK" = "OK" ]; then
    _pass "workflow_runs.json has non-empty workflow_runs array"
else
    _fail "workflow_runs.json has non-empty workflow_runs array" "$RUNS_CHECK"
fi

# Verify mix of conclusions
RUN_CONCLUSIONS=$(python3 -c "
import json
with open('$GH_RUNS') as f:
    data = json.load(f)
conclusions = set(r.get('conclusion') for r in data['workflow_runs'] if r.get('conclusion'))
print(','.join(sorted(conclusions)))
" 2>/dev/null || echo "")
if echo "$RUN_CONCLUSIONS" | grep -q "success" && echo "$RUN_CONCLUSIONS" | grep -q "failure"; then
    _pass "workflow runs include both success and failure conclusions"
else
    _fail "workflow runs include both success and failure conclusions" "found: $RUN_CONCLUSIONS"
fi

print_results
[ "$FAIL" -eq 0 ]
