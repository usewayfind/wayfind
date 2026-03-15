'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const llm = require('./connectors/llm');
const telemetry = require('./telemetry');
const { getBackend, getBackendType } = require('./storage');

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE;
const DEFAULT_STORE_PATH = HOME ? path.join(HOME, '.claude', 'team-context', 'content-store') : null;
const DEFAULT_JOURNAL_DIR = HOME ? path.join(HOME, '.claude', 'memory', 'journal') : null;
const DEFAULT_PROJECTS_DIR = HOME ? path.join(HOME, '.claude', 'projects') : null;
const DEFAULT_SIGNALS_DIR = HOME ? path.join(HOME, '.claude', 'team-context', 'signals') : null;
const INDEX_VERSION = '2.0.0';
const FILE_PERMS = 0o600;

// Field mapping for journal entries
const FIELD_MAP = {
  'Why': 'why',
  'What': 'what',
  'Outcome': 'outcome',
  'On track?': 'onTrack',
  'Lessons': 'lessons',
};

const FIELD_LABELS = {
  why: 'Why',
  what: 'What',
  outcome: 'Outcome',
  onTrack: 'On track?',
  lessons: 'Lessons',
};

// Regex patterns
const ENTRY_HEADER_RE = /^##\s+(.+?)\s+[—–]\s+(.+)$/;
const FIELD_RE = /^\*\*([^*:]+):\*\*\s*(.*)$/;
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:-([a-z0-9._-]+))?\.md$/;

// Repo exclusion list (comma-separated, case-insensitive, supports org/repo or just repo).
// NOTE: Team boundaries are now enforced at export/sync time via opt-in .claude/wayfind.json
// bindings (see buildRepoToTeamResolver in team-context.js). This env var is still useful
// for filtering repos out of indexing and queries entirely, but is no longer needed for
// preventing unbound repos from leaking into team digests.
const EXCLUDE_REPOS = (process.env.TEAM_CONTEXT_EXCLUDE_REPOS || '')
  .split(',').map(r => r.trim().toLowerCase()).filter(Boolean);

// Drift detection keywords
const DRIFT_POSITIVE = ['drift', 'drifted', 'tangent', 'pivoted', 'sidetracked', 'off track', 'off-track'];
const DRIFT_NEGATIVE = ['no drift', 'no tangent', 'on track', 'focused', 'laser focused', 'stayed focused'];

/**
 * Check if a repo name matches the exclusion list.
 * Matches against repo name alone or org/repo format.
 */
function isRepoExcluded(repo) {
  if (!EXCLUDE_REPOS.length || !repo) return false;
  const lower = repo.toLowerCase();
  return EXCLUDE_REPOS.some(ex => lower === ex || lower.endsWith('/' + ex) || lower.startsWith(ex + '/'));
}

// ── Journal parsing ─────────────────────────────────────────────────────────

/**
 * Parse a single journal file into an array of entry objects.
 * @param {string} filePath - Path to the journal markdown file
 * @returns {{ date: string, entries: Array<{ repo: string, title: string, fields: Object }> }}
 */
function parseJournalFile(filePath) {
  const basename = path.basename(filePath);
  const dateMatch = basename.match(DATE_FILE_RE);
  const date = dateMatch ? dateMatch[1] : null;
  const filenameAuthor = dateMatch ? (dateMatch[2] || null) : null;

  if (!date) return { date: null, entries: [] };

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { date, entries: [] };
  }

  // Normalize line endings — git checkouts on Windows/WSL may produce CRLF
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (!content.trim()) return { date, entries: [] };

  const lines = content.split('\n');
  const entries = [];
  let current = null;
  let currentField = null;

  // Author tracking: **Author:** lines apply to the NEXT ## entry header.
  // A pending author is consumed when the next header appears.
  const AUTHOR_RE = /^\*\*Author:\*\*\s*(.+)$/;
  let fileLevelAuthor = null;
  let pendingAuthor = null;

  for (const line of lines) {
    // Detect **Author:** lines — these always apply to the NEXT entry
    const authorMatch = line.match(AUTHOR_RE);
    if (authorMatch) {
      pendingAuthor = authorMatch[1].trim();
      if (!current) {
        // Before any entry — also set as file-level default
        fileLevelAuthor = pendingAuthor;
      }
      continue;
    }

    const headerMatch = line.match(ENTRY_HEADER_RE);
    if (headerMatch) {
      if (current) entries.push(current);
      current = {
        repo: headerMatch[1].trim().replace(/^\[|\]$/g, ''),
        title: headerMatch[2].trim(),
        fields: {},
        author: pendingAuthor || null,
      };
      pendingAuthor = null;
      currentField = null;
      continue;
    }

    if (!current) continue;

    const fieldMatch = line.match(FIELD_RE);
    if (fieldMatch) {
      const label = fieldMatch[1].trim();
      const value = fieldMatch[2].trim();
      const key = FIELD_MAP[label];
      if (key) {
        current.fields[key] = value;
        currentField = key;
      }
      continue;
    }

    // Continuation line for multi-line fields
    if (currentField && line.trim() && !line.startsWith('#')) {
      current.fields[currentField] += '\n' + line;
    }
  }

  if (current) entries.push(current);

  // Resolve author for each entry: entry-level > file-level > filename author
  for (const entry of entries) {
    if (!entry.author) {
      entry.author = fileLevelAuthor || filenameAuthor || null;
    }
  }

  return { date, entries };
}

/**
 * Detect whether an entry indicates drift.
 * @param {Object} fields - Entry fields object
 * @returns {boolean}
 */
function isDrifted(fields) {
  const text = [fields.onTrack || '', fields.outcome || '', fields.lessons || ''].join(' ').toLowerCase();

  // Check negative patterns first (they override)
  for (const neg of DRIFT_NEGATIVE) {
    if (text.includes(neg)) return false;
  }

  for (const pos of DRIFT_POSITIVE) {
    if (text.includes(pos)) return true;
  }

  return false;
}

/**
 * Generate a deterministic ID for a journal entry.
 * @param {string} date - YYYY-MM-DD
 * @param {string} repo - Repository/project name
 * @param {string} title - Entry title
 * @returns {string} - 12-char hex ID
 */
