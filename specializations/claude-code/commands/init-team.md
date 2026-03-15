---
description: Set up Wayfind team context for your organization. Interactive walkthrough that creates a team, sets up profiles, creates a team context repo, configures Slack digests, sets up Notion integration, and initializes product-state.md for a pilot repo. Run once per team.
---

# Initialize Team Context (Wayfind)

Interactive setup for team-level context sharing. Walk the user through each step,
asking questions as needed. Skip steps that are already done (idempotent).

## Quick Start (CLI)

Before running this full walkthrough, you can quickly bootstrap team basics from
the command line:

```bash
# Set up your personal profile and persona(s)
wayfind whoami --setup

# Create a new team (generates a shareable team ID)
wayfind team create

# Or join an existing team
wayfind team join <team-id>

# Check your profile and team status
wayfind whoami
wayfind team status
```

These commands create local config files in `~/.claude/team-context/`. The full
`/init-team` walkthrough below sets up the shared infrastructure (repo, Slack,
Notion, journals).

## Prerequisites Check

Before starting, verify:
1. Wayfind is installed (`~/.claude/team-context/` exists or `wayfind version` works)
2. User has a Wayfind profile (`wayfind whoami` -- if not, run `wayfind whoami --setup`, which also asks for Slack user ID)
3. User has a team configured (`wayfind team status` -- if not, run `wayfind team create`)
4. User has `gh` CLI authenticated (`gh auth status`)
5. User is in a git repo within an organization (or can specify one)
6. Ask: **"Which GitHub org will host the team context repo?"** (e.g., `acme-corp`)

If any prerequisite fails, tell the user what's needed and stop.

## Step 1: Team Context Repo

This repo holds shared journals, strategy state, digest archives, and the GitHub
Action that generates digests.

Ask: **"Do you already have a team context repo for shared journals and digests? If so, what's the repo name? If not, I'll help you create one."**

### If creating new:

Ask: **"What should the repo be called?"** Suggest: `<org>/engineering-context`

Guide the user:
```
gh repo create <org>/<repo-name> --private --description "Team decision trail — journals, digests, strategy (powered by Wayfind)"
```

Then clone it and create the initial structure:
```
<repo>/
  README.md              # Brief explanation of what this repo is
  strategy-state.md      # Strategy persona state (from templates/strategy-state.md)
  context/               # Shared context (product.md, engineering.md, architecture.md)
  members/               # Member profiles (<username>.json) with slack_user_id
  journals/              # One subdirectory per team member
    <username>/          # Journal files sync here from each person's local
  digests/               # Archive of generated digests
  prompts/               # Shared team prompts (from templates/prompts-readme.md)
    README.md            # How to use and contribute prompts
  deploy/                # Docker deployment (docker-compose.yml, .env, manifest)
  wayfind.json           # Shared config (webhook URLs, model, excluded repos)
  .github/workflows/     # Digest generation (added in Step 2)
```

Create `README.md` with:
```markdown
# Team Context

Shared decision trail for [team name]. Powered by [Wayfind](https://github.com/usewayfind/wayfind).

## What's here

- `strategy-state.md` — Strategic direction, research, prototypes, technology bets
- `context/` — Shared context files (product.md, engineering.md, architecture.md)
- `members/` — Member profiles with slack_user_id (e.g., greg.json, nick.json)
- `journals/` — AI session journals from each team member (auto-synced)
- `digests/` — Weekly digest archives
- `prompts/` — Shared, version-controlled prompts for common workflows
- `deploy/` — Docker deployment configuration (docker-compose.yml, .env, manifest)
- `wayfind.json` — Shared config (webhook URLs, model, excluded repos)
- `.github/workflows/` — Automated digest generation

## How it works

Team members use Wayfind in their daily AI-assisted development sessions.
Journals capture what was done, what was decided, what was discovered, and what drifted.
Weekly digests aggregate this into views for engineering, product, and strategy.
```

Create `strategy-state.md` from the strategy-state template in this repo's
`templates/strategy-state.md`. Fill in today's date. Ask the user to provide
a brief summary of current strategic direction (or leave placeholder comments).

Create the `journals/` directory with a `.gitkeep` file.
Create the `digests/` directory with a `.gitkeep` file.
Create the `prompts/` directory with the README from `templates/prompts-readme.md`.

Commit and push the initial structure.

### If existing:

Clone or pull the repo. Verify it has `journals/`, `digests/`, and `prompts/` directories.
Create them if missing. If `prompts/` is new, add the README from `templates/prompts-readme.md`.

Store the team context repo path for later steps. Record it in `~/.claude/global-state.md`
in the Memory Files table:

```
| `wayfind-team-context.md` | team context, journals, digests, wayfind | Team context repo location and configuration |
```

