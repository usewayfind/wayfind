# Content Store

Searchable index of session journal insights. Index locally, search by text or semantic similarity, filter by metadata, extract trends.

## Quick start

```bash
# Index your journals (auto-detects journal directory)
wayfind index-journals

# Semantic search (uses local Xenova embeddings by default, or OPENAI_API_KEY)
wayfind search-journals "how did we handle auth?"

# Browse by date (no embeddings needed)
wayfind search-journals --since 2026-04-01 --until 2026-04-05

# View insights
wayfind insights
wayfind insights --json
```

## Storage backends

The content store uses a **storage abstraction** with two backends. The backend is auto-detected on first use — no configuration needed.

### SQLite (primary)

When `better-sqlite3` is available (installed as an optional dependency), the content store uses a single SQLite database at `~/.claude/team-context/content-store/content-store.db`.

- **WAL mode** — concurrent reads don't block
- **Indexed queries** — date, repo, source, and user columns are indexed
- **Transactions** — bulk operations are atomic
- **File permissions** — `0600` (owner-only read/write)

Tables: `decisions` (journal + conversation + signal entries), `embeddings` (vector storage), `conversation_index` (transcript tracking), `digest_feedback` (reactions and comments), `metadata` (schema version).

### JSON files (fallback)

When `better-sqlite3` is not available (native compilation failed, minimal install), the store falls back to JSON files:

- `index.json` — entry metadata
- `embeddings.json` — embedding vectors
- `conversation-index.json` — processed transcript tracking
- `digest-feedback.json` — delivery records and reactions

All files use atomic writes (`.tmp` rename) and `0600` permissions.

### Configuration

| Environment variable | Values | Default |
|---------------------|--------|---------|
| `TEAM_CONTEXT_STORAGE_BACKEND` | `sqlite`, `json` | Auto-detect |

### Migration

On first run with SQLite available, existing JSON files are automatically migrated into the database. Migration is idempotent and preserves the original JSON files as backups. Use `TEAM_CONTEXT_STORAGE_BACKEND=json` to switch back at any time.

`wayfind doctor` reports which backend is active.

## How it works

### Indexing

`wayfind index-journals` parses your session journals (`~/.claude/memory/journal/*.md`) and builds a local index at `~/.claude/team-context/content-store/`.

The index is **incremental** — it hashes each entry's content and only re-processes entries that changed. Running it twice on the same journals produces zero new/updated entries.

### Searching

**Semantic search** (default):
- Generates a query embedding, computes cosine similarity against all entries
- Uses local Xenova `all-MiniLM-L6-v2` model by default (no API key needed)
- Optionally uses `OPENAI_API_KEY` for OpenAI embeddings (text-embedding-3-small)
- Falls back to date-sorted browse if no embeddings are available, with a hint to run `wayfind reindex`

**Browse mode** (date-sorted, no query needed):
- Lists entries sorted by date descending
- No embeddings required — works on day zero
- Use with `--since`/`--until` for time-range queries

Both modes support filters: `--repo`, `--since`, `--until`, `--drifted`.

### Metadata queries

`wayfind insights` computes aggregate metrics from the index:
- **Total sessions** — how many journal entries are indexed
- **Drift rate** — percentage of sessions that drifted from stated goal
- **Repo activity** — session count per repo/project
- **Tag frequency** — most common tags across all entries
- **Timeline** — sessions per date

## CLI reference

```
wayfind index-journals [--dir <path>] [--store <path>] [--no-embeddings]
wayfind reindex [--journals-only] [--conversations-only] [--export]
wayfind index-conversations [--dir <path>] [--store <path>] [--since YYYY-MM-DD]
wayfind search-journals <query> [--limit N] [--repo <name>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--drifted]
wayfind insights [--json] [--store <path>]
```

### index-journals

| Flag | Description |
|------|-------------|
| `--dir <path>` | Journal directory (default: `~/.claude/memory/journal`) |
| `--store <path>` | Store directory (default: `~/.claude/team-context/content-store`) |
| `--no-embeddings` | Skip embedding generation even if OPENAI_API_KEY is set |

### search-journals

| Flag | Description |
|------|-------------|
| `--limit N` | Max results (default: 10) |
| `--repo <name>` | Filter by repo/project name |
| `--since YYYY-MM-DD` | Only entries on or after this date |
| `--until YYYY-MM-DD` | Only entries on or before this date |
| `--drifted` | Only entries where drift was detected |

### insights

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON instead of formatted text |
| `--store <path>` | Store directory (default: `~/.claude/team-context/content-store`) |

## Conversation indexing

`indexConversations()` scans Claude Code transcript files (`.jsonl` in `~/.claude/projects/`) and extracts decision points via LLM. Each extracted decision becomes a content store entry with `source: 'conversation'`. The LLM model is controlled by `TEAM_CONTEXT_EXTRACTION_MODEL` (defaults to `claude-sonnet-4-5-20250929`).

