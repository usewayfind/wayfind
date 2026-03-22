'use strict';

/**
 * SQLite storage backend for Wayfind's content store.
 * Drop-in replacement for JSON file persistence using better-sqlite3.
 * DB file: {storePath}/content-store.db
 */

const fs = require('fs');
const path = require('path');

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = null;
}

const INDEX_VERSION = '2.0.0';
const SCHEMA_VERSION = '1';
const DB_FILENAME = 'content-store.db';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  repo TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT DEFAULT 'journal',
  user TEXT DEFAULT '',
  drifted INTEGER DEFAULT 0,
  content_hash TEXT NOT NULL,
  content_length INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  has_embedding INTEGER DEFAULT 0,
  has_reasoning INTEGER DEFAULT 0,
  has_alternatives INTEGER DEFAULT 0,
  quality_score INTEGER DEFAULT 0,
  distill_tier TEXT DEFAULT 'raw',
  distilled_from TEXT DEFAULT NULL,
  distilled_at INTEGER DEFAULT NULL,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_decisions_date ON decisions(date);
CREATE INDEX IF NOT EXISTS idx_decisions_repo ON decisions(repo);
CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source);
CREATE INDEX IF NOT EXISTS idx_decisions_user ON decisions(user);
CREATE INDEX IF NOT EXISTS idx_decisions_quality ON decisions(quality_score);
CREATE INDEX IF NOT EXISTS idx_decisions_tier ON decisions(distill_tier);

CREATE TABLE IF NOT EXISTS distillation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at INTEGER NOT NULL,
  tier TEXT NOT NULL,
  entries_input INTEGER DEFAULT 0,
  entries_output INTEGER DEFAULT 0,
  entries_merged INTEGER DEFAULT 0,
  entries_deduped INTEGER DEFAULT 0,
  llm_calls INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  vector BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_index (
  file_path TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  entry_ids TEXT DEFAULT '[]',
  extracted_at INTEGER
);

CREATE TABLE IF NOT EXISTS digest_feedback (
  key TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  persona TEXT NOT NULL,
  channel TEXT,
  ts TEXT,
  delivered_at TEXT,
  reactions TEXT DEFAULT '{}',
  comments TEXT DEFAULT '[]'
);
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function entryToRow(id, entry) {
  return {
    id,
    date: entry.date || '',
    repo: entry.repo || '',
    title: entry.title || '',
    source: entry.source || 'journal',
    user: entry.user || '',
    drifted: entry.drifted ? 1 : 0,
    content_hash: entry.contentHash || '',
    content_length: entry.contentLength || 0,
    tags: JSON.stringify(entry.tags || []),
    has_embedding: entry.hasEmbedding ? 1 : 0,
    has_reasoning: entry.hasReasoning ? 1 : 0,
    has_alternatives: entry.hasAlternatives ? 1 : 0,
    quality_score: entry.qualityScore || 0,
    distill_tier: entry.distillTier || 'raw',
    distilled_from: entry.distilledFrom ? JSON.stringify(entry.distilledFrom) : null,
    distilled_at: entry.distilledAt || null,
    created_at: entry.createdAt || Date.now(),
    updated_at: Date.now(),
  };
}

function rowToEntry(row) {
  return {
    date: row.date,
    repo: row.repo,
    title: row.title,
    source: row.source,
    user: row.user,
    drifted: !!row.drifted,
    contentHash: row.content_hash,
    contentLength: row.content_length,
    tags: JSON.parse(row.tags || '[]'),
    hasEmbedding: !!row.has_embedding,
    hasReasoning: !!row.has_reasoning,
    hasAlternatives: !!row.has_alternatives,
    qualityScore: row.quality_score || 0,
    distillTier: row.distill_tier || 'raw',
    distilledFrom: row.distilled_from ? JSON.parse(row.distilled_from) : null,
    distilledAt: row.distilled_at || null,
  };
}

// ── SqliteBackend ────────────────────────────────────────────────────────────

class SqliteBackend {
  constructor(storePath) {
    this.storePath = storePath;
    this.dbPath = path.join(storePath, DB_FILENAME);
    this.db = null;
  }

