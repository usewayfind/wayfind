'use strict';

const path = require('path');
const fs = require('fs');
const JsonBackend = require('./json-backend');

// ── Constants ────────────────────────────────────────────────────────────────

const JSON_FILES = [
  'index.json',
  'embeddings.json',
  'conversation-index.json',
  'digest-feedback.json',
];

// ── Cache ────────────────────────────────────────────────────────────────────

const cache = {};

// ── Migration ────────────────────────────────────────────────────────────────

/**
 * Migrate existing JSON data into the SQLite backend.
 * Idempotent — skips if already migrated or no JSON files exist.
 * Does NOT delete JSON files after migration.
 */
function migrateFromJson(sqliteBackend, storePath) {
  // Already migrated?
  const row = sqliteBackend.db
    .prepare('SELECT value FROM metadata WHERE key = ?')
    .get('migrated_from_json');
  if (row) return;

  // Any JSON files to migrate?
  const found = JSON_FILES.filter(f =>
    fs.existsSync(path.join(storePath, f))
  );
  if (found.length === 0) return;

  const json = new JsonBackend(storePath);
  json.open();

  let totalEntries = 0;

  // index.json → decisions table
  const index = json.loadIndex();
  if (index && index.entries) {
    const entries = index.entries;
    const count = Object.keys(entries).length;
    if (count > 0) {
      sqliteBackend.bulkUpsertEntries(entries);
      totalEntries += count;
    }
  }

  // embeddings.json → embeddings table
  const embeddings = json.loadEmbeddings();
  if (embeddings && Object.keys(embeddings).length > 0) {
    sqliteBackend.saveEmbeddings(embeddings);
    totalEntries += Object.keys(embeddings).length;
  }

  // conversation-index.json → conversation_index table
  const convIndex = json.loadConversationIndex();
  if (convIndex && Object.keys(convIndex).length > 0) {
    sqliteBackend.saveConversationIndex(convIndex);
    totalEntries += Object.keys(convIndex).length;
  }

  // digest-feedback.json → digest_feedback table
  const feedback = json.loadFeedback();
  if (feedback && feedback.digests && Object.keys(feedback.digests).length > 0) {
    sqliteBackend.saveFeedback(feedback);
    totalEntries += Object.keys(feedback.digests).length;
  }

  json.close();

  // Mark migration complete
  sqliteBackend.db
    .prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
    .run('migrated_from_json', new Date().toISOString());

  if (totalEntries > 0) {
    console.error(`[wayfind] Migrated ${totalEntries} entries from JSON to SQLite`);
  }
}

// ── Backend selection ────────────────────────────────────────────────────────

/**
 * Get (or create and cache) the storage backend for the given store path.
 * Honors TEAM_CONTEXT_STORAGE_BACKEND env var ('json' or 'sqlite').
 * When unset, auto-detects: tries SQLite first, falls back to JSON.
 *
 * @param {string} storePath - Directory for storage files
 * @returns {JsonBackend|SqliteBackend}
 */
function getBackend(storePath) {
  if (cache[storePath]) return cache[storePath];

  const forced = process.env.TEAM_CONTEXT_STORAGE_BACKEND;

  if (forced === 'json') {
    const backend = new JsonBackend(storePath);
    backend.open();
    cache[storePath] = backend;
    return backend;
  }

  if (forced === 'sqlite') {
    const SqliteBackend = require('./sqlite-backend');
    const backend = new SqliteBackend(storePath);
    backend.open();
    migrateFromJson(backend, storePath);
    cache[storePath] = backend;
    return backend;
  }

  // Auto-detect: try SQLite, fall back to JSON
  try {
    require.resolve('better-sqlite3');
    const SqliteBackend = require('./sqlite-backend');
    const backend = new SqliteBackend(storePath);
    backend.open();
    migrateFromJson(backend, storePath);
    cache[storePath] = backend;
    return backend;
  } catch (err) {
    console.error('Warning: SQLite backend failed to initialize, falling back to JSON.', err.message);
    cache[storePath + ':fallback'] = true;
    const backend = new JsonBackend(storePath);
    backend.open();
    cache[storePath] = backend;
    return backend;
  }
}

/**
 * Close all cached backends and clear the cache. Useful for tests.
 */
function clearCache() {
  for (const storePath of Object.keys(cache)) {
    try {
      cache[storePath].close();
    } catch {
      // Ignore close errors during cleanup
    }
    delete cache[storePath];
  }
}

/**
 * Returns the backend type string ('sqlite' or 'json') for a cached backend.
 *
 * @param {string} storePath
 * @returns {'sqlite'|'json'|null} null if no backend is cached for this path
 */
function getBackendType(storePath) {
  const backend = cache[storePath];
  if (!backend) return null;
  if (backend instanceof JsonBackend) return 'json';
  // SqliteBackend — check constructor name to avoid requiring the module
  // just for a type check (it may not be available)
  if (backend.constructor && backend.constructor.name === 'SqliteBackend') return 'sqlite';
  return null;
}

/**
 * Returns detailed backend info including whether it was a silent fallback.
 *
 * @param {string} storePath
 * @returns {{ type: 'sqlite'|'json'|'unknown', storePath: string, fallback: boolean }|null}
 */
function getBackendInfo(storePath) {
  const backend = cache[storePath];
  if (!backend) return null;
  const type = backend instanceof JsonBackend ? 'json' :
    (backend.constructor && backend.constructor.name === 'SqliteBackend') ? 'sqlite' : 'unknown';
  return { type, storePath, fallback: !!cache[storePath + ':fallback'] };
}

module.exports = {
  getBackend,
  clearCache,
  getBackendType,
  getBackendInfo,
};
