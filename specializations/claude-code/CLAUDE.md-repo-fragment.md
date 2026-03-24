
## Session State Protocol

**At session start (REQUIRED):**
1. Read `~/.claude/global-state.md` — preferences, active projects, memory file manifest
2. Read `.claude/team-state.md` in this repo — shared team context (architecture decisions, conventions, sprint focus, gotchas)
3. Read `.claude/personal-state.md` in this repo — your personal context (current focus, working notes, opinions)
4. Check the Memory Files table in global-state.md — load any `~/.claude/memory/` files relevant to this session's topic

**At session end (when user says stop/done/pause/tomorrow):**
1. Update `.claude/team-state.md` with shared context: architecture decisions, conventions, gotchas the whole team should know
2. Update `.claude/personal-state.md` with personal context: your next steps, working notes, opinions
3. Do NOT update `~/.claude/global-state.md` — its Active Projects table is rebuilt automatically by `wayfind status`.
4. If significant new cross-repo context was created (patterns, strategies, decisions), create or update a file in `~/.claude/memory/` and add it to the Memory Files manifest in global-state.md

**NEVER write secrets, API keys, tokens, or credentials into memory or state files.** Store pointers to where secrets live, not the secrets themselves.
**Do NOT write Wayfind files to `~/.claude/projects/<project>/memory/` root** — that's Claude Code's native auto-memory space.
**Do NOT use external memory databases or CLI tools for state storage.** Use plain markdown files only.