function generateEntryId(date, repo, title) {
  const input = `${date}:${repo}:${title}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * Build the text content for embedding from an entry's fields.
 * @param {Object} entry - Entry with date, repo, title, fields
 * @returns {string}
 */
function buildContent(entry) {
  const parts = [`${entry.repo} — ${entry.title}`];
  if (entry.date) parts.push(`Date: ${entry.date}`);
  if (entry.author) parts.push(`Author: ${entry.author}`);
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    if (entry.fields[key]) {
      parts.push(`${label}: ${entry.fields[key]}`);
    }
  }
  return parts.join('\n');
}

/**
 * Extract tags from entry content using word boundaries.
 * Includes repo name and meaningful words from the title.
 * @param {Object} entry - Entry with repo, title, fields
 * @returns {string[]}
 */
function extractTags(entry) {
  const tags = new Set();

  // Repo name as tag (lowercase, cleaned)
  const repoTag = entry.repo.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (repoTag) tags.add(repoTag);

  // Words from title (3+ chars, lowercase, word-boundary aware)
  const titleWords = entry.title.match(/\b[a-zA-Z][a-zA-Z0-9]{2,}\b/g) || [];
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'was', 'are', 'but', 'not', 'has', 'had', 'have', 'been', 'more', 'also', 'into', 'than']);
  for (const word of titleWords) {
    const lower = word.toLowerCase();
    if (!stopWords.has(lower)) tags.add(lower);
  }

  return [...tags];
}

/**
 * Compute a content hash for change detection.
 * @param {string} content - Text content
 * @returns {string} - SHA-256 hex hash (first 16 chars)
 */
function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ── Cosine similarity ───────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Core functions ──────────────────────────────────────────────────────────

/**
 * Index journal files. Incremental — skips unchanged entries.
 * @param {Object} options
 * @param {string} [options.journalDir] - Journal directory
 * @param {string} [options.storePath] - Content store directory
 * @param {boolean} [options.embeddings] - Generate embeddings (default: true if OPENAI_API_KEY or TEAM_CONTEXT_SIMULATE)
 * @returns {Promise<Object>} - Stats: { entryCount, newEntries, updatedEntries, skippedEntries, removedEntries }
 */
async function indexJournals(options = {}) {
  const journalDir = options.journalDir || DEFAULT_JOURNAL_DIR;
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const doEmbeddings = options.embeddings !== undefined
    ? options.embeddings
    : !!(process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT || llm.isSimulation());

  if (!journalDir || !storePath) {
    throw new Error('Journal directory and store path are required.');
  }

  if (!fs.existsSync(journalDir)) {
    throw new Error(`Journal directory not found: ${journalDir}`);
  }

  // Load existing index
  const backend = getBackend(storePath);
  const existingIndex = backend.loadIndex();
  const existingEntries = existingIndex ? existingIndex.entries : {};
  const existingEmbeddings = doEmbeddings ? backend.loadEmbeddings() : {};

  // Parse all journal files
  const files = fs.readdirSync(journalDir).filter(f => DATE_FILE_RE.test(f)).sort();
  const newEntries = {};

  for (const file of files) {
    const filePath = path.join(journalDir, file);
    const { date, entries } = parseJournalFile(filePath);
    if (!date) continue;

    for (const entry of entries) {
      if (isRepoExcluded(entry.repo)) continue;
      const id = generateEntryId(date, entry.repo, entry.title);
      const author = entry.author || options.defaultAuthor || '';
      const content = buildContent({ ...entry, date, author });
      const hash = contentHash(content);

      newEntries[id] = {
        date,
        repo: entry.repo,
        title: entry.title,
        user: author,
        drifted: isDrifted(entry.fields),
        contentHash: hash,
        contentLength: content.length,
        tags: extractTags(entry),
        hasEmbedding: false,
        _content: content, // temporary, not saved to index
      };
    }
  }

  // Compute diffs
  const stats = { entryCount: 0, newEntries: 0, updatedEntries: 0, skippedEntries: 0, removedEntries: 0 };
  const finalEntries = {};
  const finalEmbeddings = { ...existingEmbeddings };

  for (const [id, entry] of Object.entries(newEntries)) {
    const existing = existingEntries[id];
    const content = entry._content;
    delete entry._content;

    if (existing && existing.contentHash === entry.contentHash) {
      // Unchanged — but generate embedding if missing and embeddings are enabled
      entry.hasEmbedding = existing.hasEmbedding;
      if (doEmbeddings && !existing.hasEmbedding && content) {
        try {
          const vec = await llm.generateEmbedding(content);
          finalEmbeddings[id] = vec;
          entry.hasEmbedding = true;
          stats.updatedEntries++;
        } catch (err) {
          stats.skippedEntries++;
        }
      } else {
        stats.skippedEntries++;
      }
      finalEntries[id] = entry;
    } else if (existing) {
      // Changed — re-embed
      if (doEmbeddings) {
        try {
          const vec = await llm.generateEmbedding(content);
          finalEmbeddings[id] = vec;
          entry.hasEmbedding = true;
        } catch (err) {
          // Keep going without embedding for this entry
          entry.hasEmbedding = false;
          delete finalEmbeddings[id];
        }
      }
      finalEntries[id] = entry;
      stats.updatedEntries++;
    } else {
      // New entry
      if (doEmbeddings) {
        try {
          const vec = await llm.generateEmbedding(content);
          finalEmbeddings[id] = vec;
          entry.hasEmbedding = true;
        } catch (err) {
          entry.hasEmbedding = false;
        }
      }
      finalEntries[id] = entry;
      stats.newEntries++;
    }
  }

  // Remove stale entries (in old index but not in current journals)
  for (const id of Object.keys(existingEntries)) {
    if (!newEntries[id]) {
      delete finalEmbeddings[id];
      stats.removedEntries++;
    }
  }

  stats.entryCount = Object.keys(finalEntries).length;

  // Save
  const index = {
    version: INDEX_VERSION,
    lastUpdated: Date.now(),
    entryCount: stats.entryCount,
    entries: finalEntries,
  };

  backend.saveIndex(index);
  if (doEmbeddings) {
    backend.saveEmbeddings(finalEmbeddings);
  }

  telemetry.capture('reindex', {
    source: 'journals',
    entry_count: stats.entryCount,
    new_entries: stats.newEntries,
    has_embeddings: doEmbeddings,
  });

  return stats;
}

/**
 * Search journals using semantic similarity.
 * Falls back to searchText() if no embeddings available.
 * @param {string} query - Search query
 * @param {Object} [options]
 * @param {string} [options.storePath] - Content store directory
 * @param {number} [options.limit] - Max results (default: 10)
 * @param {string} [options.repo] - Filter by repo
 * @param {string} [options.since] - Filter by date (YYYY-MM-DD)
 * @param {string} [options.until] - Filter by date (YYYY-MM-DD)
 * @param {boolean} [options.drifted] - Filter by drift status
 * @returns {Promise<Array<{ id: string, score: number, entry: Object }>>}
 */
async function searchJournals(query, options = {}) {
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const limit = options.limit || 10;

  const backend = getBackend(storePath);
  const index = backend.loadIndex();
  if (!index) return [];

  const embeddings = backend.loadEmbeddings();
  const hasEmbeddings = Object.keys(embeddings).length > 0;

  if (!hasEmbeddings) {
    return searchText(query, options);
  }

  // Generate query embedding
  let queryVec;
  try {
    queryVec = await llm.generateEmbedding(query);
  } catch {
    // Fall back to text search if embedding fails
    return searchText(query, options);
  }

  // Score all entries
  const results = [];
  for (const [id, entry] of Object.entries(index.entries)) {
    if (!applyFilters(entry, options)) continue;
    const vec = embeddings[id];
    if (!vec) continue;

    const score = cosineSimilarity(queryVec, vec);
    results.push({ id, score: Math.round(score * 1000) / 1000, entry });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

/**
 * Full-text search across journal entries.
 * Works without any API key. Matches query words against title, repo, tags.
 * @param {string} query - Search query
 * @param {Object} [options]
 * @param {string} [options.storePath] - Content store directory
 * @param {number} [options.limit] - Max results (default: 10)
 * @param {string} [options.repo] - Filter by repo
 * @param {string} [options.since] - Filter by date (YYYY-MM-DD)
 * @param {string} [options.until] - Filter by date (YYYY-MM-DD)
 * @param {boolean} [options.drifted] - Filter by drift status
 * @returns {Array<{ id: string, score: number, entry: Object }>}
 */
function searchText(query, options = {}) {
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const journalDir = options.journalDir || DEFAULT_JOURNAL_DIR;
  const limit = options.limit || 10;

  const index = getBackend(storePath).loadIndex();
  if (!index) return [];

  // Normalize: split on whitespace, hyphens, underscores
  const queryWords = query.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 1);
  if (queryWords.length === 0) return [];

  // Pre-load journal content for full-text search (cache by date+user key)
  const journalCache = {};
  function getJournalContent(date, user) {
    const cacheKey = user ? `${date}-${user}` : date;
    if (journalCache[cacheKey] !== undefined) return journalCache[cacheKey];
    if (!journalDir) { journalCache[cacheKey] = null; return null; }
    // Try authored filename first, then plain date filename
    const candidates = user
      ? [path.join(journalDir, `${date}-${user}.md`), path.join(journalDir, `${date}.md`)]
      : [path.join(journalDir, `${date}.md`)];
    let content = null;
    for (const filePath of candidates) {
      try {
        content = fs.readFileSync(filePath, 'utf8').toLowerCase();
        break;
      } catch {
        // Try next candidate
      }
    }
    journalCache[cacheKey] = content;
    return content;
  }

  const results = [];
  for (const [id, entry] of Object.entries(index.entries)) {
    if (!applyFilters(entry, options)) continue;

    // Build searchable text from entry metadata (normalize hyphens/underscores)
    let searchable = [
      entry.title,
      entry.repo,
      entry.date,
      entry.user,
      ...(entry.tags || []),
    ].filter(Boolean).join(' ').toLowerCase().replace(/[-_]/g, ' ');

    // Also include the full journal entry content if available
    const journalContent = getJournalContent(entry.date, entry.user);
    if (journalContent) {
      // Find this entry's section in the journal file.
      // Try exact match first, then normalize hyphens/spaces for fuzzy match.
      const repoTitle = `${entry.repo} — ${entry.title}`.toLowerCase();
      let idx = journalContent.indexOf(repoTitle);
      if (idx === -1) {
        // Normalize both sides: collapse hyphens, underscores, em-dashes, and extra spaces
        const norm = (s) => s.replace(/[-_\u2014\u2013]/g, ' ').replace(/\s+/g, ' ').trim();
        const normalized = norm(repoTitle);
        // Search through journal headers for a normalized match
        const headerRegex = /\n## (.+)/g;
        let match;
        while ((match = headerRegex.exec(journalContent)) !== null) {
          const headerNorm = norm(match[1]);
          if (headerNorm.includes(normalized) || normalized.includes(headerNorm)) {
            idx = match.index + 1; // skip the \n
            break;
          }
        }
      }
      if (idx !== -1) {
        // Extract from header to next header (or end of file)
        const nextHeader = journalContent.indexOf('\n## ', idx + 1);
        const section = nextHeader !== -1 ? journalContent.slice(idx, nextHeader) : journalContent.slice(idx);
        searchable += ' ' + section.replace(/[-_]/g, ' ');
      }
    }

    // Score: count of matching query words
    let matches = 0;
    for (const word of queryWords) {
      if (searchable.includes(word)) matches++;
    }

    if (matches > 0) {
      const score = Math.round((matches / queryWords.length) * 1000) / 1000;
      results.push({ id, score, entry });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Apply metadata filters to an entry.
 * @param {Object} entry
 * @param {Object} filters
 * @returns {boolean}
 */
function applyFilters(entry, filters) {
  if (isRepoExcluded(entry.repo)) return false;
  if (filters.repo && entry.repo.toLowerCase() !== filters.repo.toLowerCase()) return false;
  if (filters.since && entry.date < filters.since) return false;
  if (filters.until && entry.date > filters.until) return false;
  if (filters.drifted !== undefined && entry.drifted !== filters.drifted) return false;
  if (filters.user && entry.user && entry.user.toLowerCase() !== filters.user.toLowerCase()) return false;
  return true;
}

/**
 * Query metadata from the index.
 * @param {Object} [options]
 * @param {string} [options.storePath] - Content store directory
 * @param {string} [options.repo] - Filter by repo
 * @param {boolean} [options.drifted] - Filter by drift status
 * @param {string} [options.since] - Filter by date (YYYY-MM-DD)
 * @param {string} [options.until] - Filter by date (YYYY-MM-DD)
 * @returns {Array<{ id: string, entry: Object }>}
 */
function queryMetadata(options = {}) {
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const index = getBackend(storePath).loadIndex();
  if (!index) return [];

  const results = [];
  for (const [id, entry] of Object.entries(index.entries)) {
    if (!applyFilters(entry, options)) continue;
    results.push({ id, entry });
  }

  // Sort by date descending
  results.sort((a, b) => b.entry.date.localeCompare(a.entry.date));
  return results;
}

/**
 * Extract insights from the indexed journal data.
 * @param {Object} [options]
 * @param {string} [options.storePath] - Content store directory
 * @returns {Object} - Insights object
 */
function extractInsights(options = {}) {
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const index = getBackend(storePath).loadIndex();
  if (!index || index.entryCount === 0) {
    return {
      totalSessions: 0,
      driftRate: 0,
      repoActivity: {},
      tagFrequency: {},
      timeline: [],
    };
  }

  const entries = Object.values(index.entries);
  const totalSessions = entries.length;
  const driftedCount = entries.filter(e => e.drifted).length;
  const driftRate = Math.round((driftedCount / totalSessions) * 100);

  // Repo activity
  const repoActivity = {};
  for (const entry of entries) {
    const repo = entry.repo;
    repoActivity[repo] = (repoActivity[repo] || 0) + 1;
  }

  // Tag frequency
  const tagFrequency = {};
  for (const entry of entries) {
    for (const tag of (entry.tags || [])) {
      tagFrequency[tag] = (tagFrequency[tag] || 0) + 1;
    }
  }

  // Timeline: sessions per date
  const dateCounts = {};
  for (const entry of entries) {
    dateCounts[entry.date] = (dateCounts[entry.date] || 0) + 1;
  }
  const timeline = Object.entries(dateCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, sessions: count }));

  // Decision quality breakdown (conversation entries only)
  const conversationEntries = entries.filter(e => e.source === 'conversation');
  const totalDecisions = conversationEntries.length;
  const richDecisions = conversationEntries.filter(e => e.hasReasoning || e.hasAlternatives).length;
  const thinDecisions = totalDecisions - richDecisions;
  const richRate = totalDecisions > 0 ? Math.round((richDecisions / totalDecisions) * 100) : 0;

  return {
    totalSessions,
    driftRate,
    repoActivity,
    tagFrequency,
    timeline,
    quality: {
      totalDecisions,
      rich: richDecisions,
      thin: thinDecisions,
      richRate,
    },
  };
}

/**
 * Get the full content of a journal entry by re-reading the original file.
 * The index stores metadata but NOT full content. This function re-reads
 * the original journal file on demand to return the complete entry text.
 *
 * Handles three entry types:
 * - Journal entries: re-reads from journalDir
 * - Signal entries (source === 'signal'): reads from signalsDir/channel/
 * - Conversation entries (source === 'conversation'): tries journal path first,
 *   falls back to buildContent() metadata
 *
 * @param {string} entryId - Entry ID from the index
 * @param {Object} [options]
 * @param {string} [options.storePath] - Content store directory
 * @param {string} [options.journalDir] - Journal directory
 * @param {string} [options.signalsDir] - Signals directory
 * @returns {string|null} - Full entry text, or null if not found
 */
function getEntryContent(entryId, options = {}) {
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const journalDir = options.journalDir || DEFAULT_JOURNAL_DIR;
  const signalsDir = options.signalsDir || DEFAULT_SIGNALS_DIR;

  const index = getBackend(storePath).loadIndex();
  if (!index || !index.entries[entryId]) return null;

  const entry = index.entries[entryId];
  if (!entry.date) return null;

  // ── Signal entries ──────────────────────────────────────────────────────
  if (entry.source === 'signal') {
    if (!signalsDir) return null;
    // entry.repo is like 'signals/github' — extract the channel
    const channel = (entry.repo || '').replace(/^signals\//, '');
    if (!channel) return null;

    const channelDir = path.join(signalsDir, channel);
    if (!fs.existsSync(channelDir)) return null;

    // Find a matching file in the channel directory
    // Try date-based filename first, then scan for any file containing the title
    const dateCandidates = [
      path.join(channelDir, `${entry.date}.md`),
      path.join(channelDir, `${entry.date}-summary.md`),
    ];
    for (const filePath of dateCandidates) {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        // Try next candidate
      }
    }

    // Scan channel dir for files matching the date
    try {
      const files = fs.readdirSync(channelDir).filter(f => f.endsWith('.md') && f.includes(entry.date));
      for (const file of files) {
        try {
          return fs.readFileSync(path.join(channelDir, file), 'utf8');
        } catch {
          continue;
        }
      }
    } catch {
      // Channel dir not readable
    }

    return null;
  }

  // ── Conversation entries ────────────────────────────────────────────────
  if (entry.source === 'conversation') {
    // Try journal path first (for --export'd conversations)
    if (journalDir) {
      const candidates = entry.user
        ? [path.join(journalDir, `${entry.date}-${entry.user}.md`), path.join(journalDir, `${entry.date}.md`)]
        : [path.join(journalDir, `${entry.date}.md`)];

      for (const filePath of candidates) {
        const result = parseJournalFile(filePath);
        if (result.date && result.entries.length > 0) {
          const match = result.entries.find(
            (e) => e.repo === entry.repo && e.title === entry.title
          );
          if (match) {
            return buildContent({ ...match, date: entry.date, author: entry.user || match.author });
          }
        }
      }
    }

    // Fallback: build content from index metadata
    return buildContent({
      repo: entry.repo,
      title: entry.title,
      date: entry.date,
      author: entry.user || '',
      fields: { why: entry.title },
    });
  }

  // ── Journal entries (default) ───────────────────────────────────────────
  if (!journalDir) return null;

  // Re-read the original journal file — try authored filename first, then plain date
  const candidates = entry.user
    ? [path.join(journalDir, `${entry.date}-${entry.user}.md`), path.join(journalDir, `${entry.date}.md`)]
    : [path.join(journalDir, `${entry.date}.md`)];

  let parsed = null;
  for (const filePath of candidates) {
    const result = parseJournalFile(filePath);
    if (result.date && result.entries.length > 0) {
      // Check if this file contains the entry we're looking for
      const hasMatch = result.entries.some(
        (e) => e.repo === entry.repo && e.title === entry.title
      );
      if (hasMatch) {
        parsed = result;
        break;
      }
    }
  }

  if (!parsed) return null;

  // Find the matching entry by repo + title
  const match = parsed.entries.find(
    (e) => e.repo === entry.repo && e.title === entry.title
  );
  if (!match) return null;

  // Build the full text content from the matched entry
  return buildContent({ ...match, date: entry.date, author: entry.user || match.author });
}

// ── Conversation parsing and extraction ─────────────────────────────────────

/**
 * Decode a Claude Code project directory name to a repo path.
 * Directory names encode the full filesystem path with dashes as separators.
 * e.g. "-home-user-repos-acme-corp-web-api" → "acme-corp/web-api"
 *
 * Strategy: reconstruct the original path by scanning the actual filesystem
 * to find where segment boundaries are, since repo names can contain hyphens.
 * Falls back to taking everything after "repos" in the encoded path.
 * @param {string} dirName - Project directory name
 * @returns {string} - Human-readable repo name
 */
function projectDirToRepo(dirName) {
  // The dir name is the full path with / replaced by -
  // Reconstruct: try to resolve the actual filesystem path
  const asPath = dirName.replace(/^-/, '/').replace(/-/g, '/');

  // Try progressively joining segments to find real directories
  const parts = asPath.split('/').filter(Boolean);
  const resolved = [];
  let i = 0;
  while (i < parts.length) {
    // Try longest match first (handles hyphenated names)
    let found = false;
    for (let len = parts.length - i; len >= 1; len--) {
      const candidate = '/' + [...resolved, parts.slice(i, i + len).join('-')].join('/');
      try {
        fs.statSync(candidate);
        resolved.push(parts.slice(i, i + len).join('-'));
        i += len;
        found = true;
        break;
      } catch {
        // Not a valid path, try shorter
      }
    }
    if (!found) {
      resolved.push(parts[i]);
      i++;
    }
  }

  // Find 'repos' marker and return everything after it
  const reposIdx = resolved.indexOf('repos');
  if (reposIdx !== -1 && resolved.length > reposIdx + 1) {
    return resolved.slice(reposIdx + 1).join('/');
  }

  // Fallback: last two segments
  return resolved.length >= 2 ? resolved.slice(-2).join('/') : resolved.join('/');
}

/**
 * Parse a Claude Code .jsonl transcript into a filtered human-readable exchange.
 * Strips tool_use, thinking, progress, and file-history-snapshot messages.
 * @param {string} filePath - Path to .jsonl transcript
 * @returns {{ messages: Array<{ role: string, text: string }>, sessionId: string, timestamp: string, repo: string }}
 */
function parseTranscript(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { messages: [], sessionId: '', timestamp: '', repo: '' };
  }

  const lines = content.split('\n').filter(Boolean);
  const messages = [];
  let sessionId = '';
  let timestamp = '';
  let repo = '';

  // Derive repo from parent directory name
  const dirName = path.basename(path.dirname(filePath));
  repo = projectDirToRepo(dirName);

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
    if (!timestamp && obj.timestamp) timestamp = obj.timestamp;

    if (obj.type === 'user' && obj.message) {
      const content = obj.message.content;
      if (typeof content === 'string' && content.trim()) {
        messages.push({ role: 'user', text: content.trim() });
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const blocks = obj.message.content;
      if (Array.isArray(blocks)) {
        const textParts = blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text.trim())
          .filter(Boolean);
        if (textParts.length > 0) {
          messages.push({ role: 'assistant', text: textParts.join('\n') });
        }
      }
    }
  }

  return { messages, sessionId, timestamp, repo };
}

/**
 * Build a condensed transcript for LLM extraction.
 * Caps at ~4000 words to stay within Haiku's sweet spot.
 * @param {Array<{ role: string, text: string }>} messages
 * @returns {string}
 */
function buildTranscriptText(messages) {
  const parts = [];
  let wordCount = 0;
  const MAX_WORDS = 4000;

  for (const msg of messages) {
    const prefix = msg.role === 'user' ? 'USER' : 'ASSISTANT';
    const text = `${prefix}: ${msg.text}`;
    const words = text.split(/\s+/).length;
    if (wordCount + words > MAX_WORDS) break;
    parts.push(text);
    wordCount += words;
  }

  return parts.join('\n\n');
}

/** System prompt for decision extraction from conversation transcripts. */
const EXTRACTION_PROMPT = `You are a decision extraction engine. Given a conversation transcript between a developer and an AI coding assistant, extract the key decision points.

Focus on:
- Rejected approaches ("don't do X because Y")
- Explicit trade-offs ("we chose A over B because...")
- Architecture or design choices
- Requirement clarifications
- Convention or pattern decisions
- Tech debt identified

Output a JSON array of decision objects. Each object has:
- "title": short summary (under 80 chars)
- "decision": what was decided and why (1-3 sentences)
- "alternatives": rejected alternatives, if any (1 sentence or empty string)
- "tags": array of 2-5 lowercase keyword tags
- "has_reasoning": boolean — true if the decision includes WHY it was made (rationale, constraints, tradeoffs), not just WHAT was decided
- "has_alternatives": boolean — true if rejected alternatives or considered options are mentioned

Strip any credentials, API keys, or tokens from the output.

If the conversation has no meaningful decisions (just file reads, simple edits, routine work), return an empty array [].

Return ONLY the JSON array, no other text.`;

const SHIFT_DETECTION_PROMPT = `You are a VERY conservative context shift detector. Your job is to say "no shift" for almost every session. Only flag genuinely rare, high-impact changes.

SHIFTS (hasShift: true) — these are RARE events, maybe 1 in 20 sessions:
- Spinning up a brand-new repo, service, or major subsystem
- Team reorgs or personnel changes affecting who works on what
- Strategic pivots (new market, product direction change, competitive response)
- Breaking changes to a public API or shared contract
- New infrastructure dependencies (new database, new cloud service, new CI provider)
- Discovered security vulnerability or data loss incident

NOT SHIFTS (hasShift: false) — this covers 95%+ of sessions:
- Bug fixes of any size or quantity
- Feature iterations, enhancements, improvements, polish
- Version bumps, releases, publishing (even many in one session)
- Config changes, env var updates, dependency upgrades
- Refactoring, renaming, restructuring within existing architecture
- Adding tests, docs, CI tweaks, linting fixes
- Performance optimization
- Routine operational work (deploys, monitoring, alerts)
- Anything described as "incremental", "fix", "update", "clean up", "tweak"

When in doubt, return hasShift: false. A session that ships 10 patch versions is routine. A session that fixes 5 bugs is routine. Only flag things that would genuinely surprise a teammate returning from vacation.

Return ONLY a JSON object:
{
  "hasShift": boolean,
  "summary": "1-2 sentence summary (empty string if no shift)",
  "stateUpdates": {
    "team": "text to append to team-state.md, or empty string",
    "personal": "text to append to personal-state.md, or empty string"
  }
}

Keep state updates concise (2-4 lines max each). Use markdown. Include dates.
Return ONLY the JSON object, no other text.`;

/**
 * Classify extracted decisions as routine or significant context shifts.
 * Uses a lightweight LLM call (Haiku) to score decisions.
 * @param {Array<{ date: string, repo: string, decisions: Array }>} allDecisions
 * @param {Object} llmConfig - LLM config (will override model to Haiku)
 * @param {string} [currentStateContext] - Current state file contents for context
 * @returns {Promise<{ hasShift: boolean, summary: string, stateUpdates: { team: string, personal: string } }>}
 */
async function detectContextShift(allDecisions, llmConfig, currentStateContext) {
  if (!allDecisions || allDecisions.length === 0) {
    return { hasShift: false, summary: '', stateUpdates: { team: '', personal: '' } };
  }

  // Flatten all decisions into a summary for classification
  const decisionSummary = allDecisions.map(({ date, repo, decisions }) =>
    decisions.map(d =>
      `[${date}] ${repo}: ${d.title} — ${d.decision}` +
      (d.alternatives ? ` (rejected: ${d.alternatives})` : '')
    ).join('\n')
  ).join('\n');

  if (decisionSummary.trim().length < 50) {
    return { hasShift: false, summary: '', stateUpdates: { team: '', personal: '' } };
  }

  // Use Haiku for cost efficiency
  const shiftConfig = {
    ...llmConfig,
    model: process.env.TEAM_CONTEXT_SHIFT_MODEL || 'claude-haiku-4-5-20251001',
  };

  const userContent = (currentStateContext
    ? `Current state context:\n${currentStateContext}\n\n`
    : '') +
    `Decisions from this session:\n${decisionSummary}`;

  try {
    const response = await llm.call(shiftConfig, SHIFT_DETECTION_PROMPT, userContent);
    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const result = JSON.parse(jsonStr);
    if (typeof result.hasShift !== 'boolean') return { hasShift: false, summary: '', stateUpdates: { team: '', personal: '' } };
    return {
      hasShift: result.hasShift,
      summary: result.summary || '',
      stateUpdates: {
        team: (result.stateUpdates && result.stateUpdates.team) || '',
        personal: (result.stateUpdates && result.stateUpdates.personal) || '',
      },
    };
  } catch {
    // Fail-safe: don't block session exit
    return { hasShift: false, summary: '', stateUpdates: { team: '', personal: '' } };
  }
}

/**
 * Apply context shift updates to state files.
 * Appends shift summary to personal-state.md and/or team-state.md.
 * @param {{ team: string, personal: string }} stateUpdates
 * @param {string} repoDir - Repository root directory
 * @param {string} shiftSummary - One-line summary of the shift
 * @returns {{ teamUpdated: boolean, personalUpdated: boolean }}
 */
function applyContextShiftToState(stateUpdates, repoDir, shiftSummary) {
  const claudeDir = path.join(repoDir, '.claude');
  const result = { teamUpdated: false, personalUpdated: false };
  const date = new Date().toISOString().slice(0, 10);
  const header = `\n\n### Context shift detected (${date})\n${shiftSummary}\n\n`;

  // Dedup: check if a shift was already appended today to avoid bloating state files
  const alreadyAppendedToday = (filePath) => {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    return content.includes(`### Context shift detected (${date})`);
  };

  if (stateUpdates.team) {
    const teamFile = path.join(claudeDir, 'team-state.md');
    if (fs.existsSync(teamFile) && !alreadyAppendedToday(teamFile)) {
      fs.appendFileSync(teamFile, header + stateUpdates.team + '\n');
      result.teamUpdated = true;
    }
  }

  if (stateUpdates.personal) {
    const personalFile = path.join(claudeDir, 'personal-state.md');
    if (fs.existsSync(personalFile) && !alreadyAppendedToday(personalFile)) {
      fs.appendFileSync(personalFile, header + stateUpdates.personal + '\n');
      result.personalUpdated = true;
    }
  }

  return result;
}

