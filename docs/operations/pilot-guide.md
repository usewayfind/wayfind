# Running a Wayfind Pilot

This is the playbook for piloting Wayfind with a real team. It covers what you're proving, how to roll out in phases, and how to know if it's working.

## What You're Proving

One sentence: **The PM reads a digest that tells them something they didn't know, sourced from signals they didn't manually compile.**

That's the proof point. Everything in this guide works backward from it. If the PM forwards the digest or references it in a meeting, you've won. If they check it before the project board, you're close.

The digest that gets forwarded looks like this: "3 support tickets mention login timeout (Intercom), Feature X is 'on track' in Aha! but the last 2 PRs surfaced open questions (GitHub), and CI failed twice on the auth branch." That's cross-signal context no one assembled by hand.

## Phase 1 -- Individual Value (Day 1)

**Goal:** One engineer finds persistent session context valuable enough to keep using it.

No team setup. No integrations. One person, one repo.

1. Install the CLI and plugin:
   ```bash
   npm install -g wayfind
   ```
   Then in Claude Code:
   ```
   /plugin marketplace add usewayfind/wayfind
   /plugin install wayfind@usewayfind
   ```
2. Run `/wayfind:init-memory` to set up state files and the session protocol.
3. Work normally. Sessions now start with "Resuming..." instead of cold start.
4. End sessions properly (say "done" or "pause") so context persists.
5. Run `wayfind update` after upgrading to re-sync hooks and commands. Run `wayfind doctor` to verify health.

This is the PLG entry point. The engineer gets value immediately -- no coordination cost, no buy-in required from anyone else. They stop losing context between sessions. That's enough to keep going.

**Exit criteria:** The engineer voluntarily uses Wayfind for 3+ sessions in a row without being reminded.

## Phase 2 -- Team Visibility (Week 1)

**Goal:** The engineering digest posts to Slack. At least one non-engineer reads it.

1. Run `/wayfind:init-team` to set up shared team state and journal aggregation.
2. Configure Slack digest delivery to a team channel.
3. The engineering digest starts posting automatically from journal entries.
4. Other team members see it without installing anything.

The key insight: only one person needs to install Wayfind for the whole team to see the digest. The digest is the viral mechanism -- it shows up in Slack where everyone already is.

**What the digest looks like (v2.0.23+):** Digests are persona-aware — a scoring layer evaluates each signal for relevance to Engineering, Product, and Strategy personas, filtering noise before generation. High-relevance items @mention specific team members in a threaded reply (v2.0.26+). Sessions also auto-detect context shifts — when work pivots unexpectedly from its stated goal, the digest surfaces this as a planning signal.

**Exit criteria:** A non-engineer (PM, designer, lead) reads the digest without being asked to.

## Phase 2.5 -- Decision Trail Bot (Week 1-2)

**Goal:** The team can ask questions about their own decision history in Slack.

Once the digest is posting, the next high-value step is the Slack bot. It lets anyone on the team ask `@wayfind <question>` and get answers grounded in the team's journal entries and decision trail.

1. Create a Slack app with Socket Mode enabled (no public URL required — runs wherever you run it).
2. Run `wayfind bot --configure` to save your Slack app token (`xapp-`), bot token (`xoxb-`), and LLM settings.
3. Index your journal entries: `wayfind index-journals`.
4. Start the bot: `wayfind bot`.
5. In Slack, mention the bot: `@wayfind what did we decide about the retry logic?`

The bot searches the content store (journal entries indexed by `index-journals`), synthesizes an answer via LLM, and replies in a thread. It acknowledges with an eyes emoji immediately so the team knows it's working.

**Who runs it:** For the pilot, one team member runs the bot locally. It connects via Socket Mode (WebSocket), so no public endpoint is needed. To run the bot persistently (no terminal needed), use `wayfind deploy init` in the team context repo to scaffold a Docker Compose deployment. Long-term, this moves to a hosted service — the architecture supports local, self-hosted Docker, and cloud modes.