Transcript tracking (which files have been processed and their content hashes) ensures re-runs skip unchanged files. The `indexConversationsWithExport()` variant additionally exports extracted decisions as journal entries for git sync — this is what runs at session end via the Stop hook.

## Signal indexing

`indexSignals()` indexes markdown files from `~/.claude/team-context/signals/` (or `TEAM_CONTEXT_SIGNALS_DIR`). Signals are organized by channel subdirectory (e.g., `github/`, `intercom/`). Each signal file becomes a content store entry with `source: 'signal'`, tagged with the channel name and section headings.

Signal data is pulled from GitHub (`TEAM_CONTEXT_GITHUB_REPOS`) and Intercom (`INTERCOM_TOKEN` + optional `TEAM_CONTEXT_INTERCOM_TAGS`) by the transport connectors, then indexed into the store.

## Digest feedback

The content store tracks digest delivery and team reactions:

- `recordDigestDelivery()` — stores channel + message timestamp after posting a digest via bot token
- `recordDigestReaction()` — records emoji reactions on digest messages (+1/-1 delta)
- `recordDigestFeedbackText()` — captures threaded text replies on digest messages
- `getDigestFeedback()` — retrieves feedback summaries, filterable by date and limit

### Feedback-driven learning

Feedback is injected into the digest prompt via `buildFeedbackContext()`. When generating a new digest, the system loads the last 14 days of feedback and builds a compact "Digest Preferences" section that tells the LLM what the team liked and disliked:

- **Positive reactions** (rocket, fire, +1, tada, etc.) → "do more of this"
- **Negative reactions** (thinking_face, -1, confused, etc.) → "reconsider emphasis"
- **Text replies** → quoted verbatim as direct team feedback

The section is capped at 500 characters and only injected when feedback exists — no prompt bloat on day zero. This creates a closed loop: team reacts → next digest adapts.

## Onboarding pack generation

`generateOnboardingPack(repoQuery)` synthesizes a context pack for new team members. It searches the content store for entries matching the repo query from the last 90 days, fetches full content for the top 30 entries, and sends them to the LLM (`TEAM_CONTEXT_LLM_MODEL`) for synthesis into an onboarding summary. Accessible via the bot's `onboard <repo>` command.

## Repo exclusion

`TEAM_CONTEXT_EXCLUDE_REPOS` (comma-separated, case-insensitive) filters repos from indexing, digests, and bot queries. Supports both `repo` and `org/repo` formats. Useful when engineers work on repos belonging to different teams.

## Multi-source entry types

Entries have a `source` field indicating their origin:
- **journal** — parsed from session journal markdown files (default, no explicit source field)
- **conversation** — extracted from Claude Code transcripts via LLM
- **signal** — indexed from GitHub/Intercom signal files

Entries also carry an `author` field parsed from journal file naming (`YYYY-MM-DD-<author>.md`) or set to empty for non-journal sources.

## Embedding support

Embeddings work with both OpenAI (`OPENAI_API_KEY`) and Azure OpenAI (`AZURE_OPENAI_EMBEDDING_ENDPOINT` + `AZURE_OPENAI_EMBEDDING_KEY` + `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`). Provider is auto-detected from env vars. Re-indexing backfills embeddings for entries that were previously indexed without them.

Embeddings are stored as binary Float64Array buffers (SQLite) or JSON arrays (JSON fallback). Cosine similarity is computed in application code. Native vector search (e.g., `sqlite-vec`) is planned for a future release when entry counts warrant it.

## Entry schema

Each entry in the content store has these fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | 12-char hex hash of `date:repo:title` |
| `date` | string | `YYYY-MM-DD` |
| `repo` | string | Repository or project name |
| `title` | string | Entry title |
| `source` | string | `journal`, `conversation`, or `signal` |
| `user` | string | Author slug (from filename or content) |
| `drifted` | boolean | Whether drift was detected |
| `contentHash` | string | 16-char hex SHA-256 of entry content |
| `contentLength` | number | Character count of full entry text |
| `tags` | string[] | Auto-extracted keyword tags |
| `hasEmbedding` | boolean | Whether an embedding vector exists |
| `hasReasoning` | boolean | Decision includes rationale (conversations only) |
| `hasAlternatives` | boolean | Decision mentions rejected alternatives (conversations only) |

## What hosted adds

The local content store is fully functional for individual use. A hosted version adds team-scale capabilities:

- **Team aggregation** — search across your entire team's journals, not just yours. See cross-team patterns, shared lessons, recurring blockers.
- **Hosted embeddings** — semantic search without managing your own API key. Processing billed via usage credits.
- **Automated indexing** — journals indexed continuously without running CLI. Webhook-triggered on session end.
- **Web dashboard** — visual drift trends, repo activity charts, tag clouds, timeline views. Replaces CLI text output with interactive exploration.

See [architecture-principles.md](architecture-principles.md) for the architectural approach.
