# Claude Code Specialization

> **Note:** The canonical plugin source is now in `plugin/` at the repo root.
> This `specializations/claude-code/` directory is kept for backward compatibility
> with `setup.sh` but `plugin/` is the source of truth for Claude Code integration.

This directory contains everything needed to wire Wayfind into Claude Code specifically.

## What's Different About Claude Code

Claude Code reads a `CLAUDE.md` file at the root of every repo (and `~/.claude/CLAUDE.md` globally) as persistent instructions. It also supports:
- **Hooks** — shell scripts that run on session start/end, file edits, commands
- **Custom slash commands** — markdown files in `.claude/commands/` become `/command-name` shortcuts
- **Settings** — `~/.claude/settings.json` controls hooks and behavior

The memory directory for Claude Code is `~/.claude/` (not `~/.ai-memory/`).

## File Map

| File | Install to | Purpose |
|------|-----------|---------|
| `CLAUDE.md-global-fragment.md` | Append to `~/.claude/CLAUDE.md` | Tells Claude to load memory files at session start |
| `CLAUDE.md-repo-fragment.md` | Append to `<repo>/CLAUDE.md` | Repo-level session protocol |
| `settings.json` | Merge into `~/.claude/settings.json` | Registers the anti-drift hook |
| `hooks/check-global-state.sh` | Copy to `~/.claude/hooks/` | Warns when global index is stale |
| `commands/init-memory.md` | Copy to `~/.claude/commands/` | Adds `/init-memory` slash command |
| `commands/init-team.md` | Copy to `~/.claude/commands/` | Adds `/init-team` slash command |
| `commands/journal.md` | Copy to `~/.claude/commands/` | Adds `/journal` slash command |
| `commands/doctor.md` | Copy to `~/.claude/commands/` | Adds `/doctor` slash command |

The `setup.sh` at the kit root handles all of this automatically.

## Manual Install

```bash
# 1. Create directories
mkdir -p ~/.claude/hooks ~/.claude/commands ~/.claude/memory/journal

# 2. Copy the global CLAUDE.md fragment
cat specializations/claude-code/CLAUDE.md-global-fragment.md >> ~/.claude/CLAUDE.md

# 3. Install hook script
cp specializations/claude-code/hooks/check-global-state.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/check-global-state.sh

# 4. Install init-memory command
cp specializations/claude-code/commands/init-memory.md ~/.claude/commands/

# 5. Merge settings.json
# If ~/.claude/settings.json doesn't exist:
cp specializations/claude-code/settings.json ~/.claude/settings.json
# If it already exists, manually add the "hooks" block from settings.json

# 6. Copy global state template
cp ../../templates/global.md ~/.claude/global-state.md
# Edit it to add your preferences and projects
```

## Per-Repo Setup

For each repo you work in:

```bash
cd ~/repos/your-org/your-repo
mkdir -p .claude

# Copy repo state templates
cp ~/.claude/team-context/templates/repo-state.md .claude/team-state.md    # Shared team context (committed)
cp ~/.claude/team-context/templates/repo-state.md .claude/personal-state.md # Personal context (gitignored)

# Add session protocol to repo CLAUDE.md
cat ~/.claude/team-context/specializations/claude-code/CLAUDE.md-repo-fragment.md >> CLAUDE.md

# Add gitignore entries (IMPORTANT — see note below)
echo ".claude/personal-state.md" >> .gitignore
echo ".claude/settings.local.json" >> .gitignore
echo ".claude/memory.db" >> .gitignore
```

Or just run `/init-memory` inside Claude Code after setup.

## Gitignore Warning

**Never add `.claude/` to `.gitignore` as a whole directory.**

Claude Code stores skills, commands, and settings in `.claude/` that should be tracked in git. If you ignore the whole directory, git won't track those files — and negation rules like `!.claude/commands/` won't rescue them (git doesn't descend into ignored directories).

**Correct pattern:**
```gitignore
# Claude Code — local only, don't track
.claude/personal-state.md
.claude/settings.local.json
.claude/memory.db
```

**Wrong:**
```gitignore
.claude/          ← this breaks skills and commands
```

## Memory Directory Note

Claude Code uses `~/.claude/` as its home. This kit uses that same directory rather than `~/.ai-memory/` so that Claude's native file loading works correctly. The file paths in your `global-state.md` will reference `~/.claude/memory/` accordingly.
