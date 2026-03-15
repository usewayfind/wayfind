'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const HOME = process.env.HOME || process.env.USERPROFILE;
const WAYFIND_DIR = path.join(HOME, '.claude', 'team-context');
const SIGNALS_DIR = path.join(WAYFIND_DIR, 'signals');

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function today() {
  return localDateStr(new Date());
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}

function toUnixTimestamp(dateStr) {
  const ms = new Date(dateStr + 'T00:00:00Z').getTime();
  if (isNaN(ms)) throw new Error(`Invalid date: "${dateStr}"`);
  return Math.floor(ms / 1000);
}

function sanitizeForMarkdown(text) {
  return text.replace(/<[^>]*>/g, '').replace(/\|/g, '\\|');
}

function isSimulation() {
  return process.env.TEAM_CONTEXT_SIMULATE === '1';
}

function getFixturesDir() {
  return process.env.TEAM_CONTEXT_SIM_FIXTURES || '';
}

// ── Intercom API transport ──────────────────────────────────────────────────

function intercomGet(token, endpoint) {
  if (isSimulation()) {
    return loadFixture(endpoint);
  }

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: 'api.intercom.io',
      path: endpoint,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Intercom-Version': '2.11',
      },
    };

    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => reject(new Error(`Response error: ${err.message}`)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode === 401) {
          reject(new Error('Intercom API: unauthorized. Check your access token.'));
          return;
        }
        if (res.statusCode === 429) {
          reject(new Error('Intercom API: rate limited. Try again in a few minutes.'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Intercom API returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (parseErr) {
          reject(new Error(`Failed to parse Intercom API response: ${parseErr.message}`));
        }
      });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Intercom API request timed out (30s)'));
    });

    req.on('error', reject);
    req.end();
  });
}

