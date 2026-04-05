# Wayfind

**Team memory for AI-assisted engineering.**

Your AI coding assistant forgets everything between sessions. Wayfind gives it a memory — for you and your whole team.

Plain markdown files. No infrastructure. Works with any MCP client.

[![CI](https://github.com/usewayfind/wayfind/actions/workflows/ci.yml/badge.svg)](https://github.com/usewayfind/wayfind/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/wayfind)](https://www.npmjs.com/package/wayfind)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Works with:** Claude Code | Cursor | Any MCP client

---

## The Problem

AI coding assistants are stateless. Every session starts cold. The decisions you made yesterday, the architecture you agreed on last week, the reason you chose Postgres over Mongo — gone. You re-explain, or the AI guesses wrong.

Now multiply that across a team. Five engineers, each with their own AI sessions, none of them aware of what the others decided. Your PM reads the standup notes, but the AI that writes the code doesn't.

## What Wayfind Does

**For you:** Sessions resume where they left off. Decisions are extracted automatically and become searchable history. Drift detection flags when work veers from the stated goal.

**For your team:** A daily digest summarizes what everyone shipped, decided, and discovered — tailored per role (engineering, product, design, strategy). Team members who use AI tools get session memory directly. Everyone else gets a Slack digest.

**For your AI tools:** An MCP server exposes your team's full decision history as tools. Claude, Cursor, or any MCP client can search decisions, browse by date, and retrieve context — no file reading or guessing.

<!-- TODO: demo GIF here — see #175 -->

---

## Quick Start

### Option A: Claude Code plugin

```
/plugin marketplace add usewayfind/wayfind
/plugin install wayfind@usewayfind
/wayfind:init-memory
```

### Option B: npm (works with any AI tool)

```bash
npm install -g wayfind
wayfind init
```

Your next AI session has memory. That's it.

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

### The Session Loop

1. **Start** — AI reads state files, summarizes context, asks "What's the goal?"
2. **Mid-session** — If work drifts from the goal, the AI flags it.
3. **End** — Decisions are extracted, written as journal entries, and synced to the team repo — automatically via hooks.

### Team Digests

Each role sees the same data through a different lens:

- **Engineering**: What shipped, what drifted, what patterns emerged
- **Product**: What shipped vs. planned, discovery signals
- **Strategy**: Cross-team patterns, drift trends, capability gaps

The digest posts to Slack. Anyone on the team — engineer, PM, CEO — who uses an AI tool gets session memory. Everyone else gets the digest.

### MCP Server

Wayfind includes an MCP server that exposes team context to any MCP-compatible AI tool. Auto-registered during `wayfind init`.

**Tools:**

| Tool | What it does |
|------|-------------|
| `search_context` | Search decisions by query, date range, author, or repo. Semantic or browse mode. |
| `get_entry` | Retrieve the full content of a specific entry. |
| `get_signals` | Recent GitHub, Intercom, and Notion activity. |
| `get_team_status` | Current team state: who's working on what, active projects, blockers. |
| `add_context` | Capture a decision or blocker from the current session. |
| `record_feedback` | Rate whether a result was useful (improves future retrieval). |

Each team member's MCP server searches their local content store — journals synced from the shared team repo, with local embeddings generated automatically. No infrastructure required.

---

## Signal Connectors

Pull external context into digests:

```bash
wayfind pull github       # Issues, PRs, Actions status
wayfind pull intercom     # Support conversations, tags, response times
wayfind pull notion       # Pages, databases, comments
wayfind pull --all        # All configured channels
```

---

## Team Setup

```
/wayfind:init-team
```

This walks you through creating a team, setting up profiles, creating a shared team-context repo, and configuring Slack digest delivery. Multi-team support built in — bind repos to different teams, each with isolated context.

---

## Tool Support

| Tool | How | Setup |
|------|-----|-------|
| **Claude Code** | Plugin (full support) | `/plugin marketplace add usewayfind/wayfind` |
| **Cursor** | MCP server | `wayfind init` auto-registers |
| **Any MCP client** | MCP server | `wayfind init` auto-registers |
| **Slack** | Bot + digests | `wayfind bot --configure` |

---

## What's Open Source

Everything that runs on your machine is open source (Apache 2.0).

| Open Source (this repo) | Commercial (future) |
|---|---|
| CLI, plugin, and all commands | Cloud-hosted team aggregation |
| Session protocol and journal extraction | Managed digest delivery |
| Content store, semantic search, MCP server | Web dashboard |
| Signal connectors (GitHub, Intercom, Notion) | SSO and tenant isolation |
| Digest generation (your API key) | |
| Slack bot (self-hosted) | |
| Multi-team support | |

---

## Architecture

- [Data Flow](docs/architecture/data-flow.md) — sessions to digests
- [Query Path](docs/architecture/query-path.md) — how queries reach the content store
- [Content Store](docs/architecture/content-store.md) — indexing, search, schema
- [Principles](docs/architecture/architecture-principles.md) — the eight constraints
- [Signal Channels](docs/architecture/architecture-signal-channels.md) — connector architecture

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first contributions:

- **Specializations** for AI tools (Windsurf, Aider, Continue)
- **Signal connectors** for new tools (Linear, Jira, Slack, HubSpot)
- Bug reports and feature requests via [issues](https://github.com/usewayfind/wayfind/issues)

---

## License

Apache 2.0. See [LICENSE](LICENSE).
