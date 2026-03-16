---
description: Run Wayfind health check — validates hooks, state files, backup status, and memory file sizes.
---

# Wayfind — Doctor

Run a health check on the memory system.

## Step 1: Check if doctor.sh is available

Look for `~/.claude/team-context/doctor.sh`. If found, run it:
```bash
bash ~/.claude/team-context/doctor.sh
```

If `doctor.sh` is not found, perform the checks manually using Steps 2-3 below.

## Step 2: Manual checks

Use the Read tool (not Bash) for file checks. Use Glob for file discovery.

1. **Hook registered?** — Read `~/.claude/settings.json`. Check if it contains "check-global-state".
2. **Global state current?** — Read `~/.claude/global-state.md`. Check the "Last updated" line near the top.
3. **Backup status** — Read `~/.claude/.backup-last-push`. If the file doesn't exist, report "Backup not configured."
4. **Repos** — Use Glob to find `~/repos/**/.claude/state.md` and `~/repos/**/.claude/team-state.md` files. Report each with its parent repo name.
5. **Memory files** — Use Glob to find `~/.claude/memory/*.md`. For each file, read it and check if it's unusually large (mention if content seems over ~200 lines). Also count journal files in `~/.claude/memory/journal/`.

## Step 3: Report findings

Report in this format:
- Items that are working correctly
- Items that need attention (not broken, but worth knowing)
- Items that are broken (with how to fix)
