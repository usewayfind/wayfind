'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const llm = require('./connectors/llm');
const contentStore = require('./content-store');
const telemetry = require('./telemetry');

const intelligence = require('./intelligence');

const HOME = process.env.HOME || process.env.USERPROFILE;
const WAYFIND_DIR = path.join(HOME, '.claude', 'team-context');
const ENV_FILE = path.join(WAYFIND_DIR, '.env');
const ROOT = path.join(__dirname, '..');
const DEFAULT_PERSONAS_PATH = path.join(ROOT, 'templates', 'personas.json');

// Team repo allowlist — mirrors content-store.js logic for digest-time filtering.
// When INCLUDE_REPOS is set, sections mentioning repos NOT on the list are removed.
// Falls back to EXCLUDE_REPOS (legacy) for backward compatibility.
const INCLUDE_REPOS_RAW = (process.env.TEAM_CONTEXT_INCLUDE_REPOS || '')
  .split(',').map(r => r.trim()).filter(Boolean);
const EXCLUDE_REPOS_RAW = (process.env.TEAM_CONTEXT_EXCLUDE_REPOS || '')
  .split(',').map(r => r.trim()).filter(Boolean);

/**
 * Check if a repo name matches the include list.
 * Supports org/* wildcards.
 */
function isRepoIncluded(repo) {
  if (INCLUDE_REPOS_RAW.length === 0) return true; // no filter = include all
  const lower = repo.toLowerCase();
  return INCLUDE_REPOS_RAW.some(pattern => {
    const p = pattern.toLowerCase();
    if (p.endsWith('/*')) {
      return lower.startsWith(p.slice(0, -2) + '/');
    }
    return lower === p || lower.endsWith('/' + p) || lower.startsWith(p + '/');
  });
}

function buildExcludePattern() {
  if (EXCLUDE_REPOS_RAW.length === 0) return null;
  const escaped = EXCLUDE_REPOS_RAW.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
}

const EXCLUDE_CONTENT_RE = buildExcludePattern();

/**
 * Filter assembled content sections by team boundaries.
 * Sections are separated by \n\n---\n\n.
 * If INCLUDE_REPOS is set: keep only sections mentioning included repos.
 * Falls back to EXCLUDE_REPOS regex for backward compatibility.
 */
function filterExcludedContent(content) {
  if (!content) return content;

  const sections = content.split('\n\n---\n\n');

  if (INCLUDE_REPOS_RAW.length > 0) {
    // Allowlist mode: extract repo from section header (### DATE — REPO) and check
    return sections.filter(section => {
      const repoMatch = section.match(/^###\s+\S+\s+[—–]\s+(\S+)/);
      if (!repoMatch) return true; // keep non-journal sections (signals, etc.)
      return isRepoIncluded(repoMatch[1]);
    }).join('\n\n---\n\n');
  }

  // Legacy: regex blocklist
  if (EXCLUDE_CONTENT_RE) {
    return sections
      .filter(section => !EXCLUDE_CONTENT_RE.test(section))
      .join('\n\n---\n\n');
  }

  return content;
}

// ── Persona loading ─────────────────────────────────────────────────────────

/**
 * Load active personas from user config or bundled default.
 * Same resolution as team-context.js:readPersonas.
 * @returns {Array<{id: string, name: string, description: string}>}
 */
function loadPersonas() {
  const candidates = [
    path.join(HOME, '.claude', 'team-context', 'personas.json'),
    path.join(HOME, '.ai-memory', 'team-context', 'personas.json'),
  ];
  let configPath = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { configPath = p; break; }
  }
  if (!configPath) configPath = DEFAULT_PERSONAS_PATH;
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return data.personas || [];
  } catch {
    return [];
  }
}

// ── Env file helpers ────────────────────────────────────────────────────────

/**
 * Save a key=value pair to ~/.claude/team-context/.env.
 * Appends or updates the key. Creates the file if missing.
 */
function saveEnvKey(key, value) {
  fs.mkdirSync(WAYFIND_DIR, { recursive: true });
  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  }
  const prefix = `${key}=`;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const entry = `${key}=${value}`;
  if (idx !== -1) {
    lines[idx] = entry;
  } else {
    lines.push(entry);
  }
  fs.writeFileSync(ENV_FILE, lines.filter((l) => l !== '').join('\n') + '\n', 'utf8');
  console.log(`Saved to ${ENV_FILE}`);
}

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

