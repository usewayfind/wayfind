'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const contentStore = require('./content-store');
const llm = require('./connectors/llm');
const { markdownToMrkdwn } = require('./slack');
const telemetry = require('./telemetry');

// ── Slack connection state (for healthcheck) ────────────────────────────────
let slackConnected = false;

// ── Feature map (loaded at startup, reloaded on-demand) ──────────────────────
/** In-memory feature map: { "org/repo": { tags: string[], description: string } } */
let featureMap = null;
let slackLastConnected = null;
let slackLastDisconnected = null;

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE;
const WAYFIND_DIR = path.join(HOME, '.claude', 'team-context');
const SIGNALS_DIR = path.join(WAYFIND_DIR, 'signals');
const ENV_FILE = path.join(WAYFIND_DIR, '.env');

/** Slack mrkdwn has a practical limit; split responses over this threshold. */
const MAX_RESPONSE_LENGTH = 3000;

/** Maximum number of search results to feed into the synthesis prompt. */
const MAX_SEARCH_RESULTS = 5;

/** Maximum thread exchanges to include as conversation context. */
const MAX_THREAD_EXCHANGES = 5;

/** Build the system prompt for the LLM synthesis step (includes current date). */
function buildSynthesisPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Wayfind, a team decision trail assistant. You answer questions about the team's engineering decisions, work sessions, and project history using the provided decision trail entries.

Today's date is ${today}.

Rules:
- Lead with the answer. Summarize what happened, what was decided, and what the outcome was.
- Be concise and specific. Under 500 words.
- Cite dates and repos when referencing decisions or sessions.
- The entries below ARE the full session notes, not summaries or titles. Read them carefully and use specific details from the Why/What/Outcome/Lessons fields.
- Never say you only have titles, headers, or tags — you have the complete content.
- Never recommend the user "check the full content" — you already have it.
- If the entries answer the question, answer confidently with specifics.
- CRITICAL: If the user asks about a specific time period (e.g. "today", "this week", "yesterday") and the entries don't fall within that period, say so clearly. Do NOT present older entries as if they match the requested time frame. Instead say something like "I don't have any entries for [requested period]. The most recent activity I have for [repo] is from [date]."
- Each entry has an Author field. When a user asks about a specific person (e.g. "what did Nick do"), use the Author field to identify entries BY that person, not entries that merely MENTION them in the content. A person can appear in content without being the author.
- When presenting entries, always mention who wrote them (the author).
- If previous thread exchanges are provided, use them for conversational context. Answer follow-up questions naturally without asking the user to repeat themselves.
- If thread history was truncated, note that you only have partial history and may be missing earlier context.
- Format your response in markdown. Use bullet points for lists.
- Do not invent information that isn't in the provided context.`;
}

// ── Feature map ──────────────────────────────────────────────────────────────

/**
 * Load features.json from the team-context repo into memory.
 * Silently no-ops if the file doesn't exist.
 * @param {Object} config - Bot config (uses team_context_dir or TEAM_CONTEXT_TEAM_CONTEXT_DIR)
 */
function loadFeatureMap(config) {
  const teamDir = config.team_context_dir || process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR || '';
  if (!teamDir) return;
  const featuresFile = path.join(teamDir, 'features.json');
  try {
    const raw = fs.readFileSync(featuresFile, 'utf8');
    featureMap = JSON.parse(raw);
  } catch {
    featureMap = null;
  }
}

/**
 * Use Haiku to determine which repos are relevant to a query, based on the feature map.
 * Returns an array of repo slugs (e.g. ["org/api-service", "org/analytics"]).
 * Returns null if routing cannot be determined (map empty, LLM fails, etc.).
 * @param {string} query
 * @param {Object} map - Feature map object
 * @param {Object} llmConfig - LLM configuration
 * @returns {Promise<string[]|null>}
 */
async function routeQueryToRepos(query, map, llmConfig) {
  if (!map || Object.keys(map).length === 0) return null;

  const repoList = Object.entries(map).map(([repo, entry]) => {
    const tags = (entry.tags || []).join(', ');
    const desc = entry.description ? ` — ${entry.description}` : '';
    return `${repo}: ${tags}${desc}`;
  }).join('\n');

  const systemPrompt = `You are a routing assistant. Given a user query and a list of repositories with their feature tags, return a JSON array of repository slugs (e.g. ["org/repo"]) that are most relevant to the query. Return only the repos that are clearly relevant. If no repos match, return an empty array. Return only valid JSON — no explanation.`;

  const userContent = `Query: ${query}\n\nRepositories:\n${repoList}`;

  const haikuConfig = {
    ...llmConfig,
    model: process.env.TEAM_CONTEXT_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
  };

  try {
    const raw = await llm.call(haikuConfig, systemPrompt, userContent);
    const parsed = JSON.parse(raw.trim());
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Save a key=value pair to ~/.claude/team-context/.env.
 * Appends or updates the key. Creates the file if missing.
 */
function saveEnvKey(key, value) {
  fs.mkdirSync(WAYFIND_DIR, { recursive: true });
  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  }
  const prefix = `${key}=`;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const entry = `${key}=${value}`;
  if (idx !== -1) {
    lines[idx] = entry;
  } else {
    lines.push(entry);
  }
  fs.writeFileSync(ENV_FILE, lines.filter((l) => l !== '').join('\n') + '\n', 'utf8');
  console.log(`Saved to ${ENV_FILE}`);
}

/**
 * Split a long message into chunks that fit within Slack's size limits.
 * Tries to split at paragraph boundaries when possible.
 * @param {string} text - Text to split
 * @param {number} maxLen - Maximum chunk length
 * @returns {string[]}
 */
function chunkMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at a paragraph break
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      // Paragraph break is too early — try a single newline
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // No good break point — hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Thread history ──────────────────────────────────────────────────────────

/**
 * Fetch prior exchanges from a Slack thread for conversation context.
 * Returns the first exchange (topic anchor) plus the most recent N-1 exchanges.
 * @param {Object} client - Slack Web API client
 * @param {string} channel - Channel ID
 * @param {string} threadTs - Thread timestamp
 * @param {string} botUserId - Bot's Slack user ID
 * @param {string} currentEventTs - Current message ts (excluded from history)
 * @returns {Promise<Array<{ question: string, answer: string }>>}
 */
async function fetchThreadHistory(client, channel, threadTs, botUserId, currentEventTs) {
  let messages;
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
    });
    messages = result.messages || [];
  } catch (err) {
    console.error(`Failed to fetch thread history: ${err.message}`);
    return [];
  }

  // Exclude the current message — it's the new query, not history
  messages = messages.filter((m) => m.ts !== currentEventTs);

  // Pair user questions (messages mentioning the bot) with bot answers
  const exchanges = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isBotMention = msg.text && botUserId && msg.text.includes(`<@${botUserId}>`);
    if (!isBotMention) continue;

    // Look for the bot's reply — next message from the bot
    const query = extractQuery(msg.text, botUserId);
    let answer = '';
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].user === botUserId || messages[j].bot_id) {
        answer = messages[j].text || '';
        break;
      }
    }
    if (query && answer) {
      exchanges.push({ question: query, answer });
    }
  }

  if (exchanges.length <= MAX_THREAD_EXCHANGES) return exchanges;

  // First exchange anchors the topic, plus the most recent N-1
  const first = exchanges[0];
  const recent = exchanges.slice(-(MAX_THREAD_EXCHANGES - 1));
  const truncated = [first, ...recent];
  truncated._truncated = true;
  return truncated;
}

