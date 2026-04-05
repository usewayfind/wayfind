#!/usr/bin/env node
'use strict';

/**
 * Wayfind MCP Server — stdio transport.
 *
 * Exposes team context (journals, signals, decisions) as MCP tools so any
 * MCP-compatible AI tool can query the same knowledge base that Wayfind builds.
 * Team-scoped from day one: resolveStorePath() picks the right store for the
 * active team based on the working directory.
 *
 * Usage (Claude Code):
 *   Add to ~/.claude/claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "wayfind": { "command": "wayfind-mcp" }
 *     }
 *   }
 *
 * Or run directly: wayfind-mcp
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const path = require('path');
const fs = require('fs');
const contentStore = require('./content-store.js');

const http = require('http');

const pkg = require('../package.json');

// ── Container proxy ─────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE;
const WAYFIND_DIR = HOME ? path.join(HOME, '.claude', 'team-context') : null;

/**
 * Read context.json to find the active team's container_endpoint.
 */
function getContainerEndpoint() {
  if (!WAYFIND_DIR) return null;
  const configPath = path.join(WAYFIND_DIR, 'context.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Resolve active team: repo binding → default
    const teamId = getActiveTeamId(config);
    if (!teamId || !config.teams || !config.teams[teamId]) return null;
    return config.teams[teamId].container_endpoint || null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve active team ID from context.json (simplified — mirrors team-context.js logic).
 */
function getActiveTeamId(config) {
  // Check repo-level binding first
  try {
    const bindingFile = path.join(process.cwd(), '.claude', 'wayfind.json');
    if (fs.existsSync(bindingFile)) {
      const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
      if (binding.team_id) return binding.team_id;
    }
  } catch (_) {}
  return config.default || null;
}

/**
 * Read the shared API key from the team-context repo.
 */
function readApiKey() {
  if (!WAYFIND_DIR) return null;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(WAYFIND_DIR, 'context.json'), 'utf8'));
    const teamId = getActiveTeamId(config);
    if (!teamId || !config.teams || !config.teams[teamId]) return null;
    const teamPath = config.teams[teamId].path;
    if (!teamPath) return null;
    const keyFile = path.join(teamPath, '.wayfind-api-key');
    return fs.readFileSync(keyFile, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

// Cache for API key (re-read from disk on 401)
let cachedApiKey = null;

/**
 * HTTP POST to the container's search API.
 * Returns parsed JSON or null on failure.
 */
function containerPost(endpoint, apiKey, body) {
  return new Promise((resolve) => {
    try {
      const url = new URL(endpoint);
      const postData = JSON.stringify(body);
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': `Bearer ${apiKey}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: data });
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(postData);
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * HTTP GET from the container's entry API.
 */
function containerGet(endpoint, apiKey) {
  return new Promise((resolve) => {
    try {
      const url = new URL(endpoint);
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: 10000,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: data });
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Try to proxy a search request to the container.
 * On 401, re-reads the API key from disk and retries once.
 * Returns parsed result or null if container unreachable/unavailable.
 */
async function proxySearch(body) {
  const endpoint = getContainerEndpoint();
  if (!endpoint) return null;

  if (!cachedApiKey) cachedApiKey = readApiKey();
  if (!cachedApiKey) return null;

  const searchUrl = `${endpoint}/api/search`;
  let result = await containerPost(searchUrl, cachedApiKey, body);

  // On 401, re-read key (may have been rotated) and retry once
  if (result && result.status === 401) {
    process.stderr.write('Container returned 401 — re-reading API key...\n');
    cachedApiKey = readApiKey();
    if (!cachedApiKey) return null;
    result = await containerPost(searchUrl, cachedApiKey, body);
  }

  if (!result || result.status !== 200) return null;

  try {
    return JSON.parse(result.body);
  } catch (_) {
    return null;
  }
}

/**
 * Try to proxy an entry retrieval to the container.
 * Same 401-retry logic as proxySearch.
 */
async function proxyGetEntry(id) {
  const endpoint = getContainerEndpoint();
  if (!endpoint) return null;

  if (!cachedApiKey) cachedApiKey = readApiKey();
  if (!cachedApiKey) return null;

  const entryUrl = `${endpoint}/api/entry/${encodeURIComponent(id)}`;
  let result = await containerGet(entryUrl, cachedApiKey);

  if (result && result.status === 401) {
    process.stderr.write('Container returned 401 — re-reading API key...\n');
    cachedApiKey = readApiKey();
    if (!cachedApiKey) return null;
    result = await containerGet(entryUrl, cachedApiKey);
  }

  if (!result || result.status !== 200) return null;

  try {
    return JSON.parse(result.body);
  } catch (_) {
    return null;
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_context',
    description: 'Search the team\'s decision history across all repos and engineers. Returns ranked entries. Use mode=browse with since/until for time-range queries ("what happened this week"). Use mode=semantic with a query for topical searches. Pass dates, authors, and repos as explicit parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query (required for semantic mode, optional for browse)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        repo: { type: 'string', description: 'Filter by repository name (e.g. "MyService", "MyOrg/my-repo")' },
        since: { type: 'string', description: 'Filter to entries on or after this date (YYYY-MM-DD)' },
        until: { type: 'string', description: 'Filter to entries on or before this date (YYYY-MM-DD)' },
        user: { type: 'string', description: 'Filter by author slug (lowercase first name, e.g. "nick")' },
        source: { type: 'string', enum: ['journal', 'conversation', 'signal'], description: 'Filter by entry source type' },
        mode: { type: 'string', enum: ['semantic', 'browse'], description: 'Search strategy. semantic (default) uses embeddings for relevance ranking. browse returns entries sorted by date (best for time-range queries).' },
      },
    },
  },
  {
    name: 'get_entry',
    description: 'Retrieve the full content of a specific journal or signal entry by ID. Use the IDs returned by search_context.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry ID from search_context results' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_signals',
    description: 'Retrieve recent signal entries (GitHub activity, Slack summaries, Intercom updates, Notion pages) for a specific channel or all channels.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Signal channel name (e.g. "github", "slack", "intercom"). Omit for all channels.' },
        since: { type: 'string', description: 'Filter to signals on or after this date (YYYY-MM-DD). Defaults to last 7 days.' },
        limit: { type: 'number', description: 'Max signals to return (default: 20)' },
      },
    },
  },
  {
    name: 'get_team_status',
    description: 'Get the current team state: who is working on what, active projects, recent decisions, and open blockers. Reads from team-state.md and personal-state.md files.',
    inputSchema: {
      type: 'object',
      properties: {
        include_personal: { type: 'boolean', description: 'Include personal-state.md in addition to team-state.md (default: true)' },
      },
    },
  },
  {
    name: 'get_personas',
    description: 'List the configured Wayfind personas (e.g. Greg/engineering, Sean/strategy). Each persona gets a tailored digest. Useful for understanding who uses this team context and how.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'record_feedback',
    description: 'Record that a context result was helpful or not. This improves future retrieval quality by down-weighting unhelpful entries.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'ID of the entry being rated' },
        helpful: { type: 'boolean', description: 'Was this entry useful for the task?' },
        query: { type: 'string', description: 'The original query that surfaced this entry (for context)' },
      },
      required: ['entry_id', 'helpful'],
    },
  },
  {
    name: 'add_context',
    description: 'Add a new context entry to the team knowledge base. Use this to capture decisions, blockers, or key context from an AI session that should be available to future sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the entry (< 80 chars)' },
        content: { type: 'string', description: 'Full content in markdown. Should include Why, What, and any key decisions.' },
        repo: { type: 'string', description: 'Repository this entry belongs to (e.g. "MyOrg/my-repo")' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['title', 'content'],
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────

async function handleSearchContext(args) {
  const { query, limit = 10, repo, since, until, user, source, mode: rawMode } = args;

  // Auto-switch to browse if no query provided
  const mode = (!query && rawMode !== 'browse') ? 'browse' : (rawMode || 'semantic');

  // Browse mode — return entries sorted by date (no embeddings needed)
  if (mode === 'browse') {
    const opts = { limit, repo, since, until, user, source };

    // Try container first
    const containerResult = await proxySearch({ query, limit, repo, since, until, user, source, mode: 'browse' });
    if (containerResult && containerResult.found > 0) {
      containerResult.source = 'container';
      return containerResult;
    }

    // Fall back to local
    const results = contentStore.queryMetadata(opts);
    const top = results.slice(0, limit);
    return {
      found: results.length,
      showing: top.length,
      source: 'local',
      results: top.map(r => ({
        id: r.id,
        date: r.entry.date,
        repo: r.entry.repo,
        title: r.entry.title,
        source: r.entry.source,
        user: r.entry.user || null,
        tags: r.entry.tags || [],
        summary: r.entry.summary || null,
      })),
    };
  }

  // Semantic mode — try container first (has embeddings for full team)
  const containerResult = await proxySearch({ query, limit, repo, since, until, user, source, mode });
  if (containerResult && containerResult.found > 0) {
    containerResult.source = 'container';
    return containerResult;
  }

  // Fall back to local semantic search
  const opts = { limit, repo, since, until, user, source };
  const results = await contentStore.searchJournals(query, opts);

  if (!results || results.length === 0) {
    return { found: 0, results: [], source: 'local', hint: 'No matches. Try a broader query or check wayfind reindex.' };
  }

  return {
    found: results.length,
    source: 'local',
    results: results.map(r => ({
      id: r.id,
      score: r.score ? Math.round(r.score * 1000) / 1000 : null,
      date: r.entry.date,
      repo: r.entry.repo,
      title: r.entry.title,
      source: r.entry.source,
      user: r.entry.user || null,
      tags: r.entry.tags || [],
      summary: r.entry.summary || null,
    })),
  };
}

async function handleGetEntry(args) {
  const { id } = args;
  const storePath = contentStore.resolveStorePath();
  const journalDir = contentStore.DEFAULT_JOURNAL_DIR;

  // Try local first (fastest)
  const index = contentStore.getBackend(storePath).loadIndex();
  if (index && index.entries && index.entries[id]) {
    const entry = index.entries[id];
    const fullContent = contentStore.getEntryContent(id, { storePath, journalDir });
    return {
      id,
      date: entry.date,
      repo: entry.repo,
      title: entry.title,
      source: entry.source,
      tags: entry.tags || [],
      content: fullContent || entry.summary || null,
    };
  }

  // Not found locally — try container (may have entries from other team members)
  const containerResult = await proxyGetEntry(id);
  if (containerResult && !containerResult.error) {
    return containerResult;
  }

  return { error: `Entry not found: ${id}` };
}


function handleGetSignals(args) {
  const { channel, limit = 20 } = args;
  const signalsDir = contentStore.resolveSignalsDir();
  const sinceDate = args.since || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  })();

  if (!signalsDir || !fs.existsSync(signalsDir)) {
    return { error: 'No signals directory found. Run "wayfind pull --all" first.', signals: [] };
  }

  const channels = channel
    ? [channel]
    : fs.readdirSync(signalsDir).filter(d => {
        try { return fs.statSync(path.join(signalsDir, d)).isDirectory(); } catch { return false; }
      });

  const signals = [];
  for (const ch of channels) {
    const chDir = path.join(signalsDir, ch);
    if (!fs.existsSync(chDir)) continue;

    const files = fs.readdirSync(chDir)
      .filter(f => f.endsWith('.md') && f >= sinceDate)
      .sort()
      .reverse()
      .slice(0, limit);

    for (const f of files) {
      const filePath = path.join(chDir, f);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        signals.push({
          channel: ch,
          date: f.slice(0, 10),
          file: f,
          content: content.slice(0, 2000) + (content.length > 2000 ? '\n...(truncated)' : ''),
        });
      } catch (_) {}
    }
  }

  signals.sort((a, b) => b.date.localeCompare(a.date));
  return { signals: signals.slice(0, limit) };
}

