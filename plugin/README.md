# Wayfind — Claude Code Plugin

Team decision trail for AI-assisted development. Session memory, decision journals, and team digests.

## Install

From the GitHub marketplace:
```
/plugin marketplace add usewayfind/wayfind
/plugin install wayfind@usewayfind
```

Or from the official Anthropic marketplace (once approved):
```
/plugin install wayfind
```

## What you get

### Tier 1: Plugin only (no npm install)

- **Session memory protocol** — loads team and personal state files at session start, saves at session end
- **Slash commands** — `/wayfind:init-memory`, `/wayfind:init-team`, `/wayfind:doctor`, `/wayfind:journal`, `/wayfind:standup`, `/wayfind:review-prs`
- **Hooks** — auto-rebuild project index on session start, auto-extract decisions on session end

### Tier 2: Plugin + npm CLI (`npm i -g wayfind`)

Everything in Tier 1, plus:

- **Decision indexing** — `wayfind reindex` extracts decisions from conversation transcripts
- **Journal sync** — `wayfind journal sync` pushes local journals to the team context repo
- **Weekly digests** — `wayfind digest` generates multi-persona summaries (engineering, product, strategy)
- **Team coordination** — `wayfind team create/join`, shared context distribution
- **Slack + Notion delivery** — digests post to Slack channels and Notion pages via GitHub Actions
- **Bot mode** — `wayfind bot` runs a Slack bot for on-demand queries

## Removing legacy session prompts

If you installed Wayfind before the plugin existed, you likely have a "Session State Protocol"
section in your CLAUDE.md files that tells the AI to ask "What's the goal for this session?"
and flag drift. The plugin now handles session memory without these prompts.

To clean up:

1. **Run `/wayfind:init-memory`** in each repo — Step 4 removes the legacy protocol from CLAUDE.md automatically.

2. **Or manually:** delete the `## Session State Protocol` section from these files:
   - `~/CLAUDE.md`
   - `~/.claude/CLAUDE.md`
   - Each repo's `CLAUDE.md`

The plugin's hooks and session-protocol skill handle state file loading without
requiring any CLAUDE.md instructions or interactive prompts.

## Documentation

Full docs: https://github.com/usewayfind/wayfind