/**
 * Format thread history as context for the LLM prompt.
 * @param {Array<{ question: string, answer: string }>} exchanges
 * @returns {string}
 */
function formatThreadContext(exchanges) {
  if (!exchanges || exchanges.length === 0) return '';

  const lines = ['Previous exchanges in this thread:'];
  if (exchanges._truncated) {
    lines.push('(Thread history truncated — oldest exchanges between the first and most recent were omitted.)');
  }
  lines.push('');
  for (const ex of exchanges) {
    lines.push(`Q: ${ex.question}`);
    lines.push(`A: ${ex.answer}`);
    lines.push('---');
  }
  return lines.join('\n');
}

// ── Query pipeline ───────────────────────────────────────────────────────────

/**
 * Extract the actual query from a Slack message text.
 * Strips bot mention patterns like <@U12345> and @wayfind prefix.
 * @param {string} text - Raw message text from Slack
 * @param {string} [botUserId] - Bot's Slack user ID
 * @returns {string} - Cleaned query text
 */
function extractQuery(text, botUserId) {
  let query = text;

  // Strip Slack user mention: <@U12345>
  if (botUserId) {
    query = query.replace(new RegExp(`<@${botUserId}>`, 'g'), '');
  }
  // Strip any remaining <@...> mentions
  query = query.replace(/<@[A-Z0-9]+>/g, '');

  // Trim before checking @wayfind prefix so leading spaces don't prevent match
  query = query.trim();

  // Strip @wayfind prefix (case-insensitive)
  query = query.replace(/^@wayfind\s*/i, '');

  return query.trim();
}

// ── Intent classification ────────────────────────────────────────────────────

/**
 * Signal-related keywords grouped by channel.
 * Used for fast heuristic intent classification before falling back to LLM.
 */
const SIGNAL_KEYWORDS = {
  intercom: [
    'intercom', 'conversations', 'support tickets', 'customer complaints',
    'customer feedback', 'support trends', 'support volume', 'inbox',
    'customer issues', 'customer signals', 'support signals',
  ],
  github: [
    'github signals', 'ci failures', 'build failures', 'failing tests',
    'open issues', 'stale prs', 'pr trends',
  ],
};

/** Keywords that strongly indicate engineering activity (decision trail) queries. */
const ENGINEERING_KEYWORDS = [
  'decision', 'decided', 'architecture', 'session', 'working on',
  'work was done', 'work done', 'work happened',
  'commit', 'shipped', 'deployed', 'refactor', 'implemented',
  'sprint', 'standup', 'retrospective', 'onboard',
  'built', 'merged', 'released', 'fixed',
];

/**
 * Classify the intent of a user query.
 * Returns { type: 'signals'|'engineering'|'mixed', channel?: string }.
 *
 * Uses keyword heuristics — fast, no API call needed. The LLM synthesis
 * step will handle nuance; this just routes to the right data source.
 */
function classifyIntent(query) {
  const q = query.toLowerCase();

  // Check for signal channel keywords
  let signalChannel = null;
  let signalScore = 0;
  for (const [channel, keywords] of Object.entries(SIGNAL_KEYWORDS)) {
    for (const kw of keywords) {
      if (q.includes(kw)) {
        signalChannel = channel;
        signalScore++;
      }
    }
  }

  // Check for engineering keywords
  let engineeringScore = 0;
  for (const kw of ENGINEERING_KEYWORDS) {
    if (q.includes(kw)) engineeringScore++;
  }

  if (signalChannel && engineeringScore > 0) {
    return { type: 'mixed', channel: signalChannel };
  }
  if (signalChannel) {
    return { type: 'signals', channel: signalChannel };
  }
  return { type: 'engineering' };
}

// ── Signal search ────────────────────────────────────────────────────────────

/**
 * Search signal files for a given channel.
 * Reads the most recent signal markdown files and returns their content.
 * @param {string} channel - Signal channel name (e.g. 'intercom', 'github')
 * @param {number} [maxFiles=3] - Maximum number of recent signal files to include
 * @returns {{ files: string[], content: string, available: boolean }}
 */
function searchSignals(channel, maxFiles) {
  const limit = maxFiles || 3;
  const channelDir = path.join(SIGNALS_DIR, channel);

  if (!fs.existsSync(channelDir)) {
    return { files: [], content: '', available: false };
  }

  let files;
  try {
    files = fs.readdirSync(channelDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return { files: [], content: '', available: false };
  }

  if (files.length === 0) {
    return { files: [], content: '', available: false };
  }

  const contentParts = [];
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(channelDir, f), 'utf8');
      contentParts.push(text);
    } catch {
      // Skip unreadable files
    }
  }

  return {
    files,
    content: contentParts.join('\n\n---\n\n'),
    available: contentParts.length > 0,
  };
}

/** Build a system prompt for signal-based questions. */
function buildSignalSynthesisPrompt(channel) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Wayfind, a team context assistant. You answer questions about business signals and trends using data pulled from ${channel}.

Today's date is ${today}.

Rules:
- Lead with the answer. Summarize trends, patterns, and notable items.
- Be concise and specific. Under 500 words.
- Use the signal data provided — it contains volume, tags, topics, and open items.
- If the data covers a different time period than what was asked, say so clearly.
- If the signal data is empty or unavailable, say so honestly.
- Format your response in markdown. Use bullet points for lists.
- Do not invent information that isn't in the provided context.`;
}

/**
 * Search the content store for entries matching the query.
 * Tries semantic search first, falls back to text search.
 * @param {string} query - Search query
 * @param {Object} config - Bot config (may contain store_path)
 * @returns {Promise<Array<{ id: string, score: number, entry: Object }>>}
 */
/**
 * Resolve temporal references in a query to {since, until} date filters.
 * Returns null values for fields that aren't constrained.
 */
