---
name: init-memory
description: Initialize Wayfind for the current repo. Creates .claude/team-state.md (tracked in git) and .claude/personal-state.md (gitignored), ensures correct .gitignore entries, cleans up legacy session protocol from CLAUDE.md, and registers the repo in the global index. Safe to run multiple times (idempotent).
user-invocable: true
---

# Initialize Memory System for Current Repo

Run these steps in order. Skip any step that's already done (this command is idempotent).

## Step 0: Detect and Migrate Old Protocol

Read the repo's `CLAUDE.md` (if it exists). If it contains "Update the project's row in" or "Update the Active Projects row", this repo has the old session protocol that writes to global-state.md.

**Migration:** Replace the matching Session End step with:
> 3. Do NOT update `~/.claude/global-state.md` — its Active Projects table is rebuilt automatically by `wayfind status`.

Report: "Migrated session protocol — sessions no longer write to global-state.md."

If the old protocol is not detected, skip this step silently.

## Step 1: Detect Context

- Determine the current working directory
- Check if it's a git repo (`ls .git` or `git rev-parse --show-toplevel`)
- Read `~/.claude/global-state.md` to check if this repo is already registered

## Step 1.5: Bind repo to team

Check if `.claude/wayfind.json` already exists in the repo.

**If it already exists:** Read it, report the current team binding ("Already bound to team: <team name>"), and ask: "Want to change the team binding?" If the user says no, skip to Step 2. If yes, proceed with team selection below (overwrite the file).

**If it does not exist:** Read `~/.claude/team-context/context.json` to get the list of configured teams.

- **No teams configured (file missing or empty `teams` array):** Tell the user: "No teams configured yet. Run `/wayfind:init-team` first to set up a team, then re-run `/wayfind:init-memory`." **Stop here — do not continue to later steps.**

- **Exactly one team:** Auto-bind to that team. Create `.claude/wayfind.json`:
  ```json
  {"team_id": "<teamId>", "bound_at": "<ISO 8601 timestamp>"}
  ```
  Report: "Bound to team: <team name> (auto-selected, only team configured)"

- **Multiple teams:** List the teams by name and ask the user which one this repo belongs to. Wait for their answer. Create `.claude/wayfind.json` with their chosen team's ID. Report: "Bound to team: <team name>"

**Verify `.gitignore` coverage:** `.claude/wayfind.json` must be gitignored. Step 3 already includes it in the required entries — confirm this is still the case. If someone removed it, Step 3 will restore it.

## Step 1.7: Embedding provider (first-time only)

Read `~/.claude/team-context/context.json`. Check for an `embedding_provider` field.

**If `embedding_provider` is already set:** Skip this step silently.

**If not set:** Present the following choice to the user:

```
Wayfind uses embeddings for semantic search (e.g. "find the auth refactor discussion").

Choose your embedding provider:

  1. Local model (recommended for getting started)
     - No API key needed
     - ~80MB download on first use, cached after that
     - Works offline
     - Good quality for most queries

  2. OpenAI (higher quality)
     - Requires OPENAI_API_KEY
     - ~$0/month at normal usage
     - Best retrieval quality

  3. Azure OpenAI
     - Requires AZURE_OPENAI_EMBEDDING_ENDPOINT + key
     - For enterprise deployments

⚠️  Switching providers later requires reindexing your content store.
    Run: wayfind reindex --force
    Embeddings are model-specific — mixing models breaks semantic search.

Which provider? [1/2/3, default: 1]
```

Wait for their answer (default to 1 if they press enter). Write their choice to `~/.claude/team-context/context.json` as:

```json
{ "embedding_provider": "local" }   // for choice 1
{ "embedding_provider": "openai" }  // for choice 2
{ "embedding_provider": "azure" }   // for choice 3
```

(Merge into existing context.json — do not overwrite other fields.)

Report: "Embedding provider set to: <name>"

## Step 2: Create state files (if missing)

This repo uses TWO state files with different visibility:

**`.claude/team-state.md`** — committed to git (shared team context)

If `.claude/team-state.md` does not exist, create it:

```markdown
# [Repo Name] — Team State

Last updated: [today's date]

## Architecture & Key Decisions
<!-- Decisions the whole team should know. Include the "why" not just the "what". -->

## Conventions
<!-- Patterns, naming, tooling choices that apply across the team. -->

## Current Sprint Focus
<!-- Team-level "what are we working on right now" -->

## Shared Gotchas
<!-- Hard-won lessons. What surprised us. What NOT to do. -->
```

**`.claude/personal-state.md`** — gitignored (your personal context)

If `.claude/personal-state.md` does not exist, create it:

```markdown
# [Repo Name] — Personal State

Last updated: [today's date]

(This file is gitignored. It's yours — context you wouldn't want teammates reading as objective fact.)

## My Current Focus
<!-- Your personal next steps -->

## Personal Context
<!-- Working notes, opinions, relationship dynamics for this repo -->

## What I'm Watching
<!-- Open questions, things to follow up on -->
```

## Step 3: Fix `.gitignore`

Check `.gitignore`. Ensure these lines are present:

```
.claude/personal-state.md
.claude/state.md
.claude/settings.local.json
.claude/memory.db
.claude/wayfind.json
```

**Do NOT add `.claude/` as a whole directory.** That breaks skills and commands. Only add the specific files above. Note that `team-state.md` is intentionally NOT gitignored — it is meant to be committed and shared with your team. The `.claude/state.md` entry covers legacy repos that use a single state file instead of the two-file model.

If any of those lines are missing, append them. If `.claude/` (as a directory) is already in `.gitignore`, remove it and replace with the four file-level entries above.

## Step 4: Clean up legacy session protocol from CLAUDE.md

Read the repo's `CLAUDE.md` (if it exists). If it contains a "## Session State Protocol" section, **remove the entire section** — the plugin's session-protocol skill and hooks handle this now.

Also remove the legacy "## Session State Protocol (AI Memory Kit)" variant if present.

If the CLAUDE.md has no other content after removal, leave it with just the repo name heading.

Report: "Removed legacy Session State Protocol from CLAUDE.md — the plugin handles this now."

If no session protocol section was found, skip silently.

## Step 5: Register State Files in Global Index

Read `~/.claude/global-state.md`. The Active Projects table is auto-generated by `wayfind status --write` — do NOT add rows to it manually.

Add the repo's state files to the State Files table if missing:

```
| `[full path]/.claude/team-state.md` | Shared team context for this repo |
| `[full path]/.claude/personal-state.md` | Personal context for this repo (gitignored) |
```

## Step 6: Report

Tell the user:
- `.claude/wayfind.json` — bound to team: <team name> (or already bound)
- `.claude/team-state.md` — created or already existed (committed to git, shared with team)
- `.claude/personal-state.md` — created or already existed (gitignored, personal only)
- `.gitignore` — updated or already correct
- `CLAUDE.md` — legacy session protocol removed (or was already clean)
- `global-state.md` — repo registered or already listed

**If they haven't set up team context yet**, mention:
"Run `/wayfind:init-team` to set up team-level context sharing — shared journals, weekly digests
(Slack + Notion), and persona state files for your configured personas."

**Mention persona configuration:**
"Run `wayfind personas` to see and customize your team's personas (defaults: Product, Design, Engineering, Strategy)."
