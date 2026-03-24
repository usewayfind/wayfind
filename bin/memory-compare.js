'use strict';

const fs = require('fs');
const path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;

/**
 * Compare Claude Code auto-memory vs Wayfind global memory.
 * Shows overlap, unique content in each, and freshness.
 */
function compare() {
  const autoMemoryRoot = path.join(HOME, '.claude', 'projects');
  const wayfindMemory = path.join(HOME, '.claude', 'memory');

  // Collect auto-memory entries
  const autoEntries = [];
  if (fs.existsSync(autoMemoryRoot)) {
    for (const proj of fs.readdirSync(autoMemoryRoot)) {
      const memDir = path.join(autoMemoryRoot, proj, 'memory');
      if (!fs.existsSync(memDir)) continue;
      for (const file of fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')) {
        const fp = path.join(memDir, file);
        const content = fs.readFileSync(fp, 'utf8');
        const typeMatch = content.match(/^type:\s*(.+)$/m);
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const stat = fs.statSync(fp);
        autoEntries.push({
          project: proj,
          file,
          type: typeMatch ? typeMatch[1].trim() : 'unknown',
          description: descMatch ? descMatch[1].trim() : '',
          size: content.length,
          modified: stat.mtime,
          daysAgo: Math.floor((Date.now() - stat.mtime) / (1000 * 60 * 60 * 24)),
        });
      }
    }
  }

  // Collect Wayfind global memory entries
  const wayfindEntries = [];
  if (fs.existsSync(wayfindMemory)) {
    for (const file of fs.readdirSync(wayfindMemory).filter(f => f.endsWith('.md'))) {
      const fp = path.join(wayfindMemory, file);
      const content = fs.readFileSync(fp, 'utf8');
      const stat = fs.statSync(fp);
      wayfindEntries.push({
        file,
        size: content.length,
        modified: stat.mtime,
        daysAgo: Math.floor((Date.now() - stat.mtime) / (1000 * 60 * 60 * 24)),
      });
    }
  }

  // Journal stats
  const journalDir = path.join(wayfindMemory, 'journal');
  let journalCount = 0;
  let journalSize = 0;
  let latestJournal = null;
  if (fs.existsSync(journalDir)) {
    const journals = fs.readdirSync(journalDir).filter(f => f.endsWith('.md'));
    journalCount = journals.length;
    for (const j of journals) {
      const fp = path.join(journalDir, j);
      journalSize += fs.statSync(fp).size;
      const stat = fs.statSync(fp);
      if (!latestJournal || stat.mtime > latestJournal) latestJournal = stat.mtime;
    }
  }

  // Report
  console.log('');
  console.log('=== Memory Systems Comparison ===');
  console.log('');

  console.log('Claude Code Auto-Memory (per-project):');
  const byType = {};
  for (const e of autoEntries) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }
  console.log(`  ${autoEntries.length} entries across ${new Set(autoEntries.map(e => e.project)).size} projects`);
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type}: ${count}`);
  }
  const recentAuto = autoEntries.filter(e => e.daysAgo <= 7);
  const staleAuto = autoEntries.filter(e => e.daysAgo > 30);
  console.log(`  Fresh (≤7d): ${recentAuto.length} | Stale (>30d): ${staleAuto.length}`);
  console.log('');

  console.log('Wayfind Global Memory:');
  console.log(`  ${wayfindEntries.length} topic files`);
  console.log(`  ${journalCount} journal entries (${Math.round(journalSize / 1024)}KB)`);
  const recentWf = wayfindEntries.filter(e => e.daysAgo <= 7);
  const staleWf = wayfindEntries.filter(e => e.daysAgo > 30);
  console.log(`  Fresh (≤7d): ${recentWf.length} | Stale (>30d): ${staleWf.length}`);
  if (latestJournal) {
    const jDaysAgo = Math.floor((Date.now() - latestJournal) / (1000 * 60 * 60 * 24));
    console.log(`  Latest journal: ${jDaysAgo}d ago`);
  }
  console.log('');

  // Overlap detection: look for similar topics
  console.log('Potential Overlap (auto-memory projects with Wayfind topic files on same subject):');
  let overlapCount = 0;
  for (const auto of autoEntries) {
    const keywords = auto.file.replace(/\.md$/, '').replace(/^(feedback|project|reference|user)_/, '').split(/[-_]/).filter(w => w.length > 2);
    for (const wf of wayfindEntries) {
      const wfWords = wf.file.replace(/\.md$/, '').split(/[-_]/).filter(w => w.length > 2);
      const overlap = keywords.filter(k => wfWords.some(w => w.includes(k) || k.includes(w)));
      if (overlap.length >= 2) {
        console.log(`  AUTO: ${auto.file} (${auto.project.slice(-30)}) <-> WF: ${wf.file}`);
        overlapCount++;
      }
    }
  }
  if (overlapCount === 0) console.log('  None detected');
  console.log('');

  // Secret scan across both memory systems
  const SECRET_PATTERNS = [
    /xoxb-[0-9A-Za-z-]+/,        // Slack bot token
    /xapp-[0-9A-Za-z-]+/,        // Slack app token
    /ghp_[0-9A-Za-z]+/,          // GitHub PAT
    /gho_[0-9A-Za-z]+/,          // GitHub OAuth
    /sk-[0-9A-Za-z]{20,}/,       // OpenAI / generic secret key
    /pat-na1-[0-9a-f-]+/,        // HubSpot PAT
    /ntn_[0-9A-Za-z]+/,          // Notion token
    /dG9r[0-9A-Za-z+/=]{20,}/,   // Base64 "tok:" prefix (Intercom-style)
    /AKIA[0-9A-Z]{16}/,          // AWS access key
    /\b[A-Za-z0-9_]{10,}\.[A-Za-z0-9_-]{20,}/,  // Azure function key pattern (xxx.yyy)
  ];

  console.log('Secret Scan:');
  let secretsFound = 0;
  const allFiles = [
    ...autoEntries.map(e => ({
      path: path.join(autoMemoryRoot, e.project, 'memory', e.file),
      label: `auto:${e.project.slice(-25)}/${e.file}`,
    })),
    ...wayfindEntries.map(e => ({
      path: path.join(wayfindMemory, e.file),
      label: `wayfind:${e.file}`,
    })),
  ];
  for (const { path: fp, label } of allFiles) {
    try {
      const content = fs.readFileSync(fp, 'utf8');
      for (const pattern of SECRET_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          // Skip if it's inside a code example or command template (has $ prefix or is in backtick-quoted env var reference)
          const line = content.split('\n').find(l => l.includes(match[0])) || '';
          if (line.includes('$') && !line.includes('`' + match[0])) continue;
          console.log(`  ⚠ ${label} — matches ${pattern.source.slice(0, 20)}...`);
          secretsFound++;
          break;
        }
      }
    } catch { /* skip unreadable */ }
  }
  if (secretsFound === 0) {
    console.log('  Clean — no secrets detected in memory files');
  }
}

if (require.main === module) {
  compare();
}

module.exports = { compare };
