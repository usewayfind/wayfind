#!/usr/bin/env bash
# Wayfind — Setup Script
# Installs the memory system for your AI coding assistant.
# Safe to re-run (idempotent). Backs up existing files before modifying.
#
# Usage:
#   bash setup.sh                    # Interactive — prompts for tool choice
#   bash setup.sh --tool claude-code # Non-interactive
#   bash setup.sh --tool cursor
#   bash setup.sh --tool generic
#   bash setup.sh --dry-run          # Preview changes without modifying files
#   bash setup.sh --version          # Print installed version and exit
#   bash setup.sh --help             # Show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL=""
DRY_RUN=false
REPO_DIR=""
UPDATE=false

# ── Argument parsing ──────────────────────────────────────────────────────────

usage() {
    cat <<USAGE
Usage: bash setup.sh [OPTIONS]

Options:
  --tool=TOOL     Specify tool without prompt (claude-code, cursor, generic)
  --tool TOOL     Same as above (space-separated form)
  --repo=PATH     Install per-repo rule into PATH (Cursor only)
  --repo PATH     Same as above (space-separated form)
  --update        Update mode: overwrite hook scripts and commands (memory files untouched)
  --dry-run       Preview what would be installed without modifying files
  --version       Print installed version and exit
  --help          Show this help message

Examples:
  bash setup.sh
  bash setup.sh --tool claude-code
  bash setup.sh --tool=cursor --repo .
  bash setup.sh --tool claude-code --update --dry-run
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tool=*) TOOL="${1#--tool=}"; shift ;;
        --tool)
            if [ -z "${2:-}" ]; then
                echo "Error: --tool requires a value (claude-code, cursor, or generic)"
                exit 1
            fi
            TOOL="$2"; shift 2 ;;
        --repo=*) REPO_DIR="$(cd "${1#--repo=}" 2>/dev/null && pwd || echo "")"; shift ;;
        --repo)
            if [ -z "${2:-}" ]; then
                echo "Error: --repo requires a path"
                exit 1
            fi
            REPO_DIR="$(cd "$2" 2>/dev/null && pwd || echo "")"; shift 2 ;;
        --update) UPDATE=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --version)
            VERSION_FILE="$HOME/.claude/team-context/.wayfind-version"
            if [ -f "$VERSION_FILE" ]; then
                echo "Wayfind v$(cat "$VERSION_FILE")"
            else
                echo "Wayfind version unknown (no .wayfind-version file found)"
            fi
            exit 0
            ;;
        --help) usage; exit 0 ;;
        *) shift ;;
    esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

log()    { echo -e "${GREEN}✓${RESET} $1"; }
warn()   { echo -e "${YELLOW}⚠${RESET}  $1"; }
info()   { echo "  $1"; }
header() { echo ""; echo -e "${GREEN}── $1 ──${RESET}"; }

backup_if_exists() {
    local file="$1"
    if [ -f "$file" ]; then
        local backup="${file}.bak.$(date +%Y%m%d%H%M%S)"
        cp "$file" "$backup"
        warn "Backed up existing $file → $backup"
    fi
}

run() {
    if [ "$DRY_RUN" = true ]; then
        info "[dry-run] $*"
    else
        "$@"
    fi
}

append_if_missing() {
    local needle="$1"
    local content="$2"
    local file="$3"
    if ! grep -qF "$needle" "$file" 2>/dev/null; then
        echo "$content" >> "$file"
        log "Appended to $file"
    else
        info "Already present in $file — skipped"
    fi
}

# ── Tool selection ─────────────────────────────────────────────────────────────

if [ -z "$TOOL" ]; then
    echo ""
    echo "Wayfind — Setup"
    echo "─────────────────────"
    echo "Which AI tool are you setting up for?"
    echo "  1) Claude Code"
    echo "  2) Cursor"
    echo "  3) Generic (system prompt / manual)"
    echo ""
    read -rp "Enter choice [1-3]: " choice
    case "$choice" in
        1) TOOL="claude-code" ;;
        2) TOOL="cursor" ;;
        3) TOOL="generic" ;;
        *) echo "Invalid choice. Exiting."; exit 1 ;;
    esac
