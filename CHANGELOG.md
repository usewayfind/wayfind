# Changelog

All notable changes to Wayfind are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [2.0.71] - 2026-04-06

### Improved
- **Cleaner post-install output.** Removed the scary "Edit global-state.md" warning that confused new users. Replaced 6-step "Next steps" list with a focused one-liner pointing to `/init-memory`. Removed unprompted personas dump. Added docs URL. First-time users now see a clear path to value instead of a wall of optional config.

## [2.0.70] - 2026-04-05

### Changed
- **Bot query engine replaced with LLM tool-use relay.** The Slack bot no longer parses intent with hand-rolled temporal/author/signal detection (~600 lines removed). Instead, it sends the user's question to Claude (Haiku) with `search_context` and `get_entry` as tools — Claude decides how to search, what date ranges to use, and which authors to filter. Same @wayfind UX, dramatically smarter answers, fraction of the code.
- **`search_context` consolidated.** New parameters: `until` (date upper bound), `user` (author filter), `source` (journal/conversation/signal filter), `mode=browse` (date-sorted metadata listing). The `list_recent` tool has been merged into `search_context` with `mode=browse`.
- **Container search API** (`POST /api/search`) now accepts `until`, `user`, `source`, and `mode=browse`. Query is optional when using browse mode.

### Removed
- **`list_recent` MCP tool** — use `search_context` with `mode=browse` instead.
- **Text search** (`mode=text`, `searchText()`) removed entirely. When semantic search is unavailable (no embeddings), the system falls back to date-sorted browse with a friendly hint to run `wayfind reindex`.
- **Bot direct commands** (`help`, `version`, `members`, `insights`, `signals`, `digest scores`) — removed. The bot now focuses on answering questions via tool-use. Use the CLI for diagnostics.

## [2.0.69] - 2026-04-04

### Fixed
- Author filter (`user` option in `applyFilters`) now strictly requires a matching `user` field. Previously, entries with no author set would pass through a user filter, causing the bot to include other team members' unattributed entries when querying a specific person.

## [2.0.68] - 2026-04-04

### Fixed
- Slack bot now filters search results by author when a query asks about a specific person (e.g. "what did Nick do this week"). Previously, semantic search returned the most relevant entries regardless of author, so person-directed queries returned the dominant author's work instead of the requested person's. Bot detects the target person from the query, resolves them against the members directory, and scopes the search to their entries.

## [2.0.67] - 2026-04-04

### Fixed
- `TEAM_CONTEXT_INCLUDE_REPOS` allowlist no longer filters out journal entries with unqualified repo names (e.g., `NotificationService` instead of `acme-org/NotificationService`). Team member journals written without an org prefix now pass through — only `org/repo` qualified names are checked against the allowlist.

## [2.0.66] - 2026-04-04

### Fixed
- `wayfind pull` now indexes journals from both `journals/` and `memory/journal/` in the team-context repo. Setups that use the backup hook with the team-context repo as the backup destination land journals in `memory/journal/` — they were previously invisible to the content store.

## [2.0.65] - 2026-04-04

### Changed
- `search_context` tool description is now explicit that it covers the full team decision history across all repos — not just local files. Makes Claude prefer it over file reads for questions about past work.
- Session protocol (CLAUDE.md) now explicitly tells Claude to use `search_context` for decision history queries instead of reading state files. State files are for current status; the content store is for decision history.

## [2.0.64] - 2026-04-04

### Fixed
- MCP registration now writes the absolute path to `wayfind-mcp` instead of the bare command name. Claude Code spawns MCP servers with a minimal environment where npm global bin directories are not in PATH, causing silent startup failures. The setup script resolves the binary path via `command -v` with an `npm config get prefix` fallback.

## [2.0.63] - 2026-04-04

### Added
- **MCP server auto-registers on install** — `wayfind init` (Claude Code) now writes `wayfind-mcp` into `~/.claude/settings.json` under `mcpServers`. `wayfind init-cursor` writes to `~/.cursor/mcp.json`. Idempotent — skips if already present. Any MCP-compatible AI tool gets access to the full team context store without manual config.

