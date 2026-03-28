# Changelog

All notable changes to Wayfind are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