/**
 * Extract a YYYY-MM-DD date from a filename.
 * Matches the first occurrence of a date pattern in the basename.
 * @param {string} filename
 * @returns {string|null}
 */
function extractDate(filename) {
  const base = path.basename(filename);
  const match = base.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Find files in a directory matching a date suffix pattern.
 * Files must contain a YYYY-MM-DD date >= sinceDate and end with the given suffix.
 * @param {string} dir - Directory to search
 * @param {string} sinceDate - Minimum date (YYYY-MM-DD, inclusive)
 * @param {string} suffix - File suffix to match (e.g. '-summary.md')
 * @returns {string[]} Array of absolute file paths
 */
function findFilesWithDate(dir, sinceDate, suffix) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesWithDate(fullPath, sinceDate, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      const date = extractDate(entry.name);
      if (date && date >= sinceDate) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Find files in a directory (non-recursive) matching a date suffix pattern.
 * @param {string} dir - Directory to search (top level only)
 * @param {string} sinceDate - Minimum date (YYYY-MM-DD, inclusive)
 * @param {string} suffix - File suffix to match (e.g. '-summary.md')
 * @returns {string[]} Array of absolute file paths
 */
function findFilesShallow(dir, sinceDate, suffix) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      const date = extractDate(entry.name);
      if (date && date >= sinceDate) {
        results.push(path.join(dir, entry.name));
      }
    }
  }
  return results;
}

/**
 * Walk owner/repo subdirectories looking for YYYY-MM-DD.md files.
 * @param {string} channelDir - Channel directory (e.g. signals/github/)
 * @param {string} sinceDate - Minimum date (YYYY-MM-DD, inclusive)
 * @returns {string[]} Array of absolute file paths
 */