### Fixed
- CONTRIBUTING.md referred to "Meridian" throughout (wrong product name, wrong GitHub URLs). Fixed to Wayfind.
- README env vars table described `OPENAI_API_KEY` as required for semantic search. Xenova local embeddings are now the default — OpenAI is an optional upgrade.

## [2.0.62] - 2026-04-04

### Fixed
- **SQLite backend now persists `embedding_model`** — `saveIndex()` writes the active embedding model name to the `metadata` table; `loadIndex()` reads it back. Previously the field was always dropped, leaving mismatch detection permanently blind and preventing automatic re-embedding when the provider changes.
- **Embedding generation is now concurrent** — `indexJournals`, `indexConversations`, and `indexSignals` no longer call `generateEmbedding()` serially. A new `batchEmbed()` helper fans out embedding calls in chunks of 20 via `Promise.all`. For a store with 35k entries, initial index time drops from ~30 minutes to ~2 minutes on the Xenova local provider.

## [2.0.61] - 2026-04-04

### Fixed
- Container indexing (journals, conversations, signals) now generates Xenova embeddings when no cloud embedding key is configured. Previously `indexJournalsIfAvailable`, `indexConversationsIfAvailable`, and `indexSignalsIfAvailable` only enabled embeddings when `OPENAI_API_KEY` or `AZURE_OPENAI_EMBEDDING_ENDPOINT` was set — they didn't check `getEmbeddingProviderInfo().available`, so Xenova was silently bypassed on every container reindex cycle.

## [2.0.60] - 2026-04-04

### Changed
- **Semantic search works out of the box** — `@xenova/transformers` is now a first-class dependency (was optional). Every `npm install -g wayfind` gets local embedding support. No API key required.
- **Docker image pre-bakes the Xenova model** at build time (`Xenova/all-MiniLM-L6-v2`, ~80MB). Container cold starts no longer trigger a network download. Set `WAYFIND_MODEL_CACHE=/app/.xenova-cache` in your container env to use the baked cache.

### Fixed
- Local embedding model (Xenova) was silently broken in Docker and any non-TTY context. The `allowLocalModels = false` flag was set whenever stdout wasn't a TTY, which forced a re-download on every process start rather than using the disk cache. Replaced with explicit `cacheDir` configuration via `WAYFIND_MODEL_CACHE` env var.

### Upgrade path
- Azure OpenAI and OpenAI embedding keys still take priority when configured — they're faster and produce higher-dimensional vectors. Xenova is now the zero-config baseline for teams that don't want embedding API costs.
- If you were relying on `@xenova/transformers` as an optional install, nothing changes. If you weren't installing it before, semantic search now works automatically after upgrading.

## [2.0.59] - 2026-04-02

### Changed
- GHA workflow: removed journal push trigger — raw journal content is already distributed via git + `wayfind context pull`; the GHA pipeline only needs to produce distilled/merged entries, which runs nightly (2am UTC) and on manual dispatch. This eliminates the livelock where long distillation runs were continuously cancelled by concurrent journal pushes.
- GHA workflow: `cancel-in-progress: false` — distillation runs queue rather than cancel, since each run is expensive and produces authoritative output.

## [2.0.58] - 2026-04-02

### Fixed
- `wayfind distill` now falls back to `ANTHROPIC_API_KEY` env var for LLM config when no connectors config exists (e.g. in GitHub Actions) — previously distillation ran but silently skipped all merging, producing zero distilled entries
- GHA workflow: daily tier only on journal pushes; weekly+archive on weekly schedule — prevents processing tens of thousands of entries on every push

## [2.0.57] - 2026-04-02

### Fixed
- `wayfind distill` now correctly resolves the store path via `resolveStorePath()` — previously it fell back to `DEFAULT_STORE_PATH`, which caused it to read from an empty store when `TEAM_CONTEXT_STORE_PATH` was set (as in the GHA pipeline), producing zero eligible entries despite 30k+ indexed journals
- GHA workflow template: added `concurrency` group with `cancel-in-progress: true` to prevent race conditions when multiple team members push journals simultaneously — concurrent runs are cancelled in favor of the latest, which always has the full journal set

