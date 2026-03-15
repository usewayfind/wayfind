'use strict';

const fs = require('fs');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE;
const DEFAULT_GLOBAL_STATE = HOME ? path.join(HOME, '.claude', 'global-state.md') : null;
const DEFAULT_ROOTS = HOME ? [path.join(HOME, 'repos')] : [];

// Header variants to try, in priority order
const STATUS_HEADERS = [
  'Current Status',
  'Current State',
  'Recent Work',
  'Current Sprint Focus',
  'Current Focus',
];

const NEXT_HEADERS = [
  "What's Next",
  'Next Session',
  "What's Left",
];

// ── Scanning ─────────────────────────────────────────────────────────────────

/**
 * Recursively find .claude/state.md, .claude/team-state.md, and
 * .claude/personal-state.md files under the given root directories.
 * Returns an array of { repoDir, stateFile } objects.
 * Prefers team-state.md over state.md when both exist.
 * @param {string[]} roots - Directories to scan
 * @returns {Array<{ repoDir: string, stateFile: string }>}
 */
function scanStateFiles(roots) {
  const results = [];
  const seen = new Set();

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    scanDir(root, results, seen, 0);
  }

  return results;
}

function scanDir(dir, results, seen, depth) {
  // Don't recurse too deep (repos are typically 1-3 levels under root)
  if (depth > 4) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Check if this directory has a .claude/ with state files
  const claudeDir = path.join(dir, '.claude');
  if (fs.existsSync(claudeDir)) {
    const teamState = path.join(claudeDir, 'team-state.md');
    const personalState = path.join(claudeDir, 'personal-state.md');
    const plainState = path.join(claudeDir, 'state.md');

    // Prefer team-state.md, fall back to state.md
    let stateFile = null;
    if (fs.existsSync(teamState)) stateFile = teamState;
    else if (fs.existsSync(plainState)) stateFile = plainState;

    if (stateFile && !seen.has(dir)) {
      seen.add(dir);
      results.push({ repoDir: dir, stateFile });

      // Also note personal-state.md if it exists (for richer parsing)
      if (fs.existsSync(personalState)) {
        results[results.length - 1].personalStateFile = personalState;
      }
    }
  }

  // Recurse into subdirectories (skip node_modules, .git, etc.)
  const skip = new Set(['node_modules', '.git', '.claude', 'vendor', 'dist', 'build']);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (skip.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
    scanDir(path.join(dir, entry.name), results, seen, depth + 1);
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a state file to extract structured data.
 * @param {string} filePath - Path to a state.md or team-state.md
 * @returns {{ project: string, repo: string, updated: string, status: string, next: string } | null}
 */
function parseStateFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  if (!content.trim()) return null;

  // Normalize CRLF → LF (some state files have Windows line endings)
  const lines = content.split('\n').map(l => l.replace(/\r$/, ''));

  // Extract project name from H1: "# Name — suffix" or "# Name"
  const h1 = lines.find(l => /^# /.test(l));
  let project = '';
  if (h1) {
    const match = h1.match(/^# (.+?)(?:\s*[—–-]\s*.+)?$/);
    project = match ? match[1].trim() : h1.replace(/^# /, '').trim();
  }

  // Extract "Last updated: YYYY-MM-DD"
  const updatedLine = lines.find(l => /^Last updated:/i.test(l));
  let updated = '';
  if (updatedLine) {
    const match = updatedLine.match(/(\d{4}-\d{2}-\d{2})/);
    updated = match ? match[1] : '';
  }

  // Derive repo path (relative to HOME)
  const repoDir = path.dirname(path.dirname(filePath));
  let repo = repoDir;
  if (HOME && repoDir.startsWith(HOME)) {
    repo = '~' + repoDir.slice(HOME.length);
  }

  // Extract status section
  const status = extractSection(lines, STATUS_HEADERS);

  // Extract next-steps section
  const next = extractSection(lines, NEXT_HEADERS);

  return { project, repo, updated, status, next };
}

/**
 * Extract the first paragraph from the first matching section header.
 * Truncates to ~120 chars.
 * @param {string[]} lines - File lines
 * @param {string[]} headers - Header names to try in priority order
 * @returns {string}
 */
function extractSection(lines, headers) {
  for (const header of headers) {
    const idx = lines.findIndex(l => {
      const match = l.match(/^#{2,3}\s+(.+)$/);
      return match && match[1].trim() === header;
    });
    if (idx === -1) continue;

    // Collect first paragraph after the header
    const para = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i];
      // Stop at next heading or empty line after content
      if (/^#{1,3}\s/.test(line)) break;
      if (line.trim() === '' && para.length > 0) break;
      if (line.trim() === '') continue; // skip leading blank lines
      para.push(line.trim());
    }

    if (para.length === 0) continue;

    let text = para.join(' ');
    // Strip markdown formatting for table readability
    text = text.replace(/\*\*/g, '').replace(/`/g, '');
    // Truncate
    if (text.length > 120) {
      text = text.slice(0, 117) + '...';
    }
    return text;
  }

  return '';
}

// ── Table generation ─────────────────────────────────────────────────────────

/**
 * Build a markdown table from parsed entries.
 * @param {Array<{ project: string, repo: string, updated: string, status: string, next: string }>} entries
 * @returns {string}
 */
function buildStatusTable(entries) {
  // Sort by updated date descending (most recent first)
  const sorted = [...entries].sort((a, b) => {
    if (!a.updated && !b.updated) return 0;
    if (!a.updated) return 1;
    if (!b.updated) return -1;
    return b.updated.localeCompare(a.updated);
  });

  const lines = [
    '| Project | Repo | Updated | Status | Next |',
    '|---------|------|---------|--------|------|',
  ];

  for (const e of sorted) {
    // Escape pipe characters in content
    const status = (e.status || '').replace(/\|/g, '\\|');
    const next = (e.next || '').replace(/\|/g, '\\|');
    const project = (e.project || '').replace(/\|/g, '\\|');
    const repo = (e.repo || '').replace(/\|/g, '\\|');
    lines.push(`| ${project} | ${repo} | ${e.updated || ''} | ${status} | ${next} |`);
  }

  return lines.join('\n');
}

// ── Global state update ──────────────────────────────────────────────────────

/**
 * Replace the ## Active Projects section in global-state.md with the given table.
 * Preserves all other sections.
 * @param {string} globalStatePath - Path to global-state.md
 * @param {string} table - Markdown table string
 * @returns {{ written: boolean, path: string }}
 */
function updateGlobalState(globalStatePath, table) {
  const gPath = globalStatePath || DEFAULT_GLOBAL_STATE;
  if (!gPath) {
    throw new Error('Cannot determine global-state.md path');
  }

  let content;
  try {
    content = fs.readFileSync(gPath, 'utf8');
  } catch {
    throw new Error(`Cannot read ${gPath}`);
  }

  const lines = content.split('\n');

  // Find "## Active Projects" section
  const startIdx = lines.findIndex(l => /^## Active Projects/.test(l));
  if (startIdx === -1) {
    throw new Error('No "## Active Projects" section found in global-state.md');
  }

  // Find the next ## section after Active Projects
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  // Build replacement section
  const replacement = [
    '## Active Projects',
    '<!-- AUTO-GENERATED by `wayfind status --write`. Do not edit manually. -->',
    '',
    table,
    '',
  ];

  // Splice
  const newLines = [
    ...lines.slice(0, startIdx),
    ...replacement,
    ...lines.slice(endIdx),
  ];

  // Update "Last updated" date at the top
  const today = new Date().toISOString().split('T')[0];
  const newContent = newLines.join('\n').replace(
    /^(Last updated:)\s*\S+/m,
    `$1 ${today}`
  );

  fs.writeFileSync(gPath, newContent);
  return { written: true, path: gPath };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  scanStateFiles,
  parseStateFile,
  buildStatusTable,
  updateGlobalState,
  extractSection,
  DEFAULT_GLOBAL_STATE,
  DEFAULT_ROOTS,
  STATUS_HEADERS,
  NEXT_HEADERS,
};
