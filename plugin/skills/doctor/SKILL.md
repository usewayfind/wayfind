---
name: doctor
description: Run Wayfind health check — validates hooks, state files, backup status, and memory file sizes.
user-invocable: true
---

# Wayfind — Doctor

Run a health check on the memory system.

## Step 1: Check if the CLI is available

```bash
wayfind doctor
```

If the CLI is installed, its built-in doctor command handles everything. Present the output and stop.

If the CLI is not found, perform the checks manually using Steps 2-3 below.

## Step 2: Manual checks

Use the Read tool (not Bash) for file checks. Use Glob for file discovery.

1. **Hook registered?** — Read `~/.claude/settings.json`. Check if it contains "check-global-state" or if the wayfind plugin is installed (plugin hooks handle this automatically).
2. **Global state current?** — Read `~/.claude/global-state.md`. Check the "Last updated" line near the top.
3. **Backup status** — Read `~/.claude/.backup-last-push`. If the file doesn't exist, report "Backup not configured."
4. **Repos** — Use Glob to find `~/repos/**/.claude/state.md` and `~/repos/**/.claude/team-state.md` files. Report each with its parent repo name.
5. **Memory files** — Use Glob to find `~/.claude/memory/*.md`. For each file, read it and check if it's unusually large (mention if content seems over ~200 lines). Also count journal files in `~/.claude/memory/journal/`.

## Step 3: Report findings

Report in this format:
- Items that are working correctly
- Items that need attention (not broken, but worth knowing)
- Items that are broken (with how to fix)
