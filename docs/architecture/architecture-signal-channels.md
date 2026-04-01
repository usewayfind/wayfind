# Signal Channels — Architecture Decision

## Context

Signal channels pipe external reality into Wayfind: support tickets, customer health, CI/CD events, analytics, chat decisions, project management. They feed persona-appropriate digests. This document decides how signal ingestion works and what ships first.

---

## 1. Architecture Options

### Option A: Cloud-Hosted

Wayfind runs a cloud service that receives webhooks and polls third-party APIs. Team authenticates once, signals flow continuously.

- **Pros**: Webhooks just work (public endpoint exists). No infrastructure for the team to run. Consistent uptime.
- **Cons**: Contradicts "plain files you own." Wayfind stores customer API tokens and signal data. Adds cloud ops burden. Privacy-sensitive teams (healthcare, finance) may refuse.

### Option B: Self-Hosted

Everything runs on the team's infrastructure. Wayfind ships connectors as CLI commands or scripts. User runs them via cron, CI, or manually.

- **Pros**: Full alignment with "plain files you own." Zero cloud infra for Wayfind. No credential custody. Privacy by default.
- **Cons**: Webhooks require the team to expose an endpoint (or use a tunnel). More setup friction. Reliability depends on the team.

### Option C: Hybrid (Recommended)

Core runs locally (state files, digests, context). Signal ingestion is primarily local polling via CLI. An optional cloud webhook relay handles push-only signals for teams that want it.

- **Pros**: Default path is self-hosted (aligned with philosophy). Cloud relay is opt-in, scoped to webhook reception only — no credential custody for poll-based signals. Minimizes Wayfind's infrastructure. Teams that can self-host everything do; teams that need webhooks get a thin relay.
- **Cons**: Two paths to maintain. Relay still needs infrastructure (though minimal).

---

## 2. Recommendation: Hybrid, CLI-First

**Default: local polling via `wayfind pull <channel>`.**

The CLI polls APIs on demand and writes signal data to local markdown files in a `signals/` directory within the team context repo. This runs on cron, in CI, or manually. No cloud dependency. No credential custody. Aligns with "plain files you own."

**Optional: cloud webhook relay for push-only signals.**

A thin relay service receives webhooks, buffers events, and exposes them via a pull endpoint. The CLI then pulls from the relay instead of the source API. The relay stores nothing permanently — events expire after 72 hours. This is a paid add-on for the Team tier.

**Why this wins for MVP**: Wayfind (the company) runs zero infrastructure for the default path. The target market — small technical teams — can run a cron job. Webhook relay ships later, only if demand justifies it.

**The CLI contract:**

```
wayfind pull github                    # Poll GitHub API, write signal files
wayfind pull github --configure        # Interactive setup (transport, repos)
wayfind pull github --add-repo o/r     # Add a repo to config
wayfind pull github --remove-repo o/r  # Remove a repo from config
wayfind pull notion                    # Poll Notion API
wayfind pull linear                    # Poll Linear API (planned, not yet available)
wayfind pull intercom                  # Poll Intercom API
wayfind pull intercom --configure      # Interactive Intercom setup
wayfind pull --all                     # Poll all configured channels
wayfind signals                        # Show configured channels and last pull time
```

Output is per-repo markdown files at `~/.claude/team-context/signals/<channel>/<owner>/<repo>/<date>.md` plus a cross-repo rollup at `~/.claude/team-context/signals/<channel>/<date>-summary.md`. The digest generator reads these alongside journals when building persona views.

**Implemented channels:** GitHub (issues, PRs, Actions), Intercom (conversations, tags, response times), and Notion (recently updated pages, database entries, comments). GitHub is transport-agnostic: auto-detects `gh` CLI or falls back to HTTPS+PAT. Intercom uses HTTPS+Bearer token with the v2.11 API. Notion uses HTTPS+Integration token with the v2022-06-28 API.

---

## 3. Signal Channel Taxonomy

### Poll-able (MVP candidates)

APIs you can call on demand. Auth via API key or OAuth token stored locally.