**Exit criteria:** Someone asks the bot a question and gets a useful answer they would have otherwise had to dig through journals or PRs to find.

## Phase 3 -- Signal Enrichment (Weeks 2-4)

**Goal:** The digest surfaces something the team would have missed.

Connect signal sources one at a time. Each one makes the digest richer. Don't connect everything at once -- add one, let the team see the difference, then add the next.

**Week 2:** Connect your first external signal source (likely Intercom or your support tool). The digest now includes support patterns alongside engineering work.

**Week 3:** Connect your PM tool (Aha! or equivalent). The digest now shows intent vs. reality -- what the roadmap says vs. what the code and support tickets show.

**Week 4:** Connect remaining engineering signals (ADO, CI dashboards). The digest now has full engineering context.

**Exit criteria:** The PM reads the digest before checking the project board. Someone says "I saw in the digest that..." in a meeting.

## Connector Priority

Build/connect in this order. Each step makes the digest more valuable.

| Priority | Connector | Status | Why |
|----------|-----------|--------|-----|
| 1 | Digest engine + Slack delivery | **Available** | Completes the vertical slice. Nothing works without this. |
| 1.5 | Slack bot (decision trail queries) | **Available** | Immediate team value — anyone can query the decision trail without installing anything. |
| 2 | Intercom | **Available** | Support signal is the fastest path to "the digest told me something I'd miss." Requires `INTERCOM_TOKEN` and optionally `TEAM_CONTEXT_INTERCOM_TAGS` to filter by conversation tags. |
| 3 | GitHub signals | **Available** | Issues, PRs, and CI data. Configure via `wayfind pull github --configure`. |
| 4 | Notion | **Available** | Pages, databases, and comments. Product context and design decisions. Configure via `wayfind pull notion --configure`. |
| 5 | Linear / Jira | **Planned** | PM intent flowing into engineering context closes the biggest information gap. [Contributions welcome.](../../CONTRIBUTING.md) |
| 6 | Slack (as signal source) | **Planned** | Channel decisions and context. Different from digest delivery — this pulls signals from Slack conversations. |
| 7 | Figma | **Planned** | Design rationale. Lower urgency, higher long-term value. |

The available connectors today are Slack (digest + bot), Intercom, GitHub, and Notion. See the [signal source roadmap](../architecture/signal-source-roadmap.md) for the full list and contributor guide.

## Success Criteria

| Timeframe | What success looks like |
|-----------|------------------------|
| Week 1 | Engineer finds persistent context valuable. Sessions resume instead of cold-starting. |
| Week 1-2 | Slack bot answers a decision trail question that saves someone from digging through PRs or journals. |
| Week 2 | Engineering digest posts to Slack. At least one non-engineer reads it. |
| Week 4 | PM reads the digest without being asked. Checks it before the project board. |
| Week 6 | PM forwards the digest or references it in a meeting. This is the conversion proof point. |
| Ongoing | The digest surfaces something the team would have missed. Bugs from support appear before someone files a ticket. Drift between roadmap and reality is detected before demo day. |

## How to Measure

Four questions. If you can answer "yes" to the first three, the pilot is working.

1. **Did the PM read it?** Slack read receipts, or they reference digest content in conversation.
2. **Did anyone forward it?** Forwarding is the strongest signal of value.
3. **Did the team act on something from the digest they wouldn't have seen otherwise?** A decision, a priority change, a bug caught early. One concrete example is enough.
4. **How often do engineers persist context?** Track whether engineers end sessions properly vs. skip them. Adoption stalls if the input side (journals) dries up.

Don't over-instrument. The proof point is qualitative: someone who didn't compile the information acts on it. If that happens, you have product-market fit signal. If it doesn't happen by week 6, the digest content isn't valuable enough yet -- add more signal sources or improve the synthesis.
