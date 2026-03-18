# Bootstrap Prompt

Copy and paste the block below into a new Claude Code session. That's it.

---

```
Please set up Wayfind for my Claude Code environment.

Step 1 — Install the CLI:
npm install -g wayfind
wayfind init

Step 2 — Install the Claude Code plugin:
/plugin marketplace add usewayfind/wayfind
/plugin install wayfind@usewayfind

Once both steps complete:
1. Tell me what was installed and what still needs to be configured
2. Run /wayfind:init-memory to initialize memory for the current repo
3. Ask me what my preferences are (communication style, tool preferences, commit
   conventions, anything I want Claude to always know) so we can fill in
   global-state.md together
4. Ask me if I want to set up backup (see below) — I will need to provide a
   private GitHub repo URL before you can proceed with that step
5. Run `wayfind whoami --setup` so I can provide my Slack user ID (used for @mentions and DMs)
6. Ask me if I want to set up team context (/wayfind:init-team) for shared journals,
   digests, and product state
7. Let me know that anonymous usage telemetry is enabled by default (set TEAM_CONTEXT_TELEMETRY=false to opt out)
```

---

## What happens

The CLI install creates:
- `~/.claude/memory/` and `~/.claude/memory/journal/`
- `~/.claude/global-state.md` (your persistent index)

The plugin provides:
- SessionStart and Stop hooks (context loading, decision extraction)
- Slash commands: `/wayfind:init-memory`, `/wayfind:init-team`, `/wayfind:journal`, `/wayfind:doctor`, `/wayfind:standup`

After the paste, Claude will walk you through filling in your preferences. From
then on, every session in every repo will start with full context of where you
left off. You don't need to do anything special — just open Claude Code and
start working. Claude reads the state files automatically.

---

## Setting up backup (recommended)

Your memory files live locally at `~/.claude/`. If you want them backed up and
synced across machines, you need to provide a **private GitHub repo**.

**You must create this repo yourself** — Claude cannot do it for you.

Steps:
1. Go to github.com/new
2. Create a **private** repo (name it anything — e.g. `claude-memory`)
3. Copy the repo URL (SSH preferred: `git@github.com:you/claude-memory.git`)
4. Tell Claude: *"Set up backup using <your-repo-url>"*

Claude will then run:
```
bash ~/.claude/team-context/backup/setup.sh <your-repo-url>
```

This will:
- Clone your backup repo to `~/.claude-backup/`
- Do an initial sync of your memory files
- Install hooks that automatically restore at session start and push at session end

After that, your memory is backed up silently on every session — no manual steps.

---

## Setting up team context (optional)

Once you have the basics working, run `/wayfind:init-team` in a Claude Code session to set up:
- A shared team context repo for journals and digests
- Slack integration for weekly digest posts
- Notion integration for browseable product state and digest archives
- Product state for your pilot repo (PM intent, success criteria, constraints)

This is the team-level layer — it turns individual session context into shared
visibility across product, engineering, and strategy.

---

## Per-repo initialization

In any repo you work in, run:
```
/wayfind:init-memory
```

Claude will create `.claude/team-state.md` (shared) and `.claude/personal-state.md`
(gitignored), fix your `.gitignore`, and register the repo in your global index.

---

## For Cursor users

```
npm install -g wayfind
wayfind init-cursor
```

(The Claude Code plugin is not available for Cursor — use the CLI-only setup.)

---

## Source

https://github.com/usewayfind/wayfind

To install a specific version:
```
npm install -g wayfind@2.0.15
wayfind init
```

Or via the shell installer with a pinned version:
```
WAYFIND_VERSION=v2.0.15 bash <(curl -fsSL https://raw.githubusercontent.com/usewayfind/wayfind/main/install.sh)
```