/**
 * Extract decision points from a transcript using an LLM.
 * @param {string} transcriptText - Condensed transcript
 * @param {Object} llmConfig - LLM configuration
 * @returns {Promise<Array<{ title: string, decision: string, alternatives: string, tags: string[] }>>}
 */
async function extractDecisions(transcriptText, llmConfig) {
  if (!transcriptText || transcriptText.trim().length < 100) return [];

  const response = await llm.call(llmConfig, EXTRACTION_PROMPT, transcriptText);

  // Parse JSON from response — handle markdown code fences
  let jsonStr = response.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const decisions = JSON.parse(jsonStr);
    if (!Array.isArray(decisions)) return [];
    return decisions.filter(
      (d) => d && d.title && d.decision
    );
  } catch {
    return [];
  }
}

/**
 * Compute a file fingerprint for incremental indexing.
 * @param {string} filePath
 * @returns {string} - Hash of path + size + mtime
 */
function fileFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const input = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

/**
 * Index conversation transcripts. Extracts decision points via LLM and adds to content store.
 * Incremental — skips transcripts already indexed (by file fingerprint).
 * @param {Object} options
 * @param {string} [options.projectsDir] - Claude Code projects directory
 * @param {string} [options.storePath] - Content store directory
 * @param {Object} [options.llmConfig] - LLM config for extraction
 * @param {boolean} [options.embeddings] - Generate embeddings
 * @param {string} [options.since] - Only index transcripts modified after this date (YYYY-MM-DD)
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Promise<Object>} - Stats: { transcriptsScanned, transcriptsProcessed, decisionsExtracted, skipped, errors }
 */
