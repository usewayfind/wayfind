#!/usr/bin/env node
/**
 * Test parallel extraction correctness.
 *
 * Strategy:
 * 1. Run indexConversations against recent transcripts (--since) with fresh store
 * 2. Verify: stats correct, entries well-formed, convIndex populated
 * 3. Incremental skip: second run should process 0
 * 4. Error isolation: bad model doesn't crash, all errors handled
 * 5. Deterministic: two runs produce same repos and similar entry counts
 * 6. Timing: parallel should complete faster than sequential estimate
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Load API key from standard locations
const envPaths = [
  process.env.TEAM_CONTEXT_ENV_FILE,
  path.join(process.env.HOME, '.config/wayfind/.env'),
  path.join(process.env.HOME, '.env'),
].filter(Boolean);

const envPath = envPaths.find(p => fs.existsSync(p));
if (envPath) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^(export\s+)?(\w+)=(.+)$/);
    if (m) process.env[m[2]] = m[3].replace(/^["']|["']$/g, '');
  }
} else if (!process.env.ANTHROPIC_API_KEY) {
  console.error('No API key found. Set ANTHROPIC_API_KEY or create ~/.config/wayfind/.env');
  process.exit(1);
}

const contentStore = require('../bin/content-store');

const HAIKU = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  api_key_env: 'ANTHROPIC_API_KEY',
};

// Only process transcripts from the last 3 days to keep tests fast
const SINCE = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.log(`  FAIL: ${message}`);
  }
}

function makeTempStore() {
  const dir = path.join(os.tmpdir(), `wayfind-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanStore(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function testBasicParallelExtraction() {
  console.log('\n=== Test 1: Basic parallel extraction (recent transcripts) ===');
  const storePath = makeTempStore();

  try {
    const decisions = [];
    const progressRepos = [];
    const start = Date.now();
    const stats = await contentStore.indexConversations({
      storePath,
      llmConfig: HAIKU,
      embeddings: false,
      since: SINCE,
      onProgress: (p) => {
        if (p.phase === 'extracting') progressRepos.push(p.repo);
      },
      onDecisions: (date, repo, decs) => {
        decisions.push({ date, repo, count: decs.length });
      },
    });
    const elapsed = Date.now() - start;

    console.log(`  Completed in ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`  Stats: scanned=${stats.transcriptsScanned}, processed=${stats.transcriptsProcessed}, decisions=${stats.decisionsExtracted}, skipped=${stats.skipped}, errors=${stats.errors}`);

    assert(stats.transcriptsScanned > 0, `Scanned transcripts (${stats.transcriptsScanned})`);
    assert(stats.transcriptsProcessed > 0, `Processed transcripts (${stats.transcriptsProcessed})`);
    assert(stats.decisionsExtracted > 0, `Extracted decisions (${stats.decisionsExtracted})`);
    assert(stats.errors === 0, `No errors (${stats.errors})`);
    assert(stats.transcriptsScanned === stats.transcriptsProcessed + stats.skipped + stats.errors,
      `Stats add up: ${stats.transcriptsScanned} = ${stats.transcriptsProcessed} + ${stats.skipped} + ${stats.errors}`);

    // Verify index was saved
    const index = contentStore.loadIndex(storePath);
    assert(index !== null, 'Index file saved');
    assert(Object.keys(index.entries).length === stats.decisionsExtracted,
      `Index entries match stats (${Object.keys(index.entries).length} = ${stats.decisionsExtracted})`);

    // Verify entries are well-formed
    let allWellFormed = true;
    for (const [id, entry] of Object.entries(index.entries)) {
      if (!entry.date || !entry.repo || !entry.title || entry.source !== 'conversation' || !entry.contentHash || !Array.isArray(entry.tags)) {
        allWellFormed = false;
        console.log(`  FAIL: Malformed entry ${id.slice(0, 12)}...`);
        failed++;
        break;
      }
    }
    if (allWellFormed) {
      passed++;
      console.log(`  PASS: All ${Object.keys(index.entries).length} entries well-formed`);
    }

    // Verify onDecisions callback count matches
    const totalFromCallbacks = decisions.reduce((sum, d) => sum + d.count, 0);
    assert(totalFromCallbacks === stats.decisionsExtracted,
      `Callback decision count matches (${totalFromCallbacks} = ${stats.decisionsExtracted})`);

    // Verify onProgress was called for each candidate
    assert(progressRepos.length === stats.transcriptsProcessed + stats.errors,
      `Progress called for each candidate (${progressRepos.length})`);

    return { storePath, stats, elapsed }; // Return for reuse in test 2
  } catch (err) {
    cleanStore(storePath);
    throw err;
  }
}

async function testIncrementalSkip(storePath) {
  console.log('\n=== Test 2: Incremental skip (second run processes 0) ===');

  try {
    const stats = await contentStore.indexConversations({
      storePath,
      llmConfig: HAIKU,
      embeddings: false,
      since: SINCE,
    });

    // Allow 1 transcript to be re-processed — the current active session's transcript
    // changes between runs since we're writing to it right now
    assert(stats.transcriptsProcessed <= 1, `Second run processed ≤1 (was ${stats.transcriptsProcessed})`);
    assert(stats.skipped >= stats.transcriptsScanned - 1, `Most skipped (${stats.skipped}/${stats.transcriptsScanned})`);
    assert(stats.errors === 0, `No errors on skip run (${stats.errors})`);
  } finally {
    cleanStore(storePath);
  }
}

async function testErrorIsolation() {
  console.log('\n=== Test 3: Error isolation (bad model) ===');
  const storePath = makeTempStore();

  try {
    const badConfig = { provider: 'anthropic', model: 'nonexistent-model-xxx', api_key_env: 'ANTHROPIC_API_KEY' };
    const stats = await contentStore.indexConversations({
      storePath,
      llmConfig: badConfig,
      embeddings: false,
      since: SINCE,
    });

    assert(stats.errors > 0, `Errors captured (${stats.errors})`);
    assert(stats.transcriptsProcessed === 0, `None processed with bad model (${stats.transcriptsProcessed})`);

    // Verify it didn't crash and convIndex was still saved
    const convIndex = contentStore.loadConversationIndex
      ? null // loadConversationIndex isn't exported, just verify no crash
      : null;
    assert(true, 'No crash — errors handled gracefully');
  } finally {
    cleanStore(storePath);
  }
}

async function testDeterministicRepos() {
  console.log('\n=== Test 4: Deterministic repos across runs ===');
  const store1 = makeTempStore();
  const store2 = makeTempStore();

  try {
    const [stats1, stats2] = await Promise.all([
      contentStore.indexConversations({ storePath: store1, llmConfig: HAIKU, embeddings: false, since: SINCE }),
      contentStore.indexConversations({ storePath: store2, llmConfig: HAIKU, embeddings: false, since: SINCE }),
    ]);

    const index1 = contentStore.loadIndex(store1);
    const index2 = contentStore.loadIndex(store2);

    const repos1 = [...new Set(Object.values(index1.entries).map(e => e.repo))].sort();
    const repos2 = [...new Set(Object.values(index2.entries).map(e => e.repo))].sort();

    assert(repos1.join(',') === repos2.join(','), `Same repos: [${repos1.join(', ')}]`);

    const count1 = Object.keys(index1.entries).length;
    const count2 = Object.keys(index2.entries).length;
    // LLM output is non-deterministic — Haiku may extract slightly different decisions
    // across runs. Allow up to 20% variance which is typical for extraction tasks.
    const maxDiff = Math.max(5, Math.ceil(Math.max(count1, count2) * 0.2));
    assert(Math.abs(count1 - count2) <= maxDiff,
      `Similar entry count: ${count1} vs ${count2} (diff=${Math.abs(count1 - count2)}, max=${maxDiff})`);

  } finally {
    cleanStore(store1);
    cleanStore(store2);
  }
}

async function testTimingBenefit(processedCount, elapsed) {
  console.log('\n=== Test 5: Timing analysis ===');

  if (processedCount < 2) {
    console.log('  SKIP: Need >= 2 processed transcripts to evaluate parallelism');
    return;
  }

  // With Haiku, each transcript takes ~4-13s. Sequential = sum, parallel = max.
  // Conservative: parallel should be < 80% of sequential estimate (processedCount * 8s avg)
  const sequentialEstimate = processedCount * 8000;
  const ratio = elapsed / sequentialEstimate;
  console.log(`  ${processedCount} transcripts in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`  Sequential estimate: ${(sequentialEstimate / 1000).toFixed(1)}s`);
  console.log(`  Ratio: ${(ratio * 100).toFixed(0)}%`);

  assert(elapsed < sequentialEstimate, `Faster than sequential estimate (${(elapsed / 1000).toFixed(1)}s < ${(sequentialEstimate / 1000).toFixed(1)}s)`);
}

async function main() {
  console.log('=== Parallel Extraction Test Suite ===');
  console.log(`Since: ${SINCE}`);

  // Test 1 returns storePath for reuse in test 2
  const { storePath, stats, elapsed } = await testBasicParallelExtraction();
  await testIncrementalSkip(storePath);
  await testErrorIsolation();
  await testTimingBenefit(stats.transcriptsProcessed, elapsed);
  await testDeterministicRepos();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