## [2.0.56] - 2026-04-02

### Fixed
- `wayfind distill --tier all` (and `archive`) no longer crashes with "Invalid time value" — `Infinity` date arithmetic was producing an invalid Date object when computing the `since` bound for the archive tier

## [2.0.55] - 2026-04-02

### Added
- **GHA distillation pipeline** — teams can now run distillation entirely via GitHub Actions, with no container required. Add `templates/gha-distill.yml` to your team-context repo and set `ANTHROPIC_API_KEY` as a repo secret. The workflow indexes journals, runs distillation, and commits `.wayfind/distilled.json` back to the repo on every journal push.
- `wayfind distill export [--output <path>]` — dumps all LLM-merged distilled entries to JSON (stdout or file). Used by the GHA pipeline; also useful for debugging what distillation produced.
- `wayfind distill import <path>` — idempotently imports distilled entries from a JSON file into the local content store. Skips entries already present by content hash.
- `wayfind context pull` now auto-imports `.wayfind/distilled.json` from the team repo after each pull — team members get distilled context without any extra steps.

### Fixed
- Distilled entry content (LLM-merged summaries) is now persisted to `{store}/distilled/{id}.md` — previously, merged content was generated but never written to disk, making it unretrievable by search and the bot.

## [2.0.54] - 2026-04-01

### Fixed
- `wayfind update` container restart now uses `docker compose up --force-recreate` — previously, if the old container hadn't been fully removed, the restart would fail with a "container name already in use" conflict error

## [2.0.53] - 2026-04-01

### Fixed
- Container scheduler `git pull` no longer uses `--autostash` — the flag requires a configured git committer identity, which the container doesn't have, producing a "Committer identity unknown" warning on every reindex cycle. Reverted to `--rebase` only, which is sufficient since the container never makes local edits (#171)

## [2.0.52] - 2026-04-01