function findRepoFiles(channelDir, sinceDate) {
  const results = [];
  if (!fs.existsSync(channelDir)) return results;

  const owners = fs.readdirSync(channelDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const owner of owners) {
    const ownerDir = path.join(channelDir, owner.name);
    const repos = fs.readdirSync(ownerDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const repo of repos) {
      const repoDir = path.join(ownerDir, repo.name);
      const files = fs.readdirSync(repoDir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.md'));

      for (const file of files) {
        const date = extractDate(file.name);
        if (date && date >= sinceDate) {
          results.push(path.join(repoDir, file.name));
        }
      }
    }
  }
  return results;
}

/**
 * Get today's date as YYYY-MM-DD.
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Store-based collection ──────────────────────────────────────────────────

/**
 * Collect digest content from the indexed content store.
 * Queries the store for all entries in the date range and retrieves full content.
 * Separates entries into journals/conversations and signals.
 * @param {string} sinceDate - Minimum date (YYYY-MM-DD, inclusive)
 * @param {Object} [options]
 * @param {string} [options.storePath] - Content store directory
 * @param {string} [options.journalDir] - Journal directory
 * @param {string} [options.signalsDir] - Signals directory
 * @returns {{ journals: string, signals: string, entryCount: number }}
 */
function collectFromStore(sinceDate, options = {}) {
  const storePath = options.storePath || contentStore.DEFAULT_STORE_PATH;
  const journalDir = options.journalDir || contentStore.DEFAULT_JOURNAL_DIR;
  const signalsDir = options.signalsDir || contentStore.DEFAULT_SIGNALS_DIR;

  const entries = contentStore.queryMetadata({
    since: sinceDate,
    until: today(),
    storePath,
  });

  if (entries.length === 0) {
    return { journals: '', signals: '', entryCount: 0, entryMeta: [] };
  }

  const journalParts = [];
  const signalParts = [];
  const journalMeta = [];
  const signalMeta = [];

  for (const { id, entry } of entries) {
    // Skip raw entries that have been absorbed into a distilled entry
    if (entry.distilledFrom) continue;

    const content = contentStore.getEntryContent(id, { storePath, journalDir, signalsDir });
    if (!content) continue;

    // Format with metadata header
    const source = entry.source || 'journal';
    const author = entry.user ? `Author: ${entry.user}` : '';
    const sourceMarker = source === 'conversation' ? ' [from conversation]' : '';
    const header = `### ${entry.date} — ${entry.repo}${entry.title ? ' — ' + entry.title : ''}${sourceMarker}`;
    const meta = author ? `${header}\n${author}\n` : `${header}\n`;
    const formatted = `${meta}\n${content}`;

    const itemMeta = {
      date: entry.date,
      source: entry.source,
      qualityScore: entry.qualityScore || 0,
      hasReasoning: entry.hasReasoning,
      hasAlternatives: entry.hasAlternatives,
      distillTier: entry.distillTier || 'raw',
    };

    if (source === 'signal') {
      signalParts.push(formatted);
      signalMeta.push(itemMeta);
    } else {
      journalParts.push(formatted);
      journalMeta.push(itemMeta);
    }
  }

  return {
    journals: journalParts.join('\n\n---\n\n'),
    signals: signalParts.join('\n\n---\n\n'),
    entryCount: entries.length,
    entryMeta: { journal: journalMeta, signal: signalMeta },
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Collect signal data from all channels since the given date.
 * Prefers rollup summaries (*-summary.md) over per-repo files to manage token budget.
 * @param {string} sinceDate - Minimum date (YYYY-MM-DD, inclusive)
 * @param {string} [signalsDir] - Override signals directory
 * @returns {string} Concatenated markdown with channel headers
 */
function collectSignals(sinceDate, signalsDir) {
  signalsDir = signalsDir || path.join(HOME, '.claude', 'team-context', 'signals');
  if (!fs.existsSync(signalsDir)) return '';

  const sections = [];
  const channels = fs.readdirSync(signalsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const channel of channels) {
    const channelDir = path.join(signalsDir, channel);

    // Prefer summary files at the channel root (non-recursive) over per-repo files
    const summaries = findFilesShallow(channelDir, sinceDate, '-summary.md');
    if (summaries.length > 0) {
      const content = summaries
        .sort()
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n\n');
      sections.push(`## ${channel} signals\n\n${content}`);
    } else {
      // Fall back to per-repo files
      const repoFiles = findRepoFiles(channelDir, sinceDate);
      if (repoFiles.length > 0) {
        const content = repoFiles
          .sort()
          .map((f) => fs.readFileSync(f, 'utf8'))
          .join('\n\n');
        sections.push(`## ${channel} signals\n\n${content}`);
      }
    }
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Collect journal entries since the given date.
 * @param {string} sinceDate - Minimum date (YYYY-MM-DD, inclusive)
 * @param {string} [journalDir] - Override journal directory
 * @returns {string} Concatenated journal content
 */
function collectJournals(sinceDate, journalDir) {
  journalDir = journalDir || path.join(HOME, '.claude', 'memory', 'journal');
  if (!fs.existsSync(journalDir)) return '';

  const files = fs.readdirSync(journalDir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith('.md'))
    .filter((f) => {
      const date = extractDate(f.name);
      return date && date >= sinceDate;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (files.length === 0) return '';

  return files
    .map((f) => fs.readFileSync(path.join(journalDir, f.name), 'utf8'))
    .join('\n\n---\n\n');
}

/**
 * Load team context files (product.md, etc.) from the team-context directory.
 * Returns a combined string, or empty string if not available.
 */
function loadTeamContext(teamContextDir) {
  if (!teamContextDir) return '';
  const contextDir = path.join(teamContextDir, 'context');
  if (!fs.existsSync(contextDir)) return '';

  const parts = [];
  const files = ['product.md', 'engineering.md', 'architecture.md'];
  for (const file of files) {
    const fp = path.join(contextDir, file);
    try {
      const content = fs.readFileSync(fp, 'utf8').trim();
      if (content) parts.push(content);
    } catch { /* skip missing files */ }
  }
  return parts.join('\n\n');
}

/**
 * Load team member profiles and build an author→role map.
 * Returns a formatted string like "- greg: CTO/Founder (engineering, strategy)"
 */
function loadTeamMembers(teamContextDir) {
  if (!teamContextDir) return '';
  const membersDir = path.join(teamContextDir, 'members');
  if (!fs.existsSync(membersDir)) return '';

  const lines = [];
  try {
    const files = fs.readdirSync(membersDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const member = JSON.parse(fs.readFileSync(path.join(membersDir, file), 'utf8'));
        const name = member.name || file.replace('.json', '');
        const personas = (member.personas || []).join(', ');
        const role = member.role || '';
        const desc = [role, personas ? `(${personas})` : ''].filter(Boolean).join(' ');
        lines.push(`- ${name}: ${desc || 'team member'}`);
      } catch { /* skip invalid files */ }
    }
  } catch { /* skip if unreadable */ }
  return lines.join('\n');
}

/**
 * Load the most recent previous digest for dedup.
 * Returns the digest content or empty string.
 */
function loadPreviousDigest(personaId, currentDate) {
  const digestDir = path.join(HOME, '.claude', 'team-context', 'digests', personaId);
  if (!fs.existsSync(digestDir)) return '';

  try {
    const files = fs.readdirSync(digestDir)
      .filter(f => f.endsWith('.md') && f < `${currentDate}.md`)
      .sort()
      .reverse();
    if (files.length === 0) return '';
    return fs.readFileSync(path.join(digestDir, files[0]), 'utf8').trim();
  } catch { return ''; }
}

// ── Feedback-driven learning ─────────────────────────────────────────────────

const POSITIVE_REACTIONS = new Set([
  'rocket', 'fire', 'tada', 'heart', '+1', 'thumbsup',
  '100', 'star', 'raised_hands', 'clap', 'pray', 'muscle',
  'white_check_mark', 'heavy_check_mark', 'star-struck', 'boom',
]);

const NEGATIVE_REACTIONS = new Set([
  '-1', 'thumbsdown', 'thinking_face', 'confused',
  'disappointed', 'face_with_rolling_eyes', 'x', 'no_entry_sign',
]);

/**
 * Build a feedback context section for the digest prompt.
 * Summarizes recent team reactions and text feedback so the LLM
 * can adapt what it surfaces.
 *
 * @param {string} personaId - Persona to filter feedback for
 * @param {Object} [options]
 * @param {string} [options.storePath] - Content store directory
 * @param {number} [options.lookbackDays] - Days of feedback to consider (default: 14)
 * @param {number} [options.maxChars] - Max output chars (default: 500)
 * @returns {string} - Feedback section text, or empty string if no feedback
 */
function buildFeedbackContext(personaId, options = {}) {
  const lookbackDays = options.lookbackDays || 14;
  const maxChars = options.maxChars || 500;

  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);
  const sinceStr = since.toISOString().slice(0, 10);

  const feedback = contentStore.getDigestFeedback({
    storePath: options.storePath,
    since: sinceStr,
  });

  if (!feedback || feedback.length === 0) return '';

  // Filter to matching persona (or include all if persona not specified in feedback)
  const relevant = feedback.filter(f => !f.persona || f.persona === personaId);
  if (relevant.length === 0) return '';

  // Tally positive/negative reactions
  let positiveTotal = 0;
  let negativeTotal = 0;
  const positiveEmoji = {};
  const negativeEmoji = {};

  for (const f of relevant) {
    for (const [emoji, count] of Object.entries(f.reactions || {})) {
      if (POSITIVE_REACTIONS.has(emoji)) {
        positiveTotal += count;
        positiveEmoji[emoji] = (positiveEmoji[emoji] || 0) + count;
      } else if (NEGATIVE_REACTIONS.has(emoji)) {
        negativeTotal += count;
        negativeEmoji[emoji] = (negativeEmoji[emoji] || 0) + count;
      }
    }
  }

  // Collect text feedback (most recent first, cap at 5)
  const quotes = [];
  for (const f of relevant) {
    for (const c of (f.comments || [])) {
      if (c.text && c.text.trim()) {
        quotes.push(c.text.trim().substring(0, 120));
      }
    }
  }
  const topQuotes = quotes.slice(0, 5);

  // If no signal at all, skip
  if (positiveTotal === 0 && negativeTotal === 0 && topQuotes.length === 0) return '';

  // Build compact summary
  const parts = [];
  parts.push('## Digest Preferences (from team feedback)');
  parts.push('The team has reacted to recent digests. Use this to calibrate what you surface:');

  if (positiveTotal > 0) {
    const topPositive = Object.entries(positiveEmoji)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([e]) => ':' + e + ':')
      .join(' ');
    parts.push(`Positive signals (${positiveTotal} reactions: ${topPositive}) — do more of what recent digests covered.`);
  }

  if (negativeTotal > 0) {
    const topNegative = Object.entries(negativeEmoji)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([e]) => ':' + e + ':')
      .join(' ');
    parts.push(`Concerns (${negativeTotal} reactions: ${topNegative}) — reconsider emphasis or framing.`);
  }

  if (topQuotes.length > 0) {
    parts.push('Direct feedback from the team:');
    for (const q of topQuotes) {
      parts.push(`- "${q}"`);
    }
  }

  let result = parts.join('\n');

  // Enforce char cap
  if (result.length > maxChars) {
    result = result.substring(0, maxChars - 3) + '...';
  }

  return result;
}

/**
 * Build the system prompt and user message for a persona digest.
 * @param {string} personaId - Persona identifier (e.g. 'engineering', 'product')
 * @param {string} signalContent - Collected signal data
 * @param {string} journalContent - Collected journal entries
 * @param {{ from: string, to: string }} dateRange - Date range
 * @param {Object} [context] - Optional enrichment context
 * @param {string} [context.teamContextDir] - Path to team-context repo
 * @returns {{ system: string, user: string }}
 */
function buildPrompt(personaId, signalContent, journalContent, dateRange, context) {
  const templatePath = path.join(__dirname, '..', 'templates', 'autopilot', `${personaId}.md`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Persona template not found: ${templatePath}`);
  }

  const system = fs.readFileSync(templatePath, 'utf8');
  const ctx = context || {};

  // Assemble user message sections
  const sections = [];
  sections.push(`# Team Digest Input \u2014 ${dateRange.from} to ${dateRange.to}`);

  // Team context (product strategy, architecture, etc.)
  const teamContext = loadTeamContext(ctx.teamContextDir);
  if (teamContext) {
    sections.push(`## Team Context\n${teamContext}`);
  }

  // Team members with roles
  const teamMembers = loadTeamMembers(ctx.teamContextDir);
  if (teamMembers) {
    sections.push(`## Team Members\n${teamMembers}`);
  }

  // Previous digest for dedup
  const prevDigest = loadPreviousDigest(personaId, dateRange.to);
  if (prevDigest) {
    sections.push(`## Previous Digest\nThe following was the most recent digest. Do not repeat these items unless there is a meaningful update.\n\n${prevDigest}`);
  }

  // Team feedback on recent digests
  const feedbackContext = buildFeedbackContext(personaId, { storePath: ctx.storePath });
  if (feedbackContext) {
    sections.push(feedbackContext);
  }

  // Excluded topics directive (driven by TEAM_CONTEXT_EXCLUDE_REPOS)
  if (EXCLUDE_REPOS_RAW.length > 0) {
    const names = EXCLUDE_REPOS_RAW.join(', ');
    sections.push(`## CRITICAL: Excluded Topics\nYou MUST NOT mention the following projects anywhere in your output: ${names}. This includes their versions, features, releases, connectors, configuration, bugs, or any development work on them. Only write about items that appear explicitly in the signal data and journal entries below. Do not infer or fabricate items about projects not present in the input.`);
  }

  // Signal data
  sections.push(`## Signal Data\n${signalContent || 'No signal data available for this period.'}`);

  // Journal entries
  sections.push(`## Session Journals\n${journalContent || 'No journal entries available for this period.'}`);

  const user = sections.join('\n\n') + '\n';

  return { system, user };
}

/**
 * Apply token budget constraints with quality-weighted packing.
 * Higher quality entries are kept preferentially over low-quality ones.
 * @param {string} signalContent
 * @param {string} journalContent
 * @param {number} maxChars
 * @param {Object} [options] - Optional metadata for quality-weighted packing
 * @param {Object} [options.entryMeta] - { journal: [{qualityScore, date, ...}], signal: [...] }
 * @param {Array} [options.scores] - Intelligence scores from Haiku scoring
 * @param {string} [options.personaId] - Current persona for score lookup
 * @returns {{ signals: string, journals: string, truncated: boolean, stats: Object }}
 */
function applyTokenBudget(signalContent, journalContent, maxChars, options = {}) {
  const total = signalContent.length + journalContent.length;
  if (total <= maxChars) {
    return { signals: signalContent, journals: journalContent, truncated: false, stats: { dropped: 0 } };
  }

  const { entryMeta, scores, personaId } = options;

  // Split into sections
  const signalSections = signalContent ? signalContent.split('\n\n---\n\n') : [];
  const journalSections = journalContent ? journalContent.split('\n\n---\n\n') : [];
  const signalMetaArr = (entryMeta && entryMeta.signal) || [];
  const journalMetaArr = (entryMeta && entryMeta.journal) || [];

  // Score each section with composite priority
  const todayStr = today();
  const yesterdayStr = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; })();

  const allSections = [];
  for (let i = 0; i < signalSections.length; i++) {
    const meta = signalMetaArr[i] || {};
    const quality = meta.qualityScore || 0;
    const recency = (meta.date === todayStr || meta.date === yesterdayStr) ? 1 : 0;
    const intel = (scores && scores[i] && personaId) ? (scores[i][personaId] || 0) : 0;
    const distillBonus = (meta.distillTier && meta.distillTier !== 'raw') ? 1 : 0;
    allSections.push({
      text: signalSections[i],
      type: 'signal',
      priority: quality + recency + intel + distillBonus,
      len: signalSections[i].length,
    });
  }
  for (let i = 0; i < journalSections.length; i++) {
    const meta = journalMetaArr[i] || {};
    const quality = meta.qualityScore || 0;
    const recency = (meta.date === todayStr || meta.date === yesterdayStr) ? 1 : 0;
    // Journal score indices start after signal count
    const scoreIdx = signalSections.length + i;
    const intel = (scores && scores[scoreIdx] && personaId) ? (scores[scoreIdx][personaId] || 0) : 0;
    const distillBonus = (meta.distillTier && meta.distillTier !== 'raw') ? 1 : 0;
    allSections.push({
      text: journalSections[i],
      type: 'journal',
      priority: quality + recency + intel + distillBonus,
      len: journalSections[i].length,
    });
  }

  // Sort by priority descending (highest quality first)
  allSections.sort((a, b) => b.priority - a.priority);

  // Greedily pack into budget
  const truncationNote = '\n\n> Note: Input was truncated to fit within token budget. Lower-quality entries were dropped.\n';
  const available = maxChars - truncationNote.length;
  const keptSignals = [];
  const keptJournals = [];
  let used = 0;
  let dropped = 0;

  for (const section of allSections) {
    const sectionCost = section.len + 7; // account for '\n\n---\n\n' separator
    if (used + sectionCost <= available) {
      if (section.type === 'signal') {
        keptSignals.push(section.text);
      } else {
        keptJournals.push(section.text);
      }
      used += sectionCost;
    } else {
      dropped++;
    }
  }

  const truncated = dropped > 0;
  let finalSignals = keptSignals.join('\n\n---\n\n');
  let finalJournals = keptJournals.join('\n\n---\n\n');
  if (truncated) {
    finalJournals += truncationNote;
  }

  return {
    signals: finalSignals,
    journals: finalJournals,
    truncated,
    stats: { dropped, total: allSections.length, kept: allSections.length - dropped },
  };
}

/**
 * Generate digests for one or more personas.
 * @param {Object} config - Digest config from connectors.json (has .llm and .slack keys)
 * @param {string[]} personaIds - Array of persona identifiers
 * @param {string} sinceDate - YYYY-MM-DD lookback date
 * @param {Function} [onProgress] - Optional callback: { phase, personaId, index, total, elapsed }
 * @returns {Promise<{ files: string[], personas: string[], dateRange: { from: string, to: string } }>}
 */
async function generateDigest(config, personaIds, sinceDate, onProgress) {
  const toDate = today();
  const dateRange = { from: sinceDate, to: toDate };

  // Try store-based collection first; fall back to raw file scan
  let signalContent = '';
  let journalContent = '';
  const storeOpts = {
    storePath: config.store_path,
    journalDir: config.journal_dir,
    signalsDir: config.signals_dir,
  };
  const storeResult = collectFromStore(sinceDate, storeOpts);
  if (storeResult.entryCount > 0) {
    journalContent = storeResult.journals;
    // Use store signals if available, otherwise fall back to direct file scan
    signalContent = storeResult.signals || collectSignals(sinceDate, config.signals_dir);
  } else {
    // Fallback: direct file scan (store not indexed)
    signalContent = collectSignals(sinceDate, config.signals_dir);
    journalContent = collectJournals(sinceDate, config.journal_dir);
  }

  // Filter by team boundaries (TEAM_CONTEXT_INCLUDE_REPOS allowlist, falls back to EXCLUDE_REPOS)
  journalContent = filterExcludedContent(journalContent);
  signalContent = filterExcludedContent(signalContent);

  // Preserve original content refs for telemetry
  const rawSignalContent = signalContent;
  const rawJournalContent = journalContent;

  // Intelligence layer: score items for persona relevance
  const personas = loadPersonas();
  let scores = null;
  if (config.intelligence?.enabled !== false && personas.length > 0) {
    const haikuConfig = {
      provider: config.llm.provider,
      model: config.intelligence?.model || 'claude-haiku-4-5-20251001',
      api_key_env: config.llm.api_key_env,
    };
    scores = await intelligence.scoreItems(signalContent, journalContent, personas, haikuConfig);
  }

  const maxInputChars = (config.llm && config.llm.max_input_chars) || 120000;

  // Generate per-persona digests
  const digestDir = path.join(HOME, '.claude', 'team-context', 'digests');
  const files = [];
  const personaResults = [];

  for (let i = 0; i < personaIds.length; i++) {
    const personaId = personaIds[i];

    if (onProgress) {
      onProgress({ phase: 'start', personaId, index: i, total: personaIds.length });
    }

    const startTime = Date.now();

    // Per-persona filtering: intelligence layer + token budget
    let pSignals = signalContent;
    let pJournals = journalContent;
    if (scores) {
      const threshold = config.intelligence?.thresholds?.[personaId]
        ?? intelligence.DEFAULT_THRESHOLDS[personaId] ?? 1;
      const allPersonaIds = personas.map(p => p.id);
      ({ signals: pSignals, journals: pJournals } =
        intelligence.filterForPersona(signalContent, journalContent, scores, personaId, threshold, allPersonaIds));
    }
    const budget = applyTokenBudget(pSignals, pJournals, maxInputChars, {
      entryMeta: storeResult.entryMeta,
      scores,
      personaId,
    });
    pSignals = budget.signals;
    pJournals = budget.journals;

    const promptContext = { teamContextDir: config.team_context_dir };
    const { system, user } = buildPrompt(personaId, pSignals, pJournals, dateRange, promptContext);

    // Debug: dump prompt if TEAM_CONTEXT_DEBUG_PROMPT is set
    if (process.env.TEAM_CONTEXT_DEBUG_PROMPT) {
      const debugPath = path.join(digestDir, `_debug-prompt-${personaId}.txt`);
      fs.mkdirSync(digestDir, { recursive: true });
      fs.writeFileSync(debugPath, `=== SYSTEM ===\n${system}\n\n=== USER ===\n${user}`, 'utf8');
      console.log(`  [debug] Prompt dumped to ${debugPath}`);
    }

    const llmConfig = { ...config.llm, _personaId: personaId };
    const result = await llm.call(llmConfig, system, user);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Write per-persona file
    const personaDir = path.join(digestDir, personaId);
    fs.mkdirSync(personaDir, { recursive: true });
    const personaFile = path.join(personaDir, `${toDate}.md`);
    fs.writeFileSync(personaFile, result, 'utf8');
    files.push(personaFile);

    personaResults.push({ id: personaId, content: result });

    if (onProgress) {
      onProgress({ phase: 'done', personaId, index: i, total: personaIds.length, elapsed });
    }
  }

  telemetry.capture('digest_generated', {
    persona_count: personaIds.length,
    personas: personaIds.join(','),
    entry_count: storeResult.entryCount || 0,
    journal_count: rawJournalContent ? rawJournalContent.split('\n---\n').length : 0,
    signal_count: rawSignalContent ? rawSignalContent.split('\n---\n').length : 0,
    has_previous_digest: !!loadPreviousDigest(personaIds[0], toDate),
    has_team_context: !!loadTeamContext(config.team_context_dir),
    intelligence_enabled: config.intelligence?.enabled !== false,
    intelligence_items_scored: scores ? scores.length : 0,
  });

  // Write combined file
  fs.mkdirSync(digestDir, { recursive: true });
  const combinedContent = personaResults
    .map((p) => {
      const title = p.id === 'unified' ? 'Wayfind Digest' : `${p.id.charAt(0).toUpperCase() + p.id.slice(1)} Digest`;
      return `# ${title}\n\n${p.content}`;
    })
    .join('\n\n---\n\n');
  const combinedFile = path.join(digestDir, `${toDate}-combined.md`);
  fs.writeFileSync(combinedFile, combinedContent, 'utf8');
  files.push(combinedFile);

  // Compute input stats for preview mode
  const entryMeta = storeResult.entryMeta || {};
  const journalMeta = entryMeta.journal || [];
  const signalMeta = entryMeta.signal || [];
  const inputStats = {
    journalEntries: journalMeta.length,
    signalEntries: signalMeta.length,
    qualityDistribution: {
      rich: journalMeta.filter(m => m.qualityScore >= 2).length,
      medium: journalMeta.filter(m => m.qualityScore === 1).length,
      thin: journalMeta.filter(m => m.qualityScore === 0).length,
    },
  };

  return { files, personas: personaIds, dateRange, scores, inputStats };
}

/**
 * Interactive setup for digest configuration.
 * Returns a config object (caller writes to disk).
 * @returns {Promise<Object>}
 */
async function configure() {
  console.log('');
  console.log('Digest Configuration');
  console.log('');

  // Step 1: LLM provider
  const llmConfig = {};

  // Auto-detect available provider
  const detected = await llm.detect();
  if (detected) {
    console.log(`Detected: ${detected.provider} (${detected.model || 'default model'})`);
    const useDetected = await ask(`Use ${detected.provider}? (Y/n): `);
    if (!useDetected || useDetected.toLowerCase() !== 'n') {
      Object.assign(llmConfig, detected);
    }
  }

  if (!llmConfig.provider) {
    console.log('Available providers: anthropic, openai, cli');
    const provider = await ask('LLM provider: ');
    llmConfig.provider = provider;

    if (provider === 'anthropic') {
      llmConfig.model = (await ask('Model (default: claude-sonnet-4-5-20250929): ')) || 'claude-sonnet-4-5-20250929';
      llmConfig.api_key_env = 'ANTHROPIC_API_KEY';
    } else if (provider === 'openai') {
      llmConfig.model = (await ask('Model (default: gpt-4o-mini): ')) || 'gpt-4o-mini';
      llmConfig.api_key_env = (await ask('API key env var (default: OPENAI_API_KEY): ')) || 'OPENAI_API_KEY';
      const baseUrl = await ask('Base URL (blank for OpenAI, or http://localhost:11434/v1 for Ollama): ');
      llmConfig.base_url = baseUrl || null;
    } else if (provider === 'cli') {
      llmConfig.command = await ask('Command (e.g. "ollama run llama3.2"): ');
    }
  }

  // Step 1b: API key — save to ~/.claude/team-context/.env
  if (llmConfig.api_key_env) {
    const existing = process.env[llmConfig.api_key_env];
    if (existing) {
      console.log(`\n${llmConfig.api_key_env} found in environment.`);
      const save = await ask('Save it to wayfind config so it works from any terminal? (Y/n): ');
      if (!save || save.toLowerCase() !== 'n') {
        saveEnvKey(llmConfig.api_key_env, existing);
      }
    } else {
      console.log(`\n${llmConfig.api_key_env} not found in environment.`);
      const key = await ask(`Paste your ${llmConfig.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key (sk-...): `);
      if (key) {
        saveEnvKey(llmConfig.api_key_env, key);
        process.env[llmConfig.api_key_env] = key;
      } else {
        console.log(`Skipped. You\'ll need to set ${llmConfig.api_key_env} in your environment.`);
      }
    }
  }

  // Step 2: Slack webhook (optional)
  console.log('');
  const webhook = await ask('Slack incoming webhook URL (blank to skip): ');

  // Step 3: Personas
  console.log('');
  const defaultPersonas = ['unified'];
  console.log(`Default digest: unified (or choose: engineering, product, strategy, design)`);
  const personaInput = await ask('Digest templates (comma-separated, blank for default): ');
  const personas = personaInput
    ? personaInput.split(',').map((s) => s.trim()).filter(Boolean)
    : defaultPersonas;

  return {
    llm: llmConfig,
    slack: {
      webhook_url: webhook || null,
      default_personas: personas,
    },
    lookback_days: 7,
    configured_at: new Date().toISOString(),
  };
}

module.exports = {
  collectSignals,
  collectJournals,
  collectFromStore,
  loadTeamContext,
  loadTeamMembers,
  loadPreviousDigest,
  loadPersonas,
  buildFeedbackContext,
  buildPrompt,
  generateDigest,
  configure,
};
