# Wayfind

**Team decision trail for AI-assisted development.**

> AI makes individual engineers faster. Nobody has solved coherent, maintainable software built by a *team* over time. Every handoff loses context. Wayfind captures it.

[![CI](https://github.com/usewayfind/wayfind/actions/workflows/ci.yml/badge.svg)](https://github.com/usewayfind/wayfind/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/wayfind)](https://www.npmjs.com/package/wayfind)

---

## Install

### Claude Code plugin (recommended)

In a Claude Code session:

```
/plugin marketplace add usewayfind/wayfind
/plugin install wayfind@usewayfind
```

Then initialize a repo:

```
/wayfind:init-memory
```

Your AI sessions now resume where you left off instead of cold-starting.

### npm CLI

The plugin includes the CLI, but you can also install it standalone:

```bash
npm install -g wayfind
wayfind init
```

The CLI is required for digest generation, Slack bot, signal connectors, and team management. The plugin handles session hooks and slash commands.

---

## What It Does

### For You (solo engineer)

- **Persistent memory** — sessions pick up where the last one ended
- **Automatic journal** — decisions and rationale extracted from every session
- **Searchable history** — `wayfind search-journals "auth refactor"`
- **Drift detection** — AI flags when work drifts from the stated goal

### For Your Team

- **Digests** — weekly summaries tailored per role (engineering, product, design, strategy)
- **Slack bot** — anyone on the team asks `@wayfind` and gets answers from the decision trail
- **Signal connectors** — pull context from GitHub, Intercom, and Notion into digests
- **Context shift detection** — surfaces significant pivots and architecture changes

Only the engineer installs anything. Everyone else sees a Slack digest.

```
/wayfind:init-team     # Set up team context, journals, and digests
```

---

## How It Works

### Plain Files, Not Databases

All context is plain markdown in directories you control:

```
~/.claude/
  global-state.md           # Thin index — always loaded at session start
  memory/
    journal/YYYY-MM-DD.md   # Daily decision log

<repo>/.claude/
  team-state.md             # Shared team context (committed)
  personal-state.md         # Your context (gitignored)
```

No proprietary formats. No vendor lock-in. `grep` works if Wayfind breaks.

### The Session Protocol

**Start:** AI reads state files, summarizes context, asks "What's the goal?"

**Mid-session:** If work drifts from the goal, the AI flags it.

**End:** Decisions are extracted, written as journal entries, and synced to the team repo — automatically via hooks.

### Digests

Each role sees the same underlying data through a different lens:

- **Engineering**: What shipped, what drifted, patterns
- **Product**: What shipped vs. planned, discovery signals
- **Design**: UX decisions, implementation gaps vs. design intent
- **Strategy**: Cross-team patterns, drift trends, capability gaps

### Signal Connectors

```bash
wayfind pull github       # Issues, PRs, Actions status
wayfind pull intercom     # Support conversations, tags, response times
wayfind pull notion       # Pages, databases, comments
wayfind pull --all        # All configured channels
```

---

## Commands

### Plugin skills (in Claude Code)

| Skill | Description |
|-------|-------------|
| `/wayfind:init-memory` | Initialize context for the current repo |
| `/wayfind:init-team` | Set up team context, journals, and digests |
| `/wayfind:doctor` | Check installation health |
| `/wayfind:standup` | Daily standup summary |
| `/wayfind:journal` | Weekly journal digest and drift detection |
| `/wayfind:review-prs` | Review overnight PRs |

### CLI commands

| Command | Description |
|---------|-------------|
| `wayfind init` | Install for your AI tool |
| `wayfind doctor` | Check installation health |
| `wayfind update` | Update hooks and commands |
| `wayfind status` | Cross-project status |
| `wayfind team create` | Create a new team |
| `wayfind team join` | Join an existing team |
| `wayfind digest` | Generate persona-specific digests |
| `wayfind digest --deliver` | Generate and post to Slack |
| `wayfind bot` | Start the Slack bot |
| `wayfind reindex` | Index journals + conversations |
| `wayfind search-journals <q>` | Search decision history |
| `wayfind pull <channel>` | Pull signals from a source |
| `wayfind journal sync` | Sync journals to team repo |
| `wayfind onboard <repo>` | Generate onboarding context pack |
| `wayfind deploy init` | Scaffold Docker deployment |
| `wayfind deploy --team <id>` | Scaffold per-team Docker deployment |
| `wayfind deploy set-endpoint <url>` | Set container endpoint for team search |
| `wayfind deploy list` | List running team containers |
| `wayfind deploy status` | Check container health |
| `wayfind migrate-to-plugin` | Remove old hooks (after plugin install) |

Run `wayfind help` for the full list.

---

## MCP Server

Wayfind includes an MCP server (`wayfind-mcp`) that exposes team context to any MCP-compatible AI tool.

**Tools:** `search_context`, `get_entry`, `list_recent`, `get_signals`, `get_team_status`, `get_personas`, `record_feedback`, `add_context`

Auto-registered during `wayfind init`. When a team container is running, the local MCP server proxies semantic search to it automatically — no config needed beyond the team-context repo.

---

## Environment Variables

### For digests and bot

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Digest generation and bot answers |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-...`) |
| `GITHUB_TOKEN` | Signal data and journal sync |

### Optional

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Upgrade semantic search to OpenAI embeddings (Xenova local model is used by default — no key needed) |
| `TEAM_CONTEXT_LLM_MODEL` | LLM for digests (default: `claude-sonnet-4-5-20250929`) |
| `TEAM_CONTEXT_DIGEST_SCHEDULE` | Cron schedule (default: `0 8 * * 1` — Monday 8am) |
| `TEAM_CONTEXT_EXCLUDE_REPOS` | Repos to exclude from digests |
| `TEAM_CONTEXT_TELEMETRY` | `true` for anonymous usage telemetry |

---

## Tool Support

| Tool | Status | Setup |
|------|--------|-------|
| Claude Code | Full support (plugin) | `/plugin marketplace add usewayfind/wayfind` |
| Claude Code | Full support (npm) | `wayfind init` |
| Cursor | Session protocol | `wayfind init-cursor` |
| Generic | Manual | See `specializations/generic/` |
| Any MCP client | Full support (MCP) | `wayfind init` auto-registers |

---

## What's Open Source

Everything that runs on your machine is open source (Apache 2.0).

| Open Source (this repo) | Commercial (future) |
|---|---|
| CLI and all commands | Cloud-hosted team aggregation |
| Session protocol and journal extraction | Managed digest delivery |
| Content store and search | Web dashboard |
| Signal connectors (GitHub, Intercom, Notion) | SSO and tenant isolation |
| Digest generation (your API key) | |
| Slack bot (self-hosted) | |
| Multi-team support | |
| MCP server (local + container proxy) | |
| Per-team content store isolation | |

See [LICENSING.md](LICENSING.md) for details.

---

## Architecture

- [Data Flow](docs/architecture/data-flow.md) — sessions to digests
- [Principles](docs/architecture/architecture-principles.md) — the eight constraints
- [Content Store](docs/architecture/content-store.md) — indexing, search, schema
- [Signal Channels](docs/architecture/architecture-signal-channels.md) — connector architecture
- [Signal Roadmap](docs/architecture/signal-source-roadmap.md) — planned connectors

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first contributions:

- **Specializations** for AI tools (Windsurf, Aider, Continue)
- **Signal connectors** for new tools (Linear, Jira, Slack, HubSpot)
- Bug reports and feature requests via [issues](https://github.com/usewayfind/wayfind/issues)

---

## License

Apache 2.0. See [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md).
