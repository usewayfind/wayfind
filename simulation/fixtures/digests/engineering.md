# Engineering Digest

**Period:** 2026-02-24 to 2026-02-28

## Technical Debt
- event-service: 3 hardcoded config values bypassing config-as-code pattern (PR #2465). Quick fix shipped but underlying config model needs cleanup.
- analytics-service Cosmos-to-SQL migration left 22 mirror views that should be dropped after validation period.

## Architecture Decisions
- GitHub signal connector chose gh CLI as primary transport with HTTPS fallback -- documented in ADR but no team discussion.
- New `connectors.json` introduced single-writer pattern for config. Good pattern, should be adopted elsewhere.

## Deployment Risk
- MonthlyRefresh scheduled job fires Sunday 2am UTC -- first run with 3 new tables. Watch #system-alerts.
- ReportService nuget PAT cleanup (PRs #2474-#2486) touching build pipeline across 12 repos.

## CI/CD
- 2 workflow failures on main this period (analytics-service). Both related to SQL MI connection timeout.
- event-service: 14 runs, 0 failures. Clean.

## Code Quality
- PR #2471 merged without tests (import-service batch endpoint). Coverage dropped 3%.
- 4 PRs open >5 days with no reviews: #2468, #2470, #2473, #2477. Review bottleneck forming.
