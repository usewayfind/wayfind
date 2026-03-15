# Product Digest

**Period:** 2026-02-24 to 2026-02-28

## Priority Conflicts
- Issue #342 (bulk import error handling) escalated by support but not on sprint board. 3 customer tickets reference it this week.
- PR #2465 (config-as-code) merged ahead of the RFP matching improvement (#338) that was marked P1 for Q1.
- Campaign briefs pipeline shipped (PR #2461) but no product sign-off on output format. Risk of rework if Sales has feedback.

## Scope Drift
- AnalyticsService SQL migration expanding scope: original plan was 18 gold tables, now at 23. Extra 5 added without updated estimates.
- ReportService branding flag (PR #2466) added mid-sprint without backlog grooming. Small but sets precedent.

## Customer Signals
- 2 enterprise prospects asked about SSO during demos this week (tracked in HubSpot). No current timeline for SSO.
- NPS survey batch completed: score dropped from 42 to 38. Detractor comments cite "slow proposal generation" (3 mentions) and "confusing venue search" (2 mentions).
- Support ticket volume up 15% week-over-week. Top category: bulk import failures (Issue #342).

## Feature Delivery
- Converged matching deployed to QA (ImportExportService). Nick and Swetha start validation Monday.
- GitHub signal connector shipped -- first signal channel live. Enables digest MVP.

## Risks
- No automated regression tests for the matching algorithm. Manual QA only. If Swetha finds issues, iteration cycle will be slow.
- Campaign briefs pipeline runs on a Monday cron -- first real run is 3/2. No alerting configured beyond #system-alerts.
