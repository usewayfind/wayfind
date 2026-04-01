# Architecture Principles

These principles govern how Wayfind is built. They are constraints, not aspirations. Violating them creates debt that compounds.

---

## 1. Integration platform from day one

Wayfind is an integration platform that happens to ship a product, not a product that bolts on integrations later. Follow the OpenTelemetry model: define the format, ship the SDK, let the ecosystem connect. When someone asks "can I pipe my Copilot context into Wayfind?" the answer is already yes because the integration surface was designed first.

**Why it matters:** Integration platforms compound in value with each new connection. Products that treat integrations as afterthoughts end up with brittle, one-off connectors that don't compose. Building the platform layer first means every new signal source (GitHub, Linear, Intercom, CI/CD) slots in through the same contract.

**Anti-pattern:** Building a closed product first and retrofitting an "API" later. Custom glue code per integration. Connectors that each speak a different internal protocol. "We'll add integrations in v2."

---

## 2. Data portability is non-negotiable

The customer owns their data. Wayfind provides the context layer, not the data silo. Everything is plain markdown, exportable, human-readable, and version-controllable. No proprietary formats. No database you can't walk away from.

**Why it matters:** Enterprise trust. "We don't lock you in" is a selling point that removes procurement friction. Teams adopt faster when the exit cost is zero. Plain files also mean the system works without infrastructure -- no database to provision, no vendor dependency to manage.

**Anti-pattern:** Proprietary storage formats. Data that only makes sense inside the product. Export features that produce lossy dumps. Any architecture where deleting Wayfind means losing context.

---

## 3. Layer on top, don't replace

Wayfind sits alongside existing tools as connective tissue. It reads from GitHub, Intercom, and Notion -- it doesn't replace any of them. Teams keep their workflows. Wayfind adds the cross-tool context layer they're missing.

The displacement path exists but is earned, not forced. As the context layer becomes indispensable, some tools become redundant. That happens naturally, not by mandate.

**Why it matters:** Zero-friction adoption. Nobody has to change their workflow to try Wayfind. One engineer runs `npx wayfind init` and the team starts getting digests. Replacement products require buy-in from the whole team before anyone gets value. Additive layers deliver value immediately.

**Anti-pattern:** Requiring teams to move their issues into Wayfind. Building a project tracker. Competing with the tools you integrate with before you've proven the context layer. "Replace your standup with our dashboard."

---

## 4. Design for forwarding

Every output Wayfind produces -- digests, reports, dashboards, summaries -- must be good enough that someone would forward it to their boss. The digest an engineer receives should be something they'd send to their PM unprompted. The weekly summary should be boardroom-ready without editing.

**Why it matters:** Forwarding is the conversion mechanism. The person who installs Wayfind is an engineer. The people who pay for it are engineering leaders. The bridge between them is a digest that lands in Slack and gets forwarded up. If the output needs editing before sharing, the viral loop breaks.

**Anti-pattern:** Raw data dumps that require interpretation. Outputs that only make sense to the person who configured them. Digests full of jargon that can't leave the engineering channel. "Here are 47 commits from this week."

---

## 5. Signal channels are integrations, not personas

Adding a new signal source (Intercom, HubSpot, CI/CD) adds an integration point, not product complexity. The persona model -- PM sees product signals, engineer sees technical signals, CTO sees strategic signals -- holds regardless of how many signal channels feed in. A new connector means more data flowing through the same routing logic, not a new product surface.

**Why it matters:** This is how the platform scales without the product becoming unwieldy. Ten signal channels should feel exactly as simple to the end user as two. The complexity lives in the integration layer, not in the user experience. Each new connector increases value for every persona without increasing cognitive load.

**Anti-pattern:** Each new integration adding a new tab, view, or configuration screen. Signal sources that require per-user setup. Connectors that bypass the routing layer and push directly to users. Product complexity growing linearly with integration count.

---

## 6. One system, three views

The same underlying data -- decision trail plus signal channels -- generates different outputs for different personas. The PM digest, the engineering summary, and the strategy report all draw from one data model. Wayfind is one system with multiple views, not three products sharing a database.

**Why it matters:** Maintaining one data model is tractable. Maintaining three is not, especially for a small team. Shared data also means cross-persona insights come for free: the PM sees engineering velocity in context, the engineer sees product priorities without switching tools, the CTO sees both without asking for reports.

**Anti-pattern:** Building separate pipelines per persona. Different data models for different user types. Features that only work for one persona. "The PM version doesn't know about the engineering data."

---

## 7. Local-first, hosted path

Every capability works locally on plain files. The hosted layer adds team-scale value -- aggregation, automation, dashboards -- not individual-scale features. The local version is never artificially limited.

**Why it matters:** The free tier must be genuinely useful, not a demo. An engineer who installs Wayfind and finds artificial limits will vibe-code around them before lunch. The local version earns trust by being complete. The hosted version earns revenue by solving problems that a single machine cannot: searching across a team's journals, running digests on a schedule, rendering insights in a browser.

**Architecture seam:** Every module separates the query interface (what you ask for) from the backend (where data lives). Today the backend is local files. Tomorrow it is an HTTP API. Same module interface, different transport. This seam is designed in from day one, not retrofitted.

**Anti-pattern:** Gating individual features behind a login. Requiring an API key for functionality that could work locally. Building hosted-only features that have no local equivalent. "Sign up to unlock search."

### The Scaling Philosophy in Detail

Local is the default. A solo engineer running `npx wayfind init` gets the full product — context persistence, session journals, persona digests, signal connectors, content search, drift detection. No account, no server, no subscription. Plain files on disk.

