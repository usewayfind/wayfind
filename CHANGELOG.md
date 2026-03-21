# Changelog

All notable changes to Wayfind are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