function resolveDateFilters(query) {
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const lower = query.toLowerCase();

  if (/\btoday\b/.test(lower)) {
    return { since: fmt(today), until: fmt(today) };
  }
  if (/\byesterday\b/.test(lower)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return { since: fmt(d), until: fmt(d) };
  }
  if (/\bthis week\b/.test(lower)) {
    const d = new Date(today);
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); // Monday
    return { since: fmt(d), until: fmt(today) };
  }
  if (/\blast week\b/.test(lower)) {
    const d = new Date(today);
    const day = d.getDay();
    const thisMon = new Date(d);
    thisMon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const lastMon = new Date(thisMon);
    lastMon.setDate(thisMon.getDate() - 7);
    const lastSun = new Date(thisMon);
    lastSun.setDate(thisMon.getDate() - 1);
    return { since: fmt(lastMon), until: fmt(lastSun) };
  }
  if (/\blast (\d+) days?\b/.test(lower)) {
    const n = parseInt(lower.match(/\blast (\d+) days?\b/)[1], 10);
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return { since: fmt(d), until: fmt(today) };
  }

  // Check for explicit YYYY-MM-DD dates in the query
  const dateMatch = query.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
  if (dateMatch) {
    if (dateMatch.length >= 2) {
      const sorted = dateMatch.sort();
      return { since: sorted[0], until: sorted[sorted.length - 1] };
    }
    return { since: dateMatch[0], until: dateMatch[0] };
  }

  // Parse natural language dates: "March 3", "March 3 and March 6",
  // "between March 3 and March 6", "March 3-6", "March 3 to March 6"
  const monthNames = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const monthPattern = Object.keys(monthNames).join('|');
  const naturalDates = [];

  // "March 3-6" or "March 3 - 6" (range within same month)
  const sameMonthRange = lower.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\b`));
  if (sameMonthRange) {
    const month = monthNames[sameMonthRange[1]];
    const year = resolveYear(today, month);
    const d1 = new Date(year, month, parseInt(sameMonthRange[2], 10));
    const d2 = new Date(year, month, parseInt(sameMonthRange[3], 10));
    return { since: fmt(d1), until: fmt(d2) };
  }

  // Find all "Month Day" patterns
  const monthDayRegex = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})\\b`, 'g');
  let m;
  while ((m = monthDayRegex.exec(lower)) !== null) {
    const month = monthNames[m[1]];
    const day = parseInt(m[2], 10);
    if (day >= 1 && day <= 31) {
      const year = resolveYear(today, month);
      naturalDates.push(new Date(year, month, day));
    }
  }

  if (naturalDates.length >= 2) {
    naturalDates.sort((a, b) => a - b);
    return { since: fmt(naturalDates[0]), until: fmt(naturalDates[naturalDates.length - 1]) };
  }
  if (naturalDates.length === 1) {
    return { since: fmt(naturalDates[0]), until: fmt(naturalDates[0]) };
  }

  return { since: null, until: null };
}

/** Resolve year for a month reference — use current year, or previous year if the month is in the future. */
function resolveYear(today, month) {
  return month > today.getMonth() ? today.getFullYear() - 1 : today.getFullYear();
}