async function indexConversations(options = {}) {
  const projectsDir = options.projectsDir || DEFAULT_PROJECTS_DIR;
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const doEmbeddings = options.embeddings !== undefined
    ? options.embeddings
    : !!(process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT || llm.isSimulation());

  if (!projectsDir || !storePath) {
    throw new Error('Projects directory and store path are required.');
  }

  if (!fs.existsSync(projectsDir)) {
    throw new Error(`Projects directory not found: ${projectsDir}`);
  }

  // Default LLM config for extraction — use Haiku for cost efficiency
  const llmConfig = options.llmConfig || {
    provider: 'anthropic',
    model: process.env.TEAM_CONTEXT_EXTRACTION_MODEL || 'claude-haiku-4-5-20251001',
    api_key_env: 'ANTHROPIC_API_KEY',
  };

  const stats = { transcriptsScanned: 0, transcriptsProcessed: 0, decisionsExtracted: 0, skipped: 0, errors: 0 };

  // Load existing indexes
  const backend = getBackend(storePath);
  const existingIndex = backend.loadIndex() || { version: INDEX_VERSION, entries: {}, lastUpdated: Date.now(), entryCount: 0 };
  const existingEmbeddings = doEmbeddings ? backend.loadEmbeddings() : {};
  const convIndex = backend.loadConversationIndex();

  // Compute since cutoff
  let sinceCutoff = 0;
  if (options.since) {
    sinceCutoff = new Date(options.since).getTime();
  }

  // Scan all project directories for .jsonl files
  const projectDirs = fs.readdirSync(projectsDir).filter((d) => {
    const full = path.join(projectsDir, d);
    return fs.statSync(full).isDirectory() || d.endsWith('.jsonl');
  });

  const transcriptFiles = [];
  for (const dir of projectDirs) {
    const dirPath = path.join(projectsDir, dir);
    if (dir.endsWith('.jsonl')) {
      transcriptFiles.push(dirPath);
      continue;
    }
    try {
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      for (const f of files) {
        transcriptFiles.push(path.join(dirPath, f));
      }
    } catch {
      // Skip unreadable directories
    }
  }

  stats.transcriptsScanned = transcriptFiles.length;

  // Phase 1: Collect candidates that need LLM extraction (synchronous, no shared-state risk)
  const candidates = [];
  for (const filePath of transcriptFiles) {
    // Check since cutoff
    if (sinceCutoff) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < sinceCutoff) {
          stats.skipped++;
          continue;
        }
      } catch {
        stats.skipped++;
        continue;
      }
    }

    // Check fingerprint for incremental indexing
    const fp = fileFingerprint(filePath);
    if (convIndex[filePath] && convIndex[filePath].fingerprint === fp) {
      stats.skipped++;
      continue;
    }

    // Parse transcript
    const transcript = parseTranscript(filePath);
    if (transcript.messages.length < 3) {
      // Too short to contain meaningful decisions
      convIndex[filePath] = { fingerprint: fp, entryIds: [], extractedAt: Date.now() };
      stats.skipped++;
      continue;
    }

    const transcriptText = buildTranscriptText(transcript.messages);
    candidates.push({ filePath, fp, transcript, transcriptText });
  }

  // Phase 2: Fire LLM extraction calls in parallel with concurrency cap
  // Cap at 5 to avoid API rate limits while still getting parallelism benefit
  const MAX_CONCURRENT = 5;

  if (options.onProgress) {
    for (const c of candidates) {
      options.onProgress({ phase: 'extracting', file: c.filePath, repo: c.transcript.repo });
    }
  }

  const extractionResults = [];
  for (let i = 0; i < candidates.length; i += MAX_CONCURRENT) {
    const batch = candidates.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(
      batch.map(async (c) => {
        try {
          const decisions = await extractDecisions(c.transcriptText, llmConfig);
          return { ...c, decisions, error: null };
        } catch (err) {
          return { ...c, decisions: [], error: err.message };
        }
      })
    );
    extractionResults.push(...batchResults);
  }

  // Phase 3: Merge results into shared indexes (sequential — single-threaded, no races)
  for (const result of extractionResults) {
    if (result.error) {
      console.error(`Extraction failed for ${result.filePath}: ${result.error}`);
      stats.errors++;
      continue;
    }

    const { filePath, fp, transcript, decisions } = result;

    // Store extracted decisions in the content store
    const entryIds = [];
    const date = transcript.timestamp
      ? transcript.timestamp.slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    for (const decision of decisions) {
      const id = generateEntryId(date, transcript.repo, decision.title);
      const content = [
        `${transcript.repo} — ${decision.title}`,
        `Date: ${date}`,
        `Decision: ${decision.decision}`,
        decision.alternatives ? `Alternatives considered: ${decision.alternatives}` : '',
      ].filter(Boolean).join('\n');

      const hash = contentHash(content);

      existingIndex.entries[id] = {
        date,
        repo: transcript.repo,
        title: decision.title,
        source: 'conversation',
        user: '',
        drifted: false,
        contentHash: hash,
        contentLength: content.length,
        tags: decision.tags || [],
        hasEmbedding: false,
        hasReasoning: !!decision.has_reasoning,
        hasAlternatives: !!decision.has_alternatives,
        _content: content,
      };

      if (doEmbeddings) {
        try {
          const vec = await llm.generateEmbedding(content);
          existingEmbeddings[id] = vec;
          existingIndex.entries[id].hasEmbedding = true;
        } catch {
          // Continue without embedding
        }
      }

      delete existingIndex.entries[id]._content;
      entryIds.push(id);
      stats.decisionsExtracted++;
    }

    // Notify caller of extracted decisions (used for journal export)
    if (options.onDecisions && decisions.length > 0) {
      options.onDecisions(date, transcript.repo, decisions);
    }

    // Update conversation index
    convIndex[filePath] = { fingerprint: fp, entryIds, extractedAt: Date.now() };
    stats.transcriptsProcessed++;
  }

  // Save everything
  existingIndex.entryCount = Object.keys(existingIndex.entries).length;
  backend.saveIndex(existingIndex);
  if (doEmbeddings) {
    backend.saveEmbeddings(existingEmbeddings);
  }
  backend.saveConversationIndex(convIndex);

  return stats;
}

