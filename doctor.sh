#!/usr/bin/env bash
# Wayfind — Doctor
# Validates that the memory system is correctly installed and functioning.
# Usage: bash doctor.sh [--verbose]

set -euo pipefail

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $1"; }
err()  { echo -e "${RED}✗${RESET} $1"; }
info() { echo "  $1"; }

ISSUES=0

is_plugin_installed() {
    # Check if wayfind is installed as a Claude Code plugin
    # Method 1: Check enabledPlugins in settings.json (authoritative — what Claude Code reads)
    local SETTINGS="$HOME/.claude/settings.json"
    if [ -f "$SETTINGS" ] && grep -q '"wayfind@' "$SETTINGS" 2>/dev/null; then
        return 0
    fi

    # Method 2: Check plugin files on disk
    local PLUGINS_DIR="$HOME/.claude/plugins"
    if [ -d "$PLUGINS_DIR" ]; then
        if find "$PLUGINS_DIR" -path '*/wayfind/plugin/.claude-plugin/plugin.json' -print -quit 2>/dev/null | grep -q .; then
            return 0
        fi
        if find "$PLUGINS_DIR" -name 'plugin.json' -exec grep -l '"name": "wayfind"' {} + 2>/dev/null | grep -q .; then
            return 0
        fi
    fi
    return 1
}

check_hook_registered() {
    echo ""
    echo "Hook registration"

    # If installed as a plugin, hooks are provided by the plugin — skip legacy checks
    if is_plugin_installed; then
        ok "Installed as Claude Code plugin (hooks provided by plugin)"
        # Warn if old specialization hook files are still present — they cause duplicate execution
        for old_hook in check-global-state.sh session-end.sh; do
            if [ -f "$HOME/.claude/hooks/$old_hook" ]; then
                warn "Orphaned legacy hook: ~/.claude/hooks/$old_hook"
                info "Plugin now handles hooks. Remove with: rm ~/.claude/hooks/$old_hook"
                ISSUES=$((ISSUES + 1))
            fi
        done
        return
    fi

    local SETTINGS="$HOME/.claude/settings.json"
    if [ ! -f "$SETTINGS" ]; then
        err "settings.json not found — hook is not registered"
        info "Run: bash setup.sh --tool claude-code"
        ISSUES=$((ISSUES + 1))
        return
    fi
    if grep -q "check-global-state" "$SETTINGS" 2>/dev/null; then
        ok "SessionStart hook registered in settings.json"
    else
        err "Hook not registered in settings.json"
        info "Re-run setup.sh to merge the hook"
        ISSUES=$((ISSUES + 1))
    fi

    if [ -f "$HOME/.claude/hooks/check-global-state.sh" ]; then
        ok "check-global-state.sh exists"
    else
        err "check-global-state.sh not found at ~/.claude/hooks/"
        ISSUES=$((ISSUES + 1))
    fi

    # Check if installed hooks are stale vs package source
    local SCRIPT_DIR
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local SOURCE_HOOKS_DIR="$SCRIPT_DIR/specializations/claude-code/hooks"
    local INSTALLED_HOOKS_DIR="$HOME/.claude/hooks"
    for hook_file in check-global-state.sh session-end.sh; do
        local src="$SOURCE_HOOKS_DIR/$hook_file"
        local dest="$INSTALLED_HOOKS_DIR/$hook_file"
        if [ -f "$src" ] && [ -f "$dest" ]; then
            if ! diff -q "$src" "$dest" >/dev/null 2>&1; then
                warn "$hook_file is out of date — run 'wayfind update' to sync"
                ISSUES=$((ISSUES + 1))
            else
                [ "$VERBOSE" = true ] && ok "$hook_file is current"
            fi
        fi
    done

    # Validate hook structure — correct format: {matcher: str, hooks: [{type, command}]}
    if command -v python3 &>/dev/null; then
        local STRUCT_RESULT
        STRUCT_RESULT=$(python3 - "$SETTINGS" 2>/dev/null <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        settings = json.load(f)
except:
    print("PARSE_ERROR"); sys.exit(0)
hooks = settings.get("hooks", {})
if not isinstance(hooks, dict):
    print("BAD_HOOKS_TYPE"); sys.exit(0)
issues = []
for event in ("SessionStart", "Stop"):
    arr = hooks.get(event)
    if arr is None:
        continue
    if not isinstance(arr, list):
        issues.append(f"{event}: expected array, got {type(arr).__name__}")
        continue
    for i, group in enumerate(arr):
        if not isinstance(group, dict):
            issues.append(f"{event}[{i}]: expected object, got {type(group).__name__}")
            continue
        # Must have "hooks" array (the inner array of commands)
        if "hooks" not in group:
            if "type" in group:
                issues.append(f"{event}[{i}]: flat hook object — needs {{matcher, hooks}} wrapper")
            else:
                issues.append(f"{event}[{i}]: missing hooks array")
            continue
        if not isinstance(group["hooks"], list):
            issues.append(f"{event}[{i}].hooks: expected array, got {type(group['hooks']).__name__}")
            continue
        # Validate each hook command in the group
        for j, h in enumerate(group["hooks"]):
            if not isinstance(h, dict) or "type" not in h:
                issues.append(f"{event}[{i}].hooks[{j}]: missing type field")
if issues:
    print("MALFORMED:" + "|".join(issues))
else:
    print("OK")
PYEOF
) || STRUCT_RESULT="PARSE_ERROR"
        if [[ "$STRUCT_RESULT" == "OK" ]]; then
            ok "Hook structure valid"
        elif [[ "$STRUCT_RESULT" == MALFORMED:* ]]; then
            err "Malformed hook structure in settings.json"
            IFS='|' read -ra MSGS <<< "${STRUCT_RESULT#MALFORMED:}"
            for msg in "${MSGS[@]}"; do
                info "  $msg"
            done
            info "Fix: run 'wayfind update' to normalize hook structure"
            ISSUES=$((ISSUES + 1))
        elif [[ "$STRUCT_RESULT" == "BAD_HOOKS_TYPE" ]]; then
            err "\"hooks\" in settings.json is not an object"
            ISSUES=$((ISSUES + 1))
        elif [[ "$STRUCT_RESULT" == "PARSE_ERROR" ]]; then
            warn "Could not parse settings.json for structure validation"
        fi
    fi
}