| Channel | API Quality | Auth | Rate Limits | Notes |
|---------|-------------|------|-------------|-------|
| GitHub | Excellent | PAT/OAuth | 5,000/hr | Issues, PRs, Actions, reviews |
| Linear | Excellent | API key | 1,500/hr | Issues, projects, cycles |
| Jira | Good | API token | ~50/sec | Issues, sprints, boards |
| Intercom | Good | Bearer token | 1,000/min | Conversations, contacts |
| HubSpot | Good | Private app key | 100/10sec | Contacts, deals, tickets |
| Notion | Good | Integration token | 3 req/sec | Pages, databases |
| Amplitude | Fair | API key/secret | Varies | Cohorts, events (export API) |

### Webhook-Only

Signals that push to you. Require a public endpoint or tunnel.

| Channel | Notes |
|---------|-------|
| Slack Events API | Real-time message events. Can also be polled via Conversations API. |
| GitHub Webhooks | Push events, PR reviews. But same data is poll-able via REST API. |
| Stripe events | Payment/subscription changes. Poll-able via Events API as fallback. |

**Key insight**: Almost every "webhook-only" signal has a poll-based fallback. True webhook-only signals are rare. This validates the CLI-first approach — webhooks are a latency optimization, not a requirement.

### Export-Based

Bulk data: analytics CSV exports, database dumps, spreadsheets. Processed on demand via CLI.

### Passive

Already local: git history, build logs, existing state files (journals, product-state.md). Zero ingestion cost.

---

## 4. MVP Signal Channels

Ship four channels in the first release. Selection criteria: high value to small technical teams, excellent API quality, poll-able, demonstrates digest value immediately.

### 1. GitHub (Issues + PRs + Actions)

- **Why**: Every target team uses it. Issues and PRs are the richest signal source for engineering digests. Actions status shows deployment reality.
- **Ingestion**: REST API, PAT auth. Well-documented, generous rate limits.
- **Digest value**: "3 PRs merged, 1 blocked on review for 48hrs, CI failed twice on main, 2 issues opened by users."

### 2. Linear (or Jira — user's choice)

- **Why**: Project management is where PM intent lives. Pulling issue status and sprint data bridges the PM-to-engineering gap.
- **Ingestion**: Linear's GraphQL API (clean, fast) or Jira REST API (ubiquitous). API key auth.
- **Digest value**: "Sprint is 60% complete, 2 items moved to backlog mid-sprint, 1 item unassigned for 3 days."

### 3. Intercom (Implemented) or Zendesk

- **Why**: Support signal is the fastest way to demonstrate that digests surface reality the team would otherwise miss. A bug report pattern appearing in Monday's digest is the "aha moment."
- **Ingestion**: REST API, bearer token. Conversation search by date range via POST `/conversations/search`. Scopes: Read conversations, Read tags.
- **Digest value**: "12 new conversations this week, 3 mention 'login timeout' (up from 0 last week), avg first response time 4.2 hrs."
- **Privacy**: Signal files contain only aggregate stats, tags, and conversation titles. Raw customer messages and PII are never extracted.

### 4. Slack (Decisions Channel)

- **Why**: Decisions made in Slack threads are the most common source of evaporated context. Pulling from a designated `#decisions` or `#engineering` channel captures what would otherwise be lost.
- **Ingestion**: Conversations API (poll-able with bot token). Read-only scope.
- **Digest value**: "4 threads in #engineering with >5 replies (likely decisions). Key topics: auth migration timeline, API versioning approach."

### Implementation Order

GitHub shipped first (established the connector pattern). Intercom shipped second (first external support signal). Notion shipped third (documentation and project management signal). Next: Linear (preferred for small teams), then Slack as signal source. Each channel follows the same pattern: auth config, pull command, markdown output, digest integration.

### Connector Interface

Every channel implements:

```
configure(credentials) → config file
pull(since: date) → markdown files in signals/<channel>/
summarize(files) → structured summary for digest input
```

This is the integration surface. Third-party and community connectors follow the same contract.

**Provider flexibility (#43):** The LLM and embedding providers are currently hardcoded to Anthropic (Claude) and OpenAI respectively. Planned work will make these configurable, supporting alternative providers and local models.