// ── Onboarding context packs ────────────────────────────────────────────────

/** System prompt for onboarding pack synthesis. */
const ONBOARDING_PROMPT = `You are Wayfind, generating an onboarding context pack for a new engineer joining a repo. Synthesize the provided decision trail entries into a structured onboarding document.

Organize into these sections (skip any section with no relevant content):

## What this repo does
Brief summary inferred from the decisions and session context.

## Key architecture decisions
The most important technical choices and why they were made. Include dates.

## Recent changes
What's been actively worked on in the last few weeks.

## Open questions and tech debt
Unresolved issues, known debt, things to watch out for.

## Gotchas and conventions
Patterns, workarounds, and things that aren't obvious from reading the code.

## Who works on this
People mentioned in the decision trail and what they focus on.

Rules:
- Be concise and specific. This is a reference doc, not a narrative.
- Cite dates when referencing decisions.
- Under 1000 words total.
- Format in markdown.
- Do not invent information not in the provided context.`;

/**
 * Generate an onboarding context pack for a repo.
 * Queries the content store for recent entries, fetches full content, and synthesizes.
 * @param {string} repoQuery - Repo name or partial match (e.g. "SellingService")
 * @param {Object} options
 * @param {string} [options.storePath] - Content store directory
 * @param {string} [options.journalDir] - Journal directory (for full content retrieval)
 * @param {number} [options.days] - Lookback window in days (default: 90)
 * @param {Object} [options.llmConfig] - LLM configuration
 * @returns {Promise<string>} - Synthesized onboarding document in markdown
 */