check_global_state() {
    echo ""
    echo "Global state file"
    local GLOBAL="$HOME/.claude/global-state.md"
    if [ ! -f "$GLOBAL" ]; then
        err "global-state.md not found at $GLOBAL"
        info "Run: bash setup.sh --tool claude-code"
        ISSUES=$((ISSUES + 1))
        return
    fi
    ok "global-state.md exists"

    # Check if it was updated recently
    local LAST_UPDATED
    LAST_UPDATED=$(grep -m1 '^Last updated:' "$GLOBAL" 2>/dev/null | sed 's/^Last updated: *//' || echo "")
    if [ -n "$LAST_UPDATED" ]; then
        if [[ "$LAST_UPDATED" < "$(date -d '7 days ago' +%Y-%m-%d 2>/dev/null || date -v-7d +%Y-%m-%d 2>/dev/null || echo '0000-00-00')" ]]; then
            warn "global-state.md last updated $LAST_UPDATED (>7 days ago)"
        else
            ok "global-state.md updated $LAST_UPDATED"
        fi
    else
        warn "global-state.md has no 'Last updated:' line"
    fi
}

check_backup() {
    echo ""
    echo "Backup status"
    local LAST_PUSH="$HOME/.claude/.backup-last-push"
    local LAST_ERROR="$HOME/.claude/.backup-last-error"

    if [ ! -f "$HOME/.claude-backup/.git/config" ] 2>/dev/null && [ ! -f "$LAST_PUSH" ]; then
        info "Backup not configured (optional — run backup/setup.sh <repo-url> to enable)"
        return
    fi

    if [ -f "$LAST_ERROR" ]; then
        warn "Backup: last push FAILED"
        info "$(cat "$LAST_ERROR")"
        ISSUES=$((ISSUES + 1))
    elif [ -f "$LAST_PUSH" ]; then
        local PUSH_TIME
        PUSH_TIME=$(cat "$LAST_PUSH")
        ok "Backup: last push $PUSH_TIME"
    else
        warn "Backup configured but no push record found"
    fi
}

scan_repos() {
    echo ""
    echo "Repo state files"
    local SCAN_ROOTS="${AI_MEMORY_SCAN_ROOTS:-$HOME/repos $HOME/code $HOME/dev $HOME/projects}"
    local FOUND=0

    for root in $SCAN_ROOTS; do
        [ -d "$root" ] || continue
        while IFS= read -r state_file; do
            FOUND=$((FOUND + 1))
            local rel="${state_file#$HOME/}"
            local repo_name="${rel%/.claude/team-state.md}"
            repo_name="${repo_name%/.claude/state.md}"
            local LAST_UPDATED
            LAST_UPDATED=$(grep -m1 '^Last updated:' "$state_file" 2>/dev/null | sed 's/^Last updated: *//' || echo "unknown")
            ok "$repo_name (updated $LAST_UPDATED)"
        done < <(find "$root" \( -path '*/.claude/state.md' -o -path '*/.claude/team-state.md' \) 2>/dev/null | sort)
    done

    if [ "$FOUND" -eq 0 ]; then
        info "No repos with state.md found in: $SCAN_ROOTS"
        info "Run /init-memory in a repo to initialize it"
    fi
}

