'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const transport = require('./transport');

const HOME = process.env.HOME || process.env.USERPROFILE;
const WAYFIND_DIR = path.join(HOME, '.claude', 'team-context');
const CONNECTORS_FILE = path.join(WAYFIND_DIR, 'connectors.json');
const SIGNALS_DIR = path.join(WAYFIND_DIR, 'signals');

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

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONNECTORS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONNECTORS_FILE), { recursive: true });
  fs.writeFileSync(CONNECTORS_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function today() {
  return localDateStr(new Date());
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  return Math.floor(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24));
}

/**
 * Normalize a repo entry to { owner, name } regardless of input format.
 * Accepts "owner/repo" string or { owner, repo } object.
 */
function parseRepo(repo) {
  if (!repo) throw new Error('repo is required');
  if (typeof repo === 'string') {
    const parts = repo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid repo format: "${repo}". Expected owner/repo.`);
    }
    return { owner: parts[0], name: parts[1] };
  }
  const owner = repo.owner;
  const name = repo.repo || repo.name;
  if (!owner || !name) throw new Error('Invalid repo object: missing owner or repo.');
  return { owner, name };
}

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '-';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function runDurationSeconds(run) {
  if (!run.created_at || !run.updated_at) return null;
  if (run.status !== 'completed') return null;
  const start = new Date(run.created_at).getTime();
  const end = new Date(run.updated_at).getTime();
  return Math.floor((end - start) / 1000);
}

// ── Transport dispatch ──────────────────────────────────────────────────────

async function apiGet(config, endpoint, params, repoOwner) {
  if (config.transport === 'gh-cli') {
    const ghUser = (config.accounts && repoOwner) ? config.accounts[repoOwner] : undefined;
    return transport.ghCli.get(endpoint, params, ghUser ? { ghUser } : undefined);
  }
  return transport.https.get(config.token || '', endpoint, params);
}

// ── Concurrency-limited Promise.all ─────────────────────────────────────────

function promiseAllLimited(tasks, limit) {
  const results = new Array(tasks.length);
  let index = 0;

  function next() {
    const i = index++;
    if (i >= tasks.length) return Promise.resolve();
    return tasks[i]().then((result) => {
      results[i] = result;
      return next();
    });
  }

  const workers = [];
  for (let w = 0; w < Math.min(limit, tasks.length); w++) {
    workers.push(next());
  }

  return Promise.all(workers).then(() => results);
}

// ── Configure ───────────────────────────────────────────────────────────────

async function configure() {
  console.log('');
  console.log('GitHub Connector Setup');
  console.log('');

  // Step 1: auto-detect transport
  const detected = await transport.detect();
  let transportType = detected.type;
  let token = detected.token || '';

  if (transportType === 'gh-cli') {
    console.log('Detected: gh CLI authenticated');
  } else if (token) {
    console.log('Detected: HTTPS with token from environment');
  } else {
    console.log('No gh CLI found. A GitHub Personal Access Token is required.');
    console.log('Required scopes: repo (or public_repo for public repos only)');
    token = await ask('GitHub PAT: ');
    if (!token) {
      throw new Error('A token is required for HTTPS transport.');
    }
    transportType = 'https';
  }

  // Step 2: select repos
  console.log('');
  const repoInput = await ask('Repos to track (comma-separated owner/repo): ');
  const repos = repoInput
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  if (repos.length === 0) {
    throw new Error('At least one repository is required.');
  }

  // Validate format
  for (const repo of repos) {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      throw new Error(`Invalid repo format: "${repo}". Expected owner/repo.`);
    }
  }

  // Step 3: build config object — caller (team-context.js) writes to disk
  const repoObjects = repos.map((r) => {
    const [owner, repo] = r.split('/');
    return { owner, repo };
  });

  // Step 4: multi-account support for gh CLI
  let accounts;
  if (transportType === 'gh-cli') {
    const ghAccounts = await transport.ghCli.listAccounts();
    if (ghAccounts.length > 1) {
      const uniqueOrgs = [...new Set(repoObjects.map((r) => r.owner))];
      console.log('');
      console.log(`Multiple gh accounts detected: ${ghAccounts.join(', ')}`);
      console.log('Map each org/owner to the gh account that has access.');
      console.log(`(press Enter to use the default active account)`);
      accounts = {};
      for (const org of uniqueOrgs) {
        const answer = await ask(`  ${org} → gh account [${ghAccounts.join('/')}]: `);
        if (answer && ghAccounts.includes(answer)) {
          accounts[org] = answer;
        }
      }
      if (Object.keys(accounts).length === 0) {
        accounts = undefined;
      }
    }
  }

  const channelConfig = {
    transport: transportType,
    token: transportType === 'https' ? token : undefined,
    accounts: accounts || undefined,
    repos: repoObjects,
    last_pull: null,
  };

  console.log('');
  console.log(`Configured ${repos.length} repo(s) with ${transportType} transport.`);
  if (accounts && Object.keys(accounts).length > 0) {
    for (const [org, user] of Object.entries(accounts)) {
      console.log(`  ${org} → ${user}`);
    }
  }
  console.log('');

  return channelConfig;
}

// ── Pull ────────────────────────────────────────────────────────────────────

async function pull(config, since) {
  const sinceDate = since || yesterday();
  const todayDate = today();
  const timestamp = new Date().toISOString();
  const repos = config.repos || [];

  if (repos.length === 0) {
    return { files: [], summary: 'No repos configured.', counts: { repos: 0, issues: 0, prs: 0, runs: 0 } };
  }

  // Fetch data for all repos with concurrency limit
  const tasks = repos.map((repo) => () => fetchRepoData(config, repo, sinceDate));
  const repoResults = await promiseAllLimited(tasks, 5);

  // Generate signal files
  const files = [];
  const repoHighlights = [];
  let totalIssues = 0;
  let totalPRs = 0;
  let totalRuns = 0;
  const allBlockedPRs = [];
  const allFailedRuns = [];
  const allIssueSpikes = [];

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const data = repoResults[i];
    const { owner, name: repoName } = parseRepo(repo);
    const repoStr = `${owner}/${repoName}`;

    // Generate per-repo markdown
    const md = generateRepoMarkdown(owner, repoName, data, sinceDate, todayDate, timestamp);

    // Write per-repo signal file
    const repoDir = path.join(SIGNALS_DIR, 'github', owner, repoName);
    fs.mkdirSync(repoDir, { recursive: true });
    const repoFile = path.join(repoDir, `${todayDate}.md`);
    fs.writeFileSync(repoFile, md, 'utf8');
    files.push(repoFile);

    // Collect stats for summary
    totalIssues += data.issues.length;
    totalPRs += data.prs.length;
    totalRuns += data.runs.length;

    // Track blocked PRs (open > 5 days, no reviews)
    const blocked = data.prs.filter((pr) => {
      return pr.state === 'open' && daysBetween(pr.created_at, todayDate) > 5;
    });
    for (const pr of blocked) {
      allBlockedPRs.push({ repo: repoStr, pr });
    }

    // Track failed CI runs
    const failed = data.runs.filter((r) => r.conclusion === 'failure');
    for (const run of failed) {
      allFailedRuns.push({ repo: repoStr, run });
    }

    // Track issue spikes (more than 5 new issues)
    const newIssues = data.issues.filter((iss) => iss.created_at && iss.created_at.slice(0, 10) >= sinceDate);
    if (newIssues.length > 5) {
      allIssueSpikes.push({ repo: repoStr, count: newIssues.length });
    }

    const openPRs = data.prs.filter((pr) => pr.state === 'open').length;
    const mergedPRs = data.prs.filter((pr) => pr.merged_at).length;
    const failedCount = failed.length;

    const highlights = [];
    highlights.push(`${data.prs.length} PRs, ${data.issues.length} issues, ${data.runs.length} CI runs`);
    if (blocked.length > 0) {
      highlights.push(`${blocked.length} PR(s) potentially blocked (open >5 days)`);
    }
    if (failedCount > 0) {
      highlights.push(`${failedCount} CI failure(s)`);
    }

    repoHighlights.push({
      repo: repoStr,
      openPRs,
      mergedPRs,
      highlights,
      topPRs: data.prs.slice(0, 5).map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login || pr.user?.name || 'unknown',
        state: pr.merged_at ? 'merged' : pr.state,
      })),
      topIssues: data.issues.slice(0, 5).map((iss) => ({
        number: iss.number,
        title: iss.title,
        labels: (iss.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
        state: iss.state,
      })),
      failedRuns: failed.map((r) => ({
        name: r.name || r.workflow?.name || 'unknown',
        branch: r.head_branch || '',
      })),
    });
  }

  // Generate rollup summary
  const summary = generateSummaryMarkdown(
    repoHighlights, allBlockedPRs, allFailedRuns, allIssueSpikes,
    sinceDate, todayDate, repos.length, totalPRs, totalIssues, totalRuns
  );

  const summaryDir = path.join(SIGNALS_DIR, 'github');
  fs.mkdirSync(summaryDir, { recursive: true });
  const summaryFile = path.join(summaryDir, `${todayDate}-summary.md`);
  fs.writeFileSync(summaryFile, summary, 'utf8');
  files.push(summaryFile);

  return {
    files,
    summary,
    counts: { repos: repos.length, issues: totalIssues, prs: totalPRs, runs: totalRuns },
  };
}

// ── Data fetching ───────────────────────────────────────────────────────────

async function fetchRepoData(config, repo, sinceDate) {
  const { owner, name: repoName } = parseRepo(repo);
  const base = `/repos/${owner}/${repoName}`;

  const [issuesRaw, prsRaw, runsRaw] = await Promise.all([
    apiGet(config, `${base}/issues`, { state: 'all', since: sinceDate, per_page: '100' }, owner),
    apiGet(config, `${base}/pulls`, { state: 'all', sort: 'updated', per_page: '100' }, owner),
    apiGet(config, `${base}/actions/runs`, { created: `>=${sinceDate}`, per_page: '100' }, owner),
  ]);

  // Filter issues: exclude pull requests (GitHub returns PRs in the issues endpoint)
  const issues = (issuesRaw || []).filter((item) => !item.pull_request);

  // Filter PRs by updated_at >= since
  const prs = (prsRaw || []).filter((pr) => {
    if (!pr.updated_at) return true;
    return pr.updated_at.slice(0, 10) >= sinceDate;
  });

  // Unwrap workflow_runs if needed (already handled in transport for simulation,
  // but the live API wraps in { workflow_runs: [...] })
  let runs = runsRaw || [];
  if (!Array.isArray(runs) && runs.workflow_runs) {
    runs = runs.workflow_runs;
  }

  return { issues, prs, runs };
}

// ── Markdown generation ─────────────────────────────────────────────────────

function generateRepoMarkdown(owner, repoName, data, sinceDate, todayDate, timestamp) {
  const lines = [];

  lines.push(`# ${owner}/${repoName} — GitHub Signals`);
  lines.push('');
  lines.push(`**Period:** ${sinceDate} to ${todayDate}  `);
  lines.push(`**Pulled:** ${timestamp}`);
  lines.push('');

  // Pull Requests
  lines.push('## Pull Requests');
  lines.push('');
  if (data.prs.length === 0) {
    lines.push('No pull request activity this period.');
  } else {
    lines.push('| # | Title | Author | State | Updated | Reviews |');
    lines.push('|---|-------|--------|-------|---------|---------|');
    for (const pr of data.prs) {
      const num = pr.number || '-';
      const title = (pr.title || '').replace(/\|/g, '\\|');
      const author = (pr.user && pr.user.login) || '-';
      const state = pr.merged_at ? 'merged' : (pr.state || '-');
      const updated = pr.updated_at ? pr.updated_at.slice(0, 10) : '-';
      const reviews = (pr.requested_reviewers && pr.requested_reviewers.length) || 0;
      lines.push(`| ${num} | ${title} | ${author} | ${state} | ${updated} | ${reviews} |`);
    }

    // Flag blocked PRs
    const blockedPRs = data.prs.filter((pr) => {
      return pr.state === 'open' && daysBetween(pr.created_at || todayDate, todayDate) > 5;
    });
    if (blockedPRs.length > 0) {
      lines.push('');
      for (const pr of blockedPRs) {
        const age = daysBetween(pr.created_at || todayDate, todayDate);
        lines.push(`> **Blocked:** PR #${pr.number} "${pr.title}" — open ${age} days, no reviews`);
      }
    }
  }
  lines.push('');

  // Issues
  lines.push('## Issues');
  lines.push('');
  if (data.issues.length === 0) {
    lines.push('No issue activity this period.');
  } else {
    lines.push('| # | Title | Labels | State | Created | Age |');
    lines.push('|---|-------|--------|-------|---------|-----|');
    for (const iss of data.issues) {
      const num = iss.number || '-';
      const title = (iss.title || '').replace(/\|/g, '\\|');
      const labels = (iss.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).join(', ') || '-';
      const state = iss.state || '-';
      const created = iss.created_at ? iss.created_at.slice(0, 10) : '-';
      const age = iss.created_at ? `${daysBetween(iss.created_at, todayDate)}d` : '-';
      lines.push(`| ${num} | ${title} | ${labels} | ${state} | ${created} | ${age} |`);
    }
  }
  lines.push('');

  // CI/CD
  lines.push('## CI/CD');
  lines.push('');
  if (data.runs.length === 0) {
    lines.push('No CI/CD activity this period.');
  } else {
    lines.push('| Run | Workflow | Branch | Status | Conclusion | Duration |');
    lines.push('|-----|----------|--------|--------|------------|----------|');
    for (const run of data.runs) {
      const id = run.id || '-';
      const workflow = run.name || '-';
      const branch = run.head_branch || '-';
      const status = run.status || '-';
      const conclusion = run.conclusion || '-';
      const duration = formatDuration(runDurationSeconds(run));
      lines.push(`| ${id} | ${workflow} | ${branch} | ${status} | ${conclusion} | ${duration} |`);
    }

    const failures = data.runs.filter((r) => r.conclusion === 'failure');
    const mainFailures = failures.filter((r) => r.head_branch === 'main' || r.head_branch === 'master');
    if (mainFailures.length > 0) {
      lines.push('');
      lines.push(`> **Failures:** ${mainFailures.length} run(s) failed on main this period`);
    } else if (failures.length > 0) {
      lines.push('');
      lines.push(`> **Failures:** ${failures.length} run(s) failed this period`);
    }
  }
  lines.push('');

  // Summary section
  const openPRs = data.prs.filter((pr) => pr.state === 'open').length;
  const mergedPRs = data.prs.filter((pr) => pr.merged_at).length;
  const noReviewPRs = data.prs.filter((pr) => {
    return pr.state === 'open' && (!pr.requested_reviewers || pr.requested_reviewers.length === 0);
  }).length;
  const newIssues = data.issues.filter((iss) => iss.created_at && iss.created_at.slice(0, 10) >= sinceDate).length;
  const closedIssues = data.issues.filter((iss) => iss.state === 'closed').length;
  const failedRuns = data.runs.filter((r) => r.conclusion === 'failure').length;
  const failRate = data.runs.length > 0 ? Math.round((failedRuns / data.runs.length) * 100) : 0;

  lines.push('## Summary');
  lines.push(`- ${openPRs} PRs open, ${mergedPRs} merged, ${noReviewPRs} with no reviews (potentially blocked)`);
  lines.push(`- ${newIssues} issues opened, ${closedIssues} closed`);
  lines.push(`- ${data.runs.length} CI runs, ${failedRuns} failures (${failRate}% failure rate)`);
  lines.push('');

  return lines.join('\n');
}

function generateSummaryMarkdown(
  repoHighlights, blockedPRs, failedRuns, issueSpikes,
  sinceDate, todayDate, repoCount, totalPRs, totalIssues, totalRuns
) {
  const lines = [];

  lines.push('# GitHub Signals — Summary');
  lines.push('');
  lines.push(`**Period:** ${sinceDate} to ${todayDate}  `);
  lines.push(`**Repos:** ${repoCount}`);
  lines.push('');

  // Per-Repo Highlights
  lines.push('## Per-Repo Highlights');
  lines.push('');
  for (const rh of repoHighlights) {
    lines.push(`### ${rh.repo}`);
    for (const h of rh.highlights) {
      lines.push(`- ${h}`);
    }
    if (rh.topPRs && rh.topPRs.length > 0) {
      const prItems = rh.topPRs.map((pr) => `#${pr.number} "${pr.title}" (${pr.author}, ${pr.state})`);
      lines.push(`**PRs:** ${prItems.join(' | ')}`);
    }
    if (rh.topIssues && rh.topIssues.length > 0) {
      const issueItems = rh.topIssues.map((iss) => {
        const labels = iss.labels && iss.labels.length > 0 ? ` [${iss.labels.join(', ')}]` : '';
        return `#${iss.number} "${iss.title}"${labels} (${iss.state})`;
      });
      lines.push(`**Issues:** ${issueItems.join(' | ')}`);
    }
    if (rh.failedRuns && rh.failedRuns.length > 0) {
      const runItems = rh.failedRuns.map((r) => `${r.name}${r.branch ? ' (' + r.branch + ')' : ''}`);
      lines.push(`**Failed CI:** ${runItems.join(' | ')}`);
    }
    lines.push('');
  }

  // Cross-Repo Patterns
  lines.push('## Cross-Repo Patterns');
  lines.push('');

  if (blockedPRs.length > 0) {
    lines.push('**PRs blocked across repos:**');
    for (const { repo, pr } of blockedPRs) {
      lines.push(`- ${repo}#${pr.number}: "${pr.title}"`);
    }
  } else {
    lines.push('- No blocked PRs detected');
  }
  lines.push('');

  if (failedRuns.length > 0) {
    lines.push('**CI failure trends:**');
    const byRepo = {};
    for (const { repo, run } of failedRuns) {
      byRepo[repo] = (byRepo[repo] || 0) + 1;
    }
    for (const [repo, count] of Object.entries(byRepo)) {
      lines.push(`- ${repo}: ${count} failure(s)`);
    }
  } else {
    lines.push('- No CI failures detected');
  }
  lines.push('');

  if (issueSpikes.length > 0) {
    lines.push('**Issue spikes:**');
    for (const { repo, count } of issueSpikes) {
      lines.push(`- ${repo}: ${count} new issues`);
    }
  } else {
    lines.push('- No issue spikes detected');
  }
  lines.push('');

  // Aggregated summary
  const totalFailures = failedRuns.length;
  const failRate = totalRuns > 0 ? Math.round((totalFailures / totalRuns) * 100) : 0;

  lines.push('## Summary');
  lines.push(`- ${totalPRs} PRs across ${repoCount} repos`);
  lines.push(`- ${totalIssues} issues across ${repoCount} repos`);
  lines.push(`- ${totalRuns} CI runs, ${totalFailures} failures (${failRate}% failure rate)`);
  if (blockedPRs.length > 0) {
    lines.push(`- ${blockedPRs.length} PR(s) potentially blocked across repos`);
  }
  lines.push('');

  return lines.join('\n');
}

// ── Repo management ─────────────────────────────────────────────────────────

function addRepo(owner, repo) {
  if (!owner || !repo) {
    throw new Error('Both owner and repo are required.');
  }
  const full = `${owner}/${repo}`;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(full)) {
    throw new Error(`Invalid repo format: "${full}". Expected owner/repo.`);
  }

  const config = readConfig();
  if (!config.github) {
    throw new Error('GitHub connector not configured. Run configure() first.');
  }
  if (!Array.isArray(config.github.repos)) {
    config.github.repos = [];
  }
  const exists = config.github.repos.some((r) => {
    const { owner: o, name: n } = parseRepo(r);
    return o === owner && n === repo;
  });
  if (exists) {
    return false; // already present
  }
  config.github.repos.push({ owner, repo });
  writeConfig(config);
  return true;
}

function removeRepo(owner, repo) {
  if (!owner || !repo) {
    throw new Error('Both owner and repo are required.');
  }

  const config = readConfig();
  if (!config.github || !Array.isArray(config.github.repos)) {
    throw new Error('GitHub connector not configured. Run configure() first.');
  }
  const before = config.github.repos.length;
  config.github.repos = config.github.repos.filter((r) => {
    const { owner: o, name: n } = parseRepo(r);
    return !(o === owner && n === repo);
  });
  if (config.github.repos.length === before) {
    return false; // not found
  }
  writeConfig(config);
  return true;
}

// ── Summarize ───────────────────────────────────────────────────────────────

function summarize(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/## Summary\n([\s\S]*?)(?:\n## |\n$|$)/);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

module.exports = {
  configure,
  pull,
  addRepo,
  removeRepo,
  summarize,
};