async function generateOnboardingPack(repoQuery, options = {}) {
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const journalDir = options.journalDir || DEFAULT_JOURNAL_DIR;
  const days = options.days || 90;
  const llmConfig = options.llmConfig || {
    provider: 'anthropic',
    model: process.env.TEAM_CONTEXT_LLM_MODEL || 'claude-sonnet-4-5-20250929',
    api_key_env: 'ANTHROPIC_API_KEY',
  };

  const index = getBackend(storePath).loadIndex();
  if (!index || index.entryCount === 0) {
    throw new Error('Content store is empty. Run "wayfind reindex" first.');
  }

  // Compute since date
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const since = sinceDate.toISOString().slice(0, 10);

  // Find matching entries — fuzzy match on repo name
  const queryLower = repoQuery.toLowerCase();
  const matchingEntries = [];
  for (const [id, entry] of Object.entries(index.entries)) {
    if (entry.date < since) continue;
    const repoLower = entry.repo.toLowerCase();
    if (repoLower.includes(queryLower) || queryLower.includes(repoLower)) {
      matchingEntries.push({ id, entry });
    }
  }

  if (matchingEntries.length === 0) {
    throw new Error(`No entries found for "${repoQuery}" in the last ${days} days.`);
  }

  // Sort by date descending, cap at 30 entries
  matchingEntries.sort((a, b) => b.entry.date.localeCompare(a.entry.date));
  const topEntries = matchingEntries.slice(0, 30);

  // Fetch full content for each entry
  const contentParts = [];
  for (const { id, entry } of topEntries) {
    const fullContent = getEntryContent(id, { storePath, journalDir });
    if (fullContent) {
      contentParts.push(`---\n${fullContent}`);
    } else {
      // Metadata-only fallback
      const source = entry.source === 'conversation' ? ' [decision]' : '';
      contentParts.push(
        `---\n${entry.date} | ${entry.repo} | ${entry.title}${source}\n` +
        `Tags: ${(entry.tags || []).join(', ')}`
      );
    }
  }

  const repoName = topEntries[0].entry.repo;
  const context = contentParts.join('\n\n');
  const userContent =
    `Generate an onboarding context pack for: ${repoName}\n` +
    `Time range: last ${days} days (${topEntries.length} entries)\n\n` +
    `Decision trail entries:\n\n${context}`;

  return await llm.call(llmConfig, ONBOARDING_PROMPT, userContent);
}

/**
 * Export extracted decisions as journal-format markdown entries.
 * Appends to the appropriate date file in the journal directory so they
 * get git-synced and picked up by the container's journal indexer.
 * @param {string} date - YYYY-MM-DD
 * @param {string} repo - Repo name (e.g. "acme-corp/web-api")
 * @param {Array<{ title: string, decision: string, alternatives: string, tags: string[] }>} decisions
 * @param {string} journalDir - Journal directory path
 */