function handleGetTeamStatus(args) {
  const { include_personal = true } = args;
  const HOME = process.env.HOME || process.env.USERPROFILE;
  const wayfindDir = process.env.WAYFIND_DIR || (HOME ? path.join(HOME, '.claude', 'team-context') : null);

  const result = {};

  // Try to read team-state.md from cwd's .claude/ directory
  const cwdTeamState = path.join(process.cwd(), '.claude', 'team-state.md');
  const cwdPersonalState = path.join(process.cwd(), '.claude', 'personal-state.md');

  for (const [key, filePath] of [['team_state', cwdTeamState], ['personal_state', cwdPersonalState]]) {
    if (key === 'personal_state' && !include_personal) continue;
    try {
      if (fs.existsSync(filePath)) {
        result[key] = fs.readFileSync(filePath, 'utf8');
      }
    } catch (_) {}
  }

  if (Object.keys(result).length === 0) {
    return { error: 'No state files found in .claude/. Make sure Wayfind is initialized in this repo.' };
  }

  return result;
}

function handleGetPersonas() {
  const HOME = process.env.HOME || process.env.USERPROFILE;
  const connectorsFile = HOME ? path.join(HOME, '.claude', 'team-context', 'connectors.json') : null;

  if (!connectorsFile || !fs.existsSync(connectorsFile)) {
    return { error: 'connectors.json not found. Run "wayfind context init" first.', personas: [] };
  }

  try {
    const config = JSON.parse(fs.readFileSync(connectorsFile, 'utf8'));
    const personas = config.personas || config.digest?.personas || [];
    return { personas };
  } catch (e) {
    return { error: `Failed to read connectors.json: ${e.message}`, personas: [] };
  }
}

