'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;

// Persona emoji map
const PERSONA_EMOJI = {
  unified: ':compass:',
  engineering: ':wrench:',
  product: ':dart:',
  design: ':art:',
  strategy: ':telescope:',
};

// ── Markdown to Slack mrkdwn conversion ─────────────────────────────────────

/**
 * Convert standard markdown to Slack mrkdwn format.
 * Preserves code blocks unchanged; converts bold, headings, links, lists, and
 * tables to Slack-compatible formatting.
 * @param {string} markdown - Markdown content
 * @returns {string} Slack mrkdwn content
 */
function markdownToMrkdwn(markdown) {
  if (!markdown) return '';

  // Extract code blocks to preserve them unchanged
  const codeBlocks = [];
  let text = markdown.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // Convert tables: strip | chars and format as indented lines
  // Match table rows (lines starting with optional whitespace then |)
  const lines = text.split('\n');
  const result = [];
  let inTable = false;
  let tableHeaders = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect table separator row (e.g., |---|---|)
    if (/^\|[\s:-]+\|/.test(trimmed) && /^[\s|:-]+$/.test(trimmed)) {
      inTable = true;
      continue; // skip separator row
    }

    // Detect table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());

      if (!inTable) {
        // This is a header row — save headers
        tableHeaders = cells;
        inTable = true;
        continue;
      }

      // Data row — format as key: value pairs
      if (tableHeaders.length > 0 && tableHeaders.length === cells.length) {
        for (let j = 0; j < cells.length; j++) {
          if (cells[j] && cells[j] !== '-') {
            result.push(`    ${tableHeaders[j]}: ${cells[j]}`);
          }
        }
        result.push('');
      } else {
        // No headers or mismatched — just output cells as indented text
        const content = cells.filter((c) => c && c !== '-').join('  ');
        if (content) {
          result.push(`    ${content}`);
        }
      }
      continue;
    }

    // End of table
    if (inTable && !trimmed.startsWith('|')) {
      inTable = false;
      tableHeaders = [];
    }

    result.push(line);
  }

  text = result.join('\n');

  // Strip horizontal rules
  text = text.replace(/^[ \t]*(---+|___+|\*\*\*+)[ \t]*$/gm, '');

  // Convert bold first (before headings, to avoid collision)
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Convert headings: # Heading -> *Heading*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Convert links: [text](url) -> <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert list items: - item -> bullet item
  text = text.replace(/^(\s*)- (.+)$/gm, '$1\u2022 $2');

  // Restore code blocks
  text = text.replace(/__CODE_BLOCK_(\d+)__/g, (_, idx) => {
    return codeBlocks[parseInt(idx, 10)];
  });

  return text;
}

// ── Date formatting ─────────────────────────────────────────────────────────

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Format a date range as "Feb 24 \u2013 Feb 28" (abbreviated month, en-dash).
 * @param {{ from: string, to: string }} dateRange
 * @returns {string}
 */
function formatDateRange(dateRange) {
  const from = new Date(dateRange.from + 'T00:00:00');
  const to = new Date(dateRange.to + 'T00:00:00');
  const fromStr = `${MONTH_ABBR[from.getUTCMonth()]} ${from.getUTCDate()}`;
  const toStr = `${MONTH_ABBR[to.getUTCMonth()]} ${to.getUTCDate()}`;
  return `${fromStr} \u2013 ${toStr}`;
}

/**
 * Capitalize the first letter of a string.
 * @param {string} str
 * @returns {string}
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ── HTTP POST ───────────────────────────────────────────────────────────────

/**
 * POST a JSON payload to a Slack incoming webhook URL.
 * @param {string} webhookUrl - Full HTTPS webhook URL
 * @param {Object} payload - JSON payload to send
 * @returns {Promise<{ ok: true }>}
 */