### Fixed
- Container scheduler `git pull` now uses `--rebase --autostash` instead of `--ff-only` — diverged branches no longer produce warnings on every reindex cycle (#171)

## [2.0.51] - 2026-04-01

### Fixed
- Embedding model switch now triggers automatic re-embedding — when `indexJournals`, `indexConversations`, or `indexSignals` detects that the stored model differs from the current provider, all entries are re-embedded with the new model before saving (#170). Previously, a model switch would silently leave old-model vectors in the store and generate query embeddings with the new model, producing garbage similarity scores with no warning.

## [2.0.50] - 2026-04-01

### Added
- **Local embedding model**: `@xenova/transformers` (`all-MiniLM-L6-v2`) is now the default embedding provider — no API key required for semantic search (#170). First use downloads the model (~80MB, cached after). Provider auto-detection order: Azure OpenAI → OpenAI → local model → full-text fallback.
- **Team journals indexed on `context pull`**: `wayfind context pull` now automatically indexes new team-context repo journals into the local content store after a successful git pull. Team-wide semantic search works via local stdio MCP server with no container required.
- **Embedding model tracking**: the content store records which model generated embeddings (`embedding_model` field in the index). `wayfind doctor` warns when the current provider doesn't match stored embeddings. `wayfind reindex --force` shows a clear mismatch warning explaining what will be cleared and regenerated.
- **Provider selection in `init-memory` and `init-team`**: first-time setup prompts for embedding provider choice with explicit tradeoff explanation (local vs OpenAI vs Azure) and switching cost warning.
- **`wayfind doctor` embedding provider check**: reports active provider and model; warns when no provider is configured or when model mismatch is detected.

## [2.0.49] - 2026-04-01

### Fixed
- Session-end hook now runs `journal split` before `journal sync` — new team members' existing journals are retroactively tagged and synced on first session end, no manual backfill needed (#163)
- `wayfind digest` falls back to local default paths when `connectors.json` contains container-internal paths (e.g., `/home/node/...`), so `--preview` works correctly on the host (#162)
- `wayfind digest --preview` no longer hangs on large content stores — intelligence scoring is skipped when content exceeds a safe threshold, letting the token budget step handle selection instead (#161)
- Journal indexing on container startup now generates embeddings when `AZURE_OPENAI_EMBEDDING_ENDPOINT` is set, matching the behavior of conversation and signal indexing (#166)
- `wayfind journal sync` updates the member version stamp even when there are no journal files to sync, keeping team health signals current (#165)
- `plugin.json` version now stays in sync with `package.json` — `sync-public` updates it automatically going forward (#164)

## [2.0.48] - 2026-03-31

### Added
- **`wayfind team join <repo-url>`**: full onboarding flow — clones the team-context repo, reads `team_id`/`team_name`/`container_endpoint` from `wayfind.json`, registers the team in `context.json`, reports search API and key status. Works with both HTTPS URLs and local paths (#51)
- `wayfind context add` now writes `team_id` and `team_name` back to `wayfind.json` and generates the first API key (commits and pushes). Team repos are self-describing for new joiners from day one.
- `wayfind deploy init` compose template now includes the compose project `name:` field to prevent container name collisions when multiple teams deploy to the same machine.

### Fixed
- `wayfind deploy set-endpoint` usage string corrected in `team join` output (was `<team-id> <url>`, now `<url> --team <id>`)
- `TEAM_CONTEXT_TEAM_CONTEXT_DIR` env var now correctly set in team container docker-compose.yml (was `TEAM_CONTEXT_DIR` — old name causing 401s on all container search requests)

## [2.0.47] - 2026-03-31

### Fixed
- Removed all hardcoded developer paths (`~/repos/greg/wayfind/`) from 7 shipped files — paths now resolved dynamically via the wayfind CLI or `npm root -g` (#159). Affects: `journal.md`, `standup.md`, `check-global-state.sh`, `memory-report.sh`, `session-end.sh`, `session-start.sh`, `doctor.sh`

## [2.0.46] - 2026-03-30

### Added
- Full documentation refresh across 10 files: `pilot-guide.md`, `dogfood-setup.md`, `FAQ.md`, `README.md`, `BOOTSTRAP_PROMPT.md`, and supporting docs updated to reflect container search API, MCP proxy, and multi-team deploy flow
- Container search API simulation: `container-search-api.sh` (10 assertions, 4 phases covering API auth, key rotation, MCP proxy fallback, and endpoint configuration)

## [2.0.45] - 2026-03-30

### Added
- **Container search API**: the Docker container now exposes `POST /api/search` and `GET /api/entry/:id` on the same port as `/healthz` (default 3141). Authenticated via bearer token from `.wayfind-api-key` in the team-context repo.
- **API key auto-rotation**: container generates a 256-bit key on startup, rotates daily (configurable via `TEAM_CONTEXT_KEY_ROTATE_SCHEDULE`), and commits the new key to the team-context repo so team members get it on their next `git pull`.
- **MCP container proxy**: the local MCP server (`wayfind-mcp`) now proxies semantic search to the team's container when `container_endpoint` is configured in `context.json`. On 401 (rotated key), it re-reads the key from the team-context repo and retries automatically. Falls back to local search if the container is unreachable.
- **`wayfind deploy set-endpoint <url>`**: new CLI subcommand to set the container endpoint URL for team members (e.g., a Tailscale hostname).
- **`wayfind deploy --team <id>`** now writes `container_endpoint` to `context.json` automatically.
- Deploy scaffolding resolves deploy directory from the team's registered repo path in `context.json` (no longer hardcoded to `~/.claude/team-context/`).
- `.env` scaffold slimmed to 3 required keys (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `TEAM_CONTEXT_TENANT_ID`). Full `.env.example` stays as reference.
- Auto port detection: scans running wayfind containers, picks next available port from 3141.
- No-Slack mode: set `TEAM_CONTEXT_NO_SLACK=1` to run the container without Slack integration.

## [2.0.44] - 2026-03-29

### Added
- **Per-team store scoping**: `repoAllowlist` option in `indexJournals()` filters entries at index time so each team's store only contains its own repos.
- **`wayfind store trim <team-id>`**: retroactive cleanup of cross-team contamination via `trimStore(storePath, allowedPatterns)`.
- **`context bind` maintains `bound_repos`** in `context.json` automatically (idempotent). Used by `indexJournals` for write-time scoping.
- 3 new simulation scenarios: store-scope-indexing, store-scope-trim, store-scope-isolation.

## [2.0.43] - 2026-03-28

### Fixed
- `wayfind doctor` storage backend section now uses `resolveStorePath()` (team-aware) instead of the legacy global store path. Previously the backend and embedding checks always inspected `~/.claude/team-context/content-store` regardless of which team was active.
- Doctor now displays the active team ID and resolved store path under "Storage backend", making per-team store isolation verifiable at a glance.

## [2.0.42] - 2026-03-28

### Fixed
- `setup.sh` no longer manages the Claude Code status line — that responsibility belongs to the user's config.

## [2.0.41] - 2026-03-28

### Fixed
- `wayfind doctor` no longer exits 1 when `better-sqlite3` is unavailable — JSON backend fallback is an optional nudge, not a hard error. Doctor now exits 0 on clean installs without native SQLite support (CI, minimal environments).

## [2.0.40] - 2026-03-28

### Added
- **Per-team content store isolation** (#149): each team now gets its own content store at `~/.claude/team-context/teams/<teamId>/`. Single-team users are migrated automatically on first access — no manual action required.
- **`resolveStorePath()` / `resolveSignalsDir()`**: new exported functions that resolve the correct store and signals paths for the active team. Team is determined from `.claude/wayfind.json` in the repo or `context.json` default. Any explicit `storePath` option passed by callers still takes priority.
- **MCP server** (`wayfind-mcp`): stdio MCP server that exposes 8 tools — `search_context`, `get_entry`, `list_recent`, `get_signals`, `get_team_status`, `get_personas`, `record_feedback`, `add_context`. Any MCP-compatible AI tool (Claude Code, Cursor, etc.) can query your team's knowledge base directly.
- **`wayfind deploy --team <teamId>`**: scaffold a per-team container config at `~/.claude/team-context/teams/<teamId>/deploy/` with per-team container name (`wayfind-<teamId>`), `com.wayfind.team` Docker label, and correct volume mounts.
- **`wayfind deploy list`**: list all running Wayfind team containers discovered via `com.wayfind.team` Docker label.
- **Multi-container `wayfind update`**: discovers and updates all `com.wayfind.team`-labeled containers automatically.

## [2.0.39] - 2026-03-28

### Added
- Container doctor: `wayfind doctor --container` (auto-detected in Docker) checks backend type, entry count, embedding coverage, signal freshness, and health endpoint status
- Post-deploy smoke check: `wayfind update` now tails container logs after restart and flags any warnings
- Schema migration test: 23 assertions verifying pre-v2.0.29 databases upgrade cleanly

## [2.0.38] - 2026-03-28

### Fixed
- SQLite schema migration order: databases created before v2.0.29 failed to initialize because `CREATE INDEX` on new columns ran before `ALTER TABLE` added them. Migration now runs column additions first, then schema (including indexes). Fixes "no such column: quality_score" error that forced JSON fallback in containers.

## [2.0.37] - 2026-03-28

### Added
- Signal chunking: long signal files are split by `##` headings into section-level entries, each with its own embedding (#156). This makes semantic search match specific sections (e.g., a CI failure in one repo, a customer deep-dive) instead of averaging entire documents. Chunks carry `source: 'signal-chunk'`, `parentId`, and `chunkIndex` for reassembly.

## [2.0.36] - 2026-03-28

### Added
- Notion connector: page-level content extraction — targeted pages have their full body text (headings, paragraphs, lists, callouts, to-dos) included in signals, not just metadata (#155)
- Notion connector: `pages` config field for targeting specific page IDs for content extraction
- `TEAM_CONTEXT_NOTION_PAGES` env var for container configuration
- `wayfind pull notion --configure` now prompts for page IDs alongside database IDs

## [2.0.35] - 2026-03-28

### Fixed
- Container config paths: `ensureContainerConfig()` now always overrides digest/bot paths with container-appropriate values, even when the mounted `connectors.json` has host paths (#153)

### Added
- `wayfind doctor` now checks embedding coverage — warns loudly when entries lack embeddings, differentiates between "no API key" and "key set but no embeddings generated"

## [2.0.34] - 2026-03-28

### Fixed
- Text search now reads signal file content — previously only searched metadata (title, tags) for signal entries, missing actual GitHub/Intercom/Notion content (#153)

## [2.0.33] - 2026-03-28

### Fixed
- Container signal pull broken — `ensureContainerConfig()` now overrides `gh-cli` transport to `https` when `GITHUB_TOKEN` is present, and backfills repos from `TEAM_CONTEXT_GITHUB_REPOS` env var (#153)
- SQLite backend silently falling back to JSON — bare `catch {}` replaced with warning to stderr so operators know when SQLite initialization fails (#154)

### Added
- `wayfind doctor` now checks storage backend type, detects unexpected JSON fallback, and warns when signal pulls are stale (>24h)
- Storage backend `getBackendInfo()` API for programmatic backend introspection
- Memory model architecture doc (`docs/architecture/memory-model.md`) — four-type taxonomy mapped to Wayfind implementation
- MCP server design doc (`docs/design/mcp-server-design.md`) — read-only context tools with feedback channel
- Architecture Principle #9 updated: MCP as optional read path over plain files
- Architecture Principle #10 added: feedback loop across all access layers
- 7 new storage backend simulation tests (auto-detect, fallback warning, signal consistency)

## [2.0.32] - 2026-03-27

### Added
- `wayfind context pull` — fetches latest team-context repo so engineers see each other's recent decisions without waiting for the daily digest
- Session-start hook runs `context pull` in the background automatically — zero impact on startup time
- Doctor warns if team-context hasn't been pulled in >24 hours (surfaces persistent auth/network issues)
- Clean-machine onboarding simulation test (22 assertions covering install-to-first-use flow)

### Fixed
- `sync-public` falsely reported "already up to date" when files had changed (#124) — replaced stale git index check with content-level diff
- Digest generation produced "no activity" despite having thousands of indexed entries (#148 unrelated, shipped in 2.0.31)

## [2.0.31] - 2026-03-27

### Fixed
- Digest generation produced "no activity" despite having thousands of indexed entries — `ensureContainerConfig()` didn't backfill `journal_dir`/`store_path` into configs created before those fields existed, causing content retrieval to look in a nonexistent container path
- `collectFromStore()` now falls back to direct file scan when content retrieval fails (not just when metadata is empty)
- Slack bot config also backfills missing `store_path`/`journal_dir` for the same reason

## [2.0.30] - 2026-03-24

### Added
- `init-folder` command: initialize Wayfind for non-repo folders (~/admin, ~/, scratch workspaces) so context persists across sessions even outside git repos (#138)
- `init-team` now prompts to set up non-repo admin folders during onboarding

## [2.0.29] - 2026-03-22

### Added
- Content distillation pipeline: tiered compaction (daily/weekly/archive) deduplicates and merges journal entries via Haiku LLM (#130)
- `wayfind distill` command with `--tier`, `--dry-run` flags for manual distillation
- `wayfind digest --preview` prints digest to stdout with input stats for iterative review
- `wayfind reindex --force` clears content store for full reindex (quality score backfill)
- Quality-weighted token budget: rich decisions survive truncation, thin auto-extracts dropped first
- Quality scoring (0-3) computed at index time based on reasoning, alternatives, and content substance

### Fixed
- GitHub signal summaries now include PR titles, issue titles, and failed CI details — not just counts
- Signal files indexed into content store with per-repo granularity (was: 0 signal entries, now: per-repo indexing)
- Signals auto-indexed after every `wayfind pull` (was: only during hourly container cron)
- Bot search results deduplicated: distilled entries preferred over redundant raw entries

## [2.0.28] - 2026-03-21

### Fixed
- `wayfind version` reported stale version after `wayfind update` — now reads from package.json instead of cached file
- `wayfind update` passed old version to setup.sh because the running process still had the pre-update code in memory — now resolves the freshly installed package path

## [2.0.27] - 2026-03-21

### Fixed
- `WAYFIND_DIR` env var override for container deployments where `HOME` differs from host
- Docker Compose: mount `connectors.json` into container so all configured signal sources (GitHub, Intercom, Notion) are available to the scheduler

### Changed
- Strategy digest template rewritten for non-technical audience (CEO/business leader) — no jargon, no issue numbers, no repo names

## [2.0.26] - 2026-03-21

### Added
- Digest @mentions: threaded reply tags team members by persona relevance when items match their role

## [2.0.23] - 2026-03-18

### Added
- Persona intelligence layer: single Haiku LLM call scores all signals per persona, filters noise before digest generation
- Per-persona threshold configuration (engineering=1, product=2, design=2, strategy=1)
- Translation rules in persona templates

## [2.0.15] - 2026-03-17

### Added
- Claude Code plugin: 7 skills (`wayfind:` namespace), SessionStart + Stop hooks, marketplace.json
- `wayfind migrate-to-plugin` command for clean migration from npm-only setup
- `wayfind update` command: re-syncs hooks/commands from package, detects and updates running containers
- `wayfind doctor`: stale hook detection with "run wayfind update" guidance

## [2.0.0] - 2026-03-15

### Changed
- **BREAKING**: Rebranded from Meridian to Wayfind
- npm package: `meridian-dev` → `wayfind`
- CLI command: `meridian` → `wayfind`
- Env vars: `MERIDIAN_*` → `TEAM_CONTEXT_*` (product-agnostic)
- Config dir: `~/.claude/meridian/` → `~/.claude/team-context/`
- Per-repo config: `.claude/meridian.json` → `.claude/wayfind.json`
- CLI entry: `bin/meridian.js` → `bin/team-context.js` (product-agnostic)

### Added
- Backward compatibility shim: old `MERIDIAN_*` env vars and `~/.claude/meridian/` directory still work with deprecation warnings (will be removed in v3.0)

## [1.8.32] - 2026-03-13

### Added
- Per-member version tracking with team `min_version` enforcement

### Fixed
- Context shift detection false positives

## [1.8.31] - 2026-03-13

### Fixed
- Hook format corrected to match Claude Code settings schema (`{matcher, hooks}` groups)
- Doctor validation for hook structure

## [1.8.30] - 2026-03-12

### Changed
- Hook merge logic improvements in setup

## [1.8.27] - 2026-03-10

### Added
- Per-team journal routing for multi-team support
- `wayfind journal split` command for migrating existing journals to multi-team format

## [1.8.25] - 2026-03-08

### Added
- Multi-team support: `wayfind context add`, `wayfind context bind`, `wayfind context list`
- Register multiple teams and route journals/context to the correct team repo

## [1.8.24] - 2026-03-07

### Added
- Automatic context shift detection at session end
- LLM-based classification of significant decisions

## [1.8.22] - 2026-03-05

### Fixed
- Natural language date parsing in Slack bot ("March 3", "between March 3 and March 6", "last week")

## [1.8.21] - 2026-03-04

### Added
- `TEAM_CONTEXT_SKIP_EXPORT=1` env var to suppress journal export in worker agents

## [1.8.20] - 2026-03-03

### Fixed
- Journal dedup: each decision individually deduped (was only checking first entry)

### Changed
- Removed `package-lock.json` from tracking

## [1.8.0] - 2026-02-24

### Added
- Content store with full-text and semantic search
- Signal connectors: GitHub (issues, PRs, Actions), Intercom (conversations, tags), Notion (pages, databases)
- Conversation transcript indexing with LLM extraction
- Slack bot for decision trail queries (Socket Mode)
- Digest generation with persona-targeted views
- Docker deployment (`wayfind deploy init`)
- `wayfind insights` for aggregate metrics
