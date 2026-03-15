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

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sanitizeForMarkdown(text) {
  return (text || '').replace(/<[^>]*>/g, '').replace(/\|/g, '\\|');
}

function isSimulation() {
  return process.env.TEAM_CONTEXT_SIMULATE === '1';
}

function getFixturesDir() {
  return process.env.TEAM_CONTEXT_SIM_NOTION_FIXTURES
    || process.env.TEAM_CONTEXT_SIM_FIXTURES
    || '';
}

// ── Notion API transport ────────────────────────────────────────────────────

function notionPost(token, endpoint, body) {
  if (isSimulation()) {
    return loadFixture(endpoint);
  }

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const reqOpts = {
      hostname: 'api.notion.com',
      path: `/v1${endpoint}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => reject(new Error(`Response error: ${err.message}`)));
      res.on('end', () => {
        const respBody = Buffer.concat(chunks).toString();
        if (res.statusCode === 401) {
          reject(new Error('Notion API: unauthorized. Check your integration token.'));
          return;
        }
        if (res.statusCode === 429) {
          reject(new Error('Notion API: rate limited. Try again in a few minutes.'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Notion API returned ${res.statusCode}: ${respBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(respBody));
        } catch (parseErr) {
          reject(new Error(`Failed to parse Notion API response: ${parseErr.message}`));
        }
      });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Notion API request timed out (30s)'));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function notionGet(token, endpoint) {
  if (isSimulation()) {
    return loadFixture(endpoint);
  }

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: 'api.notion.com',
      path: `/v1${endpoint}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
      },
    };

    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => reject(new Error(`Response error: ${err.message}`)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Notion API returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (parseErr) {
          reject(new Error(`Failed to parse Notion API response: ${parseErr.message}`));
        }
      });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Notion API request timed out (30s)'));
    });

    req.on('error', reject);
    req.end();
  });
}

// ── Simulation fixtures ─────────────────────────────────────────────────────

function loadFixture(endpoint) {
  const fixturesDir = getFixturesDir();
  if (!fixturesDir) {
    return Promise.resolve({ results: [], has_more: false });
  }

  if (endpoint.includes('/search')) {
    const fixturePath = path.join(fixturesDir, 'pages.json');
    try {
      const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      if (Array.isArray(data)) {
        return Promise.resolve({ results: data, has_more: false });
      }
      return Promise.resolve(data);
    } catch {
      return Promise.resolve({ results: [], has_more: false });
    }
  }

  if (endpoint.includes('/query')) {
    const fixturePath = path.join(fixturesDir, 'database_entries.json');
    try {
      const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      if (Array.isArray(data)) {
        return Promise.resolve({ results: data, has_more: false });
      }
      return Promise.resolve(data);
    } catch {
      return Promise.resolve({ results: [], has_more: false });
    }
  }

  if (endpoint.includes('/comments')) {
    const fixturePath = path.join(fixturesDir, 'comments.json');
    try {
      const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      if (Array.isArray(data)) {
        return Promise.resolve({ results: data, has_more: false });
      }
      return Promise.resolve(data);
    } catch {
      return Promise.resolve({ results: [], has_more: false });
    }
  }

  if (endpoint.includes('/users')) {
    const fixturePath = path.join(fixturesDir, 'users.json');
    try {
      const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      if (Array.isArray(data)) {
        return Promise.resolve({ results: data, has_more: false });
      }
      return Promise.resolve(data);
    } catch {
      return Promise.resolve({ results: [], has_more: false });
    }
  }

  return Promise.resolve({ results: [], has_more: false });
}

// ── Configure ───────────────────────────────────────────────────────────────