function intercomPost(token, endpoint, body) {
  if (isSimulation()) {
    return loadFixture(endpoint);
  }

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const reqOpts = {
      hostname: 'api.intercom.io',
      path: endpoint,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Intercom-Version': '2.11',
      },
    };

    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => reject(new Error(`Response error: ${err.message}`)));
      res.on('end', () => {
        const respBody = Buffer.concat(chunks).toString();
        if (res.statusCode === 401) {
          reject(new Error('Intercom API: unauthorized. Check your access token.'));
          return;
        }
        if (res.statusCode === 429) {
          reject(new Error('Intercom API: rate limited. Try again in a few minutes.'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Intercom API returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(respBody));
        } catch (parseErr) {
          reject(new Error(`Failed to parse Intercom API response: ${parseErr.message}`));
        }
      });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Intercom API request timed out (30s)'));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Simulation fixtures ─────────────────────────────────────────────────────

function loadFixture(endpoint) {
  const fixturesDir = getFixturesDir();
  if (!fixturesDir) {
    return Promise.resolve({ conversations: [], pages: {} });
  }

  // Map endpoints to fixture files
  if (endpoint.includes('/conversations/search') || endpoint.includes('/conversations')) {
    const fixturePath = path.join(fixturesDir, 'conversations.json');
    try {
      const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      // Wrap raw array in Intercom-like response if needed
      if (Array.isArray(data)) {
        return Promise.resolve({
          type: 'conversation.list',
          conversations: data,
          total_count: data.length,
          pages: { type: 'pages', total_pages: 1 },
        });
      }
      return Promise.resolve(data);
    } catch {
      return Promise.resolve({ conversations: [], pages: {} });
    }
  }

  if (endpoint.includes('/tags')) {
    const fixturePath = path.join(fixturesDir, 'tags.json');
    try {
      return Promise.resolve(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
    } catch {
      return Promise.resolve({ type: 'list', data: [] });
    }
  }

  return Promise.resolve({});
}

// ── Configure ───────────────────────────────────────────────────────────────

async function configure() {
  console.log('');
  console.log('Intercom Connector Setup');
  console.log('');
  console.log('You need an Intercom Access Token.');
  console.log('Find it at: Settings > Developers > Your App > Authentication');
  console.log('Required scopes: Read conversations, Read tags');
  console.log('');

  const token = await ask('Intercom Access Token: ');
  if (!token) {
    throw new Error('An access token is required.');
  }

  // Optional: inbox filter
  console.log('');
  console.log('Optional: filter to specific tags (comma-separated, or leave blank for all)');
  const tagFilter = await ask('Tag filter: ');
  const tags = tagFilter
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const channelConfig = {
    transport: 'https',
    token,
    tag_filter: tags.length > 0 ? tags : null,
    last_pull: null,
  };

  console.log('');
  console.log('Intercom connector configured.');
  if (tags.length > 0) {
    console.log(`Tag filter: ${tags.join(', ')}`);
  }
  console.log('');

  return channelConfig;
}

// ── Pull ────────────────────────────────────────────────────────────────────

async function pull(config, since) {
  const sinceDate = since || daysAgo(7);
  const todayDate = today();
  const timestamp = new Date().toISOString();
  const token = config.token || (config.token_env ? process.env[config.token_env] : '') || '';

  if (!token && !isSimulation()) {
    throw new Error('Intercom token is missing. Run "wayfind pull intercom --configure" to set it up.');
  }

  // Fetch conversations
  const conversations = await fetchConversations(token, sinceDate);

  // Apply tag filter if configured
  let filtered = conversations;
  if (config.tag_filter && config.tag_filter.length > 0) {
    const allowedTags = new Set(config.tag_filter.map((t) => t.toLowerCase()));
    filtered = conversations.filter((conv) => {
      const convTags = extractTags(conv);
      return convTags.some((t) => allowedTags.has(t.toLowerCase()));
    });
  }

  // Analyze patterns
  const analysis = analyzeConversations(filtered, sinceDate, todayDate);

  // Generate markdown
  const md = generateMarkdown(analysis, sinceDate, todayDate, timestamp);

  // Write signal file
  const signalDir = path.join(SIGNALS_DIR, 'intercom');
  fs.mkdirSync(signalDir, { recursive: true });
  const signalFile = path.join(signalDir, `${todayDate}.md`);
  fs.writeFileSync(signalFile, md, 'utf8');

  return {
    files: [signalFile],
    summary: generateSummaryText(analysis),
    counts: {
      conversations: filtered.length,
      open: analysis.openCount,
      tags: analysis.sortedTags.length,
    },
  };
}

// ── Data fetching ───────────────────────────────────────────────────────────

async function fetchConversations(token, sinceDate) {
  const sinceTimestamp = toUnixTimestamp(sinceDate);

  // Use search endpoint to filter by created_at
  const body = {
    query: {
      field: 'created_at',
      operator: '>=',
      value: sinceTimestamp,
    },
    pagination: {
      per_page: 150,
    },
  };

  const allConversations = [];
  let response = await intercomPost(token, '/conversations/search', body);
  const conversations = Array.isArray(response.conversations) ? response.conversations : [];
  allConversations.push(...conversations);

  // Handle pagination (safety bound to prevent infinite loops)
  const MAX_PAGES = 50;
  let pageCount = 0;
  let pages = response.pages || {};
  while (pages.next && pageCount < MAX_PAGES) {
    pageCount++;
    const nextBody = {
      ...body,
      pagination: {
        ...body.pagination,
        starting_after: pages.next.starting_after,
      },
    };
    response = await intercomPost(token, '/conversations/search', nextBody);
    const pageConversations = Array.isArray(response.conversations) ? response.conversations : [];
    allConversations.push(...pageConversations);
    pages = response.pages || {};
  }
  if (pageCount >= MAX_PAGES) {
    console.warn(`Warning: pagination hit safety limit (${MAX_PAGES} pages). Some conversations may be missing.`);
  }

  return allConversations;
}

// ── Analysis ────────────────────────────────────────────────────────────────

function extractTags(conv) {
  if (!conv.tags) return [];
  // Intercom tags can be { type: 'tag.list', tags: [...] } or { tags: [...] }
  const tagList = conv.tags.tags || conv.tags.data || conv.tags;
  if (!Array.isArray(tagList)) return [];
  return tagList.map((t) => (typeof t === 'string' ? t : t.name || t.id || '')).filter(Boolean);
}

function extractTitle(conv) {
  // Intercom conversations may have a title or source.subject
  // Never fall through to source.body — it contains raw customer messages (PII risk)
  if (conv.title) return conv.title;
  if (conv.source && conv.source.subject) return conv.source.subject;
  return conv.id ? `(conversation #${conv.id})` : '(no subject)';
}

function analyzeConversations(conversations, sinceDate, todayDate) {
  const tagCounts = {};
  const stateCounts = { open: 0, closed: 0, snoozed: 0 };
  const topicPatterns = {};
  const dailyCounts = {};
  let totalFirstResponseMs = 0;
  let firstResponseCount = 0;

  for (const conv of conversations) {
    // State
    const state = conv.state || (conv.open === true ? 'open' : conv.open === false ? 'closed' : 'unknown');
    if (stateCounts[state] !== undefined) {
      stateCounts[state]++;
    }

    // Tags
    const tags = extractTags(conv);
    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }

    // Daily volume
    const createdDate = conv.created_at
      ? (typeof conv.created_at === 'number'
        ? new Date(conv.created_at * 1000).toISOString().slice(0, 10)
        : new Date(conv.created_at).toISOString().slice(0, 10))
      : null;
    if (createdDate) {
      dailyCounts[createdDate] = (dailyCounts[createdDate] || 0) + 1;
    }

    // Title-based topic clustering (simple keyword extraction)
    const title = extractTitle(conv).toLowerCase();
    const keywords = extractKeywords(title);
    for (const kw of keywords) {
      topicPatterns[kw] = (topicPatterns[kw] || 0) + 1;
    }

    // First response time from statistics
    if (conv.statistics && conv.statistics.first_contact_reply_at && conv.created_at) {
      const created = typeof conv.created_at === 'number' ? conv.created_at : new Date(conv.created_at).getTime() / 1000;
      const replied = typeof conv.statistics.first_contact_reply_at === 'number'
        ? conv.statistics.first_contact_reply_at
        : new Date(conv.statistics.first_contact_reply_at).getTime() / 1000;
      if (replied > created) {
        totalFirstResponseMs += (replied - created);
        firstResponseCount++;
      }
    }
  }

  // Sort tags by count
  const sortedTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1]);

  // Sort topics by frequency, take top 10
  const sortedTopics = Object.entries(topicPatterns)
    .filter(([, count]) => count >= 2) // Only topics mentioned 2+ times
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Average first response time
  const avgFirstResponseHours = firstResponseCount > 0
    ? (totalFirstResponseMs / firstResponseCount / 3600)
    : null;

  return {
    total: conversations.length,
    openCount: stateCounts.open,
    closedCount: stateCounts.closed,
    snoozedCount: stateCounts.snoozed,
    sortedTags,
    sortedTopics,
    dailyCounts,
    avgFirstResponseHours,
    conversations,
  };
}

