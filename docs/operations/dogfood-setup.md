# Dogfood Setup — Wayfind Manages Itself

Wayfind is dogfood team #2. The Wayfind repo itself is managed by Wayfind, meaning every AI-assisted development session on this codebase follows the same session protocol, state file patterns, and digest flows that we ship to users.

## What context is captured

- **Team state** (`.claude/team-state.md`): Architecture decisions, conventions, sprint focus, signal routing, and shared gotchas for the Wayfind project. This file is committed to git and shared with all contributors.
- **Personal state** (`.claude/personal-state.md`): Per-contributor working notes, current focus, and opinions. This file is gitignored — each contributor maintains their own.
- **Session journals** (`~/.claude/memory/journal/YYYY-MM-DD.md`): Daily logs of what was built, what was decided, what drifted, and what was learned. These live in each contributor's home directory and sync to the team context repo for digest generation.

## How to read the team state

Open `.claude/team-state.md` at the repo root. It contains:

- **Product Context** — what Wayfind is and who it serves
- **Architecture & Key Decisions** — the reasoning behind major choices (plain markdown, CLI-first, hybrid personas)
- **Conventions** — naming, file structure, testing, commit message style
- **Current Sprint Focus** — what the team is working on right now
- **Signal Routing** — where engineering, product, and strategy signals come from
- **Shared Gotchas** — hard-won lessons to avoid repeating mistakes

AI sessions on this repo read team-state.md at startup, so every coding session has full project context automatically.

## State repos

The Wayfind project uses the two-repo pattern described in [state-repo-setup.md](state-repo-setup.md):

- **Personal backup**: Greg's `claude-state` private repo backs up `~/.claude/` (global state, memory files, journals, per-repo state, hooks, settings). Auto-syncs via session hooks — restore on start, backup+push on end. New machine setup is one `git clone` + `./sync.sh restore`.
- **Team context**: Currently collapsed into the personal backup repo (solo contributor). Will split to an org-level repo when additional contributors join.

## Weekly digests

Weekly digests aggregate journal entries from all Wayfind development sessions into persona-specific views. For this repo, the engineering digest surfaces what shipped, what decisions were made, what drifted from plan, and what patterns emerged. Since Greg is the sole contributor currently, the digest doubles as a personal development log and a project health check. As the contributor base grows, digests will show cross-contributor patterns and coordination gaps — the same value Wayfind delivers to user teams.

**Current setup**: `wayfind digest` runs locally using Anthropic API and delivers to #team-context via Slack bot token (`chat.postMessage`), falling back to webhook if bot delivery fails. Bot delivery is primary because it enables reaction tracking and threaded feedback. Config is built from env vars via `buildConfigFromEnv()` in the Docker container (not `connectors.json`). Two models are used: Sonnet (`TEAM_CONTEXT_LLM_MODEL`) for digest generation and onboarding packs, and `TEAM_CONTEXT_EXTRACTION_MODEL` for conversation transcript extraction. The digest shows per-persona progress during generation (persona name, index, elapsed time) so you know it's working during the 1-2 minute LLM calls.

## Slack bot

The Wayfind Slack bot connects via Socket Mode and answers ad-hoc questions about the decision trail. Anyone in the team Slack can mention `@wayfind` with a question and get an answer grounded in indexed journal entries.

**Setup:**

```bash
wayfind bot --configure    # Interactive — saves Slack app token, bot token, LLM config to ~/.claude/team-context/.env
wayfind index-journals     # Index journal entries into the content store
wayfind bot                # Start the bot (Socket Mode, runs in foreground)
```

**Architecture note:** The bot is designed for three hosting modes. Today it runs locally (Socket Mode, no public URL). The config schema includes `mode` and `store_path` fields for future self-hosted and cloud-hosted modes. For dogfooding, one person runs `wayfind bot` locally while testing — or deploys via Docker (see below).

## Container deployment

For persistent operation (no terminal required), deploy the bot and scheduler as Docker containers in your team context repo.

**Setup:**

```bash
wayfind deploy init          # Creates deploy/ with docker-compose.yml, .env.example, slack-app-manifest.json
```

**Create your Slack app:**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From a manifest.
2. Paste the contents of `deploy/slack-app-manifest.json`.
3. Install the app to your workspace.
4. Copy the bot token (`xoxb-`) from OAuth & Permissions.
5. Generate an app-level token (`xapp-`) from Basic Information → App-Level Tokens (add `connections:write` scope).

**Configure and start:**

```bash
cp deploy/.env.example deploy/.env
# Edit deploy/.env with your Slack tokens, Anthropic API key, etc.
cd deploy && docker compose up -d
```

**Model configuration:** Use exact model IDs in `deploy/.env`, not aliases:
- `TEAM_CONTEXT_LLM_MODEL=claude-sonnet-4-5-20250929` (digest generation)
- `TEAM_CONTEXT_EXTRACTION_MODEL=claude-haiku-4-5-20251001` (conversation extraction)

Model aliases like `claude-haiku-4-5-latest` currently return 404.

**What runs inside the container:**

- **Slack bot** — Socket Mode, answers `@wayfind` mentions from indexed journals
- **Scheduler** — runs digest generation and signal pulls on cron (configurable, defaults: digests Monday 8am UTC, signals daily 6am UTC)
- **Health endpoint** — `http://localhost:3141/healthz` for monitoring. Includes Slack WebSocket connection status: returns 503 when Socket Mode is disconnected, enabling Docker auto-restart for self-healing after network interruptions. Response includes `slack: { connected, lastConnected, lastDisconnected }`.

This replaces both `wayfind bot` (foreground) and manual `wayfind digest` runs. The scheduler handles everything on its configured schedule.

**Architecture note:** Three deployment modes are now real:

- **Local** — `wayfind bot` in foreground, `wayfind digest` on demand. Zero infrastructure.
- **Self-hosted Docker** — `wayfind deploy init` + `docker compose up`. Persistent, no terminal. Each team creates their own Slack app.
- **Cloud** (future) — managed hosting, distributed Slack app. Tracked in issue #41.
