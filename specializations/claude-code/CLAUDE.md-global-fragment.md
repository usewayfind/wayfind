
## Session State Protocol (Wayfind)

**Memory system:** Hierarchical plain-markdown files. No CLI tools, no databases.

### File Hierarchy

```
~/.claude/
  global-state.md          # Thin index — ALWAYS load at session start
  state.md                 # Admin/non-repo work
  memory/                  # Topic files — load on demand
    <topic>.md
    journal/YYYY-MM-DD.md  # Daily log

<repo>/.claude/
  team-state.md            # Shared team context — committed to git
  personal-state.md        # Personal context — gitignored
```

### Session Start (REQUIRED)

1. Read `~/.claude/global-state.md`
2. Read `.claude/team-state.md` (shared team context) and `.claude/personal-state.md` (your personal context) in the current repo, if they exist. Fall back to `.claude/state.md` for older repos not yet migrated. (Or `~/.claude/state.md` if in home dir.)
3. Check the Memory Files table in global-state.md — load any `~/.claude/memory/` files whose keywords match this session's topic
4. Summarize current state, then ask: **"What's the goal for this session? What does success look like?"**

### Mid-Session

If work drifts from the stated goal, flag it: *"Quick check — we set out to [goal]. This feels like [tangent]. Stay the course or pivot?"*

### Session End (on "stop" / "done" / "pause" / "tomorrow")

1. Update `.claude/team-state.md` with shared changes and `.claude/personal-state.md` with personal changes. (For older repos not yet migrated, update `.claude/state.md` as before.)
2. Do NOT update `~/.claude/global-state.md` — its Active Projects table is rebuilt automatically by `wayfind status`.
3. Create/update topic files in `~/.claude/memory/` for significant new cross-repo context
4. Append to `~/.claude/memory/journal/YYYY-MM-DD.md`:
   ```
   ## [Repo] — [Title]
   **Why:** [Stated goal]
   **What:** [What was done]
   **Outcome:** [Did we hit it?]
   **On track?:** [Focused or drift?]
   **Lessons:** [Cross-session learnings]
   ```
5. Confirm: **"State saved. Say 'let's continue' next time."**

### Rules

- Keep `global-state.md` under 80 lines. Detail goes in `~/.claude/memory/` files.
- Per-repo `state.md` stays focused on that repo only.
- New cross-repo topics get new files in `~/.claude/memory/`, not appended to global-state.md.
- Do NOT use external memory databases or CLI tools for state storage. Use plain markdown files only.