Create `~/.claude/memory/wayfind-team-context.md` with:
```markdown
# Wayfind Team Context

> Load this file when: team context, journals, digests, wayfind, init-team

## Team Context Repo
- Org: <org>
- Repo: <org>/<repo-name>
- Local path: <path>

## Integrations Configured
- Slack webhook: [yes/no — URL stored in repo secret]
- Notion: [yes/no — page ID]

## Team Members
- <list of usernames with journal directories>
```

## Step 1b: Link and Distribute Context

Once the team context repo exists, link it so Wayfind knows where to find shared
context files:

```bash
# Link the team context repo (sets context_repo in config)
wayfind context init <path-to-team-context-repo>

# Distribute shared context files to engineer repos
wayfind context sync
```

`wayfind context sync` copies files from `context/` in the team context repo into
`.claude/context/` in each engineer's local repos. PM/product owners maintain the
context files (e.g., `context/product.md`, `context/engineering.md`); engineers pull
them via sync.

### Repo filtering

If certain repos should be excluded from digests and context sync (e.g., the wayfind
repo itself), set:

```bash
export TEAM_CONTEXT_EXCLUDE_REPOS="wayfind,other-repo"
```

This can also be configured in `wayfind.json` in the team context repo.

### Docker deployment (optional)

To scaffold a self-hosted Docker deployment for the bot + scheduler + auto-indexer:

```bash
wayfind deploy init
```

This creates `deploy/docker-compose.yml`, `deploy/.env`, and related files in the
team context repo. The container runs the Slack bot, scheduled digests, and journal
reindexing with `restart: unless-stopped`.

## Step 2: Slack Integration

Ask: **"Do you want weekly digests posted to Slack? You'll need a Slack Incoming Webhook URL. If you have one, paste it. If not, I can walk you through creating one."**

### If they need help creating a webhook:
1. Go to https://api.slack.com/apps → Create New App → From Scratch
2. Name it "Wayfind Digests" (or team preference), select workspace
3. Features → Incoming Webhooks → Activate
4. Add New Webhook to Workspace → Select channel (suggest `#engineering`)
5. Copy the webhook URL

### Once they have the URL:

Store it as a GitHub repo secret (NOT in plain text):
```
gh secret set SLACK_WEBHOOK_URL --repo <org>/<team-context-repo> --body "<webhook-url>"
```

Ask: **"Which Slack channel(s) should receive digests?"**
Suggest defaults based on the team's configured personas (see `wayfind personas`).
For example, with the default personas:
- Engineering digest -> `#engineering`
- Product digest -> `#product` (or the same channel if team is small)
- Strategy digest -> `#leadership` (or skip if the strategy owner just reads the Notion page)

Record the channel configuration in `wayfind-team-context.md`.

### Create the GitHub Action:

Create `.github/workflows/weekly-digest.yml` in the team context repo:

```yaml
name: Weekly Digest

on:
  schedule:
    - cron: '0 10 * * 1'  # Monday 10:00 UTC (adjust for timezone)
  workflow_dispatch:  # Manual trigger for testing

jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Wayfind
        run: npm install -g wayfind

      - name: Reindex journals
        run: wayfind reindex

      - name: Generate and deliver digest
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: wayfind digest --since last-week --deliver

      - name: Archive digest
        run: |
          git config user.name "Wayfind Bot"
          git config user.email "wayfind-bot@users.noreply.github.com"
          git add digests/
          git diff --cached --quiet || git commit -m "Weekly digest $(date +%Y-%m-%d)"
          git push
```

Tell the user: **"You can test the digest manually: go to the Actions tab in the team context repo and run the 'Weekly Digest' workflow."**

## Step 3: Notion Integration

Ask: **"Do you want digests and product context visible in Notion? This creates a shared Notion page your PM and team can browse."**

### If yes:

Ask: **"What Notion workspace should I create the Wayfind pages in? I can search for existing pages or create a new top-level page."**

Use the Notion MCP tools to:

1. **Create a top-level page**: "Wayfind — [Team Name]"
   - Use `mcp__notion__notion-create-pages` or the Claude.ai Notion tools

2. **Create child pages**:
   - "Weekly Digests" — will hold one child page per week
   - "Product State" — browseable product intent (mirrors product-state.md files, if using the Product persona)
   - "Decisions Log" — searchable history of decisions
   - "Strategy" — mirrors strategy-state.md (if using the Strategy persona)
   Adapt these pages to match the team's configured personas (see `wayfind personas`).

3. For now, note the page IDs. Full Notion sync (automated posting of digests to
   Notion pages) will be added as a GitHub Action step later. For the dogfood phase,
   digests can be manually pasted or the CTO can update Notion from their session.

