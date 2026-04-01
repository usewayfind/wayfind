# Signal Source Roadmap

Planned signal source integrations, organized by priority tier. Shipped connectors are in **Tier 0**. Everything else is planned — contributions welcome.

> Last updated: 2026-04-01

---

## Tier 0: Shipped

| Signal Source | Personas | What it Pulls |
|---------------|----------|---------------|
| **GitHub** | Engineering, Product | PRs (state, author, age, review status), issues (labels, state, age), CI/CD runs (status, conclusion, duration). Per-repo files + cross-repo summary. Flags blocked PRs and CI failures. |
| **Intercom** | Product, Strategy | Conversation stats, tag analysis, topic clustering, daily volume trends, first-response time. Privacy-safe: titles and tags only, never raw message body. |
| **Notion** | Product, Strategy, Engineering | Recently updated pages, database entry status, comments, top contributors. Auto-discovers shared databases. |

**Connector interface** — all three implement this contract:

```javascript
configure()          // Interactive setup → writes ~/.claude/team-context/connectors.json
pull(config, since)  // Fetches signals → writes markdown to signals/<channel>/
summarize(filePath)  // Extracts summary section from a signal file
```

Community connectors follow the same interface. See `bin/connectors/` for reference implementations.

---

## Tier 1: Pre-PMF

High-value integrations for small technical teams. Linear and DORA metrics are the priorities.

| Source | Why | Status |
|--------|-----|--------|
| **Linear** | Small teams prefer Linear over Jira. Excellent GraphQL API. Issue velocity, blocked items, cycle progress, label patterns. | Planned |
| **DORA Metrics** | Derived from existing GitHub data — zero new connectors. Deployment frequency, lead time, change failure rate, MTTR. | Planned |
| **Jira** | Enterprise teams. API quality declining but ubiquitous. Build only if Linear doesn't cover the ICP. | Planned |
| **Asana** | Good REST Events API for "what changed since last pull." Activity feed per task. | Planned |

---

## Tier 2: PMF Validation

Expand signal diversity across all four personas.

| Source | Why | Status |
|--------|-----|--------|
| **Sentry** | Release Health API — "did our last deploy make things worse?" Crash-free session rate per release. | Planned |
| **Slack** (as signal) | Decisions made in Slack threads. Bot token, read-only Conversations API. | Planned |
| **Market Intel** | HN front page, tech news, Bluesky/Twitter engineering accounts. Surfaces relevant external context in strategy digests. | Planned |
| **Meeting Transcripts** | Fathom, Fireflies, Otter. Decisions from meetings that never make it into issues or journals. | Planned |
| **Vercel / Netlify** | Deployment status, build times, preview URLs. Complements GitHub Actions. | Planned |
| **PostHog** | Feature flag state, funnel metrics, session counts. Bridges product analytics into engineering context. | Planned |
| **Google Drive** | Recently modified docs and sheets in designated team folders. | Planned |

---

## Tier 3: Scale

Broader persona coverage as user base grows.

| Source | Why |
|--------|-----|
| **Figma** | Design handoff status, component updates, prototype links. |
| **AI tool metrics** | Claude Code, Copilot, Cursor usage patterns. Lines changed, session counts. |
| **Calendar health** | Meeting load vs. focus time ratio. Flags weeks with no protected time. |
| **GitLab** | Alternative to GitHub for self-hosted teams. Same interface, different transport. |
| **Datadog / New Relic** | APM metrics — error rates, latency, saturation. Production health signal. |
| **LaunchDarkly** | Feature flag rollouts, experiment results, kill switch activity. |

---

## Tier 4: Enterprise

| Source | Why |
|--------|-----|
| **Zendesk** | Enterprise support signal (Intercom alternative). |
| **PagerDuty** | Incident frequency, MTTR, on-call burden. Engineering health. |
| **Revenue signals** | ChartMogul, HubSpot, Stripe. MRR changes and churn events in strategy digests. |
| **SonarQube** | Code quality trends. Tech debt signal. |

---

## Contributing

Signal connectors are the most accessible contribution surface. To add a new connector:

1. Create `bin/connectors/<name>.js` implementing `configure()`, `pull()`, `summarize()`
2. Add the connector to the pull command dispatch in `bin/team-context.js`
3. Write a test in `tests/test-connectors.sh`

See [architecture-signal-channels.md](architecture-signal-channels.md) for the full connector architecture and interface spec.
