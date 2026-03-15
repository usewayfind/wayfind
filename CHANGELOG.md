# Changelog

All notable changes to Wayfind are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