async function configure() {
  console.log('');
  console.log('Notion Connector Setup');
  console.log('');
  console.log('You need a Notion Internal Integration Token.');
  console.log('Create one at: https://www.notion.so/my-integrations');
  console.log('Required capabilities: Read content, Read comments');
  console.log('');
  console.log('After creating the integration, share the pages/databases');
  console.log('you want to monitor with the integration (via the ··· menu → Connections).');
  console.log('');

  const token = await ask('Notion Integration Token (ntn_...): ');
  if (!token) {
    throw new Error('An integration token is required.');
  }

  // Optional: database IDs to monitor
  console.log('');
  console.log('Optional: specific database IDs to monitor (comma-separated, or blank for all shared pages).');
  console.log('Find database IDs in the URL: notion.so/<workspace>/<database-id>');
  const dbInput = await ask('Database IDs: ');
  const databases = dbInput
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  const channelConfig = {
    transport: 'https',
    token,
    token_env: 'NOTION_TOKEN',
    databases: databases.length > 0 ? databases : null,
    last_pull: null,
  };

  console.log('');
  console.log('Notion connector configured.');
  if (databases.length > 0) {
    console.log(`Monitoring ${databases.length} database(s).`);
  } else {
    console.log('Monitoring all shared pages.');
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
    throw new Error('Notion token is missing. Run "wayfind pull notion --configure" to set it up.');
  }

  // Resolve user IDs to display names
  const userMap = await fetchUsers(token);

  // Fetch recently edited pages
  const pages = await fetchRecentPages(token, sinceDate);

  // Fetch database entries — auto-discover databases if none configured
  let dbEntries = [];
  let databases = config.databases || [];
  if (databases.length === 0) {
    databases = await discoverDatabases(token);
  }
  for (const dbId of databases) {
    const entries = await fetchDatabaseEntries(token, dbId, sinceDate);
    dbEntries.push(...entries.map((e) => ({ ...e, _databaseId: dbId })));
  }

  // Fetch comment counts for active pages (top 20 by recency)
  const activePages = pages.slice(0, 20);
  const commentCounts = {};
  for (const page of activePages) {
    const comments = await fetchComments(token, page.id);
    const recentComments = comments.filter((c) => {
      const created = c.created_time || '';
      return created.slice(0, 10) >= sinceDate;
    });
    if (recentComments.length > 0) {
      commentCounts[page.id] = recentComments.length;
    }
  }

  // Analyze
  const analysis = analyzeActivity(pages, dbEntries, commentCounts, sinceDate, todayDate, userMap);

  // Generate markdown
  const md = generateMarkdown(analysis, sinceDate, todayDate, timestamp, userMap);

  // Write signal file
  const signalDir = path.join(SIGNALS_DIR, 'notion');
  fs.mkdirSync(signalDir, { recursive: true });
  const signalFile = path.join(signalDir, `${todayDate}.md`);
  fs.writeFileSync(signalFile, md, 'utf8');

  return {
    files: [signalFile],
    summary: generateSummaryText(analysis),
    counts: {
      pages: analysis.pageCount,
      database_entries: analysis.dbEntryCount,
      comments: analysis.totalComments,
    },
  };
}

// ── Data fetching ───────────────────────────────────────────────────────────

async function fetchUsers(token) {
  const userMap = {};
  if (isSimulation()) {
    const fixturesDir = getFixturesDir();
    if (fixturesDir) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'users.json'), 'utf8'));
        const results = Array.isArray(data) ? data : (data.results || []);
        for (const u of results) {
          if (u.id && u.name) userMap[u.id] = u.name;
        }
      } catch { /* no fixture */ }
    }
    return userMap;
  }

  try {
    let response = await notionGet(token, '/users?page_size=100');
    const results = Array.isArray(response.results) ? response.results : [];
    for (const u of results) {
      if (u.id && u.name) userMap[u.id] = u.name;
    }
    // Paginate if needed
    let hasMore = response.has_more;
    let nextCursor = response.next_cursor;
    while (hasMore) {
      response = await notionGet(token, `/users?page_size=100&start_cursor=${nextCursor}`);
      for (const u of (response.results || [])) {
        if (u.id && u.name) userMap[u.id] = u.name;
      }
      hasMore = response.has_more;
      nextCursor = response.next_cursor;
    }
  } catch {
    // Non-fatal — fall back to IDs
  }
  return userMap;
}

async function discoverDatabases(token) {
  if (isSimulation()) return [];

  const dbIds = [];
  try {
    const body = {
      filter: { property: 'object', value: 'database' },
      page_size: 100,
    };
    const response = await notionPost(token, '/search', body);
    const results = Array.isArray(response.results) ? response.results : [];
    for (const db of results) {
      if (db.id) dbIds.push(db.id);
    }
  } catch {
    // Non-fatal — just won't have database entries
  }
  return dbIds;
}

async function fetchRecentPages(token, sinceDate) {
  const body = {
    filter: {
      property: 'object',
      value: 'page',
    },
    sort: {
      direction: 'descending',
      timestamp: 'last_edited_time',
    },
    page_size: 100,
  };

  const allPages = [];
  let response = await notionPost(token, '/search', body);
  const results = Array.isArray(response.results) ? response.results : [];

  // Filter to pages edited since sinceDate
  for (const page of results) {
    const editedAt = (page.last_edited_time || '').slice(0, 10);
    if (editedAt >= sinceDate) {
      allPages.push(page);
    }
  }

  // Handle pagination (safety bound)
  const MAX_PAGES = 10;
  let pageCount = 0;
  let hasMore = response.has_more;
  let nextCursor = response.next_cursor;

  while (hasMore && pageCount < MAX_PAGES) {
    pageCount++;
    const nextBody = { ...body, start_cursor: nextCursor };
    response = await notionPost(token, '/search', nextBody);
    const pageResults = Array.isArray(response.results) ? response.results : [];

    let foundOlder = false;
    for (const page of pageResults) {
      const editedAt = (page.last_edited_time || '').slice(0, 10);
      if (editedAt >= sinceDate) {
        allPages.push(page);
      } else {
        foundOlder = true;
      }
    }

    // Stop if we've gone past our date range
    if (foundOlder) break;
    hasMore = response.has_more;
    nextCursor = response.next_cursor;
  }

  return allPages;
}

