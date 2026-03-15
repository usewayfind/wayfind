# Session State Protocol
## (Add this to your AI tool's system prompt or project instructions file)

---

## Session State Protocol

**Memory directory:** `~/.ai-memory/` (global) and `.ai-memory/` (per-repo)

**At session start (REQUIRED):**
1. Read `~/.ai-memory/global.md` — preferences, active projects table, memory file manifest
2. Read `.ai-memory/state.md` in the current repo — branch, progress, next steps, gotchas
3. If persona state files exist (e.g. `.ai-memory/product-state.md`, `.ai-memory/strategy-state.md`), read them — these capture intent, success criteria, and constraints from your configured personas. Keep them in mind during the session.
4. Check the "Memory Files" table in global.md — load any files from `~/.ai-memory/memory/` whose keywords match this session's topic
5. Summarize the current state of the project, then ask: **"What's the goal for this session? What does success look like?"**

**Mid-session:**
If the session appears to be diverging from the stated goal (new tangent, scope creep), gently flag it:
> *"Quick check — we set out to [goal]. This feels like it's moving toward [tangent]. Want to stay the course, or deliberately pivot?"*
If the user pivots, update the goal. This is a nudge, not a gate — the user always decides.

**At session end (when user says "stop", "done", "pause", "tomorrow", "wrap up"):**
1. Update `.ai-memory/state.md` in the current repo: what was done, what's next, blockers, gotchas
2. Do NOT update `~/.ai-memory/global.md` Active Projects table — it is rebuilt automatically by `wayfind status`.
3. If significant new cross-repo context was created (patterns, strategies, decisions), create or update a file in `~/.ai-memory/memory/` and add it to the Memory Files manifest
4. Append to `~/.ai-memory/memory/journal/YYYY-MM-DD.md`:

```
## [Repo or context] — [Brief title]
**Why:** [The stated goal]
**What:** [Bullet list of what was done]
**Outcome:** [Did we hit the goal? Key deliverables]
**On track?:** [Focused or drift? What caused drift?]
**Lessons:** [Worth remembering cross-session]
**Discovery:** [Optional — things learned that challenge assumptions, create new options,
  or need PM/CTO attention. Skip if nothing notable. Include who should see this and why.]
```

5. If the session surfaced items that belong in a persona state file (e.g. open questions for the product owner, strategic discoveries for the CTO), add them to the relevant persona state file.
6. Confirm: **"State saved. Say 'let's continue' next time."**

**Rules:**
- Use the Edit tool to update files in place — don't append new sections
- Keep `global.md` under 80 lines. Detail goes in topic files.
- Per-repo state stays focused on that repo. Cross-repo context goes in `~/.ai-memory/memory/`
- Do NOT use proprietary memory CLI tools for state storage. Plain markdown files only.