function postToWebhook(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const data = JSON.stringify(payload);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
        } else {
          reject(new Error(`Slack webhook returned ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Slack webhook timeout'));
    });
    req.write(data);
    req.end();
  });
}

// ── Bot token delivery ──────────────────────────────────────────────────────

/**
 * Deliver a digest to Slack via chat.postMessage (bot token).
 * Returns the message ts for reaction tracking.
 *
 * @param {string} botToken - Slack bot OAuth token (xoxb-...)
 * @param {string} channel - Slack channel ID or name
 * @param {string} content - Formatted mrkdwn content (already converted)
 * @param {string} personaName - Persona ID
 * @returns {Promise<{ ok: true, persona: string, ts: string, channel: string }>}
 */
async function deliverViaBot(botToken, channel, content, personaName) {
  const { WebClient } = require('@slack/web-api');
  const client = new WebClient(botToken);

  const truncated = content.length > 3900 ? content.slice(0, 3900) + '\n\n_...truncated_' : content;

  const result = await client.chat.postMessage({
    channel,
    text: truncated,
    unfurl_links: false,
  });

  // Post a threaded follow-up asking for feedback
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: result.ts,
      text: '_React to the digest or reply here with feedback — what was useful? What was missing? Your input shapes future digests._',
      unfurl_links: false,
    });
  } catch (err) {
    // Non-fatal — digest was delivered, feedback prompt is optional
  }

  return { ok: true, persona: personaName, ts: result.ts, channel: result.channel };
}

// ── Deliver ─────────────────────────────────────────────────────────────────

/**
 * Deliver a digest to Slack via incoming webhook or bot token.
 * In simulation mode, writes the payload JSON to disk instead of POSTing.
 *
 * @param {string} webhookUrl - Slack incoming webhook URL
 * @param {string} digestContent - Markdown content of the digest
 * @param {string} personaName - Persona ID (engineering, product, design, strategy)
 * @param {{ from: string, to: string }} dateRange - Date range for the digest
 * @param {Object} [options] - Optional delivery options
 * @param {string} [options.botToken] - Slack bot token for chat.postMessage delivery
 * @param {string} [options.channel] - Slack channel for bot delivery
 * @returns {Promise<{ ok: true, persona: string, ts?: string, channel?: string }>}
 */
async function deliver(webhookUrl, digestContent, personaName, dateRange, options) {
  const emoji = PERSONA_EMOJI[personaName] || ':memo:';
  const label = personaName === 'unified' ? 'Wayfind' : capitalize(personaName);
  const range = formatDateRange(dateRange);
  const mrkdwn = markdownToMrkdwn(digestContent);
  const formattedText = `${emoji} *${label} Digest* (${range})\n\n${mrkdwn}`;

  const payload = {
    text: formattedText,
    unfurl_links: false,
    unfurl_media: false,
  };

  // Simulation mode: write payload to disk
  if (process.env.TEAM_CONTEXT_SIMULATE === '1') {
    const digestsDir = path.join(HOME, '.claude', 'team-context', 'digests');
    fs.mkdirSync(digestsDir, { recursive: true });
    const outFile = path.join(digestsDir, `${dateRange.to}-slack-${personaName}.json`);
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return { ok: true, persona: personaName };
  }

  // Try bot token delivery first (returns message ts for reaction tracking)
  const opts = options || {};
  if (opts.botToken && opts.channel) {
    try {
      return await deliverViaBot(opts.botToken, opts.channel, formattedText, personaName);
    } catch (err) {
      console.error(`Bot delivery failed for ${personaName}, falling back to webhook: ${err.message}`);
    }
  }

  // Fallback: POST to webhook
  await postToWebhook(webhookUrl, payload);
  return { ok: true, persona: personaName };
}

// ── Deliver All ─────────────────────────────────────────────────────────────

/**
 * Deliver digests for multiple personas to Slack.
 * Reads each persona's digest file and calls deliver() with a 1-second delay
 * between posts to respect Slack rate limits.
 *
 * @param {string} webhookUrl - Slack incoming webhook URL
 * @param {Object} digestResult - Return value from generateDigest():
 *   { files: string[], personas: string[], dateRange: { from, to } }
 * @param {string[]} personaIds - Array of persona IDs to deliver
 * @param {Object} [options] - Optional delivery options
 * @param {string} [options.botToken] - Slack bot token for chat.postMessage delivery
 * @param {string} [options.channel] - Slack channel for bot delivery
 * @returns {Promise<Array<{ ok: true, persona: string, ts?: string, channel?: string }>>}
 */
async function deliverAll(webhookUrl, digestResult, personaIds, options) {
  const results = [];
  const toDate = digestResult.dateRange.to;

  for (let i = 0; i < personaIds.length; i++) {
    const persona = personaIds[i];

    try {
      // Read the digest file for this persona
      const digestFile = path.join(
        HOME, '.claude', 'team-context', 'digests', persona, `${toDate}.md`
      );

      let content;
      try {
        content = fs.readFileSync(digestFile, 'utf8');
      } catch {
        results.push({ ok: false, persona, error: `Digest file not found: ${digestFile}` });
        continue;
      }

      // Rate limit: 1 second delay between posts (skip before first)
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }

      const result = await deliver(webhookUrl, content, persona, digestResult.dateRange, options);
      results.push(result);
    } catch (err) {
      results.push({ ok: false, persona, error: err.message });
    }
  }

  return results;
}

module.exports = {
  deliver,
  deliverAll,
  deliverViaBot,
  markdownToMrkdwn,
  postToWebhook,
};