check_memory_files() {
    echo ""
    echo "Memory files"
    local MEMORY_DIR="$HOME/.claude/memory"
    if [ ! -d "$MEMORY_DIR" ]; then
        warn "Memory directory not found: $MEMORY_DIR"
        return
    fi

    local COUNT=0
    while IFS= read -r f; do
        COUNT=$((COUNT + 1))
        local SIZE
        SIZE=$(wc -c < "$f" 2>/dev/null || echo 0)
        local SIZE_KB=$((SIZE / 1024))
        local FNAME
        FNAME=$(basename "$f")
        if [ "$SIZE" -gt 8192 ]; then
            warn "$FNAME (${SIZE_KB}KB) — exceeds recommended 8KB; consider summarizing"
        else
            [ "$VERBOSE" = true ] && ok "$FNAME (${SIZE_KB}KB)"
        fi
    done < <(find "$MEMORY_DIR" -name '*.md' -not -path '*/journal/*' 2>/dev/null | sort)

    local JOURNAL_DIR="$MEMORY_DIR/journal"
    if [ -d "$JOURNAL_DIR" ]; then
        local JOURNAL_COUNT
        JOURNAL_COUNT=$(find "$JOURNAL_DIR" -name '*.md' 2>/dev/null | wc -l)
        ok "Journal: $JOURNAL_COUNT entries"
    fi

    [ "$COUNT" -gt 0 ] && ok "$COUNT memory file(s) found" || info "No memory files yet"
}

check_team_versions() {
    echo ""
    echo "Team version compliance"

    # Get installed version from .wayfind-version file (written by setup.sh)
    local VERSION_FILE="$HOME/.claude/team-context/.wayfind-version"
    local INSTALLED="unknown"
    if [ -f "$VERSION_FILE" ]; then
        INSTALLED=$(cat "$VERSION_FILE")
    fi

    if [ "$INSTALLED" = "unknown" ]; then
        info "Version not recorded yet (run wayfind update to set)"
        return
    fi

    ok "Installed version: v$INSTALLED"

    # Check min_version from check-version command output
    local CHECK_OUTPUT=""
    if [ -f "$HOME/repos/greg/wayfind/bin/team-context.js" ]; then
        CHECK_OUTPUT=$(node "$HOME/repos/greg/wayfind/bin/team-context.js" check-version 2>&1 || true)
    elif command -v wayfind >/dev/null 2>&1; then
        CHECK_OUTPUT=$(wayfind check-version 2>&1 || true)
    fi

    if echo "$CHECK_OUTPUT" | grep -q "below team minimum"; then
        local MIN_VER
        MIN_VER=$(echo "$CHECK_OUTPUT" | grep -o 'minimum v[0-9.]*' | head -1 | sed 's/minimum v//')
        warn "Below team minimum v$MIN_VER — run: npm update -g wayfind"
        ISSUES=$((ISSUES + 1))
    else
        ok "Version meets team requirements"
    fi
}

check_storage_backend() {
    echo ""
    echo "Storage backend"

    # Check for env var override
    if [ -n "${TEAM_CONTEXT_STORAGE_BACKEND:-}" ]; then
        info "TEAM_CONTEXT_STORAGE_BACKEND=$TEAM_CONTEXT_STORAGE_BACKEND (env override)"
    fi

    # Check if better-sqlite3 is available
    if node -e "require('better-sqlite3')" 2>/dev/null; then
        ok "Storage backend: sqlite (better-sqlite3 available)"
    else
        ok "Storage backend: json (better-sqlite3 not installed — using JSON fallback)"
    fi
}

# Run checks
echo ""
echo "Wayfind — Doctor"
echo "══════════════════════"

check_hook_registered
check_global_state
check_backup
check_team_versions
check_storage_backend
check_memory_files
scan_repos

echo ""
echo "══════════════════════"
if [ "$ISSUES" -eq 0 ]; then
    echo -e "${GREEN}All checks passed${RESET}"
else
    echo -e "${YELLOW}$ISSUES issue(s) found${RESET}"
    exit 1
fi