fi

SPEC_DIR="$SCRIPT_DIR/specializations/$TOOL"
if [ ! -d "$SPEC_DIR" ]; then
    echo -e "${RED}Error:${RESET} No specialization found for '$TOOL' at $SPEC_DIR"
    echo "Available: $(ls "$SCRIPT_DIR/specializations/")"
    exit 1
fi

echo ""
[ "$DRY_RUN" = true ] && warn "Dry-run mode — no files will be modified"
[ "$UPDATE" = true ] && warn "Update mode: overwriting hook scripts and commands (memory files untouched)"

# Show upgrade messaging if version info is available (passed from install.sh)
WAYFIND_OLD_VERSION="${WAYFIND_OLD_VERSION:-}"
WAYFIND_NEW_VERSION="${WAYFIND_NEW_VERSION:-}"
if [ "$UPDATE" = true ] && [ -n "$WAYFIND_OLD_VERSION" ] && [ -n "$WAYFIND_NEW_VERSION" ]; then
    if [ "$WAYFIND_OLD_VERSION" != "$WAYFIND_NEW_VERSION" ]; then
        info "Upgrading from v${WAYFIND_OLD_VERSION} to v${WAYFIND_NEW_VERSION}"
    fi
fi

# ── Tool-specific config ───────────────────────────────────────────────────────

case "$TOOL" in
    claude-code)
        MEMORY_DIR="$HOME/.claude"
        MEMORY_SUBDIR="$HOME/.claude/memory"
        GLOBAL_STATE="$HOME/.claude/global-state.md"
        ADMIN_STATE="$HOME/.claude/state.md"
        GLOBAL_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
        ;;
    cursor)
        MEMORY_DIR="$HOME/.ai-memory"
        MEMORY_SUBDIR="$HOME/.ai-memory/memory"
        GLOBAL_STATE="$HOME/.ai-memory/global.md"
        ADMIN_STATE="$HOME/.ai-memory/state.md"
        GLOBAL_CLAUDE_MD=""  # No global instructions file for Cursor
        ;;
    generic)
        MEMORY_DIR="$HOME/.ai-memory"
        MEMORY_SUBDIR="$HOME/.ai-memory/memory"
        GLOBAL_STATE="$HOME/.ai-memory/global.md"
        ADMIN_STATE="$HOME/.ai-memory/state.md"
        GLOBAL_CLAUDE_MD=""
        ;;
esac

# ── Counters for aggregate output ─────────────────────────────────────────────

CONFIG_FILES=0
HOOKS_INSTALLED=0
COMMANDS_INSTALLED=0
MCP_OK=false

# ── Step 1: Directories ────────────────────────────────────────────────────────

run mkdir -p "$MEMORY_SUBDIR/journal"

if [ "$TOOL" = "claude-code" ]; then
    run mkdir -p "$HOME/.claude/hooks"
    run mkdir -p "$HOME/.claude/commands"
fi

# ── Step 2: Global state file ─────────────────────────────────────────────────

if [ ! -f "$GLOBAL_STATE" ]; then
    if [ "$TOOL" = "claude-code" ]; then
        if [ "$DRY_RUN" = false ]; then
            sed \
                -e 's|~/.ai-memory/|~/.claude/|g' \
                -e 's|\.ai-memory/state\.md|.claude/state.md|g' \
                "$SCRIPT_DIR/templates/global.md" > "$GLOBAL_STATE"
        else
            info "[dry-run] Would sed (path substitution) templates/global.md > $GLOBAL_STATE"
        fi
    else
        run cp "$SCRIPT_DIR/templates/global.md" "$GLOBAL_STATE"
    fi
    CONFIG_FILES=$((CONFIG_FILES + 1))
fi

# ── Step 3: Admin state file (team/personal split) ───────────────────────────

