# Cursor Integration — Wayfind

Full setup guide for Cursor users.

## Quick Setup

Install Wayfind globally, then run the Cursor initializer:
```bash
npm install -g wayfind
wayfind init-cursor
```

Or use the shell installer directly: `bash setup.sh --tool cursor`. Manual steps below.

## How It Works

Cursor injects rule files into the AI context at session start. The memory kit hooks into this system to load your state files automatically.

### Memory Directory

The Cursor specialization uses `~/.ai-memory/` as the memory root (tool-agnostic, not tied to Cursor's config location):

```
~/.ai-memory/
  global.md              # Always loaded — thin index of all state
  state.md               # Admin/non-repo work
  memory/
    <topic>.md           # Loaded on demand
    journal/
      YYYY-MM-DD.md      # Daily session log
```

### Per-Repo Files

```
<repo>/.cursor/
  rules/
    memory.mdc           # Repo-level memory rules (committed to git)
```

### Session Flow

**Session start:** Cursor reads `.cursor/rules/memory.mdc` → AI loads `~/.ai-memory/global.md` + repo state

**Session end (manual):** Say "done for today, update state files" — the AI updates the state files and appends a journal entry

## Setup

### Step 1: Memory directory

```bash
mkdir -p ~/.ai-memory/memory/journal
```

### Step 2: Global index

```bash
cp templates/global.md ~/.ai-memory/global.md
# Edit with your preferences, projects, team context
```

### Step 3: Global Cursor rules

Cursor supports global rules in `~/.cursor/rules/`. Create the memory rule:

```bash
mkdir -p ~/.cursor/rules
cp specializations/cursor/global-rule.mdc ~/.cursor/rules/ai-memory.mdc
```

### Step 4: Initialize a repo

In any repo you work in with Cursor, run:

```bash
bash setup.sh --tool cursor --repo .
# Or manually:
mkdir -p .cursor/rules
cp specializations/cursor/repo-rule.mdc .cursor/rules/memory.mdc
```

Edit `.cursor/rules/memory.mdc` to reflect the repo name and what it's about.

### Step 5: Fill in your global index

Open `~/.ai-memory/global.md` and fill in:
- Your preferences and working style
- Active projects table
- Team context (using the examples as a guide)

## Session End Triggers

Since Cursor has no native hooks, use these natural language triggers to end a session:

- "done for today" — triggers state file updates + journal entry
- "stop, update memory" — same
- "save session state" — same

The rule file instructs the AI to perform all updates when it hears these phrases.

## What Gets Committed

- `.cursor/rules/memory.mdc` — **commit this** (shared context for any AI tool that reads the repo)
- `~/.ai-memory/` files — **never commit** (personal memory, lives outside the repo)

## Limitations vs. Claude Code

| Feature | Claude Code | Cursor |
|---------|------------|--------|
| Auto session-start | ✓ Hook fires automatically | ✓ Rule file injected automatically |
| Auto session-end | ✓ Hook triggers on stop | ✗ Manual trigger required |
| `/init-memory` command | ✓ | ✗ Use `wayfind init-cursor` or `setup.sh --tool cursor --repo .` |
| Team commands (`/init-team`) | ✓ | ✗ Not available |
| Context sync | ✓ | ✗ Not available |
| Deploy | ✓ | ✗ Not available |
| Bot | ✓ | ✗ Not available |
| Digest reactions | ✓ | ✗ Not available |
| Telemetry | ✓ (opt-in) | ✗ Not available |
| Prompts | ✓ | ✗ Not available |
| Global memory path | `~/.claude/` | `~/.ai-memory/` |
