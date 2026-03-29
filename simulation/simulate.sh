#!/usr/bin/env bash
# Wayfind — End-to-end simulation harness
# Runs all scenarios in isolation to verify the install -> onboarding -> signal flow.
#
# Usage:
#   ./simulate.sh                            # Run all scenarios
#   ./simulate.sh --scenario fresh-install   # Run one scenario
#   ./simulate.sh --list                     # List available scenarios
#   ./simulate.sh --help                     # Show help
#
# Works both inside Docker and on a local machine.

set -euo pipefail

SIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIOS_DIR="$SIM_DIR/scenarios"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Available scenarios (order matters for readability) ──────────────────────

SCENARIO_ORDER=(
    clean-machine-onboard
    fresh-install
    reinstall-preserve-state
    upgrade-version
    new-team-bootstrap
    join-existing-team
    custom-personas
    signal-fixtures-valid
    github-pull-simulate
    whoami-setup
    digest-generate-simulate
    multi-team-routing
    store-scope-indexing
    store-scope-trim
    store-scope-isolation
)

# ── Argument parsing ─────────────────────────────────────────────────────────

TARGET=""
ACTION="run-all"

usage() {
    cat <<USAGE
Wayfind — Simulation Harness

Usage:
  bash simulate.sh                            Run all scenarios
  bash simulate.sh --scenario <name>          Run one scenario
  bash simulate.sh --list                     List available scenarios
  bash simulate.sh --help                     Show this help

Scenarios:
USAGE
    for s in "${SCENARIO_ORDER[@]}"; do
        echo "  $s"
    done
    echo ""
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --scenario=*) TARGET="${1#--scenario=}"; ACTION="run-one"; shift ;;
        --scenario)
            if [ -z "${2:-}" ]; then echo "Error: --scenario requires a name"; exit 1; fi
            TARGET="$2"; ACTION="run-one"; shift 2 ;;
        --list) ACTION="list"; shift ;;
        --help) usage; exit 0 ;;
        *) echo "Unknown option: $1"; usage; exit 1 ;;
    esac
done

# ── List mode ────────────────────────────────────────────────────────────────

if [ "$ACTION" = "list" ]; then
    echo "Available scenarios:"
    for s in "${SCENARIO_ORDER[@]}"; do
        echo "  $s"
    done
    exit 0
fi

# ── Preflight checks ────────────────────────────────────────────────────────

check_dependency() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo -e "${RED}Error:${RESET} '$1' is required but not found."
        exit 1
    fi
}

check_dependency bash
check_dependency python3
check_dependency git
check_dependency node

# ── Run a single scenario ────────────────────────────────────────────────────

run_scenario() {
    local name="$1"
    local script="$SCENARIOS_DIR/${name}.sh"

    if [ ! -f "$script" ]; then
        echo -e "${RED}Error:${RESET} scenario '$name' not found at $script"
        return 1
    fi

    # Each scenario runs in a subshell (bash "$script"), so HOME changes
    # inside a scenario don't leak to the parent. No save/restore needed.
    local exit_code=0
    bash "$script" || exit_code=$?
    return "$exit_code"
}

# ── Single scenario mode ────────────────────────────────────────────────────

if [ "$ACTION" = "run-one" ]; then
    echo ""
    echo -e "${BOLD}Wayfind Simulation — Single Scenario${RESET}"
    echo "======================================"
    run_scenario "$TARGET"
    exit $?
fi

# ── Full suite mode ──────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Wayfind Simulation — Full Suite${RESET}"
echo "================================="
echo "Running ${#SCENARIO_ORDER[@]} scenarios..."

TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_SCENARIOS=()
START_TIME=$(date +%s)

for scenario in "${SCENARIO_ORDER[@]}"; do
    SCENARIO_EXIT=0
    run_scenario "$scenario" || SCENARIO_EXIT=$?

    if [ "$SCENARIO_EXIT" -eq 0 ]; then
        TOTAL_PASS=$((TOTAL_PASS + 1))
    else
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        FAILED_SCENARIOS+=("$scenario")
    fi
done

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "================================================================"
echo -e "${BOLD}Simulation Summary${RESET}"
echo "================================================================"
echo "  Scenarios: $((TOTAL_PASS + TOTAL_FAIL)) total, $TOTAL_PASS passed, $TOTAL_FAIL failed"
echo "  Duration:  ${ELAPSED}s"

if [ "${#FAILED_SCENARIOS[@]}" -gt 0 ]; then
    echo ""
    echo -e "  ${RED}Failed scenarios:${RESET}"
    for s in "${FAILED_SCENARIOS[@]}"; do
        echo -e "    ${RED}- $s${RESET}"
    done
fi

echo "================================================================"

if [ "$TOTAL_FAIL" -eq 0 ]; then
    echo -e "${GREEN}All scenarios passed.${RESET}"
    exit 0
else
    echo -e "${RED}$TOTAL_FAIL scenario(s) failed.${RESET}"
    exit 1
fi