if [ ! -f "$ADMIN_STATE" ]; then
    run cp "$SCRIPT_DIR/templates/repo-state.md" "$ADMIN_STATE"
    CONFIG_FILES=$((CONFIG_FILES + 1))
fi

# ── Step 3b: Persona configuration ────────────────────────────────────────────

case "$TOOL" in
    claude-code) PERSONAS_DIR="$HOME/.claude/team-context" ;;
    *)           PERSONAS_DIR="$HOME/.ai-memory/team-context" ;;
esac

PERSONAS_DEST="$PERSONAS_DIR/personas.json"
if [ ! -f "$PERSONAS_DEST" ]; then
    run mkdir -p "$PERSONAS_DIR"
    run cp "$SCRIPT_DIR/templates/personas.json" "$PERSONAS_DEST"
    CONFIG_FILES=$((CONFIG_FILES + 1))
fi

# ── Step 4: Tool-specific files ───────────────────────────────────────────────

case "$TOOL" in
    claude-code)
        # Global CLAUDE.md fragment
        if [ -n "$GLOBAL_CLAUDE_MD" ]; then
            if [ "$DRY_RUN" = true ]; then
                info "[dry-run] Would append Session State Protocol to $GLOBAL_CLAUDE_MD"
            else
                touch "$GLOBAL_CLAUDE_MD"
                if ! grep -qF "Session State Protocol" "$GLOBAL_CLAUDE_MD" 2>/dev/null; then
                    cat "$SPEC_DIR/CLAUDE.md-global-fragment.md" >> "$GLOBAL_CLAUDE_MD"
                    CONFIG_FILES=$((CONFIG_FILES + 1))
                fi
            fi
        fi

        # Hook scripts
        HOOK_DEST="$HOME/.claude/hooks/check-global-state.sh"
        if [ ! -f "$HOOK_DEST" ] || [ "$UPDATE" = true ]; then
            run cp "$SPEC_DIR/hooks/check-global-state.sh" "$HOOK_DEST"
            run chmod +x "$HOOK_DEST"
            HOOKS_INSTALLED=$((HOOKS_INSTALLED + 1))
        fi

        SESSION_END_DEST="$HOME/.claude/hooks/session-end.sh"
        if [ ! -f "$SESSION_END_DEST" ] || [ "$UPDATE" = true ]; then
            run cp "$SPEC_DIR/hooks/session-end.sh" "$SESSION_END_DEST"
            run chmod +x "$SESSION_END_DEST"
            HOOKS_INSTALLED=$((HOOKS_INSTALLED + 1))
        fi

        # Commands
        CMD_DEST="$HOME/.claude/commands/init-memory.md"
        if [ ! -f "$CMD_DEST" ] || [ "$UPDATE" = true ]; then
            run cp "$SPEC_DIR/commands/init-memory.md" "$CMD_DEST"
            COMMANDS_INSTALLED=$((COMMANDS_INSTALLED + 1))
        fi

        DOCTOR_CMD_DEST="$HOME/.claude/commands/doctor.md"
        if [ ! -f "$DOCTOR_CMD_DEST" ] || [ "$UPDATE" = true ]; then
            run cp "$SPEC_DIR/commands/doctor.md" "$DOCTOR_CMD_DEST"
            COMMANDS_INSTALLED=$((COMMANDS_INSTALLED + 1))
        fi

        # Support scripts
        run mkdir -p "$HOME/.claude/team-context"
        DOCTOR_DEST="$HOME/.claude/team-context/doctor.sh"
        if [ ! -f "$DOCTOR_DEST" ] || [ "$UPDATE" = true ]; then
            run cp "$SCRIPT_DIR/doctor.sh" "$DOCTOR_DEST"
            run chmod +x "$DOCTOR_DEST"
        fi

        JOURNAL_DEST="$HOME/.claude/team-context/journal-summary.sh"
        if [ ! -f "$JOURNAL_DEST" ] || [ "$UPDATE" = true ]; then
            run cp "$SCRIPT_DIR/journal-summary.sh" "$JOURNAL_DEST"
            run chmod +x "$JOURNAL_DEST"
        fi

        JOURNAL_CMD_DEST="$HOME/.claude/commands/journal.md"
        if [ ! -f "$JOURNAL_CMD_DEST" ] || [ "$UPDATE" = true ]; then
            run cp "$SPEC_DIR/commands/journal.md" "$JOURNAL_CMD_DEST"
            COMMANDS_INSTALLED=$((COMMANDS_INSTALLED + 1))
        fi

        TEAM_CMD_DEST="$HOME/.claude/commands/init-team.md"
        if [ ! -f "$TEAM_CMD_DEST" ] || [ "$UPDATE" = true ]; then
            if [ -f "$SPEC_DIR/commands/init-team.md" ]; then
                run cp "$SPEC_DIR/commands/init-team.md" "$TEAM_CMD_DEST"
                COMMANDS_INSTALLED=$((COMMANDS_INSTALLED + 1))
            fi
        fi

        REVIEW_CMD_DEST="$HOME/.claude/commands/review-prs.md"
        if [ ! -f "$REVIEW_CMD_DEST" ] || [ "$UPDATE" = true ]; then
            if [ -f "$SPEC_DIR/commands/review-prs.md" ]; then
                run cp "$SPEC_DIR/commands/review-prs.md" "$REVIEW_CMD_DEST"
                COMMANDS_INSTALLED=$((COMMANDS_INSTALLED + 1))
            fi
        fi

        # settings.json — merge hooks, don't overwrite
        SETTINGS="$HOME/.claude/settings.json"
        START_HOOK_CMD="bash ~/.claude/hooks/check-global-state.sh"
        STOP_HOOK_CMD="bash ~/.claude/hooks/session-end.sh"

        if [ ! -f "$SETTINGS" ]; then
            run cp "$SPEC_DIR/settings.json" "$SETTINGS"
            CONFIG_FILES=$((CONFIG_FILES + 1))
        else
            # Merge both hooks into existing settings.json using Python
            NEEDS_MERGE=false
            grep -q "check-global-state" "$SETTINGS" 2>/dev/null || NEEDS_MERGE=true
            grep -q "session-end" "$SETTINGS" 2>/dev/null || NEEDS_MERGE=true
            if [ "$NEEDS_MERGE" = true ]; then
                if [ "$DRY_RUN" = false ]; then
                    TMP_SETTINGS="$(mktemp)"
                    if python3 - "$SETTINGS" "$START_HOOK_CMD" "$STOP_HOOK_CMD" "$TMP_SETTINGS" <<'PYEOF' 2>/dev/null; then