/** Words that are temporal references, not content keywords. */
const TEMPORAL_WORDS = new Set([
  'today', 'yesterday', 'week', 'this', 'last', 'days', 'day',
  'recent', 'recently', 'latest', 'current', 'now', 'between', 'and', 'to',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);

/**
 * Strip temporal and filler words from a query to get content keywords.
 * Returns the cleaned query string.
 */
function stripTemporalWords(query) {
  const filler = new Set(['what', 'happened', 'show', 'me', 'tell', 'about',
    'are', 'is', 'the', 'any', 'all', 'from', 'in', 'on', 'for', 'of',
    'how', 'many', 'much', 'were', 'was', 'there', 'can', 'you', 'do',
    'did', 'has', 'have', 'been', 'get', 'give', 'list', 'count',
    'journal', 'entries', 'entry', 'sessions', 'session', 'made']);
  return query
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter(w => w.length > 1 && !TEMPORAL_WORDS.has(w) && !filler.has(w))
    .join(' ');
}

async function searchDecisionTrail(query, config) {
  const searchOpts = {
    limit: MAX_SEARCH_RESULTS,
  };
  if (config.store_path) {
    searchOpts.storePath = config.store_path;
  }
  if (config.journal_dir) {
    searchOpts.journalDir = config.journal_dir;
  }
  if (config._repoFilter && config._repoFilter.length > 0) {
    searchOpts.repos = config._repoFilter;
  }

  // Resolve temporal references to date filters
  const dateFilters = resolveDateFilters(query);
  if (dateFilters.since) searchOpts.since = dateFilters.since;
  if (dateFilters.until) searchOpts.until = dateFilters.until;

  // Strip temporal words to get content keywords
  const contentQuery = stripTemporalWords(query);

  // If query is purely temporal (no content keywords), browse by date
  if (!contentQuery && (dateFilters.since || dateFilters.until)) {
    const browseOpts = { ...searchOpts };
    const all = contentStore.queryMetadata(browseOpts);
    return all.slice(0, searchOpts.limit).map(r => ({ ...r, score: 1 }));
  }

  // Use content keywords for search (or original query if no temporal refs)
  const searchQuery = contentQuery || query;

  let results;
  try {
    results = await contentStore.searchJournals(searchQuery, searchOpts);
  } catch {
    // Semantic search failed — fall back to text search
    results = contentStore.searchText(searchQuery, searchOpts);
  }

  // If semantic search returned empty, also try text search
  if (!results || results.length === 0) {
    results = contentStore.searchText(searchQuery, searchOpts);
  }

  // If text search returned results but none are journal entries (all signals/conversations),
  // and we have date filters, also try metadata browse to find actual journal entries.
  // This handles broad queries like "today's activity" where keyword search matches
  // signal files but misses the journal entries the user actually wants.
  if (results && results.length > 0 && (dateFilters.since || dateFilters.until)) {
    const hasJournalResults = results.some(r => {
      const source = r.entry?.source;
      return !source || source === 'journal';
    });
    if (!hasJournalResults) {
      const browseOpts = { ...searchOpts };
      const metadataResults = contentStore.queryMetadata(browseOpts);
      if (metadataResults.length > 0) {
        // Prefer metadata browse (actual journal entries) over signal-only text search
        results = metadataResults.slice(0, searchOpts.limit).map(r => ({ ...r, score: 1 }));
      }
    }
  }

  // If date-filtered search returned empty, try browsing by date
  if ((!results || results.length === 0) && (dateFilters.since || dateFilters.until)) {
    const browseOpts = { ...searchOpts };
    const all = contentStore.queryMetadata(browseOpts);
    if (all.length > 0) {
      return all.slice(0, searchOpts.limit).map(r => ({ ...r, score: 1 }));
    }

    // Still nothing — broaden to all dates so the LLM can explain what it has
    delete searchOpts.since;
    delete searchOpts.until;
    try {
      results = await contentStore.searchJournals(searchQuery, searchOpts);
    } catch {
      results = contentStore.searchText(searchQuery, searchOpts);
    }
    if (!results || results.length === 0) {
      results = contentStore.searchText(searchQuery, searchOpts);
    }
  }

  // Deduplicate: prefer distilled entries over their raw sources
  return contentStore.deduplicateResults(results || []);
}

/**
 * Synthesize an answer from search results using the LLM.
 * If synthesis fails, returns a formatted list of raw results.
 * @param {string} query - User's question
 * @param {Array<{ id: string, score: number, entry: Object }>} results - Search results
 * @param {Object} llmConfig - LLM configuration
 * @returns {Promise<string>} - Synthesized answer in markdown
 */
async function synthesizeAnswer(query, results, llmConfig, contentOpts, threadHistory) {
  if (results.length === 0) {
    return 'No matching entries found in the decision trail. Try rephrasing your question or indexing more journals with `wayfind index-journals`.';
  }

  // Build context from search results, enriching with full content where possible
  const contextParts = [];
  for (const r of results) {
    const fullContent = contentStore.getEntryContent(r.id, contentOpts || {});
    if (fullContent) {
      contextParts.push(`---\n${fullContent}`);
    } else {
      // Log why content retrieval failed for debugging
      console.log(`[content-miss] id=${r.id} date=${r.entry.date} repo=${r.entry.repo} title=${r.entry.title} opts=${JSON.stringify(contentOpts)}`);
      // Fall back to metadata-only summary
      const drift = r.entry.drifted ? ' [DRIFT]' : '';
      contextParts.push(
        `---\n${r.entry.date} | ${r.entry.repo} | ${r.entry.title}${drift}\n` +
        `Tags: ${(r.entry.tags || []).join(', ')}`
      );
    }
  }
  const context = contextParts.join('\n\n');

  const threadContext = formatThreadContext(threadHistory);
  const userContent =
    (threadContext ? `${threadContext}\n\n` : '') +
    `Question: ${query}\n\n` +
    `Here are the most relevant entries from the team's decision trail:\n\n${context}`;

  try {
    return await llm.call(llmConfig, buildSynthesisPrompt(), userContent);
  } catch (err) {
    // LLM failed — return raw results as fallback
    console.error(`LLM synthesis failed: ${err.message}`);
    return formatRawResults(results);
  }
}

/**
 * Format raw search results as a readable list.
 * Used as a fallback when LLM synthesis fails.
 * @param {Array<{ id: string, score: number, entry: Object }>} results
 * @returns {string}
 */
function formatRawResults(results) {
  if (results.length === 0) return 'No results found.';

  const lines = ['Here are the most relevant entries I found:\n'];
  for (const r of results) {
    const drift = r.entry.drifted ? ' [DRIFT]' : '';
    lines.push(`- **${r.entry.date}** | ${r.entry.repo} | ${r.entry.title}${drift}`);
  }
  lines.push('\n_LLM synthesis was unavailable. These are raw search results._');
  return lines.join('\n');
}

/**
 * Format a synthesized answer for Slack.
 * Converts markdown to Slack mrkdwn and adds a sources section.
 * @param {string} answer - Markdown answer text
 * @param {Array<{ id: string, score: number, entry: Object }>} results - Source entries
 * @returns {string} - Slack mrkdwn formatted response
 */
function formatResponse(answer, results) {
  let text = markdownToMrkdwn(answer);

  // Add sources section
  if (results && results.length > 0) {
    const sources = results.map((r) => {
      const drift = r.entry.drifted ? ' [drift]' : '';
      return `${r.entry.date} | ${r.entry.repo} | ${r.entry.title}${drift}`;
    });
    text += '\n\n_Sources:_\n' + sources.map((s) => `> ${s}`).join('\n');
  }

  return text;
}

/**
 * Resolve the prompts directory from environment or config.
 * @returns {string|null} - Path to prompts directory, or null if not found
 */
function resolvePromptsDir() {
  const teamDir = process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR || '';
  if (teamDir) {
    const dir = path.join(teamDir, 'prompts');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// ── Direct commands (no LLM needed) ─────────────────────────────────────────

/**
 * Resolve the team-context members directory from environment or config.
 * @param {Object} config - Bot config
 * @returns {string|null}
 */
function resolveMembersDir(config) {
  const teamDir = config.team_context_dir || process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR || '';
  if (teamDir) {
    const dir = path.join(teamDir, 'members');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Handle direct bot commands that don't require LLM synthesis.
 * Returns formatted text if the query matches a command, or null to fall through.
 * @param {string} query - User's question
 * @param {Object} config - Bot config
 * @returns {string|null}
 */
function handleDirectCommand(query, config) {
  const q = query.trim().toLowerCase();

  // help
  if (q === 'help' || q === '?' || q === 'commands') {
    return handleHelp();
  }

  // version
  if (q === 'version' || q === 'what version' || q === 'what version are you') {
    return handleVersion();
  }

  // members
  if (q === 'members' || q === 'team members' || q === 'who is on the team' ||
      /^(?:show|list|get)\s+(?:team\s+)?members$/i.test(query.trim()) ||
      /^(?:what|which)\s+version\s+is\s+\w+\s+(?:on|running|using)/i.test(query.trim()) ||
      /^(?:who|what)\s+version/i.test(query.trim())) {
    return handleMembers(config);
  }

  // insights
  if (q === 'insights' || q === 'journal insights' || q === 'show insights' ||
      /^(?:show|get)\s+(?:journal\s+)?insights$/i.test(query.trim())) {
    return handleInsights(config);
  }

  // digest scores / feedback
  if (q === 'digest scores' || q === 'scores' || q === 'digest feedback' ||
      /^(?:show|get)\s+(?:digest\s+)?(?:scores|feedback)$/i.test(query.trim())) {
    return handleDigestScores(config);
  }

  // signals
  if (q === 'signals' || q === 'show signals' || q === 'signal channels' ||
      /^(?:show|list|get)\s+(?:signal\s+)?channels$/i.test(query.trim())) {
    return handleSignalChannels();
  }

  return null;
}

/** Bot help command — lists available capabilities. */
function handleHelp() {
  return `*Wayfind Bot — Commands*

You can ask me anything about your team's decision trail, or use these commands:

*Queries*
• Ask any question — I'll search journals and synthesize an answer
• Use dates naturally: "what happened yesterday", "this week", "March 3-6"
• Thread replies continue the conversation without re-mentioning me

*Commands*
• \`help\` — this message
• \`version\` — bot version
• \`members\` — team members, versions, and activity
• \`insights\` — journal analytics (session count, drift rate, repo activity)
• \`digest scores\` — digest feedback and reactions
• \`signals\` — configured signal channels
• \`onboard <repo>\` — generate an onboarding context pack
• \`reindex\` — re-index all sources
• \`prompts\` — list shared team prompts
• \`show <name> prompt\` — show a specific prompt`;
}

/** Bot version command. */
function handleVersion() {
  const version = telemetry.getWayfindVersion();
  return `Wayfind v${version}`;
}

/** Bot members command — reads member profiles from team-context repo. */
function handleMembers(config) {
  const membersDir = resolveMembersDir(config);
  if (!membersDir) {
    return 'No team members directory found. Set `TEAM_CONTEXT_TEAM_CONTEXT_DIR` or configure `team_context_dir` in the bot config.';
  }

  let files;
  try {
    files = fs.readdirSync(membersDir).filter(f => f.endsWith('.json'));
  } catch {
    return 'Could not read team members directory.';
  }

  if (files.length === 0) {
    return 'No team members found. Members register via `wayfind whoami --setup`.';
  }

  const lines = ['*Team Members*\n'];
  for (const file of files.sort()) {
    try {
      const member = JSON.parse(fs.readFileSync(path.join(membersDir, file), 'utf8'));
      const name = member.name || file.replace('.json', '');
      const version = member.wayfind_version ? `v${member.wayfind_version}` : '?';
      const lastActive = member.last_active ? member.last_active.slice(0, 10) : '—';
      const personas = (member.personas || []).join(', ') || '—';
      const slackId = member.slack_id ? `<@${member.slack_id}>` : '';
      lines.push(`• *${name}* ${slackId} — ${version} — active: ${lastActive} — personas: ${personas}`);
    } catch {
      // Skip unreadable files
    }
  }

  return lines.join('\n');
}

/** Bot insights command — journal analytics. */
function handleInsights(config) {
  const opts = {};
  if (config.store_path) opts.storePath = config.store_path;

  const insights = contentStore.extractInsights(opts);

  const lines = ['*Journal Insights*\n'];
  lines.push(`Total sessions: ${insights.totalSessions}`);
  lines.push(`Drift rate: ${insights.driftRate}%`);

  if (Object.keys(insights.repoActivity).length > 0) {
    lines.push('\n*Repo activity:*');
    const sorted = Object.entries(insights.repoActivity).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [repo, count] of sorted) {
      lines.push(`  ${repo} — ${count} session(s)`);
    }
  }

  if (Object.keys(insights.tagFrequency).length > 0) {
    lines.push('\n*Top tags:*');
    const sorted = Object.entries(insights.tagFrequency).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [tag, count] of sorted) {
      lines.push(`  ${tag} — ${count}`);
    }
  }

  if (insights.timeline.length > 0) {
    lines.push('\n*Recent activity (last 7 days):*');
    const recent = insights.timeline.slice(-7);
    for (const { date, sessions } of recent) {
      const bar = '\u2588'.repeat(Math.min(sessions, 20));
      lines.push(`  ${date} ${bar} ${sessions}`);
    }
  }

  return lines.join('\n');
}

/** Bot digest scores command — feedback and reactions. */
function handleDigestScores(config) {
  const opts = { limit: 10 };
  if (config.store_path) opts.storePath = config.store_path;

  const feedback = contentStore.getDigestFeedback(opts);
  if (feedback.length === 0) {
    return 'No digest feedback yet. Reactions on digest messages will appear here.';
  }

  const lines = ['*Digest Feedback*\n'];
  for (const d of feedback) {
    const reactions = Object.entries(d.reactions)
      .map(([emoji, count]) => `:${emoji}: \u00d7 ${count}`)
      .join('  ');
    lines.push(`• ${d.date} (${d.persona}): ${reactions || 'no reactions'} — total: ${d.totalReactions}`);
    if (d.comments.length > 0) {
      for (const c of d.comments) {
        lines.push(`    \u2192 "${c.text}"`);
      }
    }
  }

  return lines.join('\n');
}

/** Bot signals command — show configured signal channels. */
function handleSignalChannels() {
  const signalsDir = process.env.TEAM_CONTEXT_SIGNALS_DIR || path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.claude', 'team-context', 'signals'
  );

  if (!fs.existsSync(signalsDir)) {
    return 'No signal channels configured. Set up channels with `wayfind pull <channel> --configure`.';
  }

  let channels;
  try {
    channels = fs.readdirSync(signalsDir).filter(f => {
      try { return fs.statSync(path.join(signalsDir, f)).isDirectory(); } catch { return false; }
    });
  } catch {
    return 'Could not read signals directory.';
  }

  if (channels.length === 0) {
    return 'No signal channels found. Set up channels with `wayfind pull <channel> --configure`.';
  }

  const lines = ['*Signal Channels*\n'];
  for (const ch of channels.sort()) {
    const chDir = path.join(signalsDir, ch);
    let fileCount = 0;
    let latestFile = null;
    try {
      const files = fs.readdirSync(chDir).filter(f => f.endsWith('.md')).sort();
      fileCount = files.length;
      latestFile = files.length > 0 ? files[files.length - 1].replace('.md', '') : null;
    } catch { /* skip */ }
    lines.push(`• *${ch}* — ${fileCount} file(s)${latestFile ? ` — latest: ${latestFile}` : ''}`);
  }

  return lines.join('\n');
}

/**
 * Handle prompt-related queries directly from the filesystem.
 * Returns formatted text if the query matches a prompt pattern, or null to fall through.
 * @param {string} query - User's question
 * @returns {string|null}
 */
function handlePromptQuery(query) {
  const promptMatch = query.match(/(?:show|get|find|what(?:'s| is)|list)\s+(?:the\s+)?(?:prompts?|(?:our|team)\s+prompts?)(?:\s+(?:for|about|called|named)\s+(.+))?/i)
    || query.match(/^prompts?$/i)
    || query.match(/prompt\s+(?:for|about|called|named)\s+(.+)/i);

  if (!promptMatch) return null;

  const promptsDir = resolvePromptsDir();
  if (!promptsDir) return null;

  const files = fs.readdirSync(promptsDir)
    .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();

  const searchTerm = (promptMatch[1] || '').trim();

  if (searchTerm) {
    // Find specific prompt
    const match = files.find(f =>
      f.toLowerCase().includes(searchTerm.toLowerCase()) ||
      f.replace('.md', '').toLowerCase() === searchTerm.toLowerCase()
    );
    if (match) {
      const content = fs.readFileSync(path.join(promptsDir, match), 'utf8');
      return `*${match.replace('.md', '')}*\n\n${content}`;
    }
    return `No prompt matching "${searchTerm}" found. Available: ${files.map(f => f.replace('.md', '')).join(', ')}`;
  }

  // List all prompts
  if (files.length === 0) {
    return 'No prompts yet. Add .md files to your team-context/prompts/ directory.';
  }
  const list = files.map(f => {
    const content = fs.readFileSync(path.join(promptsDir, f), 'utf8');
    const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || '';
    return `• *${f.replace('.md', '')}*${firstLine ? ` — ${firstLine}` : ''}`;
  }).join('\n');
  return `*Team Prompts*\n\n${list}\n\nAsk me to "show <name> prompt" to see the full text.`;
}

/**
 * Core query handler. Runs the full pipeline: search, synthesize, format.
 * Exported for independent testing without a Slack connection.
 * @param {string} query - User's question
 * @param {Object} config - Bot configuration from connectors.json
 * @returns {Promise<{ text: string, results: Array }>}
 */
async function handleQuery(query, config, threadHistory) {
  const queryStart = Date.now();

  // Check direct commands first — no LLM needed
  const directResult = handleDirectCommand(query, config);
  if (directResult) {
    return { text: directResult, results: [], _directCommand: true };
  }

  // Check if this is a prompt query — answer directly without LLM
  const promptResult = handlePromptQuery(query);
  if (promptResult) {
    return { text: promptResult, results: [], _promptQuery: true };
  }

  // On-demand feature map reload — user signals they just updated features
  if (/\b(?:just\s+(?:added|updated|set|ran)\s+(?:features?|wayfind\s+features?))\b/i.test(query) ||
      /\bwayfind\s+features\s+(?:add|set|describe)\b/i.test(query)) {
    loadFeatureMap(config);
    const count = featureMap ? Object.keys(featureMap).length : 0;
    return {
      text: count > 0
        ? `Feature map reloaded. I now know about ${count} repo(s): ${Object.keys(featureMap).join(', ')}`
        : 'Feature map reloaded, but no repos are configured yet. Run `wayfind features add` in a repo.',
      results: [],
    };
  }

  const intent = classifyIntent(query);
  const llmConfig = config.llm || {};
  const contentOpts = {};
  if (config.store_path) contentOpts.storePath = config.store_path;
  if (config.journal_dir) contentOpts.journalDir = config.journal_dir;

  // Route based on intent
  if (intent.type === 'signals' || intent.type === 'mixed') {
    const signals = searchSignals(intent.channel);

    if (signals.available) {
      // Synthesize from signal data
      const threadContext = formatThreadContext(threadHistory);
      const userContent =
        (threadContext ? `${threadContext}\n\n` : '') +
        `Question: ${query}\n\n` +
        `Here is the latest ${intent.channel} signal data:\n\n${signals.content}`;

      let answer;
      try {
        answer = await llm.call(llmConfig, buildSignalSynthesisPrompt(intent.channel), userContent);
      } catch (err) {
        console.error(`LLM synthesis failed for signals: ${err.message}`);
        answer = `Here is the raw ${intent.channel} signal data:\n\n${signals.content}`;
      }

      // For mixed intent, also search the decision trail and append
      if (intent.type === 'mixed') {
        const results = await searchDecisionTrail(query, config);
        if (results.length > 0) {
          const trailAnswer = await synthesizeAnswer(query, results, llmConfig, contentOpts, threadHistory);
          answer += '\n\n---\n\n**From the engineering decision trail:**\n\n' + trailAnswer;
        }
      }

      const text = markdownToMrkdwn(answer);
      return { text, results: [] };
    }

    // Signal data not available from files — check indexed entries
    if (intent.type === 'signals') {
      const indexedResults = await searchDecisionTrail(query, config);
      const signalEntries = indexedResults.filter(r => r.entry.repo && r.entry.repo.startsWith('signals/'));
      if (signalEntries.length > 0) {
        const answer = await synthesizeAnswer(query, signalEntries, llmConfig, contentOpts, threadHistory);
        const text = formatResponse(answer, signalEntries);
        return { text, results: signalEntries };
      }

      const text = `I don't have ${intent.channel} signal data available. ` +
        `The ${intent.channel} connector may not be configured, or no signals have been pulled yet.\n\n` +
        `To set it up: \`wayfind pull ${intent.channel} --configure\`\n` +
        `To pull now: \`wayfind pull ${intent.channel}\``;
      return { text, results: [] };
    }

    // Mixed but no signals — fall through to engineering-only
  }

  // Engineering intent (or mixed fallback)
  // For follow-up queries in threads, enrich the search with date context from prior exchanges.
  // If the current query has no date references, inherit them from the thread.
  let searchQuery = query;
  const currentDates = resolveDateFilters(query);
  if (!currentDates.since && threadHistory && threadHistory.length > 0) {
    // Combine all prior thread text and check for date references
    const priorText = threadHistory
      .flatMap(ex => [ex.question, ex.answer])
      .filter(Boolean)
      .join(' ');
    const priorDates = resolveDateFilters(priorText);
    if (priorDates.since) {
      // Append resolved dates so searchDecisionTrail picks them up
      searchQuery = `${query} ${priorDates.since}` +
        (priorDates.until !== priorDates.since ? ` ${priorDates.until}` : '');
    }
  }

  // Feature map routing: if a map exists, ask Haiku which repos are relevant
  let repoFilter = null;
  if (featureMap && Object.keys(featureMap).length > 0) {
    const routedRepos = await routeQueryToRepos(query, featureMap, llmConfig);
    if (routedRepos !== null) {
      if (routedRepos.length === 0) {
        return {
          text: "I couldn't determine which repositories are relevant to your question. If this seems wrong, run `wayfind features add` in the relevant repo(s) and try again.",
          results: [],
        };
      }
      repoFilter = routedRepos;
    }
  }

  const searchConfig = repoFilter
    ? { ...config, _repoFilter: repoFilter }
    : config;

  const results = await searchDecisionTrail(searchQuery, searchConfig);
  const answer = await synthesizeAnswer(query, results, llmConfig, contentOpts, threadHistory);
  const text = formatResponse(answer, results);
  return {
    text,
    results,
    _telemetry: {
      intent_type: intent.type,
      has_thread_history: !!(threadHistory && threadHistory.length),
      result_count: results.length,
      response_length: text.length,
      duration_ms: Date.now() - queryStart,
    },
  };
}

// ── Bot lifecycle ────────────────────────────────────────────────────────────

/**
 * Start the Slack bot using Socket Mode.
 * Connects to Slack, listens for @mentions, and runs the query pipeline.
 * @param {Object} config - Bot configuration from connectors.json (slack_bot key)
 * @returns {Promise<{ app: Object, stop: Function }>}
 */
async function start(config) {
  // Lazy-require @slack/bolt so the module can be loaded without it installed
  // (e.g. for configure-only flows or testing)
  let App, LogLevel;
  try {
    const bolt = require('@slack/bolt');
    App = bolt.App;
    LogLevel = bolt.LogLevel;
  } catch {
    throw new Error(
      '@slack/bolt is not installed. Run "npm install @slack/bolt" in the Wayfind directory.'
    );
  }

  // Ensure journal_dir has a default for configs saved before this field existed
  if (!config.journal_dir) {
    config.journal_dir = process.env.TEAM_CONTEXT_JOURNALS_DIR || '/data/journals';
  }

  // Resolve tokens from environment
  const botTokenEnv = config.bot_token_env || 'SLACK_BOT_TOKEN';
  const appTokenEnv = config.app_token_env || 'SLACK_APP_TOKEN';
  const botToken = process.env[botTokenEnv];
  const appToken = process.env[appTokenEnv];

  if (!botToken) {
    throw new Error(
      `Missing ${botTokenEnv}. Run "wayfind bot --configure" or set it in your environment.`
    );
  }
  if (!appToken) {
    throw new Error(
      `Missing ${appTokenEnv}. Run "wayfind bot --configure" or set it in your environment.`
    );
  }

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });

  // Get bot user ID for mention detection
  let botUserId;
  try {
    const auth = await app.client.auth.test();
    botUserId = auth.user_id;
  } catch (err) {
    console.error(`Warning: Could not get bot user ID: ${err.message}`);
  }

  // Build members directory path for Slack user identity resolution
  const teamContextDir = config.team_context_dir || process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR || null;
  const membersDir = teamContextDir ? path.join(teamContextDir, 'members') : null;

  // Load feature map for repo routing
  loadFeatureMap(config);
  if (featureMap && Object.keys(featureMap).length > 0) {
    console.log(`Loaded feature map: ${Object.keys(featureMap).length} repo(s)`);
  }

  // Handle @mentions
  app.event('app_mention', async ({ event, client }) => {
    const channel = event.channel;
    const threadTs = event.thread_ts || event.ts;

    // Acknowledge with eyes emoji
    try {
      await client.reactions.add({
        channel,
        timestamp: event.ts,
        name: 'eyes',
      });
    } catch {
      // Non-critical — continue even if reaction fails
    }

    // Extract and validate query
    const query = extractQuery(event.text, botUserId);
    if (!query) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: 'What would you like to know? Mention me with a question about your team\'s decision trail.',
      });
      return;
    }

    try {
      // Handle onboard command
      const onboardMatch = query.match(/^onboard\s+(.+)/i);
      if (onboardMatch) {
        const repoQuery = onboardMatch[1].trim();
        await client.reactions.add({ channel, timestamp: event.ts, name: 'hourglass_flowing_sand' }).catch(() => {});
        try {
          const pack = await contentStore.generateOnboardingPack(repoQuery, {
            storePath: config.store_path || undefined,
            journalDir: config.journal_dir || undefined,
            llmConfig: config.llm || undefined,
          });
          const formatted = markdownToMrkdwn(pack);
          const chunks = chunkMessage(formatted, MAX_RESPONSE_LENGTH);
          for (const chunk of chunks) {
            await client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
          }
        } catch (err) {
          await client.chat.postMessage({
            channel, thread_ts: threadTs,
            text: `Onboarding pack failed: ${err.message}`,
          });
        }
        return;
      }

      // Handle reindex command
      if (query.toLowerCase().match(/^reindex\b/)) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: 'Re-indexing all sources... this may take a few minutes.',
        });
        try {
          const journalStats = await contentStore.indexJournals({
            storePath: config.store_path || undefined,
            journalDir: config.journal_dir || undefined,
          });
          const convStats = await contentStore.indexConversations({
            storePath: config.store_path || undefined,
          });
          let signalStats = { fileCount: 0, newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
          const signalsDir = process.env.TEAM_CONTEXT_SIGNALS_DIR || contentStore.DEFAULT_SIGNALS_DIR;
          if (signalsDir && fs.existsSync(signalsDir)) {
            signalStats = await contentStore.indexSignals({ signalsDir });
          }
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `Reindex complete.\n` +
              `Journals: ${journalStats.entryCount} entries (${journalStats.newEntries} new)\n` +
              `Conversations: ${convStats.transcriptsProcessed} processed, ${convStats.decisionsExtracted} decisions extracted\n` +
              `Signals: ${signalStats.fileCount} files (${signalStats.newEntries} new, ${signalStats.updatedEntries} updated)`,
          });
        } catch (reindexErr) {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `Reindex failed: ${reindexErr.message}`,
          });
        }
        return;
      }

      // Fetch prior thread exchanges for conversation context
      let threadHistory = [];
      if (event.thread_ts && botUserId) {
        threadHistory = await fetchThreadHistory(client, channel, event.thread_ts, botUserId, event.ts);
      }

      const result = await handleQuery(query, config, threadHistory);
      const authorSlug = telemetry.resolveSlackUser(event.user, membersDir);
      if (result._directCommand) {
        telemetry.capture('bot_direct_command', { query: query.toLowerCase().slice(0, 50) }, authorSlug);
      } else if (result._promptQuery) {
        telemetry.capture('bot_prompt_query', { found: true }, authorSlug);
      } else if (result._telemetry) {
        telemetry.capture('bot_query', result._telemetry, authorSlug);
      }

      // Split long responses into chunks
      const chunks = chunkMessage(result.text, MAX_RESPONSE_LENGTH);
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: chunk,
        });
      }
    } catch (err) {
      console.error(`Query failed: ${err.message}`);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Something went wrong while processing your query: ${err.message}`,
      });
    }
  });

  // Listen for threaded replies in conversations the bot is already in.
  // This lets users ask follow-up questions without re-mentioning @Wayfind.
  app.event('message', async ({ event, client }) => {
    // Only respond to threaded replies (not top-level messages)
    if (!event.thread_ts) return;
    // Ignore bot's own messages
    if (event.user === botUserId || event.bot_id) return;
    // Ignore messages that mention the bot (handled by app_mention)
    if (event.text && event.text.includes(`<@${botUserId}>`)) return;
    // Ignore messages that @mention other users — the message is directed at a person, not the bot.
    // Slack encodes mentions as <@U...>. If any mention is present and none is the bot, skip.
    if (event.text && /<@U[A-Z0-9]+>/.test(event.text)) return;
    // Ignore message subtypes (edits, joins, etc.)
    if (event.subtype) return;

    // Check if this is a reply to a digest message — capture as feedback
    const feedbackRecorded = contentStore.recordDigestFeedbackText({
      messageTs: event.thread_ts,
      user: event.user,
      text: event.text ? event.text.trim() : '',
      storePath: config.store_path,
    });
    if (feedbackRecorded) {
      const feedbackAuthor = telemetry.resolveSlackUser(event.user, membersDir);
      telemetry.capture('digest_feedback', { text_length: event.text ? event.text.length : 0 }, feedbackAuthor);
      try {
        await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'memo' });
      } catch { /* non-critical */ }
      return; // Don't process as a bot query
    }

    // Check if the bot has already replied in this thread
    let botInThread = false;
    try {
      const result = await client.conversations.replies({
        channel: event.channel,
        ts: event.thread_ts,
        limit: 20,
      });
      botInThread = (result.messages || []).some(
        (m) => m.user === botUserId || (m.bot_id && m.user === botUserId)
      );
    } catch {
      // Can't read thread — skip
      return;
    }

    if (!botInThread) return;

    const channel = event.channel;
    const threadTs = event.thread_ts;
    const query = event.text ? event.text.trim() : '';
    if (!query) return;

    // Acknowledge
    try {
      await client.reactions.add({ channel, timestamp: event.ts, name: 'eyes' });
    } catch { /* non-critical */ }

    try {
      // Fetch thread history for context
      const threadHistory = await fetchThreadHistory(client, channel, threadTs, botUserId, event.ts);
      const result = await handleQuery(query, config, threadHistory);
      const authorSlug = telemetry.resolveSlackUser(event.user, membersDir);
      if (result._directCommand) {
        telemetry.capture('bot_direct_command', { query: query.toLowerCase().slice(0, 50) }, authorSlug);
      } else if (result._promptQuery) {
        telemetry.capture('bot_prompt_query', { found: true }, authorSlug);
      } else if (result._telemetry) {
        telemetry.capture('bot_query', result._telemetry, authorSlug);
      }

      const chunks = chunkMessage(result.text, MAX_RESPONSE_LENGTH);
      for (const chunk of chunks) {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
      }
    } catch (err) {
      console.error(`Thread reply query failed: ${err.message}`);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Something went wrong: ${err.message}`,
      });
    }
  });

  // ── Reaction tracking for digest feedback ──────────────────────────────────
  app.event('reaction_added', async ({ event }) => {
    try {
      const recorded = contentStore.recordDigestReaction({
        messageTs: event.item.ts,
        reaction: event.reaction,
        delta: 1,
        storePath: config.store_path,
      });
      if (recorded) {
        const reactionAuthor = telemetry.resolveSlackUser(event.user, membersDir);
        telemetry.capture('digest_reaction', { reaction_emoji: event.reaction, delta: 1 }, reactionAuthor);
      }
    } catch (err) {
      // Silently ignore — reaction may not be on a tracked digest message
    }
  });

  app.event('reaction_removed', async ({ event }) => {
    try {
      const recorded = contentStore.recordDigestReaction({
        messageTs: event.item.ts,
        reaction: event.reaction,
        delta: -1,
        storePath: config.store_path,
      });
      if (recorded) {
        const reactionAuthor = telemetry.resolveSlackUser(event.user, membersDir);
        telemetry.capture('digest_reaction', { reaction_emoji: event.reaction, delta: -1 }, reactionAuthor);
      }
    } catch (err) {
      // Silently ignore
    }
  });

  await app.start();

  // Track Socket Mode WebSocket connection state for healthcheck
  slackConnected = true;
  slackLastConnected = new Date().toISOString();
  if (app.receiver && app.receiver.client) {
    const socketClient = app.receiver.client;
    socketClient.on('connected', () => {
      slackConnected = true;
      slackLastConnected = new Date().toISOString();
      console.log(`[${slackLastConnected}] Slack WebSocket reconnected`);
    });
    socketClient.on('disconnected', () => {
      slackConnected = false;
      slackLastDisconnected = new Date().toISOString();
      console.log(`[${slackLastDisconnected}] Slack WebSocket disconnected`);
    });
  }

  console.log('Wayfind bot connected to Slack (Socket Mode)');
  if (botUserId) {
    console.log(`Bot user ID: ${botUserId}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down Wayfind bot...');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    app,
    stop: () => app.stop(),
  };
}

/**
 * Returns current Slack WebSocket connection state for healthcheck integration.
 */
function getConnectionStatus() {
  return {
    connected: slackConnected,
    lastConnected: slackLastConnected,
    lastDisconnected: slackLastDisconnected,
  };
}

// ── Configure ────────────────────────────────────────────────────────────────

/**
 * Interactive setup for the Slack bot.
 * Prompts for tokens, validates format, saves to .env and returns config.
 * @returns {Promise<Object>} - Bot configuration for connectors.json
 */
async function configure() {
  console.log('');
  console.log('Wayfind Slack Bot Configuration');
  console.log('================================');
  console.log('');
  console.log('Prerequisites:');
  console.log('  1. Create a Slack app at https://api.slack.com/apps');
  console.log('  2. Enable Socket Mode (Settings > Socket Mode)');
  console.log('  3. Add an App-Level Token with "connections:write" scope');
  console.log('  4. Add Bot Token Scopes: app_mentions:read, chat:write, reactions:read, reactions:write');
  console.log('  5. Subscribe to bot events: app_mention, reaction_added, reaction_removed');
  console.log('  6. Install the app to your workspace');
  console.log('');

  // App-Level Token
  const appToken = await ask('App-Level Token (xapp-...): ');
  if (!appToken.startsWith('xapp-')) {
    console.error('Error: App-Level Token must start with "xapp-".');
    process.exit(1);
  }

  // Bot Token
  const botToken = await ask('Bot User OAuth Token (xoxb-...): ');
  if (!botToken.startsWith('xoxb-')) {
    console.error('Error: Bot Token must start with "xoxb-".');
    process.exit(1);
  }

  // Save tokens to .env
  saveEnvKey('SLACK_APP_TOKEN', appToken);
  saveEnvKey('SLACK_BOT_TOKEN', botToken);

  // LLM config — detect or reuse from digest
  let llmConfig = {};
  const connectorsFile = path.join(WAYFIND_DIR, 'connectors.json');
  try {
    const connectors = JSON.parse(fs.readFileSync(connectorsFile, 'utf8'));
    if (connectors.digest && connectors.digest.llm) {
      console.log(`\nFound existing LLM config from digest: ${connectors.digest.llm.provider}`);
      const reuse = await ask('Reuse this LLM config for the bot? (Y/n): ');
      if (!reuse || reuse.toLowerCase() !== 'n') {
        llmConfig = { ...connectors.digest.llm };
      }
    }
  } catch {
    // No existing config — detect
  }

  if (!llmConfig.provider) {
    const detected = await llm.detect();
    if (detected) {
      console.log(`\nDetected: ${detected.provider} (${detected.model || 'default model'})`);
      const useDetected = await ask(`Use ${detected.provider}? (Y/n): `);
      if (!useDetected || useDetected.toLowerCase() !== 'n') {
        llmConfig = detected;
      }
    }

    if (!llmConfig.provider) {
      console.log('\nAvailable providers: anthropic, openai, cli');
      const provider = await ask('LLM provider: ');
      llmConfig.provider = provider;

      if (provider === 'anthropic') {
        llmConfig.model = (await ask('Model (default: claude-sonnet-4-5-20250929): ')) || 'claude-sonnet-4-5-20250929';
        llmConfig.api_key_env = 'ANTHROPIC_API_KEY';
      } else if (provider === 'openai') {
        llmConfig.model = (await ask('Model (default: gpt-4o-mini): ')) || 'gpt-4o-mini';
        llmConfig.api_key_env = (await ask('API key env var (default: OPENAI_API_KEY): ')) || 'OPENAI_API_KEY';
      } else if (provider === 'cli') {
        llmConfig.command = await ask('Command (e.g. "ollama run llama3.2"): ');
      }
    }
  }

  const config = {
    mode: 'local',
    bot_token_env: 'SLACK_BOT_TOKEN',
    app_token_env: 'SLACK_APP_TOKEN',
    llm: llmConfig,
    store_path: null,
    configured_at: new Date().toISOString(),
  };

  console.log('');
  console.log('Slack bot configured successfully.');
  console.log('');
  console.log('Start the bot with:');
  console.log('  wayfind bot');
  console.log('');

  return config;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  configure,
  start,
  getConnectionStatus,
  handleQuery,
  handleDirectCommand,
  formatResponse,
  extractQuery,
  chunkMessage,
  fetchThreadHistory,
  formatThreadContext,
  classifyIntent,
  searchSignals,
};
