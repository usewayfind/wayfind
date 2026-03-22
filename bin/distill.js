'use strict';

const contentStore = require('./content-store');
const llm = require('./connectors/llm');

// ── Tier definitions ────────────────────────────────────────────────────────

const TIERS = {
  daily: { minAgeDays: 3, maxAgeDays: 14 },
  weekly: { minAgeDays: 14, maxAgeDays: 60 },
  archive: { minAgeDays: 60, maxAgeDays: Infinity },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(dateStr) {
  const now = new Date();
  const then = new Date(dateStr + 'T00:00:00Z');
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function today() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Compute Jaccard similarity between two titles (word-level).
 * @param {string} a
 * @param {string} b
 * @returns {number} 0-1
 */
function titleSimilarity(a, b) {
  const wordsA = new Set((a || '').toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set((b || '').toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── Grouping ────────────────────────────────────────────────────────────────

/**
 * Group entries by (date, repo), then cluster by title similarity within each group.
 * @param {Array<{id: string, entry: Object}>} entries
 * @returns {Array<Array<{id: string, entry: Object}>>} Clusters of related entries
 */
function groupEntries(entries) {
  // Group by date+repo
  const groups = {};
  for (const item of entries) {
    const key = `${item.entry.date}|${item.entry.repo}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  // Within each group, cluster by title similarity
  const clusters = [];
  for (const items of Object.values(groups)) {
    if (items.length === 1) {
      clusters.push(items);
      continue;
    }

    const assigned = new Set();
    for (let i = 0; i < items.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [items[i]];
      assigned.add(i);
      for (let j = i + 1; j < items.length; j++) {
        if (assigned.has(j)) continue;
        if (titleSimilarity(items[i].entry.title, items[j].entry.title) > 0.8) {
          cluster.push(items[j]);
          assigned.add(j);
        }
      }
      clusters.push(cluster);
    }
  }

  return clusters;
}

// ── Deduplication ───────────────────────────────────────────────────────────

/**
 * Deduplicate a cluster of entries.
 * - Exact content_hash matches: keep highest quality_score
 * - Returns { canonical: [{id, entry}], absorbed: [ids] }
 */
function deduplicateGroup(cluster) {
  if (cluster.length <= 1) {
    return { canonical: cluster, absorbed: [] };
  }

  // Group by content hash
  const byHash = {};
  for (const item of cluster) {
    const hash = item.entry.contentHash;
    if (!byHash[hash]) byHash[hash] = [];
    byHash[hash].push(item);
  }

  const canonical = [];
  const absorbed = [];

  for (const items of Object.values(byHash)) {
    if (items.length === 1) {
      canonical.push(items[0]);
      continue;
    }
    // Keep the one with highest quality score
    items.sort((a, b) => (b.entry.qualityScore || 0) - (a.entry.qualityScore || 0));
    canonical.push(items[0]);
    for (let i = 1; i < items.length; i++) {
      absorbed.push(items[i].id);
    }
  }

  return { canonical, absorbed };
}

// ── Merging ─────────────────────────────────────────────────────────────────

const MERGE_PROMPTS = {
  daily: `You are merging duplicate decision entries from the same day and repo.
Remove exact duplicates. Keep all distinct decisions with full reasoning.
Return a single markdown entry that preserves all unique information.
Format: Start with the repo and title, then include all distinct decisions with their reasoning.`,

  weekly: `You are creating a weekly summary for a repo.
Combine related decisions into a concise per-repo weekly summary.
Preserve key reasoning and alternatives that were considered.
Remove redundancy and boilerplate.
Format: A clean markdown summary organized by topic.`,

  archive: `You are creating a monthly archive summary.
Compress multiple entries into a brief summary with key decisions and outcomes only.
Focus on what was decided and why, not the details of how.
Format: A compact markdown summary, max 500 words.`,
};

/**
 * Merge 2+ related entries into a single distilled entry via LLM.
 * @param {Array<{id: string, entry: Object}>} entries
 * @param {Object} llmConfig - { provider, model, api_key_env }
 * @param {string} tier - 'daily', 'weekly', or 'archive'
 * @returns {Promise<{content: string, title: string}>}
 */
async function mergeEntries(entries, llmConfig, tier) {
  const storePath = contentStore.DEFAULT_STORE_PATH;
  const journalDir = contentStore.DEFAULT_JOURNAL_DIR;
  const signalsDir = contentStore.DEFAULT_SIGNALS_DIR;

  const parts = entries.map(({ id, entry }) => {
    const content = contentStore.getEntryContent(id, { storePath, journalDir, signalsDir });
    return content || `${entry.date} — ${entry.repo} — ${entry.title}`;
  });

  const systemPrompt = MERGE_PROMPTS[tier] || MERGE_PROMPTS.daily;
  const userContent = parts.join('\n\n---\n\n');

  const config = {
    provider: llmConfig.provider || 'anthropic',
    model: llmConfig.model || 'claude-haiku-4-5-20251001',
    api_key_env: llmConfig.api_key_env || 'ANTHROPIC_API_KEY',
    max_tokens: 2000,
  };
  const result = await llm.call(config, systemPrompt, userContent);

  // Extract title from first line or generate one
  const firstEntry = entries[0].entry;
  const title = `[${tier}] ${firstEntry.repo} — ${firstEntry.date}`;

  return { content: result, title };
}

// ── Main Pipeline ───────────────────────────────────────────────────────────

/**
 * Run the distillation pipeline.
 * @param {Object} options
 * @param {string} [options.tier] - 'daily', 'weekly', 'archive', or 'all'
 * @param {boolean} [options.dryRun] - If true, don't write changes
 * @param {Object} [options.llmConfig] - LLM config for merge operations
 * @param {string} [options.storePath] - Content store path
 * @returns {Promise<Object>} Stats: { grouped, deduped, merged, llmCalls }
 */
async function distillEntries(options = {}) {
  const tierName = options.tier || 'daily';
  const dryRun = options.dryRun || false;
  const storePath = options.storePath || contentStore.DEFAULT_STORE_PATH;

  const tiersToRun = tierName === 'all'
    ? ['daily', 'weekly', 'archive']
    : [tierName];

  const totalStats = { grouped: 0, deduped: 0, merged: 0, llmCalls: 0 };

  for (const tier of tiersToRun) {
    const tierDef = TIERS[tier];
    if (!tierDef) {
      console.log(`Unknown tier: ${tier}`);
      continue;
    }

    // Calculate date range for this tier
    const now = new Date();
    const sinceDate = new Date(now);
    sinceDate.setDate(sinceDate.getDate() - tierDef.maxAgeDays);
    const untilDate = new Date(now);
    untilDate.setDate(untilDate.getDate() - tierDef.minAgeDays);

    const since = sinceDate.toISOString().split('T')[0];
    const until = untilDate.toISOString().split('T')[0];

    // Query entries eligible for this tier
    const entries = contentStore.queryMetadata({ since, until, storePath });

    // Filter: only raw entries that haven't been distilled yet
    const eligible = entries.filter(({ entry }) => {
      return (entry.distillTier === 'raw' || !entry.distillTier)
        && !entry.distilledAt
        && !entry.distilledFrom;  // not already a distilled entry
    });

    if (eligible.length === 0) {
      console.log(`  ${tier}: no eligible entries`);
      continue;
    }

    console.log(`  ${tier}: ${eligible.length} eligible entries (${since} to ${until})`);

    // Group and cluster
    const clusters = groupEntries(eligible);
    totalStats.grouped += clusters.length;

    // Deduplicate within each cluster
    let totalDeduped = 0;
    const mergeableClusters = [];

    for (const cluster of clusters) {
      const { canonical, absorbed } = deduplicateGroup(cluster);
      totalDeduped += absorbed.length;

      if (!dryRun && absorbed.length > 0) {
        // Mark absorbed entries
        const backend = contentStore.getBackend(storePath);
        const index = backend.loadIndex();
        for (const absorbedId of absorbed) {
          if (index.entries[absorbedId]) {
            index.entries[absorbedId].distilledAt = Date.now();
            index.entries[absorbedId].distillTier = tier;
          }
        }
        backend.saveIndex(index);
      }

      // Only merge if there are 2+ canonical entries in the cluster
      if (canonical.length >= 2) {
        mergeableClusters.push(canonical);
      }
    }

    totalStats.deduped += totalDeduped;

    if (dryRun) {
      console.log(`    Would dedup: ${totalDeduped} entries`);
      console.log(`    Would merge: ${mergeableClusters.length} clusters (${mergeableClusters.reduce((s, c) => s + c.length, 0)} entries)`);
      continue;
    }

    // Merge clusters via LLM
    if (mergeableClusters.length > 0 && options.llmConfig) {
      for (const cluster of mergeableClusters) {
        try {
          const { content, title } = await mergeEntries(cluster, options.llmConfig, tier);
          totalStats.llmCalls++;

          // Create distilled entry in the content store
          const firstEntry = cluster[0].entry;
          const absorbedIds = cluster.map(c => c.id);
          const id = contentStore.generateEntryId(firstEntry.date, firstEntry.repo, title);
          const hash = contentStore.contentHash(content);

          const backend = contentStore.getBackend(storePath);
          const index = backend.loadIndex();

          index.entries[id] = {
            date: firstEntry.date,
            repo: firstEntry.repo,
            title,
            source: 'distilled',
            user: '',
            drifted: false,
            contentHash: hash,
            contentLength: content.length,
            tags: firstEntry.tags || [],
            hasEmbedding: false,
            hasReasoning: true,
            hasAlternatives: false,
            qualityScore: 3, // distilled entries are high quality by definition
            distillTier: tier,
            distilledFrom: absorbedIds,
            distilledAt: Date.now(),
          };

          // Mark source entries as absorbed
          for (const item of cluster) {
            if (index.entries[item.id]) {
              index.entries[item.id].distilledAt = Date.now();
              index.entries[item.id].distillTier = tier;
            }
          }

          index.entryCount = Object.keys(index.entries).length;
          backend.saveIndex(index);
          totalStats.merged += cluster.length;
        } catch (err) {
          console.log(`    Merge failed for cluster: ${err.message}`);
        }
      }
    }

    // Log the distillation run
    if (!dryRun) {
      try {
        const backend = contentStore.getBackend(storePath);
        if (backend.db) {
          backend.db.prepare(`
            INSERT INTO distillation_log (run_at, tier, entries_input, entries_output, entries_merged, entries_deduped, llm_calls)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(Date.now(), tier, eligible.length, eligible.length - totalDeduped - totalStats.merged, totalStats.merged, totalDeduped, totalStats.llmCalls);
        }
      } catch { /* non-fatal */ }
    }
  }

  return totalStats;
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  distillEntries,
  groupEntries,
  deduplicateGroup,
  mergeEntries,
  titleSimilarity,
  TIERS,
};