import json, sys
settings_path, start_cmd, stop_cmd, out_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    with open(settings_path) as f:
        settings = json.load(f)
except (json.JSONDecodeError, IOError):
    sys.exit(1)
hooks = settings.setdefault("hooks", {})

# Claude Code hook format: each event is an array of {matcher, hooks} groups.
# Each group has a "matcher" (string, "" = match all) and "hooks" (array of
# {type, command} objects).

def collect_hook_commands(event_arr):
    """Extract all {type, command, ...} objects from any format variant."""
    cmds = []
    if not isinstance(event_arr, list):
        event_arr = [event_arr] if isinstance(event_arr, dict) else []
    for item in event_arr:
        if not isinstance(item, dict):
            continue
        # Correct format: {matcher, hooks: [{type, command}]}
        if "hooks" in item and isinstance(item["hooks"], list):
            for h in item["hooks"]:
                if isinstance(h, dict) and "type" in h:
                    cmds.append(h)
        # Legacy flat format: {type, command} directly in array
        elif "type" in item:
            cmds.append(item)
    return cmds

def ensure_hook_cmd(event_name, cmd, extra_fields=None):
    """Add a hook command to an event, normalizing to correct format."""
    existing = collect_hook_commands(hooks.get(event_name, []))
    if any(h.get("command") == cmd for h in existing):
        return  # already present
    entry = {"type": "command", "command": cmd}
    if extra_fields:
        entry.update(extra_fields)
    existing.append(entry)
    # Write back in correct {matcher, hooks} format
    hooks[event_name] = [{"matcher": "", "hooks": existing}]

