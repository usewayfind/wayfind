#!/usr/bin/env bash
# Scenario: join-existing-team
# Simulate a second person joining by using an existing team-state.md.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: join-existing-team"
echo "============================="

# Set up isolated HOME
MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

# Run setup for the "joining" user
bash "$KIT_DIR/setup.sh" --tool claude-code >/dev/null 2>&1

# Simulate a repo that already has team-state.md from another team member
MOCK_REPO="$(mktemp -d)"
mkdir -p "$MOCK_REPO/.claude"

# Create a team-state.md that looks like it was already initialized by someone else
cat > "$MOCK_REPO/.claude/team-state.md" <<'EOF'
# Team State — Sample Project

Last updated: 2026-02-28

## Team

| Name | Role | Joined |
|------|------|--------|
| Alice | Tech Lead | 2026-02-01 |

## Architecture & Key Decisions

- **Auth:** JWT tokens with refresh rotation
- **Database:** PostgreSQL 16 with pgvector
- **Deployment:** Kubernetes on GCP

## Current Sprint

- [ ] Implement dark mode (Alice)
- [x] Fix CSV export regression
EOF

# The joining user should be able to use the repo's team-state.md
assert_file_exists "$MOCK_REPO/.claude/team-state.md" "team-state.md exists in repo"
assert_file_contains "$MOCK_REPO/.claude/team-state.md" "Alice" "existing team member present"
assert_file_contains "$MOCK_REPO/.claude/team-state.md" "Architecture" "architecture section present"

# The joining user can add themselves by appending to the file
# (In real usage, Claude does this via /init-memory — here we simulate the outcome)
cat >> "$MOCK_REPO/.claude/team-state.md" <<'EOF'
| Bob | Backend Dev | 2026-02-28 |
EOF

assert_file_contains "$MOCK_REPO/.claude/team-state.md" "Bob" "new team member added to team-state.md"
assert_file_contains "$MOCK_REPO/.claude/team-state.md" "Alice" "original team member still present"

# Also create the personal (gitignored) state for the joining user
cp "$KIT_DIR/templates/personal-state.md" "$MOCK_REPO/.claude/personal-state.md"
assert_file_exists "$MOCK_REPO/.claude/personal-state.md" "personal-state.md created for joining user"

# Verify the joining user's global setup still works
assert_file_exists "$MOCK_HOME/.claude/global-state.md" "joiner has global-state.md"
assert_file_exists "$MOCK_HOME/.claude/settings.json" "joiner has settings.json"

# Clean up
rm -rf "$MOCK_REPO"

print_results
[ "$FAIL" -eq 0 ]