function handleRecordFeedback(args) {
  const { entry_id, helpful, query } = args;
  const storePath = contentStore.resolveStorePath();

  try {
    const feedback = contentStore.loadFeedback(storePath);
    const existing = feedback.entries || {};
    existing[entry_id] = existing[entry_id] || { helpful: 0, unhelpful: 0, queries: [] };

    if (helpful) {
      existing[entry_id].helpful = (existing[entry_id].helpful || 0) + 1;
    } else {
      existing[entry_id].unhelpful = (existing[entry_id].unhelpful || 0) + 1;
    }
    if (query) {
      existing[entry_id].queries = [...(existing[entry_id].queries || []).slice(-4), query];
    }

    contentStore.saveFeedback(storePath, { ...feedback, entries: existing });
    return { recorded: true, entry_id, helpful };
  } catch (e) {
    return { error: `Failed to record feedback: ${e.message}` };
  }
}

function handleAddContext(args) {
  const { title, content, repo, tags = [] } = args;
  const journalDir = contentStore.DEFAULT_JOURNAL_DIR;

  if (!journalDir) {
    return { error: 'Cannot resolve journal directory.' };
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const sanitizedTitle = title.replace(/[^a-zA-Z0-9\s\-_]/g, '').slice(0, 60);
    const repoLine = repo ? `\n**Repo:** ${repo}` : '';
    const tagsLine = tags.length ? `\n**Tags:** ${tags.join(', ')}` : '';

    const entry = [
      `## ${repo || 'general'} — ${sanitizedTitle}`,
      `**Why:** Added via Wayfind MCP`,
      `**What:** ${content}`,
      repoLine,
      tagsLine,
    ].filter(Boolean).join('\n');

    const filePath = path.join(journalDir, `${today}.md`);
    fs.mkdirSync(journalDir, { recursive: true });

    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    fs.writeFileSync(filePath, existing + (existing ? '\n\n' : '') + entry + '\n');

    return {
      added: true,
      date: today,
      title: sanitizedTitle,
      file: filePath,
      hint: 'Run "wayfind index-journals" to make this entry searchable.',
    };
  } catch (e) {
    return { error: `Failed to add context: ${e.message}` };
  }
}

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'wayfind', version: pkg.version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  let result;
  switch (name) {
    case 'search_context':   result = await handleSearchContext(args); break;
    case 'get_entry':        result = await handleGetEntry(args); break;
    case 'get_signals':      result = handleGetSignals(args); break;
    case 'get_team_status':  result = handleGetTeamStatus(args); break;
    case 'get_personas':     result = handleGetPersonas(); break;
    case 'record_feedback':  result = handleRecordFeedback(args); break;
    case 'add_context':      result = handleAddContext(args); break;
    default:
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
  }

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so it doesn't pollute the MCP stdio channel
  process.stderr.write(`Wayfind MCP server v${pkg.version} ready\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