ensure_hook_cmd("SessionStart", start_cmd)
ensure_hook_cmd("Stop", stop_cmd, {"timeout": 30000})

with open(out_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PYEOF
                        mv "$TMP_SETTINGS" "$SETTINGS"
                    else
                        rm -f "$TMP_SETTINGS"
                        warn "Could not auto-merge hooks into $SETTINGS (malformed JSON or python3 unavailable)."
                        warn "Manually add hooks from: $SPEC_DIR/settings.json"
                    fi
                else
                    info "[dry-run] Would merge hooks into $SETTINGS"
                fi
            fi
        fi

        # MCP server — register wayfind-mcp in settings.json using absolute path
        # (Claude Code spawns MCP servers with a minimal env; bare command may not resolve)
        MCP_BIN="$(command -v wayfind-mcp 2>/dev/null || true)"
        if [ -z "$MCP_BIN" ]; then
            NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
            [ -n "$NPM_PREFIX" ] && MCP_BIN="$NPM_PREFIX/bin/wayfind-mcp"
        fi
        MCP_REGISTERED=false
        grep -q '"wayfind"' "$SETTINGS" 2>/dev/null && MCP_REGISTERED=true
        if [ -n "$MCP_BIN" ] && [ -f "$MCP_BIN" ]; then
            if [ "$MCP_REGISTERED" = false ]; then
                if [ "$DRY_RUN" = false ]; then
                    TMP_SETTINGS="$(mktemp)"
                    if python3 - "$SETTINGS" "$MCP_BIN" "$TMP_SETTINGS" <<'PYEOF' 2>/dev/null; then
import json, sys
settings_path, mcp_bin, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(settings_path) as f:
        settings = json.load(f)
except (json.JSONDecodeError, IOError):
    sys.exit(1)
mcp = settings.setdefault("mcpServers", {})
if "wayfind" not in mcp:
    mcp["wayfind"] = {"command": mcp_bin}
with open(out_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PYEOF
                        mv "$TMP_SETTINGS" "$SETTINGS"
                        MCP_OK=true
                    else
                        rm -f "$TMP_SETTINGS"
                        warn "Could not register MCP server — add manually to ~/.claude/settings.json"
                    fi
                else
                    info "[dry-run] Would register wayfind MCP server ($MCP_BIN) in $SETTINGS"
                fi
            else
                MCP_OK=true
            fi
        else
            warn "wayfind-mcp not found — MCP registration skipped. Re-run setup after npm install."
        fi

        ;;

    cursor)
        # Global rules
        run mkdir -p "$HOME/.cursor/rules"
        GLOBAL_RULE="$HOME/.cursor/rules/ai-memory.mdc"
        if [ ! -f "$GLOBAL_RULE" ] || [ "${UPDATE:-false}" = true ]; then
            run cp "$SPEC_DIR/global-rule.mdc" "$GLOBAL_RULE"
            CONFIG_FILES=$((CONFIG_FILES + 1))
        fi

        # Per-repo rule (if --repo was passed)
        if [ -n "${REPO_DIR:-}" ]; then
            if [ -d "$REPO_DIR" ]; then
                RULE_DIR="$REPO_DIR/.cursor/rules"
                run mkdir -p "$RULE_DIR"
                if [ ! -f "$RULE_DIR/memory.mdc" ] || [ "${UPDATE:-false}" = true ]; then
                    run cp "$SPEC_DIR/repo-rule.mdc" "$RULE_DIR/memory.mdc"
                    CONFIG_FILES=$((CONFIG_FILES + 1))
                else
                    info "Repo rule already exists — skipped"
                fi
            else
                warn "--repo path not found or not a directory: $REPO_DIR"
            fi
        fi

        # MCP server — register wayfind-mcp in ~/.cursor/mcp.json using absolute path
        CURSOR_MCP_BIN="$(command -v wayfind-mcp 2>/dev/null || true)"
        if [ -z "$CURSOR_MCP_BIN" ]; then
            NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
            [ -n "$NPM_PREFIX" ] && CURSOR_MCP_BIN="$NPM_PREFIX/bin/wayfind-mcp"
        fi
        CURSOR_MCP="$HOME/.cursor/mcp.json"
        run mkdir -p "$HOME/.cursor"
        CURSOR_MCP_REGISTERED=false
        grep -q '"wayfind"' "$CURSOR_MCP" 2>/dev/null && CURSOR_MCP_REGISTERED=true
        if [ -n "$CURSOR_MCP_BIN" ] && [ -f "$CURSOR_MCP_BIN" ]; then
            if [ "$CURSOR_MCP_REGISTERED" = false ]; then
                if [ "$DRY_RUN" = false ]; then
                    if [ ! -f "$CURSOR_MCP" ]; then
                        printf '{\n  "mcpServers": {\n    "wayfind": {\n      "command": "%s",\n      "args": []\n    }\n  }\n}\n' "$CURSOR_MCP_BIN" > "$CURSOR_MCP"
                        MCP_OK=true
                    else
                        TMP_MCP="$(mktemp)"
                        if python3 - "$CURSOR_MCP" "$CURSOR_MCP_BIN" "$TMP_MCP" <<'PYEOF' 2>/dev/null; then
import json, sys
mcp_path, mcp_bin, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(mcp_path) as f:
        config = json.load(f)
except (json.JSONDecodeError, IOError):
    config = {}
mcp = config.setdefault("mcpServers", {})
if "wayfind" not in mcp:
    mcp["wayfind"] = {"command": mcp_bin, "args": []}
with open(out_path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PYEOF
                            mv "$TMP_MCP" "$CURSOR_MCP"
                            MCP_OK=true
                        else
                            rm -f "$TMP_MCP"
                            warn "Could not register MCP server — add manually to ~/.cursor/mcp.json"
                        fi
                    fi
                else
                    info "[dry-run] Would register wayfind MCP server ($CURSOR_MCP_BIN) in ~/.cursor/mcp.json"
                fi
            else
                MCP_OK=true
            fi
        else
            warn "wayfind-mcp not found — MCP registration skipped. Re-run setup after npm install."
        fi
        ;;

    generic)
        info "Generic setup complete. See $SPEC_DIR/README.md for system prompt instructions."
        ;;
esac

# ── Step 5: Write version file ────────────────────────────────────────────────

# If we know the version (passed from install.sh or from package.json), write it
if [ -n "$WAYFIND_NEW_VERSION" ]; then
    INSTALL_VERSION="$WAYFIND_NEW_VERSION"
elif [ -f "$SCRIPT_DIR/package.json" ]; then
    INSTALL_VERSION="$(grep '"version"' "$SCRIPT_DIR/package.json" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
else
    INSTALL_VERSION=""
fi

if [ -n "$INSTALL_VERSION" ]; then
    KIT_DEST_DIR="$HOME/.claude/team-context"
    VERSION_DEST="$KIT_DEST_DIR/.wayfind-version"
    if [ "$DRY_RUN" = false ]; then
        mkdir -p "$KIT_DEST_DIR"
        TMP_VER="$(mktemp)"
        echo "$INSTALL_VERSION" > "$TMP_VER"
        mv "$TMP_VER" "$VERSION_DEST"
    else
        info "[dry-run] Would write v${INSTALL_VERSION} to $KIT_DEST_DIR/.wayfind-version"
    fi
fi

# ── Step 6: Inject elicitation prompts into existing team-state files ────────

if [ "$UPDATE" = true ] && [ "$TOOL" = "claude-code" ]; then
    header "Elicitation prompts"

    ELICITATION_MARKER="## Elicitation Prompts"
    ELICITATION_BLOCK="$ELICITATION_MARKER

<!-- These prompts guide the AI to capture richer context at decision moments.
     The AI should ask AT MOST ONE of these when a significant decision is stated
     without reasoning. Do not ask during routine implementation — only at moments
     where a choice was made between alternatives.

     The answers aren't for you (you already know) — they're for your teammates
     who will read the digest tomorrow. -->

When a technical or product decision is made without stated reasoning, ask one of:
- \"What alternatives did you consider?\"
- \"What constraint or requirement drove this choice?\"
- \"What would need to change for you to reverse this decision?\"
- \"Who else on the team does this affect, and how?\"
- \"What's the risk if this assumption is wrong?\"

Do not ask if the decision already includes reasoning, tradeoffs, or constraints.
Do not ask more than once per decision. Do not ask during routine implementation."

    # Scan repos for team-state.md files and inject if missing
    INJECT_COUNT=0
    for state_file in $(find "$HOME/repos" -path '*/.claude/team-state.md' 2>/dev/null); do
        if ! grep -qF "$ELICITATION_MARKER" "$state_file" 2>/dev/null; then
            if [ "$DRY_RUN" = false ]; then
                # Insert before "## Shared Gotchas" if it exists, otherwise append
                if grep -qF "## Shared Gotchas" "$state_file" 2>/dev/null; then
                    TMP_STATE="$(mktemp)"
                    awk -v block="$ELICITATION_BLOCK" '
                        /^## Shared Gotchas/ { print block; print ""; }
                        { print }
                    ' "$state_file" > "$TMP_STATE"
                    mv "$TMP_STATE" "$state_file"
                else
                    echo "" >> "$state_file"
                    echo "$ELICITATION_BLOCK" >> "$state_file"
                fi
                log "Injected elicitation prompts: $state_file"
                INJECT_COUNT=$((INJECT_COUNT + 1))
            else
                info "[dry-run] Would inject elicitation prompts into $state_file"
            fi
        else
            info "Already has elicitation: $(basename "$(dirname "$(dirname "$state_file")")")/$(basename "$(dirname "$state_file")")  — skipped"
        fi
    done

    if [ "$INJECT_COUNT" -eq 0 ] && [ "$DRY_RUN" = false ]; then
        info "No team-state.md files needed elicitation injection"
    fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""

# Aggregate summary of what was installed
SUMMARY_PARTS=""
[ "$CONFIG_FILES" -gt 0 ] && SUMMARY_PARTS="${SUMMARY_PARTS}${CONFIG_FILES} config files"
if [ "$HOOKS_INSTALLED" -gt 0 ]; then
    [ -n "$SUMMARY_PARTS" ] && SUMMARY_PARTS="${SUMMARY_PARTS}, "
    SUMMARY_PARTS="${SUMMARY_PARTS}${HOOKS_INSTALLED} hooks"
fi
if [ "$COMMANDS_INSTALLED" -gt 0 ]; then
    [ -n "$SUMMARY_PARTS" ] && SUMMARY_PARTS="${SUMMARY_PARTS}, "
    SUMMARY_PARTS="${SUMMARY_PARTS}${COMMANDS_INSTALLED} commands"
fi
if [ "$MCP_OK" = true ]; then
    [ -n "$SUMMARY_PARTS" ] && SUMMARY_PARTS="${SUMMARY_PARTS}, "
    SUMMARY_PARTS="${SUMMARY_PARTS}MCP server"
fi
if [ -n "$SUMMARY_PARTS" ]; then
    log "Created ${SUMMARY_PARTS}"
fi

echo -e "${GREEN}✓${RESET} Wayfind installed for ${TOOL}."
echo ""

if [ "$TOOL" = "claude-code" ]; then
    echo "  Next: open a repo and run /init-memory to set it up."
    echo "        Then start a Claude Code session — Wayfind captures context automatically."
elif [ "$TOOL" = "cursor" ]; then
    echo "  Next: open a repo and run: bash setup.sh --tool cursor --repo <path>"
    echo "        Then start a Cursor session — the global rule loads your state automatically."
else
    echo "  Next: add the session protocol to your tool's system prompt."
    echo "        See: specializations/generic/README.md"
fi

echo ""
echo "  Docs: https://github.com/usewayfind/wayfind"
echo ""
