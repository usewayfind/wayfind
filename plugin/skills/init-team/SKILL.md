---
name: init-team
description: Set up Wayfind team context for your organization. Interactive walkthrough that creates a team, sets up profiles, creates a team context repo, configures Slack digests, sets up Notion integration, and initializes product-state.md for a pilot repo. Run once per team.
user-invocable: true
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
`/wayfind:init-team` walkthrough below sets up the shared infrastructure (repo, Slack,
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

Commit and push the initial structure.

### If existing:

Clone or pull the repo. Verify it has `journals/`, `digests/`, and `prompts/` directories.
Create them if missing. If `prompts/` is new, add the README from `templates/prompts-readme.md`.

Store the team context repo path for later steps.

## Step 1a: Non-Repo Folder Setup (Optional)

After the team context repo is set up, ask:

**"Do you have a non-repo folder you use for admin or cross-cutting work? (e.g., your home directory) We can set that up too so context from those sessions is preserved."**

If yes, run `/wayfind:init-folder` in that directory (or guide them to run it later).

## Step 2: Slack Integration

Ask: **"Do you want weekly digests posted to Slack? You'll need a Slack Incoming Webhook URL. If you have one, paste it. If not, I can walk you through creating one."**

### If they need help creating a webhook:
1. Go to https://api.slack.com/apps -> Create New App -> From Scratch
2. Name it "Wayfind Digests" (or team preference), select workspace
3. Features -> Incoming Webhooks -> Activate
4. Add New Webhook to Workspace -> Select channel (suggest `#engineering`)
5. Copy the webhook URL

### Once they have the URL:

Store it as a GitHub repo secret (NOT in plain text):
```
gh secret set SLACK_WEBHOOK_URL --repo <org>/<team-context-repo> --body "<webhook-url>"
```

Ask: **"Which Slack channel(s) should receive digests?"**

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

## Step 3: Notion Integration

Ask: **"Do you want digests and product context visible in Notion?"**

If yes, use Notion MCP tools to create pages and record the page IDs.

## Step 4: Product State for Pilot Repo

Ask: **"Which repo should we set up persona state files for first?"**

Check the team's configured personas and create appropriate state templates.

## Step 5: Journal Sync Configuration

Each team member's journals need to flow to the team context repo:

```bash
wayfind journal sync
```

Ensure the session-end hook includes journal sync (the plugin handles this automatically).

## Step 6: Onboarding Instructions

Generate a message the user can send to their team:

```
Hey team — I've set up Wayfind for our engineering context.

**What you need to do**:
1. Install the Claude Code plugin:
   /plugin marketplace add usewayfind/wayfind
   /plugin install wayfind@usewayfind
2. For full features (digests, extraction), also install the CLI:
   npm install -g wayfind
3. Join our team:
   wayfind team join [TEAM_ID]
4. Set up your profile:
   wayfind whoami --setup
5. In any repo you work in, run /wayfind:init-memory

That's it. Work normally. Wayfind captures context at the end of each session.
```

## Step 7: Report

Summarize everything that was set up and tell the user to send the onboarding message.
