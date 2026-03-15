# Generic Specialization
## Any AI Tool with System Prompt Support

If your tool doesn't have a file-based instruction system, you can still use this kit by pasting the session protocol into your system prompt or the beginning of each conversation.

## Option 1: System Prompt Injection

Paste the contents of `../../templates/session-protocol-fragment.md` into your tool's system prompt field. Adjust the memory directory path from `~/.ai-memory/` to wherever you want to store the files.

## Option 2: Conversation Starter

If your tool has no persistent system prompt, start each session with:

```
Before we begin: read ~/.ai-memory/global.md and .ai-memory/state.md in this repo.
Summarize where we left off, then ask what the goal is for this session.
```

## Memory Directory

Use `~/.ai-memory/` as a tool-neutral memory root:

```bash
mkdir -p ~/.ai-memory/memory/journal
cp ../../templates/global.md ~/.ai-memory/global.md
```

## Session End

Since there are no hooks, you must explicitly trigger the state update:

> "We're done for today. Please update the state files."

The AI will update `.ai-memory/state.md` and append to the journal. Do NOT update `~/.ai-memory/global.md` at session end — it is rebuilt automatically by `wayfind status`.

## Limitations

- No automatic session-start file loading (must be in system prompt or triggered manually)
- No hook support for automation
- No custom commands

## What Still Works

- All the file templates
- The protocol itself (session goals, drift checks, journal)
- Topic memory files
- Cross-session continuity (as long as the AI reads the files)
