'use strict';

const fs = require('fs');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────────

const INDEX_FILE = 'index.json';
const EMBEDDINGS_FILE = 'embeddings.json';
const CONVERSATION_INDEX_FILE = 'conversation-index.json';
const FEEDBACK_FILE = 'digest-feedback.json';
const INDEX_VERSION = '2.0.0';
const FILE_PERMS = 0o600;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Atomic write: write to .tmp then rename into place.
 * @param {string} filePath
 * @param {string} content
 */
function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, { mode: FILE_PERMS });
  fs.renameSync(tmp, filePath);
}

/**
 * Read and parse a JSON file, returning fallback on any error.
 * @param {string} filePath
 * @param {*} fallback
 * @returns {*}
 */
function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── JsonBackend ──────────────────────────────────────────────────────────────

class JsonBackend {
  /**
   * @param {string} storePath - Directory for JSON storage files
   */
  constructor(storePath) {
    this._storePath = storePath;
    this._open = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Ensure the store directory exists and mark backend as open.
   */
  open() {
    if (!fs.existsSync(this._storePath)) {
      fs.mkdirSync(this._storePath, { recursive: true });
    }
    this._open = true;
  }

  /**
   * No-op for JSON backend — nothing to tear down.
   */
  close() {
    this._open = false;
  }

  /**
   * @returns {boolean}
   */
  isOpen() {
    return this._open;
  }

  // ── Index ────────────────────────────────────────────────────────────────

  /**
   * Load the full index from disk.
   * @returns {{ version: string, lastUpdated: number, entryCount: number, entries: Object }|null}
   */
  loadIndex() {
    const data = readJson(path.join(this._storePath, INDEX_FILE), null);
    if (data && data.version === INDEX_VERSION) return data;
    return null;
  }

  /**
   * Save the full index to disk (atomic write).
   * @param {Object} index
   */
  saveIndex(index) {
    this._ensureDir();
    index.lastUpdated = Date.now();
    index.entryCount = Object.keys(index.entries).length;
    const content = JSON.stringify(index, null, 2) + '\n';
    atomicWrite(path.join(this._storePath, INDEX_FILE), content);
  }

  /**
   * Get a single entry by id.
   * @param {string} id
   * @returns {Object|null}
   */
  getEntry(id) {
    const index = this.loadIndex();
    if (!index) return null;
    return index.entries[id] || null;
  }

  /**
   * Insert or update a single entry, then persist.
   * @param {string} id
   * @param {Object} entry
   */
  upsertEntry(id, entry) {
    let index = this.loadIndex();
    if (!index) {
      index = { version: INDEX_VERSION, lastUpdated: 0, entryCount: 0, entries: {} };
    }
    index.entries[id] = entry;
    this.saveIndex(index);
  }

  /**
   * Merge a map of { id: entry } into the index and persist once.
   * @param {Object} entriesMap - { id: entry }
   */
  bulkUpsertEntries(entriesMap) {
    let index = this.loadIndex();
    if (!index) {
      index = { version: INDEX_VERSION, lastUpdated: 0, entryCount: 0, entries: {} };
    }
    Object.assign(index.entries, entriesMap);
    this.saveIndex(index);
  }

  /**
   * Remove entries by id array and persist.
   * @param {string[]} ids
   */
  removeEntries(ids) {
    const index = this.loadIndex();
    if (!index) return;
    for (const id of ids) {
      delete index.entries[id];
    }
    this.saveIndex(index);
  }

  /**
   * Iterate entries and apply filters. Returns matching [{ id, entry }].
   *
   * Filters: { repo, since, until, drifted, user, source }
   * - repo/user: case-insensitive exact match
   * - since/until: inclusive date string comparison (YYYY-MM-DD)
   * - drifted: boolean match
   * - source: exact match
   *
   * Note: repo exclusion (TEAM_CONTEXT_EXCLUDE_REPOS) is handled at a higher
   * level in content-store.js, not here.
   *
   * @param {Object} filters
   * @returns {Array<{ id: string, entry: Object }>}
   */
  queryEntries(filters = {}) {
    const index = this.loadIndex();
    if (!index) return [];

    const results = [];
    for (const [id, entry] of Object.entries(index.entries)) {
      if (filters.repo && entry.repo &&
          entry.repo.toLowerCase() !== filters.repo.toLowerCase()) continue;
      if (filters.since && entry.date < filters.since) continue;
      if (filters.until && entry.date > filters.until) continue;
      if (filters.drifted !== undefined && entry.drifted !== filters.drifted) continue;
      if (filters.user && entry.user &&
          entry.user.toLowerCase() !== filters.user.toLowerCase()) continue;
      if (filters.source && entry.source !== filters.source) continue;
      results.push({ id, entry });
    }

    // Sort by date descending
    results.sort((a, b) => (b.entry.date || '').localeCompare(a.entry.date || ''));
    return results;
  }

  // ── Embeddings ───────────────────────────────────────────────────────────

  /**
   * Load embeddings map from disk.
   * @returns {Object} - { id: vector[] }
   */
  loadEmbeddings() {
    return readJson(path.join(this._storePath, EMBEDDINGS_FILE), {});
  }

  /**
   * Save full embeddings map to disk (atomic write).
   * @param {Object} map - { id: vector[] }
   */
  saveEmbeddings(map) {
    this._ensureDir();
    const content = JSON.stringify(map) + '\n';
    atomicWrite(path.join(this._storePath, EMBEDDINGS_FILE), content);
  }

  /**
   * Get a single embedding vector by id.
   * @param {string} id
   * @returns {number[]|null}
   */
  getEmbedding(id) {
    const map = this.loadEmbeddings();
    return map[id] || null;
  }

  /**
   * Insert or update a single embedding, then persist.
   * @param {string} id
   * @param {number[]} vector
   */
  upsertEmbedding(id, vector) {
    const map = this.loadEmbeddings();
    map[id] = vector;
    this.saveEmbeddings(map);
  }

  /**
   * Remove embeddings by id array and persist.
   * @param {string[]} ids
   */
  removeEmbeddings(ids) {
    const map = this.loadEmbeddings();
    for (const id of ids) {
      delete map[id];
    }
    this.saveEmbeddings(map);
  }

  // ── Conversation index ───────────────────────────────────────────────────

  /**
   * Load the conversation index.
   * @returns {Object} - { filePath: { fingerprint, entryIds, extractedAt } }
   */
  loadConversationIndex() {
    return readJson(path.join(this._storePath, CONVERSATION_INDEX_FILE), {});
  }

  /**
   * Save the full conversation index (atomic write).
   * @param {Object} convIndex
   */
  saveConversationIndex(convIndex) {
    this._ensureDir();
    const content = JSON.stringify(convIndex, null, 2) + '\n';
    atomicWrite(path.join(this._storePath, CONVERSATION_INDEX_FILE), content);
  }

  /**
   * Get a single conversation entry by file path.
   * @param {string} filePath
   * @returns {Object|null}
   */
  getConversationEntry(filePath) {
    const convIndex = this.loadConversationIndex();
    return convIndex[filePath] || null;
  }

  /**
   * Insert or update a conversation entry, then persist.
   * @param {string} filePath
   * @param {Object} entry
   */
  upsertConversationEntry(filePath, entry) {
    const convIndex = this.loadConversationIndex();
    convIndex[filePath] = entry;
    this.saveConversationIndex(convIndex);
  }

  // ── Digest feedback ──────────────────────────────────────────────────────

  /**
   * Load digest feedback data.
   * @returns {{ digests: Object }}
   */
  loadFeedback() {
    return readJson(path.join(this._storePath, FEEDBACK_FILE), { digests: {} });
  }

  /**
   * Save digest feedback data (atomic write).
   * @param {Object} feedback
   */
  saveFeedback(feedback) {
    this._ensureDir();
    const content = JSON.stringify(feedback, null, 2) + '\n';
    atomicWrite(path.join(this._storePath, FEEDBACK_FILE), content);
  }

  /**
   * Find a digest entry whose ts matches the given messageTs.
   * @param {string} messageTs
   * @returns {{ key: string, digest: Object }|null}
   */
  findDigestByTs(messageTs) {
    const feedback = this.loadFeedback();
    for (const [key, digest] of Object.entries(feedback.digests || {})) {
      if (digest.ts === messageTs) return { key, digest };
    }
    return null;
  }

  /**
   * Insert or update a single digest entry, then persist.
   * @param {string} key
   * @param {Object} digest
   */
  upsertDigest(key, digest) {
    const feedback = this.loadFeedback();
    feedback.digests[key] = digest;
    this.saveFeedback(feedback);
  }

  // ── Meta ─────────────────────────────────────────────────────────────────

  /**
   * Returns the schema identifier for this backend.
   * @returns {string}
   */
  getSchemaVersion() {
    return 'json';
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _ensureDir() {
    if (!fs.existsSync(this._storePath)) {
      fs.mkdirSync(this._storePath, { recursive: true });
    }
  }
}

module.exports = JsonBackend;