Record the Notion page IDs in `wayfind-team-context.md`.

Tell the user: **"Notion pages created. For now, digests will post to Slack automatically. Notion gets updated when you or a team member copies the digest over, or we can automate that next."**

## Step 4: Product State for Pilot Repo

Ask: **"Which repo should we set up persona state files for first? I'll create the intent layer so sessions have context from your configured personas."**

Check the team's configured personas (read from `~/.claude/team-context/personas.json` or fall back to `templates/personas.json`). For personas that have state templates (e.g. product-state.md, strategy-state.md), offer to create them.

Navigate to that repo (or confirm we're already in it).

For the Product persona (default), create `.claude/product-state.md` using the template from `templates/product-state.md`.

Walk through filling it in interactively:

1. Ask: **"Who's the PM for this repo?"** → record in team-state.md Signal Routing
2. Ask: **"In one or two sentences, what is this repo building and for whom?"** → fill "What We're Building"
3. Ask: **"Why is this the priority right now?"** → fill "Why This, Why Now"
4. Ask: **"How will you know it's working? What does success look like in user terms?"** → fill "Success Criteria"
5. Ask: **"Any scope constraints or product decisions that engineering should know?"** → fill "Scope & Constraints"
6. Ask: **"Any open questions that haven't been decided yet?"** → fill "Open Questions"

If the user doesn't know answers to some questions, leave the placeholder comments.
Those fields will get filled by the PM in a future session.

## Step 5: Update Team State

If `.claude/team-state.md` exists in the pilot repo, update the Signal Routing section:

```markdown
## Signal Routing
Bugs & feedback: [answer from user or "TBD"]
Persona contacts: [one entry per configured persona — name and role]
QA process: [answer from user or "TBD"]
```

If it doesn't exist, create it from `templates/team-state.md` and fill in what we know.

## Step 6: Journal Sync Configuration

Each team member's journals need to flow to the team context repo. Wayfind handles
this with a single command:

```bash
wayfind journal sync
```

This copies local journal files to the team context repo's `journals/<username>/`
directory, commits, and pushes. The session-end hook should run this automatically.

Tell the user to ensure their session-end Stop hook includes `wayfind journal sync`.
The hook is configured in `~/.claude/settings.json` and typically runs
`wayfind reindex --conversations-only --export` followed by `wayfind journal sync`.

## Step 7: Onboarding Instructions

Generate a message the user can send to their team. Ask: **"What's the best way to share setup instructions with your team? Slack message? Notion page?"**

Draft the onboarding message:

```
Hey team — I've set up Wayfind for our engineering context.

**What it does**: Captures the decisions, discoveries, and context from your AI-assisted
sessions and generates weekly digests so everyone stays oriented.

**What you need to do**:
1. Install Wayfind:
   ```
   npm install -g wayfind
   ```
2. Initialize Wayfind:
   ```
   wayfind init
   ```
3. Join our team:
   ```
   wayfind team join [TEAM_ID]
   ```
4. Set up your profile (includes Slack user ID):
   ```
   wayfind whoami --setup
   ```
5. In any repo you work in, run `/init-memory` to set up context tracking
6. That's it. Work normally. Claude will capture context at the end of each session.

**What you'll see**:
- Monday digest in #[channel] showing what shipped, what drifted, and what was discovered
- Product context in your sessions (so your AI knows *why* you're building what you're building)

Questions? Ask [user's name].
```

## Step 8: Autopilot Configuration

Personas without a human assigned will run in **autopilot mode**. When a persona
has no user profile claiming it, Wayfind will use autopilot prompt templates
(in `templates/autopilot/`) to generate that persona's perspective in digests.

Tell the user:

**"Any persona that no team member claims will run in autopilot mode — the system
generates that persona's perspective automatically. You can check the current state
with `wayfind autopilot status`."**

Show them the current autopilot status:

```
wayfind autopilot status
```

If they want to disable autopilot for a specific persona (leaving it unfilled
rather than AI-generated):

```
wayfind autopilot disable <persona-id>
```

They can re-enable it later with `wayfind autopilot enable <persona-id>`.

## Step 9: Report

Summarize everything that was set up:

- Team context repo: `<org>/<repo>` — created/configured
- Slack: webhook configured, posting to `#<channel>` on Mondays
- Notion: pages created at [page link] (or skipped)
- Persona state: initialized in `<pilot-repo>` for configured personas
- Journal sync: configured for current user
- Onboarding: message drafted for team

Tell the user: **"Team context is set up. Send the onboarding message to your team,
then run the GitHub Action manually to test the first digest. Once journals start
flowing, you'll see the first real digest next Monday."**
