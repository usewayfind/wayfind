#!/bin/bash
# Daily memory systems comparison report — posts to Slack via bot token.
# Add to crontab: 43 8 * * * /home/greg/repos/greg/wayfind/bin/memory-report.sh
#
# Runs on host (needs access to ~/.claude/projects for auto-memory).
# Pulls SLACK_BOT_TOKEN from the wayfind container if not set locally.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANNEL="${SLACK_MEMORY_REPORT_CHANNEL:-C0AHV3UUW67}"
DATE=$(date +%Y-%m-%d)
PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Get Slack token from container if not in environment
if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  SLACK_BOT_TOKEN=$(docker exec wayfind printenv SLACK_BOT_TOKEN 2>/dev/null || true)
fi
if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  echo "[$DATE] No SLACK_BOT_TOKEN available — skipping report"
  exit 0
fi

# Generate comparison
REPORT=$(node "$SCRIPT_DIR/memory-compare.js" 2>&1)

# Format for Slack
PAYLOAD=$(node -e "
const report = process.argv[1];
const date = process.argv[2];
const msg = ':brain: *Daily Memory Systems Report — ' + date + '*\n\`\`\`\n' + report.replace(/=== Memory Systems Comparison ===\n\n/, '') + '\n\`\`\`';
const body = JSON.stringify({ channel: process.argv[3], text: msg });
process.stdout.write(body);
" "$REPORT" "$DATE" "$CHANNEL")

# Post to Slack
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null

echo "[$DATE] Memory report posted to Slack"