function exportDecisionsAsJournal(date, repo, decisions, journalDir, teamId, author) {
  if (!decisions || decisions.length === 0) return;

  const authorPart = author ? `-${author}` : '';
  const teamPart = teamId ? `-${teamId}` : '';
  const filePath = path.join(journalDir, `${date}${authorPart}${teamPart}.md`);

  // Dedup each decision individually against existing file content
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : null;

  const newLines = [];
  for (const d of decisions) {
    // Skip if this decision's title already appears in the file
    if (existing && existing.includes(d.title)) continue;

    const qualityTags = [];
    if (d.has_reasoning) qualityTags.push('rich:reasoning');
    if (d.has_alternatives) qualityTags.push('rich:alternatives');
    const qualityLabel = qualityTags.length > 0 ? qualityTags.join(', ') : 'thin';

    newLines.push(`## ${repo} — ${d.title} [decision]`);
    newLines.push(`**Why:** Extracted from conversation transcript`);
    newLines.push(`**What:** ${d.decision}`);
    if (d.alternatives) {
      newLines.push(`**Outcome:** Alternatives considered: ${d.alternatives}`);
    } else {
      newLines.push(`**Outcome:** Decision recorded`);
    }
    newLines.push(`**On track?:** N/A (extracted decision point)`);
    newLines.push(`**Quality:** ${qualityLabel}`);
    newLines.push(`**Lessons:** ${(d.tags || []).join(', ')}`);
    newLines.push('');
  }

  if (newLines.length === 0) return;

  const content = '\n' + newLines.join('\n');

  if (existing !== null) {
    fs.appendFileSync(filePath, content);
  } else {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(filePath, `# ${date}\n${content}`);
  }
}

/**
 * Index conversations with optional export to journal directory.
 * When exportDir is set, extracted decisions are also written as journal entries
 * so they get picked up by git sync and the container's journal indexer.
 * Passes an onDecisions callback into indexConversations to capture decisions
 * at extraction time (avoids double LLM calls).
 * @param {Object} options - Same as indexConversations plus:
 * @param {string} [options.exportDir] - Journal directory to export decisions to
 * @returns {Promise<Object>} - Same stats as indexConversations plus exported count
 */
async function indexConversationsWithExport(options = {}) {
  const exportDir = options.exportDir;
  const repoToTeam = options.repoToTeam || (() => null);
  const author = options.author || null;
  let exported = 0;
  let richCount = 0;
  let thinCount = 0;
  const pendingExports = [];

  const stats = await indexConversations({
    ...options,
    onDecisions: exportDir ? (date, repo, decisions) => {
      pendingExports.push({ date, repo, decisions });
    } : undefined,
  });

  // Write pending exports — route to per-team journal files
  for (const { date, repo, decisions } of pendingExports) {
    const teamId = repoToTeam(repo);
    if (!teamId) continue;  // Unbound repo — skip export (opt-in via .claude/wayfind.json)
    exportDecisionsAsJournal(date, repo, decisions, exportDir, teamId, author);
    exported += decisions.length;
    for (const d of decisions) {
      if (d.has_reasoning || d.has_alternatives) {
        richCount++;
      } else {
        thinCount++;
      }
    }
  }

  return { ...stats, exported, pendingExports, richCount, thinCount };
}

// ── Signal file indexing ─────────────────────────────────────────────────────

/**
 * Index signal markdown files into the content store.
 * Each file at signalsDir/channel/YYYY-MM-DD.md is one entry.
 * Incremental — skips unchanged files via contentHash.
 * @param {Object} options
 * @param {string} [options.signalsDir] - Signals directory
 * @param {string} [options.storePath] - Content store directory
 * @param {boolean} [options.embeddings] - Generate embeddings (default: true if OPENAI_API_KEY or TEAM_CONTEXT_SIMULATE)
 * @returns {Promise<Object>} - Stats: { fileCount, newEntries, updatedEntries, skippedEntries }
 */
async function indexSignals(options = {}) {
  const signalsDir = options.signalsDir || DEFAULT_SIGNALS_DIR;
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const doEmbeddings = options.embeddings !== undefined
    ? options.embeddings
    : !!(process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT || llm.isSimulation());

  if (!signalsDir || !storePath) {
    throw new Error('Signals directory and store path are required.');
  }

  if (!fs.existsSync(signalsDir)) {
    throw new Error(`Signals directory not found: ${signalsDir}`);
  }

  // Load existing index (contains journal + conversation entries too)
  const backend = getBackend(storePath);
  const existingIndex = backend.loadIndex() || { version: INDEX_VERSION, entries: {}, lastUpdated: Date.now(), entryCount: 0 };
  const existingEmbeddings = doEmbeddings ? backend.loadEmbeddings() : {};

  const stats = { fileCount: 0, newEntries: 0, updatedEntries: 0, skippedEntries: 0 };

  // Scan channel directories
  let channels;
  try {
    channels = fs.readdirSync(signalsDir).filter(d => {
      return fs.statSync(path.join(signalsDir, d)).isDirectory();
    });
  } catch {
    return stats;
  }

  for (const channel of channels) {
    const channelDir = path.join(signalsDir, channel);
    let files;
    try {
      files = fs.readdirSync(channelDir).filter(f => f.endsWith('.md')).sort();
    } catch {
      continue;
    }

    for (const file of files) {
      stats.fileCount++;
      const filePath = path.join(channelDir, file);
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      // Extract date from filename (YYYY-MM-DD.md) or fall back to filename
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      const date = dateMatch ? dateMatch[1] : file.replace(/\.md$/, '');

      // Extract title from first # heading, or fall back to filename
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, '');

      // Extract tags: channel name + any ## section headings
      const tags = [channel];
      const sectionRe = /^##\s+(.+)$/gm;
      let sectionMatch;
      while ((sectionMatch = sectionRe.exec(content)) !== null) {
        const tag = sectionMatch[1].trim().toLowerCase();
        if (!tags.includes(tag)) {
          tags.push(tag);
        }
      }

      const repo = 'signals/' + channel;
      const id = generateEntryId(date, repo, file.replace(/\.md$/, ''));
      const hash = contentHash(content);

      const existing = existingIndex.entries[id];

      if (existing && existing.contentHash === hash) {
        // Unchanged — but generate embedding if missing
        if (doEmbeddings && !existing.hasEmbedding && content) {
          try {
            const vec = await llm.generateEmbedding(content);
            existingEmbeddings[id] = vec;
            existing.hasEmbedding = true;
            stats.updatedEntries++;
          } catch {
            stats.skippedEntries++;
          }
        } else {
          stats.skippedEntries++;
        }
      } else if (existing) {
        // Changed — update entry and re-embed
        existingIndex.entries[id] = {
          date,
          repo,
          title,
          source: 'signal',
          user: '',
          drifted: false,
          contentHash: hash,
          contentLength: content.length,
          tags,
          hasEmbedding: false,
        };

        if (doEmbeddings) {
          try {
            const vec = await llm.generateEmbedding(content);
            existingEmbeddings[id] = vec;
            existingIndex.entries[id].hasEmbedding = true;
          } catch {
            delete existingEmbeddings[id];
          }
        }
        stats.updatedEntries++;
      } else {
        // New entry
        existingIndex.entries[id] = {
          date,
          repo,
          title,
          source: 'signal',
          user: '',
          drifted: false,
          contentHash: hash,
          contentLength: content.length,
          tags,
          hasEmbedding: false,
        };

        if (doEmbeddings) {
          try {
            const vec = await llm.generateEmbedding(content);
            existingEmbeddings[id] = vec;
            existingIndex.entries[id].hasEmbedding = true;
          } catch {
            // Continue without embedding
          }
        }
        stats.newEntries++;
      }
    }
  }

  // Save
  existingIndex.entryCount = Object.keys(existingIndex.entries).length;
  backend.saveIndex(existingIndex);
  if (doEmbeddings) {
    backend.saveEmbeddings(existingEmbeddings);
  }

  return stats;
}

// ── Digest feedback ─────────────────────────────────────────────────────────

function loadFeedback(storePath) {
  return getBackend(storePath || DEFAULT_STORE_PATH).loadFeedback();
}

function saveFeedback(storePath, feedback) {
  getBackend(storePath || DEFAULT_STORE_PATH).saveFeedback(feedback);
}

/**
 * Record a digest delivery — stores channel + ts for reaction tracking.
 */
