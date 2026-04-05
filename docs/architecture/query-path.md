# Query Path

How a query gets context from Wayfind — from session to store to response.

There are two query paths: **Slack bot** (`@wayfind` mention) and **MCP** (`search_context`, `get_entry` mid-session). Both use the same tool surface — `search_context` and `get_entry`. The bot is a thin LLM relay: it hands the user's question to Claude (Haiku) with the same tools MCP clients use, and Claude decides what to search.

---

## The Stores

Three distinct content stores exist. Each serves a different role:

| Store | Location | What it contains | Who reads it |
|-------|----------|-----------------|-------------|
| **Member local store** | `~/.claude/team-context/content-store/` (per member machine) | Raw journals + conversation extracts + distilled entries imported from `distilled.json` | MCP server, `wayfind digest`, CLI search |
| **Container store** | Docker volume, `TEAM_CONTEXT_STORE_PATH` inside container | Same raw content + full embeddings | Slack bot, container's `/api/search` + `/api/entry` HTTP endpoints |
| **Ephemeral GHA store** | `$GITHUB_WORKSPACE/.wayfind/store` | Rebuilt from scratch each nightly distillation run | `wayfind distill` only — discarded after export |

---

## Path A: Slack Bot Query

User types `@wayfind what's happening with billing?` in Slack.

```
User @-mentions bot in Slack
        ↓
Slack → Socket Mode → Bolt app (running inside Docker container)
        ↓
app_mention handler strips "@wayfind", extracts question
        ↓
LLM tool-use relay (Claude Haiku via ANTHROPIC_API_KEY)
  system prompt + user question + thread history (up to 5 prior turns)
  tools available: search_context, get_entry
        ↓
Claude decides what to search:
  calls search_context({ query, since, until, user, source, mode })
  calls get_entry({ id }) for promising results
  may call search_context multiple times with different params
        ↓
Claude synthesizes answer from retrieved entries
        ↓
Slack thread reply posted back to channel
```

The bot **only ever touches the container store** (via direct content-store calls, not HTTP). There is no fallback to member local stores.

---

## Path B: MCP Mid-Session Query

AI calls `mcp__wayfind__search_context({ query: "..." })` during a coding session.

### Step 1 — `search_context`

```
AI calls search_context({ query, limit, repo, since, until, user, source, mode })
        ↓
wayfind-mcp process (stdio transport) → handleSearchContext()
        ↓
  ┌─────────────────────────────────────────────┐
  │  Try container proxy first (if configured)  │
  │                                             │
  │  Reads container_endpoint from context.json │
  │  Reads Bearer token from .wayfind-api-key   │
  │  POST http://<container>/api/search         │
  │                                             │
  │  On 401: re-reads key from disk, retries 1x │
  │  (key rotates daily via container cron)     │
  └─────────────────────────────────────────────┘
        ↓  if container unreachable OR returns 0 results
  ┌──────────────────────────────────────────────┐
  │  Fall back to member local store             │
  │                                              │
  │  resolveStorePath() →                        │
  │    TEAM_CONTEXT_STORE_PATH env var           │
  │    or ~/.claude/team-context/content-store/  │
  │                                              │
  │  mode=semantic → contentStore.searchJournals │
  │  mode=browse   → list recent entries         │
  └──────────────────────────────────────────────┘
        ↓
Returns ranked stubs (id, title, date, score, repo, source)
No content yet — content fetched per-entry via get_entry
```

**Parameters:**
- `query` (string, optional): Natural language search query. Required for semantic mode, omit for browse.
- `limit` (number, optional): Max results. Default 10.
- `repo` (string, optional): Filter by repository name.
- `since` (string, optional): Filter to entries on or after this date (YYYY-MM-DD).
- `until` (string, optional): Filter to entries on or before this date (YYYY-MM-DD).
- `user` (string, optional): Filter by author name.
- `source` (string, optional): Filter by entry source type (`journal`, `conversation`, `signal`).
- `mode` (string, optional): `semantic` (default) or `browse`. Semantic uses embeddings. Browse lists recent entries without a search query.

### Step 2 — `get_entry`

```
AI calls get_entry({ id })
        ↓
handleGetEntry()
        ↓
  ┌──────────────────────────────────────────────┐
  │  Check member local store first              │
  │                                              │
  │  loadIndex(storePath) → index.entries[id]    │
  │  getEntryContent(id, { storePath, journalDir }) │
  └──────────────────────────────────────────────┘
        ↓  if not found locally
  ┌──────────────────────────────────────────────┐
  │  proxyGetEntry() → container GET /api/entry/:id │
  └──────────────────────────────────────────────┘
        ↓
Returns full entry content (markdown)
```

`get_entry` checks **local first, container second** — opposite priority from `search_context`.

---

## Priority Comparison

| | Bot | MCP `search_context` | MCP `get_entry` |
|--|--|--|--|
| **Tool surface** | Same as MCP (search_context, get_entry) | search_context, get_entry | get_entry |
| **Who decides what to search** | Claude (Haiku) via tool-use | The calling AI (Claude, Cursor, etc.) | N/A (content fetch) |
| **1st store** | Container (direct, no HTTP) | Container (proxy) | Member local |
| **2nd store** | — | Member local (fallback) | Container (fallback) |
| **Embeddings** | Always (container owns them) | Container if up; browse fallback if not | N/A (content fetch, no ranking) |
| **Requires container** | Yes | No (degrades to local) | No (degrades gracefully) |

---

## How Entries Get Into the Stores

```
Engineer AI session ends
        ↓
session-end hook: wayfind journal sync
  copies YYYY-MM-DD-{author}-{teamId}.md → team-context/journals/
        ↓
team-context repo (git)
        ├── Container: git pull (cron) → reindex → Container store
        ├── GHA nightly: index-journals → distill → distilled.json committed
        └── Members: context pull (git pull) → indexJournals + importDistilled → Member local store
```

See [data-flow.md](data-flow.md) for the full capture → distill → deliver pipeline.
