---
name: session-protocol
description: Wayfind session memory protocol — state file locations and conventions. The plugin's hooks handle automation (loading/saving); this skill tells the AI where state files live.
disable-model-invocation: false
user-invocable: false
---

## Wayfind — Session Memory Protocol

Automation (project index rebuild, decision extraction, journal sync) is handled by
the plugin's hooks. This skill tells you where state files live so you can load context.

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
4. Briefly summarize current state for the user

### Rules

- Keep `global-state.md` under 80 lines. Detail goes in `~/.claude/memory/` files.
- Per-repo state files stay focused on that repo only.
- New cross-repo topics get new files in `~/.claude/memory/`, not appended to global-state.md.
- Do NOT use external memory databases or CLI tools for state storage. Use plain markdown files only.