  open() {
    if (!Database) {
      throw new Error(
        'better-sqlite3 is not installed. Run: npm install better-sqlite3'
      );
    }
    fs.mkdirSync(this.storePath, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);
    fs.chmodSync(this.dbPath, 0o600);

    const existing = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version');
    if (!existing) {
      this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    }

    // Migrate existing databases: add new columns if they don't exist
    const cols = this.db.prepare('PRAGMA table_info(decisions)').all().map(c => c.name);
    if (!cols.includes('quality_score')) {
      this.db.exec('ALTER TABLE decisions ADD COLUMN quality_score INTEGER DEFAULT 0');
    }
    if (!cols.includes('distill_tier')) {
      this.db.exec('ALTER TABLE decisions ADD COLUMN distill_tier TEXT DEFAULT \'raw\'');
    }
    if (!cols.includes('distilled_from')) {
      this.db.exec('ALTER TABLE decisions ADD COLUMN distilled_from TEXT DEFAULT NULL');
    }
    if (!cols.includes('distilled_at')) {
      this.db.exec('ALTER TABLE decisions ADD COLUMN distilled_at INTEGER DEFAULT NULL');
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  isOpen() {
    return this.db !== null;
  }

  // ── Index (decisions table) ──────────────────────────────────────────────

  loadIndex() {
    const rows = this.db.prepare('SELECT * FROM decisions').all();
    const entries = {};
    for (const row of rows) {
      entries[row.id] = rowToEntry(row);
    }
    return {
      version: INDEX_VERSION,
      lastUpdated: Date.now(),
      entryCount: rows.length,
      entries,
    };
  }

  saveIndex(index) {
    const entries = index.entries || {};
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM decisions').run();
      const stmt = this.db.prepare(`
        INSERT INTO decisions (id, date, repo, title, source, user, drifted,
          content_hash, content_length, tags, has_embedding, has_reasoning,
          has_alternatives, quality_score, distill_tier, distilled_from, distilled_at,
          created_at, updated_at)
        VALUES (@id, @date, @repo, @title, @source, @user, @drifted,
          @content_hash, @content_length, @tags, @has_embedding, @has_reasoning,
          @has_alternatives, @quality_score, @distill_tier, @distilled_from, @distilled_at,
          @created_at, @updated_at)
      `);
      for (const [id, entry] of Object.entries(entries)) {
        stmt.run(entryToRow(id, entry));
      }
    });
    txn();
  }

  getEntry(id) {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    return row ? rowToEntry(row) : null;
  }

  upsertEntry(id, entry) {
    this.db.prepare(`
      INSERT OR REPLACE INTO decisions (id, date, repo, title, source, user, drifted,
        content_hash, content_length, tags, has_embedding, has_reasoning,
        has_alternatives, created_at, updated_at)
      VALUES (@id, @date, @repo, @title, @source, @user, @drifted,
        @content_hash, @content_length, @tags, @has_embedding, @has_reasoning,
        @has_alternatives, @created_at, @updated_at)
    `).run(entryToRow(id, entry));
  }

