# Design Digest

**Period:** 2026-02-24 to 2026-02-28

## UX Consistency
- ReportService branding flag (PR #2466) introduces a new toggle pattern. Existing settings pages use dropdowns for similar controls. Inconsistency risk if shipped as-is.
- Bulk import error messages (Issue #342) surfacing raw database errors to users. Needs human-readable error mapping before customer-facing release.

## Accessibility
- Venue search results page still missing ARIA labels on filter controls (Issue #291, open 34 days). Blocks VPAT compliance update.
- New analytics dashboard tables (AnalyticsService migration) have no responsive breakpoints. Unusable on tablet viewport.

## Design Debt
- 3 different date picker components in use across EventSubscription, ImportExport, and ReportService. Consolidation to shared component overdue.
- Proposal generation flow has 7 steps -- user testing showed 40% drop-off at step 4. Simplification spec drafted but not prioritized.

## Information Architecture
- Campaign briefs output format uses a flat markdown structure. For Slack delivery, will need a condensed card layout. Design spec not started.
- Signal channel digest format (GitHub connector) established a good heading hierarchy. Recommend adopting same pattern for future connectors.
