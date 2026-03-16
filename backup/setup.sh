#!/usr/bin/env bash
# Wayfind — Backup Setup
# Wires a private GitHub repo as your memory backup.
#
# Usage: bash backup/setup.sh <repo-url>
# Example: bash backup/setup.sh git@github.com:you/claude-memory.git
#          bash backup/setup.sh https://github.com/you/claude-memory.git
#
# What this does:
#   1. Clones your backup repo to ~/.claude-backup/
#   2. Does an initial sync of your memory files into it
#   3. Installs session-start (restore) and session-end (push) hooks
#   4. Registers both hooks in ~/.claude/settings.json

set -euo pipefail

REPO_URL="${1:-}"
BACKUP_DIR="$HOME/.claude-backup"
MEMORY_DIR="$HOME/.claude"
HOOKS_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
log()  { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $1"; }
err()  { echo -e "${RED}✗${RESET} $1"; exit 1; }

# ── Validate ──────────────────────────────────────────────────────────────────

if [ -z "$REPO_URL" ]; then
    err "No repo URL provided.\nUsage: bash backup/setup.sh <repo-url>"
fi

if ! command -v git &>/dev/null; then
    err "git is required but not installed."
fi

if ! command -v rsync &>/dev/null; then
    err "rsync is required but not installed. On macOS: brew install rsync"
fi

# ── Clone or init backup repo ─────────────────────────────────────────────────

echo ""
echo "Wayfind — Backup Setup"
echo ""

if [ -d "$BACKUP_DIR/.git" ]; then
    warn "Backup repo already exists at $BACKUP_DIR — pulling latest"
    git -C "$BACKUP_DIR" pull --quiet
else
    echo "Cloning backup repo..."
    if git clone "$REPO_URL" "$BACKUP_DIR" 2>/dev/null; then
        log "Cloned $REPO_URL → $BACKUP_DIR"
    else
        # Repo exists on GitHub but is empty — clone fails. Init locally instead.
        mkdir -p "$BACKUP_DIR"
        git -C "$BACKUP_DIR" init
        git -C "$BACKUP_DIR" remote add origin "$REPO_URL"
        log "Initialized empty backup repo at $BACKUP_DIR"
    fi
fi

# ── Initial sync ──────────────────────────────────────────────────────────────

echo "Syncing memory files to backup repo..."

# Files to back up: global index, admin state, and the entire memory/ directory
mkdir -p "$BACKUP_DIR"
rsync -a \
    "$MEMORY_DIR/global-state.md" \
    "$MEMORY_DIR/state.md" \
    "$BACKUP_DIR/" 2>/dev/null || true

if [ -d "$MEMORY_DIR/memory" ]; then
    mkdir -p "$BACKUP_DIR/memory"
    rsync -a "$MEMORY_DIR/memory/" "$BACKUP_DIR/memory/" 2>/dev/null || true
fi

# Initial commit
cd "$BACKUP_DIR"
git add -A
if ! git diff --cached --quiet; then
    git commit -m "initial backup — $(date '+%Y-%m-%d')"
    git push -u origin main 2>/dev/null || git push -u origin master 2>/dev/null || \
        warn "Push failed — check your repo URL and SSH/token auth, then run: git -C $BACKUP_DIR push"
    log "Initial backup pushed"
else
    log "Nothing to commit in initial sync"
fi

# ── Install hook scripts ──────────────────────────────────────────────────────

mkdir -p "$HOOKS_DIR"

cp "$SCRIPT_DIR/hooks/session-start.sh" "$HOOKS_DIR/backup-restore.sh"
chmod +x "$HOOKS_DIR/backup-restore.sh"
log "Installed: $HOOKS_DIR/backup-restore.sh"

cp "$SCRIPT_DIR/hooks/session-end.sh" "$HOOKS_DIR/backup-push.sh"
chmod +x "$HOOKS_DIR/backup-push.sh"
log "Installed: $HOOKS_DIR/backup-push.sh"

# Store the backup dir path so hooks know where to find it
echo "$BACKUP_DIR" > "$MEMORY_DIR/.backup-dir"
log "Stored backup dir config: $MEMORY_DIR/.backup-dir"

# ── Register hooks in settings.json ──────────────────────────────────────────

if [ ! -f "$SETTINGS" ]; then
    cp "$SCRIPT_DIR/../specializations/claude-code/settings.json" "$SETTINGS"
fi

python3 - <<PYEOF
import json, os

settings_path = os.path.expanduser("$SETTINGS")
with open(settings_path) as f:
    s = json.load(f)

hooks = s.setdefault("hooks", {})

# SessionStart: restore (pull) — prepend so it runs before check-global-state
start_hooks = hooks.setdefault("SessionStart", [])
restore_cmd = {"type": "command", "command": "bash ~/.claude/hooks/backup-restore.sh"}
if not any(h.get("command", "").endswith("backup-restore.sh") for h in start_hooks):
    start_hooks.insert(0, restore_cmd)
    print("  + Registered backup-restore.sh in SessionStart")
else:
    print("  - backup-restore.sh already in SessionStart")

# Stop: push — runs when Claude session ends
stop_hooks = hooks.setdefault("Stop", [])
push_cmd = {"type": "command", "command": "bash ~/.claude/hooks/backup-push.sh"}
if not any(h.get("command", "").endswith("backup-push.sh") for h in stop_hooks):
    stop_hooks.append(push_cmd)
    print("  + Registered backup-push.sh in Stop")
else:
    print("  - backup-push.sh already in Stop")

with open(settings_path, "w") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PYEOF

log "Updated $SETTINGS"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "Backup setup complete."
echo "  Backup repo:    $BACKUP_DIR  →  $REPO_URL"
echo "  Restore hook:   runs at session start (pulls latest)"
echo "  Push hook:      runs at session end (commits + pushes changes)"
echo ""