  bulkUpsertEntries(entriesMap) {
    const txn = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO decisions (id, date, repo, title, source, user, drifted,
          content_hash, content_length, tags, has_embedding, has_reasoning,
          has_alternatives, created_at, updated_at)
        VALUES (@id, @date, @repo, @title, @source, @user, @drifted,
          @content_hash, @content_length, @tags, @has_embedding, @has_reasoning,
          @has_alternatives, @created_at, @updated_at)
      `);
      for (const [id, entry] of Object.entries(entriesMap)) {
        stmt.run(entryToRow(id, entry));
      }
    });
    txn();
  }

  removeEntries(ids) {
    if (!ids || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM decisions WHERE id IN (${placeholders})`).run(...ids);
  }

  queryEntries(filters = {}) {
    const conditions = [];
    const params = {};

    if (filters.repo) {
      conditions.push('repo = @repo');
      params.repo = filters.repo;
    }
    if (filters.since) {
      conditions.push('date >= @since');
      params.since = filters.since;
    }
    if (filters.until) {
      conditions.push('date <= @until');
      params.until = filters.until;
    }
    if (filters.drifted !== undefined) {
      conditions.push('drifted = @drifted');
      params.drifted = filters.drifted ? 1 : 0;
    }
    if (filters.user) {
      conditions.push('user = @user');
      params.user = filters.user;
    }
    if (filters.source) {
      conditions.push('source = @source');
      params.source = filters.source;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM decisions ${where}`).all(params);
    return rows.map(row => ({ id: row.id, entry: rowToEntry(row) }));
  }

  // ── Embeddings ───────────────────────────────────────────────────────────

  loadEmbeddings() {
    const rows = this.db.prepare('SELECT * FROM embeddings').all();
    const result = {};
    for (const row of rows) {
      result[row.id] = Array.from(new Float64Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 8));
    }
    return result;
  }

  saveEmbeddings(map) {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM embeddings').run();
      const stmt = this.db.prepare('INSERT INTO embeddings (id, vector) VALUES (?, ?)');
      for (const [id, vector] of Object.entries(map)) {
        stmt.run(id, Buffer.from(new Float64Array(vector).buffer));
      }
    });
    txn();
  }

  getEmbedding(id) {
    const row = this.db.prepare('SELECT vector FROM embeddings WHERE id = ?').get(id);
    if (!row) return null;
    return Array.from(new Float64Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 8));
  }

  upsertEmbedding(id, vector) {
    this.db.prepare('INSERT OR REPLACE INTO embeddings (id, vector) VALUES (?, ?)')
      .run(id, Buffer.from(new Float64Array(vector).buffer));
  }

  removeEmbeddings(ids) {
    if (!ids || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM embeddings WHERE id IN (${placeholders})`).run(...ids);
  }

  // ── Conversation index ───────────────────────────────────────────────────

  loadConversationIndex() {
    const rows = this.db.prepare('SELECT * FROM conversation_index').all();
    const result = {};
    for (const row of rows) {
      result[row.file_path] = {
        fingerprint: row.fingerprint,
        entryIds: JSON.parse(row.entry_ids || '[]'),
        extractedAt: row.extracted_at,
      };
    }
    return result;
  }

  saveConversationIndex(convIndex) {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM conversation_index').run();
      const stmt = this.db.prepare(`
        INSERT INTO conversation_index (file_path, fingerprint, entry_ids, extracted_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const [filePath, entry] of Object.entries(convIndex)) {
        stmt.run(filePath, entry.fingerprint, JSON.stringify(entry.entryIds || []), entry.extractedAt || null);
      }
    });
    txn();
  }

  getConversationEntry(filePath) {
    const row = this.db.prepare('SELECT * FROM conversation_index WHERE file_path = ?').get(filePath);
    if (!row) return null;
    return {
      fingerprint: row.fingerprint,
      entryIds: JSON.parse(row.entry_ids || '[]'),
      extractedAt: row.extracted_at,
    };
  }

  upsertConversationEntry(filePath, entry) {
    this.db.prepare(`
      INSERT OR REPLACE INTO conversation_index (file_path, fingerprint, entry_ids, extracted_at)
      VALUES (?, ?, ?, ?)
    `).run(filePath, entry.fingerprint, JSON.stringify(entry.entryIds || []), entry.extractedAt || null);
  }

  // ── Digest feedback ──────────────────────────────────────────────────────

  loadFeedback() {
    const rows = this.db.prepare('SELECT * FROM digest_feedback').all();
    const digests = {};
    for (const row of rows) {
      digests[row.key] = {
        date: row.date,
        persona: row.persona,
        channel: row.channel,
        ts: row.ts,
        deliveredAt: row.delivered_at,
        reactions: JSON.parse(row.reactions || '{}'),
        comments: JSON.parse(row.comments || '[]'),
      };
    }
    return { digests };
  }

  saveFeedback(feedback) {
    const digests = (feedback && feedback.digests) || {};
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM digest_feedback').run();
      const stmt = this.db.prepare(`
        INSERT INTO digest_feedback (key, date, persona, channel, ts, delivered_at, reactions, comments)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [key, d] of Object.entries(digests)) {
        stmt.run(
          key, d.date, d.persona, d.channel || null, d.ts || null,
          d.deliveredAt || null, JSON.stringify(d.reactions || {}), JSON.stringify(d.comments || [])
        );
      }
    });
    txn();
  }

  findDigestByTs(messageTs) {
    const row = this.db.prepare('SELECT * FROM digest_feedback WHERE ts = ?').get(messageTs);
    if (!row) return null;
    return {
      date: row.date,
      persona: row.persona,
      channel: row.channel,
      ts: row.ts,
      deliveredAt: row.delivered_at,
      reactions: JSON.parse(row.reactions || '{}'),
      comments: JSON.parse(row.comments || '[]'),
    };
  }

  upsertDigest(key, digest) {
    this.db.prepare(`
      INSERT OR REPLACE INTO digest_feedback (key, date, persona, channel, ts, delivered_at, reactions, comments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key, digest.date, digest.persona, digest.channel || null, digest.ts || null,
      digest.deliveredAt || null, JSON.stringify(digest.reactions || {}), JSON.stringify(digest.comments || [])
    );
  }

  // ── Meta ─────────────────────────────────────────────────────────────────

  getSchemaVersion() {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version');
    return row ? row.value : null;
  }
}

module.exports = SqliteBackend;