async function fetchDatabaseEntries(token, databaseId, sinceDate) {
  const body = {
    filter: {
      timestamp: 'last_edited_time',
      last_edited_time: {
        on_or_after: `${sinceDate}T00:00:00.000Z`,
      },
    },
    page_size: 100,
  };

  const allEntries = [];
  let response = await notionPost(token, `/databases/${databaseId}/query`, body);
  const results = Array.isArray(response.results) ? response.results : [];
  allEntries.push(...results);

  // Handle pagination
  const MAX_PAGES = 10;
  let pageCount = 0;
  let hasMore = response.has_more;
  let nextCursor = response.next_cursor;

  while (hasMore && pageCount < MAX_PAGES) {
    pageCount++;
    const nextBody = { ...body, start_cursor: nextCursor };
    response = await notionPost(token, `/databases/${databaseId}/query`, nextBody);
    const pageResults = Array.isArray(response.results) ? response.results : [];
    allEntries.push(...pageResults);
    hasMore = response.has_more;
    nextCursor = response.next_cursor;
  }

  return allEntries;
}

async function fetchComments(token, pageId) {
  try {
    const response = await notionGet(token, `/comments?block_id=${pageId}&page_size=100`);
    return Array.isArray(response.results) ? response.results : [];
  } catch {
    return [];
  }
}

// ── Property extraction ─────────────────────────────────────────────────────

function extractTitle(page) {
  const props = page.properties || {};

  // Try common title property names
  for (const key of ['Name', 'Title', 'title', 'name']) {
    const prop = props[key];
    if (prop && prop.title && Array.isArray(prop.title)) {
      const text = prop.title.map((t) => t.plain_text || '').join('');
      if (text) return text;
    }
  }

  // Try any title-type property
  for (const prop of Object.values(props)) {
    if (prop && prop.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title.map((t) => t.plain_text || '').join('');
      if (text) return text;
    }
  }

  return page.id ? `(page ${page.id.slice(0, 8)})` : '(untitled)';
}

function extractEditedBy(page, userMap) {
  const editor = page.last_edited_by;
  if (!editor) return '-';
  if (editor.name) return editor.name;
  if (editor.id && userMap && userMap[editor.id]) return userMap[editor.id];
  return editor.id || '-';
}

function extractPropertyValue(prop) {
  if (!prop) return '-';
  switch (prop.type) {
    case 'select':
      return prop.select ? prop.select.name : '-';
    case 'multi_select':
      return (prop.multi_select || []).map((s) => s.name).join(', ') || '-';
    case 'status':
      return prop.status ? prop.status.name : '-';
    case 'people':
      return (prop.people || []).map((p) => p.name || p.id).join(', ') || '-';
    case 'date':
      return prop.date ? prop.date.start : '-';
    case 'number':
      return prop.number != null ? String(prop.number) : '-';
    case 'checkbox':
      return prop.checkbox ? 'Yes' : 'No';
    case 'rich_text':
      return (prop.rich_text || []).map((t) => t.plain_text).join('') || '-';
    case 'title':
      return (prop.title || []).map((t) => t.plain_text).join('') || '-';
    default:
      return '-';
  }
}

// ── Analysis ────────────────────────────────────────────────────────────────

