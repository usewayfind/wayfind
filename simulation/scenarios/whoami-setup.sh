#!/usr/bin/env bash
# Scenario: whoami-setup
# Verify the global state profile creation flow works correctly.
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: whoami-setup"
echo "======================="

# Set up isolated HOME
MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"' EXIT
export HOME="$MOCK_HOME"

# Run setup
bash "$KIT_DIR/setup.sh" --tool claude-code >/dev/null 2>&1

# Verify fresh install has a template global-state.md
assert_file_exists "$MOCK_HOME/.claude/global-state.md" "global-state.md exists after setup"

# Verify it has placeholder content (not yet personalized)
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "YYYY-MM-DD" "global-state.md has placeholder date"

# Simulate a user filling in their profile (what /init-memory or manual edit does)
cat > "$MOCK_HOME/.claude/global-state.md" <<'EOF'
# Global State — Index

Last updated: 2026-02-28

## Preferences

### Working style
- Direct and concise, skip pleasantries
- Draft all external comms before sending
- Prefer async over meetings

### Technical preferences
- TypeScript strict mode
- Imperative commit messages
- Test before merge

### Team context
- Sarah (Design): async feedback via Figma, 24h heads-up for scope changes
- Jordan (co-founder): peer, keep informed, manages own workload

### Decision frameworks
- Pricing: always segment paid vs free first
- Build vs buy: default buy for non-core infra

## Active Projects

| Project | Repo | Status | Next |
|---------|------|--------|------|
| Wayfind | ~/repos/meridian | Building v1.1 | Ship simulation harness |

## Memory Files (load on demand)

| File | When to load | Summary |
|------|-------------|---------|
| `wayfind-arch.md` | wayfind, architecture | Architecture decisions for Wayfind |

## State Files (per-repo)

| Location | Covers |
|----------|--------|
| `~/.claude/state.md` | Admin work, non-repo tasks |
| `~/repos/meridian/.claude/state.md` | Wayfind dev state |
EOF

# Verify personalized content
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "2026-02-28" "profile has real date"
assert_file_not_contains "$MOCK_HOME/.claude/global-state.md" "YYYY-MM-DD" "placeholder date replaced"
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "Direct and concise" "working style filled in"
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "TypeScript strict" "technical preferences filled in"
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "Sarah" "team context filled in"
assert_file_contains "$MOCK_HOME/.claude/global-state.md" "Wayfind" "active projects filled in"

# Verify doctor still passes with personalized profile
DOCTOR_EXIT=0
bash "$KIT_DIR/doctor.sh" >/dev/null 2>&1 || DOCTOR_EXIT=$?
if [ "$DOCTOR_EXIT" -eq 0 ]; then
    _pass "doctor.sh passes with personalized profile"
else
    _fail "doctor.sh passes with personalized profile" "exited $DOCTOR_EXIT"
fi

print_results
[ "$FAIL" -eq 0 ]