function recordDigestDelivery(options) {
  const { date, persona, channel, ts, storePath } = options;
  const feedback = loadFeedback(storePath);
  const key = `${date}/${persona}`;
  feedback.digests[key] = feedback.digests[key] || {};
  feedback.digests[key].date = date;
  feedback.digests[key].persona = persona;
  feedback.digests[key].channel = channel;
  feedback.digests[key].ts = ts;
  feedback.digests[key].deliveredAt = new Date().toISOString();
  feedback.digests[key].reactions = feedback.digests[key].reactions || {};
  saveFeedback(storePath, feedback);
}

/**
 * Record a reaction on a digest message.
 * @param {string} messageTs - Slack message timestamp
 * @param {string} reaction - Emoji name (without colons)
 * @param {number} delta - +1 for added, -1 for removed
 */
function recordDigestReaction(options) {
  const { messageTs, reaction, delta, storePath } = options;
  const feedback = loadFeedback(storePath);

  // Find the digest entry by message ts
  const entry = Object.values(feedback.digests).find(d => d.ts === messageTs);
  if (!entry) return false; // Not a tracked digest message

  entry.reactions = entry.reactions || {};
  entry.reactions[reaction] = (entry.reactions[reaction] || 0) + delta;
  if (entry.reactions[reaction] <= 0) delete entry.reactions[reaction];

  saveFeedback(storePath, feedback);
  return true;
}

/**
 * Record a text feedback reply on a digest thread.
 * Returns true if the message was on a tracked digest, false otherwise.
 */
function recordDigestFeedbackText(options) {
  const { messageTs, user, text, storePath } = options;
  if (!text) return false;
  const feedback = loadFeedback(storePath);

  // Find the digest entry by thread parent ts
  const entry = Object.values(feedback.digests).find(d => d.ts === messageTs);
  if (!entry) return false;

  entry.comments = entry.comments || [];
  entry.comments.push({
    user,
    text,
    at: new Date().toISOString(),
  });

  saveFeedback(storePath, feedback);
  return true;
}

/**
 * Get digest feedback summary.
 * @returns {Array<{ date, persona, deliveredAt, reactions, totalReactions, comments }>}
 */
function getDigestFeedback(options = {}) {
  const { storePath, since, limit } = options;
  const feedback = loadFeedback(storePath);

  let results = Object.values(feedback.digests)
    .filter(d => !since || d.date >= since)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (limit) results = results.slice(0, limit);

  return results.map(d => ({
    date: d.date,
    persona: d.persona,
    deliveredAt: d.deliveredAt,
    reactions: d.reactions || {},
    totalReactions: Object.values(d.reactions || {}).reduce((s, n) => s + n, 0),
    comments: d.comments || [],
  }));
}

// ── Quality profile ─────────────────────────────────────────────────────────

/**
 * Compute a per-member quality profile from the content store index.
 * Analyzes conversation entries to find patterns in what's captured vs missing.
 * @param {Object} [options]
 * @param {string} [options.storePath] - Content store directory
 * @param {number} [options.days] - Look back N days (default: 30)
 * @returns {{ totalDecisions: number, rich: number, thin: number, richRate: number,
 *             reasoning: { present: number, missing: number, rate: number },
 *             alternatives: { present: number, missing: number, rate: number },
 *             weeklyTrend: Array<{ week: string, richRate: number, count: number }>,
 *             focus: string[] }}
 */
function computeQualityProfile(options = {}) {
  const storePath = options.storePath || DEFAULT_STORE_PATH;
  const days = options.days || 30;
  const index = getBackend(storePath).loadIndex();

  if (!index || index.entryCount === 0) {
    return {
      totalDecisions: 0, rich: 0, thin: 0, richRate: 0,
      reasoning: { present: 0, missing: 0, rate: 0 },
      alternatives: { present: 0, missing: 0, rate: 0 },
      weeklyTrend: [],
      focus: [],
    };
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const entries = Object.values(index.entries)
    .filter(e => e.source === 'conversation' && e.date >= cutoffStr);

  const totalDecisions = entries.length;
  const withReasoning = entries.filter(e => e.hasReasoning).length;
  const withAlternatives = entries.filter(e => e.hasAlternatives).length;
  const rich = entries.filter(e => e.hasReasoning || e.hasAlternatives).length;
  const thin = totalDecisions - rich;
  const richRate = totalDecisions > 0 ? Math.round((rich / totalDecisions) * 100) : 0;

  // Weekly trend
  const weekBuckets = {};
  for (const entry of entries) {
    const d = new Date(entry.date);
    // ISO week start (Monday)
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(d);
    weekStart.setDate(diff);
    const weekKey = weekStart.toISOString().slice(0, 10);
    if (!weekBuckets[weekKey]) weekBuckets[weekKey] = { rich: 0, total: 0 };
    weekBuckets[weekKey].total++;
    if (entry.hasReasoning || entry.hasAlternatives) weekBuckets[weekKey].rich++;
  }
  const weeklyTrend = Object.entries(weekBuckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, { rich: r, total }]) => ({
      week,
      richRate: total > 0 ? Math.round((r / total) * 100) : 0,
      count: total,
    }));

  // Determine focus areas — what's missing most
  const focus = [];
  const reasoningRate = totalDecisions > 0 ? Math.round((withReasoning / totalDecisions) * 100) : 0;
  const alternativesRate = totalDecisions > 0 ? Math.round((withAlternatives / totalDecisions) * 100) : 0;

  if (alternativesRate < 40) {
    focus.push('alternatives considered — you tend to record what was chosen but not what was rejected');
  }
  if (reasoningRate < 50) {
    focus.push('reasoning and constraints — capture why, not just what');
  }
  if (alternativesRate >= 40 && reasoningRate >= 50 && richRate < 70) {
    focus.push('depth on both dimensions — you capture some context but could go deeper');
  }
  if (richRate >= 70) {
    focus.push('keep it up — your decision context is strong');
  }

  return {
    totalDecisions,
    rich,
    thin,
    richRate,
    reasoning: {
      present: withReasoning,
      missing: totalDecisions - withReasoning,
      rate: reasoningRate,
    },
    alternatives: {
      present: withAlternatives,
      missing: totalDecisions - withAlternatives,
      rate: alternativesRate,
    },
    weeklyTrend,
    focus,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Parsing
  parseJournalFile,
  isDrifted,
  generateEntryId,
  buildContent,
  extractTags,
  contentHash,

  // Conversation parsing
  parseTranscript,
  buildTranscriptText,
  extractDecisions,
  projectDirToRepo,

  // Storage backend
  getBackend,
  getBackendType,
  // Backward-compatible storage wrappers (delegate to backend)
  loadIndex: (storePath) => getBackend(storePath || DEFAULT_STORE_PATH).loadIndex(),
  saveIndex: (storePath, index) => getBackend(storePath || DEFAULT_STORE_PATH).saveIndex(index),
  loadEmbeddings: (storePath) => getBackend(storePath || DEFAULT_STORE_PATH).loadEmbeddings(),
  saveEmbeddings: (storePath, embeddings) => getBackend(storePath || DEFAULT_STORE_PATH).saveEmbeddings(embeddings),
  loadConversationIndex: (storePath) => getBackend(storePath || DEFAULT_STORE_PATH).loadConversationIndex(),
  saveConversationIndex: (storePath, convIndex) => getBackend(storePath || DEFAULT_STORE_PATH).saveConversationIndex(convIndex),

  // Filtering
  applyFilters,

  // Core operations
  indexJournals,
  indexSignals,
  indexConversations,
  indexConversationsWithExport,
  exportDecisionsAsJournal,
  detectContextShift,
  applyContextShiftToState,
  generateOnboardingPack,
  searchJournals,
  searchText,
  queryMetadata,
  extractInsights,
  computeQualityProfile,
  getEntryContent,

  // Constants (for testing)
  INDEX_VERSION,
  FIELD_MAP,
  FIELD_LABELS,
  DEFAULT_STORE_PATH,
  DEFAULT_JOURNAL_DIR,
  DEFAULT_PROJECTS_DIR,
  DEFAULT_SIGNALS_DIR,

  // Digest feedback
  loadFeedback,
  saveFeedback,
  recordDigestDelivery,
  recordDigestReaction,
  recordDigestFeedbackText,
  getDigestFeedback,
};
