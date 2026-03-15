---
description: Generate a journal summary — weekly digest, drift detection, and recurring lessons from AI session journals.
---

# Wayfind — Journal Summary

Aggregate AI session journal entries into a weekly digest with drift detection and recurring lesson extraction.

## Step 1: Run journal-summary.sh

Look for `~/.claude/team-context/journal-summary.sh`. If found, run it based on what the user asked:

```bash
# This week (default)
bash ~/.claude/team-context/journal-summary.sh

# Last week
bash ~/.claude/team-context/journal-summary.sh --last-week

# Specific date range
bash ~/.claude/team-context/journal-summary.sh --from 2026-02-01 --to 2026-02-28

# All history as Markdown (good for Notion/GitHub)
bash ~/.claude/team-context/journal-summary.sh --all --format markdown

# Team aggregate (each subdir is a contributor's journal dir)
bash ~/.claude/team-context/journal-summary.sh --team ~/team-journals

# Custom journal directory
bash ~/.claude/team-context/journal-summary.sh --dir ~/.ai-memory/memory/journal
```

## Step 2: If journal-summary.sh is not installed

Run setup.sh with `--update` to install it:
```bash
bash ~/repos/greg/wayfind/setup.sh --tool claude-code --update
```

Or install manually:
```bash
cp ~/repos/greg/wayfind/journal-summary.sh ~/.claude/team-context/journal-summary.sh
chmod +x ~/.claude/team-context/journal-summary.sh
```

## Step 3: Interpret results

The summary surfaces four key sections:

- **Sessions by Repo** — Every session in the period, grouped by repo. ⚠ marks drifted sessions.
- **Drift Log** — Sessions where "On track?" indicated scope creep or goal drift. Review these to identify recurring blockers.
- **Recurring Lessons** — Lessons that appeared in 2+ sessions. These are strong candidates to add to `CLAUDE.md` or `global-state.md` so the AI learns from them.
- **All Lessons** — Full lesson archive for the period, with ♻ markers on recurring ones.

## Options quick reference

```
--dir <path>        Journal directory (auto-detects ~/.claude or ~/.ai-memory)
--team <path>       Team mode: each subdirectory is a contributor's journal dir
--week              This week Mon–Sun (default)
--last-week         Last week Mon–Sun
--from <YYYY-MM-DD> Start date
--to   <YYYY-MM-DD> End date (default: today)
--all               All available journal files
--format markdown   Output as Markdown instead of plain text
```
