# Wayfind FAQ & Known Issues

## Setup & Configuration

### How do I set up Wayfind for a new repo?

First, install the plugin if you haven't already:

```
/plugin marketplace add usewayfind/wayfind
/plugin install wayfind@usewayfind
```

Then run `/wayfind:init-memory` in the repo. This creates `.claude/team-state.md` (shared, tracked) and `.claude/personal-state.md` (personal, gitignored), updates `.gitignore`, and registers the repo globally.

### Can I use Wayfind outside a git repo?

Yes. Run `/wayfind:init-folder` (or `/init-folder` with commands) in any directory — your home folder, an admin workspace, a scratch directory. It creates `.claude/personal-state.md` so context persists across sessions. This is useful for triage, cross-project coordination, vendor management, or any work that doesn't belong to a single repo. Cross-repo context that should be available everywhere should go in `~/.claude/memory/` instead.

### How do I set up a team?

Run `/wayfind:init-team`. It walks you through creating a team, setting up profiles, creating a team-context repo, configuring Slack digests, and optionally connecting Notion.

### Can I be on multiple teams?

Yes (as of v1.8.25). Register additional teams with `wayfind context add <team-id> <path>`, then bind repos to specific teams with `wayfind context bind <team-id>`. Journals and context sync route to the correct team automatically. See `wayfind context list` for your current setup.

### I enabled multi-team and journals are going to the wrong repo

As of v1.8.27, journal files are written per-team at extraction time (`YYYY-MM-DD-{author}-{teamId}.md`). The sync command routes each file to the correct team-context repo.

If you have existing journals from before multi-team, run the migration:
```
wayfind journal split --dry-run   # preview what will happen
wayfind journal split             # split existing files by team
wayfind journal sync              # push to correct team repos
```

The split command parses `## Org/Repo —` headers in each entry and routes them using your repo→team bindings (`.claude/wayfind.json`). Originals are backed up as `.bak` files.

### What files should be gitignored?

These must be in `.gitignore` (NOT `.claude/` as a whole directory):
```
.claude/personal-state.md
.claude/state.md
.claude/settings.local.json
.claude/memory.db
.claude/wayfind.json
```

`team-state.md` is intentionally tracked — it's shared context for your team.

---

## Digests & Slack Bot

### The bot can't answer questions about older dates

Fixed in v1.8.22. The bot now parses natural language dates ("March 3", "between March 3 and March 6", "March 3-6"). Previously only "today/yesterday/this week/last N days" and explicit YYYY-MM-DD worked.

If you're still seeing issues, make sure your container is running the latest image.

### The bot says "I don't have entries from [date range]"

This usually means those journal entries haven't been indexed yet. Check:
1. Were sessions running during that period? (`ls ~/.claude/memory/journal/`)
2. Did journal sync run? (`wayfind journal sync --since YYYY-MM-DD`)
3. Is the container's cron job running? (Check Docker logs)

### How do I change when digests are sent?

Edit your `connectors.json` schedule, or ask your team admin to update the container's cron schedule. Per-member scheduling is tracked in [#68](https://github.com/usewayfind/wayfind/issues/68).

---

## Multi-Agent / Swarms

### How do I prevent worker agents from flooding my journals?

Set `TEAM_CONTEXT_SKIP_EXPORT=1` in the environment when spawning worker agents. Only the orchestrator agent (which doesn't have this var) will export decisions. Added in v1.8.21.

### Does Wayfind support a push API for agent frameworks?

Not yet. Currently decisions are extracted from Claude Code session transcripts. A push API (`wayfind decision` CLI / HTTP endpoint) for framework-agnostic intake is being designed in [#79](https://github.com/usewayfind/wayfind/issues/79).

---

## Session Lifecycle

### Do I need to manually save state at the end of a session?

Usually no. The session-end hook automatically extracts decisions, writes journal entries, and syncs to the team-context repo. As of v1.8.24, it also auto-detects significant context shifts and updates state files when needed.

Manual updates are only needed for major context shifts that the auto-detection misses — product pivots, new team conventions, etc.

### What triggers a "significant context shift"?

A lightweight Haiku LLM call classifies extracted decisions. It flags: architecture changes affecting the team, strategic pivots, new infrastructure/dependencies, priority reordering, and deployment gotchas. Routine bug fixes and incremental work are ignored.

---

## Digests — GitHub Actions vs. Container

### I'm using the GitHub Actions workflow for digests. What happens if I also deploy the container?

You'll get duplicate digests. The container and the Actions workflow both generate and deliver independently. **Disable the workflow** when you deploy the container — delete or disable `.github/workflows/wayfind-digest.yml` in your team-context repo.

The container handles everything the workflow does plus signal connectors and the Slack bot, so there's no reason to keep both running.

---

## Updates

### I updated the npm package but my hooks are still old

If you're using the **Claude Code plugin** (recommended), hooks update automatically with the plugin — no manual step needed.

If you're using the legacy npm-only setup, `npm update -g wayfind` only updates the package files. To deploy new hooks and commands to `~/.claude/hooks/`, run:

```
wayfind update
```

To switch from legacy hooks to the plugin model:

```
/plugin marketplace add usewayfind/wayfind
/plugin install wayfind@usewayfind
wayfind migrate-to-plugin
```

---

## Known Issues

### Docker build requires `npm install` not `npm ci`

As of v1.8.20, `package-lock.json` is no longer tracked. The Dockerfile uses `npm install --omit=dev`. If you have a custom Dockerfile referencing `npm ci`, switch it to `npm install`.

### LLM model aliases don't work — use exact dated model IDs

Anthropic model aliases like `claude-3-haiku-latest` can break. Always use exact IDs:
- Extraction/shift detection: `claude-haiku-4-5-20251001`
- Digest generation: `claude-sonnet-4-5-20250929`

Override via env vars: `TEAM_CONTEXT_EXTRACTION_MODEL`, `TEAM_CONTEXT_SHIFT_MODEL`.

### Journal dedup was fragile before v1.8.20

Prior to v1.8.20, re-running `wayfind reindex --export` could create duplicate journal entries because dedup only checked the first decision's title. Fixed — each decision is now individually deduped.
