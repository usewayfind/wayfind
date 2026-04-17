---
description: Initialize Wayfind for the current repo. Creates .claude/team-state.md (tracked in git) and .claude/personal-state.md (gitignored), ensures correct .gitignore entries, appends session protocol to CLAUDE.md, and registers the repo in the global index. Safe to run multiple times (idempotent).
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

- **No teams configured (file missing or empty `teams` array):** Tell the user: "No teams configured yet. Run `/init-team` first to set up a team, then re-run `/init-memory`." **Stop here — do not continue to later steps.**

- **Exactly one team:** Auto-bind to that team. Create `.claude/wayfind.json`:
  ```json
  {"team_id": "<teamId>", "bound_at": "<ISO 8601 timestamp>"}
  ```
  Report: "Bound to team: <team name> (auto-selected, only team configured)"

- **Multiple teams:** List the teams by name and ask the user which one this repo belongs to. Wait for their answer. Create `.claude/wayfind.json` with their chosen team's ID. Report: "Bound to team: <team name>"

**Verify `.gitignore` coverage:** `.claude/wayfind.json` must be gitignored. Step 3 already includes it in the required entries — confirm this is still the case. If someone removed it, Step 3 will restore it.

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

## Elicitation Prompts

<!-- These prompts guide the AI to capture richer context at decision moments.
     The answers aren't for you — they're for your teammates who read the digest. -->

When a technical or product decision is made without stated reasoning, ask one of:
- "What alternatives did you consider?"
- "What constraint or requirement drove this choice?"
- "What would need to change for you to reverse this decision?"
- "Who else on the team does this affect, and how?"
- "What's the risk if this assumption is wrong?"

Do not ask if the decision already includes reasoning, tradeoffs, or constraints.
Do not ask more than once per decision. Do not ask during routine implementation.

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

## Step 4: Append Session Protocol to CLAUDE.md

Read the repo's `CLAUDE.md`. If it does NOT already contain "Session State Protocol", append this:

```markdown

## Session State Protocol

**At session start (REQUIRED):**
1. Read `~/.claude/global-state.md` — preferences, active projects, memory file manifest
2. Read `.claude/team-state.md` in this repo — shared team context: architecture decisions, conventions, sprint focus, gotchas
3. Read `.claude/personal-state.md` in this repo — your personal context: current focus, working notes, opinions
4. Check the Memory Files table in global-state.md — load any `~/.claude/memory/` files relevant to this session's topic

**At session end (when user says stop/done/pause/tomorrow):**
1. Update `.claude/team-state.md` with shared context: architecture decisions, conventions, gotchas the team should know
2. Update `.claude/personal-state.md` with personal context: your next steps, working notes, opinions
3. Do NOT update `~/.claude/global-state.md` — its Active Projects table is rebuilt automatically by `wayfind status`.
4. If significant new cross-repo context was created (patterns, strategies, decisions), create or update a file in `~/.claude/memory/` and add it to the Memory Files manifest in global-state.md

**Do NOT use ruvector/claude-flow memory CLI for state storage.** Use plain markdown files only.
```

If `CLAUDE.md` doesn't exist, create a minimal one with the repo name as a heading and the block above.

## Step 4.5: Patch Write Permissions in ~/.claude/settings.json

Read `~/.claude/settings.json` (create it as `{}` if missing).

Ensure the following entries are present in `permissions.allow`. Add any that are missing — do NOT remove existing entries.

Each path needs two forms: absolute (for tools that resolve paths before the permission check) and literal (tilde or relative, for tools that pass the path as-is). Both are required — Claude Code matches against the literal `file_path` argument, not the resolved path.

```
Write(<HOME>/.claude/memory/**)
Write(~/.claude/memory/**)
Write(<HOME>/.claude/global-state.md)
Write(~/.claude/global-state.md)
Write(<HOME>/.claude/state.md)
Write(~/.claude/state.md)
Write(<HOME>/**/.claude/team-state.md)
Write(.claude/team-state.md)
Write(<HOME>/**/.claude/personal-state.md)
Write(.claude/personal-state.md)
```

Where `<HOME>` is the user's actual home directory (e.g. `/home/greg` or `/Users/greg`).

**Why:** Without these, Claude Code's plan mode prompts for approval on every journal and state-file write — even when the user is in bypass/dangerously-skip-permissions mode. These files are internal Wayfind state and are never dangerous to write.

Report: "Write permissions patched — N entries added" (or "already present" if nothing changed).

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
- `CLAUDE.md` — protocol appended or already present
- `global-state.md` — repo registered or already listed

**If they haven't set up team context yet**, mention:
"Run `/init-team` to set up team-level context sharing — shared journals, weekly digests
(Slack + Notion), and persona state files for your configured personas."

**Mention persona configuration:**
"Run `wayfind personas` to see and customize your team's personas (defaults: Product, Design, Engineering, Strategy)."