The hosted layer adds things that a single machine cannot do alone:

- **Team aggregation** — search across everyone's journals, not just yours
- **No-key convenience** — hosted LLM and embedding processing without managing API keys
- **Automation** — scheduled digests, continuous indexing, webhook-triggered pulls
- **Dashboards** — web UI for drift trends, repo activity, tag clouds, timeline views

These are team-scale capabilities. They require infrastructure. They justify a subscription.

**Architecture seam details:**

Every module is designed so the backend is swappable:

- **Content store**: `loadIndex()` / `saveIndex()` today read/write JSON files. Tomorrow they can hit an HTTP API. The query interface (`searchJournals`, `queryMetadata`, `extractInsights`) stays the same.
- **Signal connectors**: `pull()` returns structured data. Today it writes markdown files locally. A hosted version writes to a team store.
- **Digest engine**: `generateDigest()` calls an LLM provider. Today that is your API key. Hosted uses a shared key and bills credits.

The seam is the module interface. Swap the backend, keep the contract.

**Conversion triggers:**

Conversion is natural. It happens when a user hits a real limitation of the local version, not an artificial paywall:

- "I want to search across my team's journals" → team aggregation
- "I want automatic indexing without running CLI" → hosted pipeline
- "I want a drift dashboard, not CLI text" → web UI
- "I don't have an OpenAI key but want semantic search" → hosted embeddings

Nobody hits a paywall. They hit a use case that requires infrastructure.

**What this means in practice:**

When building a new feature:

1. Make it work locally first — plain files, zero dependencies, no API key required for core functionality
2. Design the module interface so the backend is swappable (query interface vs. storage layer)
3. Identify the natural team-scale extension (what would a team of 10 need that a solo user does not?)
4. That extension is the hosted value. Document it. Don't build it yet.

---

## 8. All context is equal

Every piece of context Wayfind touches — journal entries, conversation transcripts, Intercom signals, GitHub activity, CI/CD events — flows into the same unified index. The storage and retrieval layer is source-agnostic. A search query hits one index, not N channel-specific stores.

The intelligence to distinguish between "what are customers complaining about?" and "what did we decide about the auth refactor?" lives in the query layer (intent classification, prompt routing), not the storage layer. Content from Intercom and content from engineering journals are neighbors in the same vector space. The system figures out what's relevant at query time.

**Why it matters:** Teams don't think in data sources. A PM asking "what's happening with billing?" wants Intercom complaints, engineering decisions, and GitHub issues in one answer — not three separate queries to three separate stores. Treating all context as first-class means every new signal source automatically becomes searchable, embeddable, and synthesizable the moment it's connected. No special plumbing per channel.

**Anti-pattern:** Separate indexes per signal channel. Search functions that only look at journals. Signal data that's ingested but invisible to the query layer. "We pull Intercom data but the bot can't see it." Storage schemas that encode assumptions about content structure.

---

## 9. Plain files are the source of truth — protocol layers are optional read paths

Plain markdown files are always the canonical data store. No middleware is required to read context. `grep` always works. Wayfind functions fully without MCP or any protocol layer.

MCP is a useful access layer for tools and environments that cannot read files directly — agents running in Cursor, Windsurf, CI pipelines, remote environments. It is equivalent to the Slack bot: another read path over the same data. Not a replacement for files.

**MCP surface:**
- **Read-only** for context retrieval — memories, journals, team state, search results.
- **Write-only** for feedback signals — relevance scores, stale flags, retrieval quality labels.
- No mutations to the memory store. The file system is the only writer.

**Transport tiers:**
- **stdio** — local dev. Agent spawns the MCP server as a child process. Zero config.
- **Container HTTP/SSE** — team deployment. The Wayfind container exposes MCP over HTTP alongside the existing API.
- **Cloud hosted** — managed platform. Same tool handlers, hosted transport, team-scale access.

Same tool handlers across all three tiers. The transport changes, the interface does not.

**Why it matters:** Many AI tools now speak MCP natively. An agent in Cursor or a CI pipeline cannot `cat ~/.claude/memory/topic.md` — it needs a protocol interface. Refusing to provide one forces users to build their own adapters, which is worse than offering an official read path. The security concern with MCP was always about servers that take actions — send emails, execute code, modify state. A read-only context server with a feedback write path has minimal attack surface. Wayfind's MCP layer reads files and accepts signals. It does not act.

**Anti-pattern:** Making MCP the primary interface — files are always primary. Requiring MCP to access context that is available as a file. Adding write operations beyond feedback signals. Running an MCP server as a required dependency.

---

## 10. Feedback improves retrieval — the memory loop must close

Every access layer — bot, digest, MCP, CLI search — should capture signals about memory quality. When an agent retrieves a memory, the system should know whether it was useful, stale, or irrelevant. These signals feed back into retrieval scoring, distillation priority, and forgetting decisions.

The digest feedback loop is the proven pattern: emoji reactions on Slack digests tell the system what landed and what missed, and the next digest adapts. MCP feedback and retrieval metrics extend this same loop to all access layers. Every retrieval becomes a test. Every user or agent reaction becomes a label.

**Why it matters:** Memory systems that only write and read degrade over time. Retrieval quality drops as stores grow. The only way to maintain quality is to close the feedback loop — treating every retrieval as a test and every user/agent reaction as a label. Without feedback, the system accumulates stale context indefinitely, and relevance decays until the memory store becomes noise.

**Anti-pattern:** Memory stores with no eviction policy. Retrieval systems with no quality metrics. Adding memory capacity without adding memory evaluation. "We'll add feedback later."
