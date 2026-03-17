---
name: session-protocol
description: Wayfind session memory protocol — behavioral instructions for AI sessions. Elicitation prompts, drift detection, and state file conventions. The plugin's hooks handle automation (loading/saving); this skill defines how the AI should behave.
disable-model-invocation: false
user-invocable: false
---

## Wayfind — Session Behavior Protocol

This skill defines behavioral instructions for AI sessions. Automation (state file loading,
decision extraction, journal sync) is handled by the plugin's hooks — this skill covers
the human-judgment parts that hooks can't automate.

### State File Locations

```
~/.claude/
  global-state.md          # Thin index — preferences, active projects, memory file manifest
  memory/                  # Topic files — load on demand by keyword match
    journal/YYYY-MM-DD.md  # Daily work log

<repo>/.claude/
  team-state.md            # Shared team context — committed to git
  personal-state.md        # Personal context — gitignored
```

### Session Start

1. Read `~/.claude/global-state.md`
2. Read `.claude/team-state.md` and `.claude/personal-state.md` in the current repo (fall back to `.claude/state.md` for legacy repos)
3. Check the Memory Files table — load any `~/.claude/memory/` files whose keywords match this session's topic
4. Summarize current state, then ask: **"What's the goal for this session? What does success look like?"**

### Mid-Session — Drift Detection

If work drifts from the stated goal, flag it:
> *"Quick check — we set out to [goal]. This feels like [tangent]. Stay the course or pivot?"*

### Elicitation Prompts

When a technical or product decision is made without stated reasoning, ask ONE of:
- "What alternatives did you consider?"
- "What constraint or requirement drove this choice?"
- "What would need to change for you to reverse this decision?"
- "Who else on the team does this affect, and how?"
- "What's the risk if this assumption is wrong?"

Do not ask if the decision already includes reasoning, tradeoffs, or constraints.
Do not ask more than once per decision. Do not ask during routine implementation.

### Rules

- Keep `global-state.md` under 80 lines. Detail goes in `~/.claude/memory/` files.
- Per-repo state files stay focused on that repo only.
- New cross-repo topics get new files in `~/.claude/memory/`, not appended to global-state.md.
- Do NOT use external memory databases or CLI tools for state storage. Use plain markdown files only.