function extractKeywords(text) {
  // Simple keyword extraction: split on non-alpha, filter stopwords, keep 2+ char words
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
    'and', 'but', 'or', 'nor', 'not', 'no', 'so', 'if', 'then', 'than',
    'too', 'very', 'just', 'about', 'above', 'all', 'also', 'any', 'each',
    'how', 'what', 'when', 'where', 'which', 'who', 'whom', 'why',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
    'this', 'that', 'these', 'those', 'up', 'out', 'get', 'got', 'getting',
    'im', 'dont', 'cant', 'wont',
  ]);

  return text
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !stopwords.has(w));
}

// ── Markdown generation ─────────────────────────────────────────────────────

function generateMarkdown(analysis, sinceDate, todayDate, timestamp) {
  const lines = [];

  lines.push('# Intercom Signals');
  lines.push('');
  lines.push(`**Period:** ${sinceDate} to ${todayDate}  `);
  lines.push(`**Pulled:** ${timestamp}`);
  lines.push('');

  // Volume overview
  lines.push('## Volume');
  lines.push('');
  lines.push(`- **${analysis.total}** conversations in period`);
  lines.push(`- **${analysis.openCount}** open, **${analysis.closedCount}** closed, **${analysis.snoozedCount}** snoozed`);
  if (analysis.avgFirstResponseHours != null) {
    lines.push(`- Avg first response: **${analysis.avgFirstResponseHours.toFixed(1)} hrs**`);
  }
  lines.push('');

  // Daily volume
  const sortedDays = Object.entries(analysis.dailyCounts).sort((a, b) => a[0].localeCompare(b[0]));
  if (sortedDays.length > 0) {
    lines.push('## Daily Volume');
    lines.push('');
    for (const [day, count] of sortedDays) {
      const bar = '\u2588'.repeat(Math.min(count, 30));
      lines.push(`  ${day}  ${bar} ${count}`);
    }
    lines.push('');
  }

  // Top tags
  if (analysis.sortedTags.length > 0) {
    lines.push('## Top Tags');
    lines.push('');
    lines.push('| Tag | Count |');
    lines.push('|-----|-------|');
    for (const [tag, count] of analysis.sortedTags.slice(0, 15)) {
      lines.push(`| ${sanitizeForMarkdown(tag)} | ${count} |`);
    }
    lines.push('');
  }

  // Recurring topics (privacy-safe: patterns, not individual conversations)
  if (analysis.sortedTopics.length > 0) {
    lines.push('## Recurring Topics');
    lines.push('');
    lines.push('Topics mentioned in 2+ conversations:');
    lines.push('');
    for (const [topic, count] of analysis.sortedTopics) {
      lines.push(`- **${topic}** (${count} conversations)`);
    }
    lines.push('');
  }

  // Open conversations (privacy-safe: titles and tags only, no raw message content)
  const openConvs = analysis.conversations.filter((c) => {
    const state = c.state || (c.open === true ? 'open' : 'closed');
    return state === 'open';
  });
  const todayMs = new Date(todayDate + 'T00:00:00Z').getTime();
  if (openConvs.length > 0) {
    lines.push('## Open Conversations');
    lines.push('');
    lines.push('| Title | Tags | Age |');
    lines.push('|-------|------|-----|');
    for (const conv of openConvs.slice(0, 20)) {
      const title = sanitizeForMarkdown(extractTitle(conv));
      const tags = extractTags(conv).map((t) => sanitizeForMarkdown(t)).join(', ') || '-';
      const created = conv.created_at
        ? (typeof conv.created_at === 'number'
          ? new Date(conv.created_at * 1000)
          : new Date(conv.created_at))
        : null;
      const age = created ? `${Math.floor((todayMs - created.getTime()) / (1000 * 60 * 60 * 24))}d` : '-';
      lines.push(`| ${title} | ${tags} | ${age} |`);
    }
    lines.push('');
  }

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(generateSummaryText(analysis));
  lines.push('');

  return lines.join('\n');
}

function generateSummaryText(analysis) {
  const parts = [];
  parts.push(`${analysis.total} conversations (${analysis.openCount} open, ${analysis.closedCount} closed)`);

  if (analysis.sortedTags.length > 0) {
    const topTags = analysis.sortedTags.slice(0, 3).map(([tag, count]) => `${tag} (${count})`);
    parts.push(`Top tags: ${topTags.join(', ')}`);
  }

  if (analysis.sortedTopics.length > 0) {
    const topTopics = analysis.sortedTopics.slice(0, 3).map(([topic, count]) => `${topic} (${count}x)`);
    parts.push(`Recurring: ${topTopics.join(', ')}`);
  }

  if (analysis.avgFirstResponseHours != null) {
    parts.push(`Avg first response: ${analysis.avgFirstResponseHours.toFixed(1)} hrs`);
  }

  return parts.join('\n');
}

// ── Summarize ───────────────────────────────────────────────────────────────

function summarize(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/## Summary\n([\s\S]*?)(?:\n## |\n$|$)/);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

module.exports = {
  configure,
  pull,
  summarize,
};
