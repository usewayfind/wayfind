#!/usr/bin/env bash
# Wayfind — Uninstaller
# Removes installed hooks, commands, and settings fragments.
# NEVER deletes your memory content (global-state.md, memory/ directory).
#
# Usage: bash uninstall.sh [--tool claude-code]

set -euo pipefail

TOOL="${1:-}"
[[ "${1:-}" == "--tool" ]] && TOOL="${2:-}"
[[ "${1:-}" == "--tool="* ]] && TOOL="${1#--tool=}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
log()  { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $1"; }
info() { echo "  $1"; }
err()  { echo -e "${RED}✗${RESET} $1"; exit 1; }

echo ""
echo "Wayfind — Uninstall"
echo ""
warn "This will remove hooks, commands, and settings fragments."
warn "Your memory files (global-state.md, memory/) will NOT be deleted."
echo ""
read -rp "Continue? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# Remove hook
HOOK="$HOME/.claude/hooks/check-global-state.sh"
if [ -f "$HOOK" ]; then
    rm "$HOOK"
    log "Removed $HOOK"
fi

# Remove commands
CMD="$HOME/.claude/commands/init-memory.md"
if [ -f "$CMD" ]; then
    rm "$CMD"
    log "Removed $CMD"
fi

DOCTOR_CMD="$HOME/.claude/commands/doctor.md"
if [ -f "$DOCTOR_CMD" ]; then
    rm "$DOCTOR_CMD"
    log "Removed $DOCTOR_CMD"
fi

# Remove hook from settings.json
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && grep -q "check-global-state" "$SETTINGS" 2>/dev/null; then
    python3 - "$SETTINGS" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    settings = json.load(f)
hooks = settings.get("hooks", {})
for event in ("SessionStart", "Stop"):
    groups = hooks.get(event, [])
    if not isinstance(groups, list):
        continue
    cleaned = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        # Correct format: {matcher, hooks: [...]}
        if "hooks" in group and isinstance(group["hooks"], list):
            group["hooks"] = [h for h in group["hooks"]
                              if not ("check-global-state" in h.get("command", "")
                                      or "session-end" in h.get("command", ""))]
            if group["hooks"]:
                cleaned.append(group)
        # Legacy flat format: {type, command}
        elif "type" in group:
            cmd = group.get("command", "")
            if "check-global-state" not in cmd and "session-end" not in cmd:
                cleaned.append(group)
    if cleaned:
        hooks[event] = cleaned
    elif event in hooks:
        del hooks[event]
if not hooks:
    del settings["hooks"]
with open(path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PYEOF
    log "Removed hook from $SETTINGS"
fi

# Remove installed kit copy
KIT_DEST="$HOME/.claude/team-context"
if [ -d "$KIT_DEST" ]; then
    rm -rf "$KIT_DEST"
    log "Removed $KIT_DEST"
fi

echo ""
log "Uninstall complete."
echo ""
info "Your memory files are preserved:"
info "  ~/.claude/global-state.md"
info "  ~/.claude/memory/"
info ""
info "To reinstall: curl -fsSL https://raw.githubusercontent.com/leizerowicz/meridian/main/install.sh | bash"
