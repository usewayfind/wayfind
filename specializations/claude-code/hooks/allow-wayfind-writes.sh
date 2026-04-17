#!/usr/bin/env bash
# Auto-approve Write permission requests for known-safe Wayfind state files.
# Runs as a PermissionRequest hook so it fires before Claude Code's sensitive-file
# prompt — the allowlist in settings.json doesn't suppress that prompt.
#
# Returns {"decision": "allow"} for matched paths, exits 0 with no output otherwise
# (Claude Code falls through to its normal permission handling).

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[ -z "$file_path" ] && exit 0

# Expand leading tilde to $HOME
expanded="${file_path/#\~/$HOME}"

if [[ "$expanded" == "$HOME/.claude/memory/"* ]] || \
   [[ "$expanded" == "$HOME/.claude/global-state.md" ]] || \
   [[ "$expanded" == "$HOME/.claude/state.md" ]] || \
   [[ "$expanded" == *"/.claude/team-state.md" ]] || \
   [[ "$expanded" == *"/.claude/personal-state.md" ]]; then
  echo '{"decision": "allow"}'
  exit 0
fi
