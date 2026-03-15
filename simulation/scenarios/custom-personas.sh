#!/usr/bin/env bash
# Scenario: custom-personas
# Verify persona configuration: templates, CLI add/remove/reset, and state customization.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: custom-personas"
echo "=========================="

# Set up isolated HOME
MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

# Run setup
bash "$KIT_DIR/setup.sh" --tool claude-code >/dev/null 2>&1

# Verify the personas.json template and installed config exist
assert_file_exists "$KIT_DIR/templates/personas.json" "personas.json template exists in kit"
assert_file_exists "$MOCK_HOME/.claude/team-context/personas.json" "personas.json installed to user config"

# Verify installed personas.json has the default personas
assert_json_valid "$MOCK_HOME/.claude/team-context/personas.json" "installed personas.json is valid JSON"
assert_json_field "$MOCK_HOME/.claude/team-context/personas.json" ".personas[0].id" "product" "first default persona is product"

# Verify the core state templates exist
assert_file_exists "$KIT_DIR/templates/global.md" "global.md template exists"
assert_file_exists "$KIT_DIR/templates/team-state.md" "team-state.md template exists"
assert_file_exists "$KIT_DIR/templates/repo-state.md" "repo-state.md template exists"

# Test CLI personas --add with valid ID
node "$KIT_DIR/bin/team-context.js" personas --add devops DevOps "CI/CD and infrastructure" >/dev/null 2>&1
assert_json_field "$MOCK_HOME/.claude/team-context/personas.json" ".personas[4].id" "devops" "CLI added devops persona"
assert_json_field "$MOCK_HOME/.claude/team-context/personas.json" ".personas[4].name" "DevOps" "CLI added devops with correct name"

# Test CLI personas --add rejects invalid ID (spaces, uppercase)
INVALID_EXIT=0
node "$KIT_DIR/bin/team-context.js" personas --add "Bad Name" "Bad" >/dev/null 2>&1 || INVALID_EXIT=$?
if [ "$INVALID_EXIT" -ne 0 ]; then
    _pass "CLI rejects invalid persona ID with spaces"
else
    _fail "CLI rejects invalid persona ID with spaces" "expected non-zero exit"
fi

# Test CLI personas --remove
node "$KIT_DIR/bin/team-context.js" personas --remove devops >/dev/null 2>&1
PERSONAS_COUNT=$(python3 -c "import json, sys; print(len(json.load(open(sys.argv[1]))['personas']))" "$MOCK_HOME/.claude/team-context/personas.json" 2>/dev/null)
if [ "$PERSONAS_COUNT" = "4" ]; then
    _pass "CLI removed devops persona (back to 4)"
else
    _fail "CLI removed devops persona" "expected 4 personas, got $PERSONAS_COUNT"
fi

# Test CLI personas --reset
node "$KIT_DIR/bin/team-context.js" personas --add qa QA >/dev/null 2>&1
node "$KIT_DIR/bin/team-context.js" personas --reset >/dev/null 2>&1
RESET_COUNT=$(python3 -c "import json, sys; print(len(json.load(open(sys.argv[1]))['personas']))" "$MOCK_HOME/.claude/team-context/personas.json" 2>/dev/null)
if [ "$RESET_COUNT" = "4" ]; then
    _pass "CLI reset restored default personas"
else
    _fail "CLI reset restored default personas" "expected 4 personas, got $RESET_COUNT"
fi

# Simulate a user customizing their team-state.md with additional roles
MOCK_REPO="$(mktemp -d)"
mkdir -p "$MOCK_REPO/.claude"
cp "$KIT_DIR/templates/team-state.md" "$MOCK_REPO/.claude/team-state.md"

cat >> "$MOCK_REPO/.claude/team-state.md" <<'EOF'

## DevOps Context

- CI/CD: GitHub Actions with self-hosted runners
- Infrastructure: Terraform-managed GCP
EOF

assert_file_contains "$MOCK_REPO/.claude/team-state.md" "DevOps Context" "custom DevOps section added"
assert_file_contains "$MOCK_REPO/.claude/team-state.md" "Architecture" "original sections preserved"

# Clean up
rm -rf "$MOCK_REPO"

print_results
[ "$FAIL" -eq 0 ]