function analyzeActivity(pages, dbEntries, commentCounts, sinceDate, todayDate, userMap) {
  const editorCounts = {};
  const dailyCounts = {};
  let totalComments = 0;

  for (const page of pages) {
    // Editor activity
    const editor = extractEditedBy(page, userMap);
    editorCounts[editor] = (editorCounts[editor] || 0) + 1;

    // Daily volume
    const editedDate = (page.last_edited_time || '').slice(0, 10);
    if (editedDate) {
      dailyCounts[editedDate] = (dailyCounts[editedDate] || 0) + 1;
    }
  }

  // Comment totals
  for (const count of Object.values(commentCounts)) {
    totalComments += count;
  }

  // Sort editors by activity
  const sortedEditors = Object.entries(editorCounts)
    .sort((a, b) => b[1] - a[1]);

  // Database entry status counts
  const statusCounts = {};
  for (const entry of dbEntries) {
    const props = entry.properties || {};
    // Try common status properties
    for (const key of ['Status', 'status', 'State', 'state']) {
      const prop = props[key];
      if (prop) {
        const val = extractPropertyValue(prop);
        if (val !== '-') {
          statusCounts[val] = (statusCounts[val] || 0) + 1;
          break;
        }
      }
    }
  }

  return {
    pageCount: pages.length,
    dbEntryCount: dbEntries.length,
    totalComments,
    sortedEditors,
    dailyCounts,
    statusCounts,
    commentCounts,
    pages,
    dbEntries,
  };
}

// ── Markdown generation ─────────────────────────────────────────────────────

function generateMarkdown(analysis, sinceDate, todayDate, timestamp, userMap) {
  const lines = [];

  lines.push('# Notion Signals');
  lines.push('');
  lines.push(`**Period:** ${sinceDate} to ${todayDate}  `);
  lines.push(`**Pulled:** ${timestamp}`);
  lines.push('');

  // Volume overview
  lines.push('## Volume');
  lines.push('');
  lines.push(`- **${analysis.pageCount}** pages updated`);
  if (analysis.dbEntryCount > 0) {
    lines.push(`- **${analysis.dbEntryCount}** database entries modified`);
  }
  if (analysis.totalComments > 0) {
    lines.push(`- **${analysis.totalComments}** new comments`);
  }
  lines.push('');

  // Daily volume
  const sortedDays = Object.entries(analysis.dailyCounts).sort((a, b) => a[0].localeCompare(b[0]));
  if (sortedDays.length > 0) {
    lines.push('## Daily Activity');
    lines.push('');
    for (const [day, count] of sortedDays) {
      const bar = '\u2588'.repeat(Math.min(count, 30));
      lines.push(`  ${day}  ${bar} ${count}`);
    }
    lines.push('');
  }

  // Top editors
  if (analysis.sortedEditors.length > 0) {
    lines.push('## Top Contributors');
    lines.push('');
    lines.push('| Person | Pages Edited |');
    lines.push('|--------|-------------|');
    for (const [editor, count] of analysis.sortedEditors.slice(0, 10)) {
      lines.push(`| ${sanitizeForMarkdown(editor)} | ${count} |`);
    }
    lines.push('');
  }

  // Recently updated pages
  if (analysis.pages.length > 0) {
    lines.push('## Recently Updated Pages');
    lines.push('');
    lines.push('| Page | Editor | Updated | Comments |');
    lines.push('|------|--------|---------|----------|');
    for (const page of analysis.pages.slice(0, 20)) {
      const title = sanitizeForMarkdown(extractTitle(page));
      const editor = sanitizeForMarkdown(extractEditedBy(page, userMap));
      const updated = (page.last_edited_time || '').slice(0, 10);
      const comments = analysis.commentCounts[page.id] || 0;
      const commentStr = comments > 0 ? `${comments} new` : '-';
      lines.push(`| ${title} | ${editor} | ${updated} | ${commentStr} |`);
    }
    lines.push('');
  }

  // Database entry status breakdown
  if (Object.keys(analysis.statusCounts).length > 0) {
    lines.push('## Database Entry Status');
    lines.push('');
    for (const [status, count] of Object.entries(analysis.statusCounts)) {
      lines.push(`- **${sanitizeForMarkdown(status)}**: ${count}`);
    }
    lines.push('');
  }

  // Pages with active discussions (comments)
  const discussedPages = analysis.pages.filter((p) => analysis.commentCounts[p.id] > 0);
  if (discussedPages.length > 0) {
    lines.push('## Active Discussions');
    lines.push('');
    for (const page of discussedPages.slice(0, 10)) {
      const title = sanitizeForMarkdown(extractTitle(page));
      const count = analysis.commentCounts[page.id];
      lines.push(`- **${title}** — ${count} new comment(s)`);
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
  parts.push(`${analysis.pageCount} pages updated`);

  if (analysis.dbEntryCount > 0) {
    parts.push(`${analysis.dbEntryCount} database entries modified`);
  }

  if (analysis.totalComments > 0) {
    parts.push(`${analysis.totalComments} new comments`);
  }

  if (analysis.sortedEditors.length > 0) {
    const topEditors = analysis.sortedEditors.slice(0, 3).map(([name, count]) => `${name} (${count})`);
    parts.push(`Top contributors: ${topEditors.join(', ')}`);
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
