#!/usr/bin/env node

const { spawnSync, spawn: spawnChild } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const readline = require('readline');

const HOME = process.env.HOME || process.env.USERPROFILE;
if (!HOME) {
  console.error('Error: HOME environment variable is not set.');
  process.exit(1);
}

const WAYFIND_DIR = process.env.WAYFIND_DIR || path.join(HOME, '.claude', 'team-context');

const EFFECTIVE_DIR = WAYFIND_DIR;

// Auto-load .env from config dir BEFORE requiring modules
// (modules like content-store read env vars at load time)
const ENV_FILE = path.join(EFFECTIVE_DIR, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const connectors = require('./connectors');
const digest = require('./digest');
const slack = require('./slack');
const slackBot = require('./slack-bot');
const contentStore = require('./content-store');
const rebuildStatus = require('./rebuild-status');
const telemetry = require('./telemetry');

process.on('beforeExit', async () => { await telemetry.flush(); });

const ROOT = path.join(__dirname, '..');
const DEFAULT_PERSONAS_PATH = path.join(ROOT, 'templates', 'personas.json');

const CLI_USER = process.env.TEAM_CONTEXT_AUTHOR || 'system';
const TEAM_FILE = path.join(WAYFIND_DIR, 'team.json');
const PROFILE_FILE = path.join(WAYFIND_DIR, 'profile.json');
const CONNECTORS_FILE = path.join(WAYFIND_DIR, 'connectors.json');

// ── Persona config resolution ────────────────────────────────────────────────
// User config lives at ~/.claude/team-context/personas.json (Claude Code) or
// ~/.ai-memory/team-context/personas.json (Cursor/generic). Falls back to the
// bundled default in templates/personas.json.

function getPersonasConfigPath() {
  const candidates = [
    path.join(HOME, '.claude', 'team-context', 'personas.json'),
    path.join(HOME, '.ai-memory', 'team-context', 'personas.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getPersonasPath() {
  return getPersonasConfigPath() || DEFAULT_PERSONAS_PATH;
}

function readPersonas() {
  const configPath = getPersonasPath();
  const data = readJSONFile(configPath);
  if (!data) {
    console.error(`Error reading personas config: ${configPath}`);
    process.exit(1);
  }
  return data;
}

function writePersonas(configPath, data) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function ensureUserConfig() {
  const existing = getPersonasConfigPath();
  if (existing) return existing;
  // Copy default to the first candidate location
  const dest = path.join(HOME, '.claude', 'team-context', 'personas.json');
  const data = JSON.parse(fs.readFileSync(DEFAULT_PERSONAS_PATH, 'utf8'));
  writePersonas(dest, data);
  return dest;
}

// ── Personas command ─────────────────────────────────────────────────────────

function runPersonas(args) {
  if (args.includes('--reset')) {
    const dest = ensureUserConfig();
    const defaults = JSON.parse(fs.readFileSync(DEFAULT_PERSONAS_PATH, 'utf8'));
    writePersonas(dest, defaults);
    console.log(`Personas reset to defaults (${defaults.personas.length} personas).`);
    console.log(`Config: ${dest}`);
    return;
  }

  const addIdx = args.indexOf('--add');
  if (addIdx !== -1) {
    const id = args[addIdx + 1];
    const name = args[addIdx + 2];
    if (!id || !name) {
      console.error('Usage: wayfind personas --add <id> <name> [description]');
      process.exit(1);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      console.error(`Invalid persona ID "${id}". Use lowercase letters, numbers, and hyphens (must start with a letter).`);
      process.exit(1);
    }
    const description = args.slice(addIdx + 3).join(' ') || `${name} perspective`;
    const configPath = ensureUserConfig();
    const data = readPersonas();
    if (data.personas.some((p) => p.id === id)) {
      console.error(`Persona with id "${id}" already exists.`);
      process.exit(1);
    }
    data.personas.push({ id, name, description, autopilot: true });
    writePersonas(configPath, data);
    console.log(`Added persona: ${name} (${id})`);
    console.log(`Config: ${configPath}`);
    return;
  }

  const removeIdx = args.indexOf('--remove');
  if (removeIdx !== -1) {
    const id = args[removeIdx + 1];
    if (!id) {
      console.error('Usage: wayfind personas --remove <id>');
      process.exit(1);
    }
    const configPath = ensureUserConfig();
    const data = readPersonas();
    const before = data.personas.length;
    data.personas = data.personas.filter((p) => p.id !== id);
    if (data.personas.length === before) {
      console.error(`No persona found with id "${id}".`);
      process.exit(1);
    }
    writePersonas(configPath, data);
    console.log(`Removed persona: ${id}`);
    console.log(`Config: ${configPath}`);
    return;
  }

  // Default: list personas
  const data = readPersonas();
  const configPath = getPersonasPath();
  const isDefault = configPath === DEFAULT_PERSONAS_PATH;
  console.log('');
  console.log(`Personas${isDefault ? ' (defaults — no user config yet)' : ''}:`);
  console.log('');
  for (const p of data.personas) {
    console.log(`  ${p.id.padEnd(16)} ${p.name.padEnd(14)} ${p.description}`);
  }
  console.log('');
  console.log(`Config: ${configPath}`);
  if (isDefault) {
    console.log('Run "wayfind personas --add" or "wayfind personas --reset" to create a user config.');
  }
  console.log('');
}

// ── Autopilot command ────────────────────────────────────────────────────────

function autopilotStatus() {
  const data = readPersonas();
  const profile = readJSONFile(PROFILE_FILE);
  const claimed = (profile && Array.isArray(profile.personas)) ? profile.personas : [];
  const userName = (profile && profile.name) || null;

  console.log('');
  console.log('Persona          Status');
  console.log('\u2500'.repeat(37));

  for (const persona of data.personas) {
    const isClaimed = claimed.includes(persona.id);
    let status;
    if (isClaimed) {
      status = userName ? `${userName} (you)` : 'You';
    } else if (persona.autopilot) {
      status = 'Autopilot';
    } else {
      status = 'Unfilled';
    }
    console.log(`${persona.name.padEnd(17)}${status}`);
  }
  console.log('');
}

function autopilotEnable(personaId) {
  const configPath = ensureUserConfig();
  const data = readPersonas();
  const persona = data.personas.find((p) => p.id === personaId);
  if (!persona) {
    console.error(`Unknown persona: ${personaId}`);
    console.error(`Available personas: ${data.personas.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }
  if (persona.autopilot) {
    console.log(`Autopilot is already enabled for ${persona.name}.`);
    return;
  }
  persona.autopilot = true;
  writePersonas(configPath, data);
  console.log(`Autopilot enabled for ${persona.name}.`);
}

function autopilotDisable(personaId) {
  const configPath = ensureUserConfig();
  const data = readPersonas();
  const persona = data.personas.find((p) => p.id === personaId);
  if (!persona) {
    console.error(`Unknown persona: ${personaId}`);
    console.error(`Available personas: ${data.personas.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }
  if (!persona.autopilot) {
    console.log(`Autopilot is already disabled for ${persona.name}.`);
    return;
  }
  persona.autopilot = false;
  writePersonas(configPath, data);
  console.log(`Autopilot disabled for ${persona.name}. Persona is now unfilled.`);
}

function runAutopilot(args) {
  const sub = args[0] || 'status';
  if (sub === 'status') {
    autopilotStatus();
  } else if (sub === 'enable') {
    if (!args[1]) {
      console.error('Usage: wayfind autopilot enable <persona-id>');
      process.exit(1);
    }
    autopilotEnable(args[1]);
  } else if (sub === 'disable') {
    if (!args[1]) {
      console.error('Usage: wayfind autopilot disable <persona-id>');
      process.exit(1);
    }
    autopilotDisable(args[1]);
  } else {
    console.error(`Unknown autopilot subcommand: ${sub}`);
    console.error('Usage: wayfind autopilot [status|enable|disable] [persona-id]');
    process.exit(1);
  }
}

// ── JSON file helpers ────────────────────────────────────────────────────────

function ensureWayfindDir() {
  if (!fs.existsSync(WAYFIND_DIR)) {
    fs.mkdirSync(WAYFIND_DIR, { recursive: true });
  }
}

function readJSONFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSONFile(filePath, data) {
  ensureWayfindDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function generateTeamId() {
  return crypto.randomBytes(4).toString('hex');
}

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

// ── Team command ────────────────────────────────────────────────────────────

async function teamCreate() {
  const name = await ask('Team name: ');
  if (!name) {
    console.error('Error: team name is required.');
    process.exit(1);
  }

  const id = generateTeamId();
  const personasData = readPersonas();
  const team = {
    name,
    id,
    created: new Date().toISOString(),
    personas: personasData.personas.map((p) => p.id),
  };

  writeJSONFile(TEAM_FILE, team);
  telemetry.capture('team_created', { member_count: 1 }, CLI_USER);
  console.log('');
  console.log(`Team '${name}' created.`);
  console.log(`Share your team ID with teammates: ${id}`);
  console.log('');
  console.log('Teammates can join with:');
  console.log(`  wayfind team join ${id}`);
  console.log('');
}

async function teamJoin(args) {
  const input = args[0];
  if (!input) {
    console.error('Error: repo URL or path is required.');
    console.error('Usage: wayfind team join <repo-url-or-path>');
    console.error('Example: wayfind team join https://github.com/acme/team-context');
    process.exit(1);
  }

  // Determine if input is a URL to clone or a local path
  const isUrl = /^https?:\/\/|^git@|^github\.com\//.test(input);
  let repoPath;

  if (isUrl) {
    // Parse org/repo from URL for clone destination suggestion
    const urlMatch = input.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (!urlMatch) {
      console.error(`Could not parse org/repo from URL: ${input}`);
      process.exit(1);
    }
    const [, org, repo] = urlMatch;
    const orgDir = path.join(HOME, 'repos', org);
    const suggested = fs.existsSync(orgDir)
      ? path.join(orgDir, repo)
      : path.join(HOME, '.claude', 'team-context', repo);

    let dest = suggested;
    if (fs.existsSync(suggested)) {
      console.log(`\nRepo already cloned at: ${suggested}`);
      const useExisting = await ask(`Use existing clone? [Y/n]: `);
      if (useExisting.toLowerCase() === 'n') {
        const custom = await ask(`Clone to [${suggested}]: `);
        dest = custom ? path.resolve(custom.replace(/^~/, HOME)) : suggested;
      }
    } else {
      const confirm = await ask(`\nClone to ${suggested}? [Y/n]: `);
      if (confirm.toLowerCase() === 'n') {
        const custom = await ask(`Clone to: `);
        if (!custom) { console.error('Destination required.'); process.exit(1); }
        dest = path.resolve(custom.replace(/^~/, HOME));
      }
      console.log(`Cloning ${input}...`);
      const cloneUrl = /^https?:\/\//.test(input) ? input : `https://${input}`;
      const result = spawnSync('git', ['clone', cloneUrl, dest], { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error('Clone failed.');
        process.exit(1);
      }
    }
    repoPath = dest;
  } else {
    repoPath = path.resolve(input.replace(/^~/, HOME));
    if (!fs.existsSync(repoPath)) {
      console.error(`Directory not found: ${repoPath}`);
      process.exit(1);
    }
  }

  // Read wayfind.json from the repo
  const sharedConfig = readJSONFile(path.join(repoPath, 'wayfind.json')) || {};
  const teamId = sharedConfig.team_id;
  if (!teamId) {
    console.error('');
    console.error(`Error: wayfind.json in that repo has no team_id.`);
    console.error('Ask your team admin to run:');
    console.error(`  wayfind context add <team-id> ${repoPath}`);
    process.exit(1);
  }
  const teamName = sharedConfig.team_name || teamId;
  const containerEndpoint = sharedConfig.container_endpoint || null;

  // Register in local context.json
  const config = readContextConfig();
  if (!config.teams) config.teams = {};
  const existing = config.teams[teamId];
  config.teams[teamId] = {
    path: repoPath,
    name: teamName,
    configured_at: new Date().toISOString(),
    ...(containerEndpoint ? { container_endpoint: containerEndpoint } : {}),
    ...(existing && existing.bound_repos ? { bound_repos: existing.bound_repos } : {}),
  };
  if (!config.default) config.default = teamId;
  writeContextConfig(config);

  // Check API key status
  const keyFile = path.join(repoPath, '.wayfind-api-key');
  const keyReady = fs.existsSync(keyFile) && (() => {
    try { return fs.readFileSync(keyFile, 'utf8').trim().length >= 32; } catch { return false; }
  })();

  // Print confirmation
  console.log('');
  console.log(`Joined team '${teamName}' (${teamId})`);
  console.log(`  Repo:             ${repoPath}`);
  if (containerEndpoint) {
    console.log(`  Semantic search:  available  |  ${containerEndpoint}`);
  } else {
    console.log(`  Semantic search:  not configured`);
    console.log(`                    Ask your team admin: wayfind deploy set-endpoint <url> --team ${teamId}`);
  }
  if (keyReady) {
    console.log(`  Search API key:   ready — rotates daily, committed to team repo`);
  } else {
    console.log(`  Search API key:   pending — will appear after the container's first key rotation`);
    console.log(`                    Run \`git pull\` in ${repoPath} after the container starts`);
  }
  console.log('');
  console.log('How the search key works:');
  console.log('  The container rotates this key every 24 hours and commits it to the team repo.');
  console.log('  Your Claude Code sessions read the latest key automatically from the cloned repo.');
  console.log('  You never need to manage it — just keep the repo up to date (git pull).');
  console.log('');
  console.log('Next: bind your repos to this team with:');
  console.log(`  wayfind context bind ${teamId}   (run from each repo you work in)`);

  if (existing) {
    console.log('');
    console.log(`  (Updated existing registration for team ${teamId})`);
  }

  // Register profile in team directory
  const profile = readJSONFile(PROFILE_FILE);
  if (profile) {
    syncMemberToRegistry(profile, teamId);
    await announceToSlack(profile, teamId);
  } else {
    console.log('');
    console.log("Run 'wayfind whoami --setup' to register your profile in the team directory.");
  }
  console.log('');
}

function teamStatus() {
  const team = readJSONFile(TEAM_FILE);
  if (!team) {
    console.log('');
    console.log("No team configured. Run 'wayfind team create' or 'wayfind team join <id>'");
    console.log('');
    return;
  }

  console.log('');
  if (team.name) {
    console.log(`Team: ${team.name}`);
    console.log(`ID: ${team.id}`);
    console.log(`Created: ${team.created}`);
    if (team.personas && team.personas.length > 0) {
      console.log(`Personas: ${team.personas.join(', ')}`);
    }
  } else if (team.teamId) {
    console.log(`Joined team: ${team.teamId}`);
    console.log(`Joined: ${team.joined}`);
  }

  // Show member roster from team-context repo
  const repoPath = getTeamContextPath();
  if (!repoPath) {
    console.log('');
    console.log("(Run 'wayfind context init' to see team members)");
  } else {
    // Pull latest so we see all members, not just local state
    try {
      const { execSync } = require('child_process');
      execSync(`git -C "${repoPath}" pull --rebase 2>/dev/null`, { stdio: 'pipe' });
    } catch { /* offline is fine — show what we have */ }
    const membersDir = path.join(repoPath, 'members');
    if (!fs.existsSync(membersDir)) {
      console.log('');
      console.log('No members registered yet.');
    } else {
      const files = fs.readdirSync(membersDir).filter((f) => f.endsWith('.json'));
      if (files.length === 0) {
        console.log('');
        console.log('No members registered yet.');
      } else {
        console.log('');
        console.log('Members:');
        for (const file of files) {
          const member = readJSONFile(path.join(membersDir, file));
          if (!member) continue;
          const name = (member.name || '').padEnd(24);
          const personas = Array.isArray(member.personas)
            ? member.personas.join(', ')
            : '';
          const joined = member.joined
            ? member.joined.slice(0, 10)
            : '';
          const slackIndicator = member.slack_user_id ? ' [Slack]' : '';
          console.log(`  ${name}${personas.padEnd(24)}joined ${joined}${slackIndicator}`);
        }
      }
    }
  }
  console.log('');
}

async function runTeam(args) {
  const sub = args[0] || 'status';
  const subArgs = args.slice(1);

  switch (sub) {
    case 'create':
      await teamCreate();
      break;
    case 'join':
      await teamJoin(subArgs);
      break;
    case 'status':
      teamStatus();
      break;
    default:
      console.error(`Unknown team subcommand: ${sub}`);
      console.error('Available: create, join, status');
      process.exit(1);
  }
}

// ── Whoami command ──────────────────────────────────────────────────────────

async function whoamiSetup() {
  const name = await ask('Display name: ');
  if (!name) {
    console.error('Error: display name is required.');
    process.exit(1);
  }

  const personasData = readPersonas();
  console.log('');
  console.log('Available personas:');
  for (const p of personasData.personas) {
    console.log(`  ${p.id.padEnd(14)} ${p.description}`);
  }
  console.log('');

  const selection = await ask('Select personas (comma-separated IDs, e.g. engineering,product): ');
  const selectedIds = selection
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const validIds = personasData.personas.map((p) => p.id);
  const invalid = selectedIds.filter((id) => !validIds.includes(id));
  if (invalid.length > 0) {
    console.error(`Unknown persona(s): ${invalid.join(', ')}`);
    console.error(`Valid options: ${validIds.join(', ')}`);
    process.exit(1);
  }

  if (selectedIds.length === 0) {
    console.error('Error: at least one persona is required.');
    process.exit(1);
  }

  console.log('');
  console.log('Your Slack user ID lets the bot @mention you in digests and send you direct messages.');
  console.log('To find it: open your Slack profile → click ⋯ → "Copy member ID".');
  const slackUserId = await ask('Slack user ID (or leave blank to skip): ');

  const profile = {
    name,
    personas: selectedIds,
    created: new Date().toISOString(),
  };
  if (slackUserId) {
    profile.slack_user_id = slackUserId.trim();
  }

  writeJSONFile(PROFILE_FILE, profile);
  console.log('');
  console.log(`Profile created: ${name}`);
  console.log(`Active personas: ${selectedIds.join(', ')}`);

  const team = readJSONFile(TEAM_FILE);
  if (team) {
    console.log(`Team: ${team.name || team.teamId}`);
    const teamId = team.id || team.teamId;
    syncMemberToRegistry(profile, teamId);
    await announceToSlack(profile, teamId);
  }
  console.log('');
}

function whoamiShow() {
  const profile = readJSONFile(PROFILE_FILE);
  if (!profile) {
    console.log('');
    console.log("No profile configured. Run 'wayfind whoami --setup' to create one.");
    console.log('');
    return;
  }

  console.log('');
  console.log(`Name: ${profile.name}`);
  const personas = Array.isArray(profile.personas) ? profile.personas : [];
  console.log(`Personas: ${personas.join(', ')}`);
  console.log(`Created: ${profile.created}`);
  if (profile.slack_user_id) {
    console.log(`Slack user ID: ${profile.slack_user_id}`);
  }

  const team = readJSONFile(TEAM_FILE);
  if (team) {
    console.log(`Team: ${team.name || team.teamId}`);
  } else {
    console.log('Team: (none)');
  }
  console.log('');
}

async function runWhoami(args) {
  if (args.includes('--setup')) {
    await whoamiSetup();
  } else {
    whoamiShow();
  }
}

// ── Signal channels (pull / signals) ────────────────────────────────────────

function readConnectorsConfig() {
  return readJSONFile(CONNECTORS_FILE) || {};
}

function writeConnectorsConfig(config) {
  ensureWayfindDir();
  // Restrict permissions — file may contain API tokens
  fs.writeFileSync(CONNECTORS_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Map connector configs to env var names for the deploy .env.
 * Each entry: { envKey: 'ENV_VAR_NAME', configField: 'field_in_channelConfig' }
 */
const CONNECTOR_ENV_MAP = {
  intercom: [
    { envKey: 'INTERCOM_TOKEN', configField: 'token' },
  ],
  github: [
    { envKey: 'GITHUB_TOKEN', configField: 'token', configFieldAlt: 'token_env', resolveEnv: true },
  ],
};

/**
 * After configuring a connector locally, sync its secrets to the deploy .env
 * so the container picks them up on restart. No-op if no deploy dir exists.
 */
function syncConnectorToDeployEnv(channel, channelConfig) {
  const mapping = CONNECTOR_ENV_MAP[channel];
  if (!mapping) return;

  // Find deploy .env: check team context repo first, then cwd/deploy
  const candidates = [];
  const teamCtxPath = getTeamContextPath();
  if (teamCtxPath) {
    candidates.push(path.join(teamCtxPath, 'deploy', '.env'));
  }
  candidates.push(path.join(process.cwd(), 'deploy', '.env'));

  let envFile = null;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      envFile = candidate;
      break;
    }
  }
  if (!envFile) return;

  let envContent = fs.readFileSync(envFile, 'utf8');
  let updated = false;

  for (const { envKey, configField, configFieldAlt, resolveEnv } of mapping) {
    let value = channelConfig[configField] || '';
    if (!value && resolveEnv && configFieldAlt && channelConfig[configFieldAlt]) {
      value = process.env[channelConfig[configFieldAlt]] || '';
    }
    if (!value) continue;

    const lines = envContent.split('\n');
    const idx = lines.findIndex((l) => l.startsWith(`${envKey}=`));
    if (idx !== -1) {
      lines[idx] = `${envKey}=${value}`;
    } else {
      lines.push(`${envKey}=${value}`);
    }
    envContent = lines.join('\n');
    updated = true;
  }

  if (updated) {
    fs.writeFileSync(envFile, envContent, { mode: 0o600 });
    console.log(`Deploy .env updated: ${envFile}`);
  }
}

function getSinceDate(args) {
  const sinceIdx = args.indexOf('--since');
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    const val = args[sinceIdx + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      console.error(`Invalid date format: "${val}". Expected YYYY-MM-DD.`);
      process.exit(1);
    }
    return val;
  }
  // Default: yesterday
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function printPullResult(channel, result) {
  console.log('');
  if (channel === 'intercom') {
    console.log(`  ${channel}:`);
    console.log(`    Conversations: ${result.counts.conversations}`);
    console.log(`    Open:          ${result.counts.open}`);
    console.log(`    Tags:          ${result.counts.tags}`);
  } else if (channel === 'notion') {
    console.log(`  ${channel}:`);
    console.log(`    Pages:            ${result.counts.pages}`);
    console.log(`    Database entries: ${result.counts.database_entries}`);
    console.log(`    Comments:         ${result.counts.comments}`);
  } else {
    console.log(`  ${channel}: ${result.counts.repos} repo(s)`);
    console.log(`    Issues:  ${result.counts.issues}`);
    console.log(`    PRs:     ${result.counts.prs}`);
    console.log(`    CI runs: ${result.counts.runs}`);
  }
  console.log('');
  console.log('  Files written:');
  for (const f of result.files) {
    console.log(`    ${f}`);
  }
  console.log('');
}

async function runPull(args) {
  // --all: pull all configured channels
  if (args.includes('--all')) {
    const config = readConnectorsConfig();
    const channels = Object.keys(config).filter((k) => connectors.get(k));
    if (channels.length === 0) {
      console.log('No channels configured. Run "wayfind pull <channel> --configure" first.');
      return;
    }
    const since = getSinceDate(args);
    for (const name of channels) {
      const connector = connectors.get(name);
      if (!connector) {
        console.log(`Warning: unknown connector "${name}", skipping.`);
        continue;
      }
      console.log(`\nPulling ${name}...`);
      const result = await connector.pull(config[name], since);
      // Update last_pull — re-read config fresh to avoid stale overwrites
      const freshConfig = readConnectorsConfig();
      freshConfig[name].last_pull = new Date().toISOString();
      writeConnectorsConfig(freshConfig);
      printPullResult(name, result);
    }
    // Auto-index signals into content store after pull
    try {
      console.log('\nIndexing signals...');
      const signalStats = await contentStore.indexSignals({ embeddings: false });
      console.log(`  ${signalStats.newEntries} new, ${signalStats.updatedEntries} updated, ${signalStats.skippedEntries} unchanged`);
    } catch (err) {
      console.log(`  Signal indexing skipped: ${err.message}`);
    }
    return;
  }

  const channel = args[0];
  if (!channel) {
    console.error('Usage: wayfind pull <channel> [--since YYYY-MM-DD] [--configure]');
    console.error('       wayfind pull --all');
    console.error(`Available channels: ${connectors.list().join(', ')}`);
    process.exit(1);
  }

  const connector = connectors.get(channel);
  if (!connector) {
    console.error(`Unknown channel: ${channel}`);
    console.error(`Available channels: ${connectors.list().join(', ')}`);
    process.exit(1);
  }

  const channelArgs = args.slice(1);

  // --configure
  if (channelArgs.includes('--configure')) {
    const channelConfig = await connector.configure();
    const config = readConnectorsConfig();
    config[channel] = channelConfig;
    writeConnectorsConfig(config);
    syncConnectorToDeployEnv(channel, channelConfig);
    console.log(`\n${channel} configured successfully.`);
    return;
  }

  // --add-repo
  const addIdx = channelArgs.indexOf('--add-repo');
  if (addIdx !== -1) {
    const repoArg = channelArgs[addIdx + 1];
    if (!repoArg || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoArg)) {
      console.error(`Usage: wayfind pull ${channel} --add-repo owner/repo`);
      process.exit(1);
    }
    const [owner, repo] = repoArg.split('/');
    const config = readConnectorsConfig();
    if (!config[channel]) {
      console.error(`${channel} is not configured. Run "wayfind pull ${channel} --configure" first.`);
      process.exit(1);
    }
    config[channel].repos = config[channel].repos || [];
    const exists = config[channel].repos.some(r => {
      if (typeof r === 'string') return r === repoArg;
      return r.owner === owner && (r.repo === repo || r.name === repo);
    });
    if (exists) {
      console.log(`${owner}/${repo} is already configured.`);
      return;
    }
    config[channel].repos.push({ owner, repo });
    writeConnectorsConfig(config);
    console.log(`Added ${owner}/${repo} to ${channel}.`);
    return;
  }

  // --remove-repo
  const removeIdx = channelArgs.indexOf('--remove-repo');
  if (removeIdx !== -1) {
    const repoArg = channelArgs[removeIdx + 1];
    if (!repoArg || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoArg)) {
      console.error(`Usage: wayfind pull ${channel} --remove-repo owner/repo`);
      process.exit(1);
    }
    const [owner, repo] = repoArg.split('/');
    const config = readConnectorsConfig();
    if (!config[channel] || !config[channel].repos) {
      console.error(`${channel} is not configured.`);
      process.exit(1);
    }
    const before = config[channel].repos.length;
    config[channel].repos = config[channel].repos.filter(r => {
      if (typeof r === 'string') return r !== repoArg;
      return !(r.owner === owner && (r.repo === repo || r.name === repo));
    });
    if (config[channel].repos.length === before) {
      console.error(`${owner}/${repo} not found in ${channel} config.`);
      process.exit(1);
    }
    writeConnectorsConfig(config);
    console.log(`Removed ${owner}/${repo} from ${channel}.`);
    return;
  }

  // Default: pull
  let config = readConnectorsConfig();
  if (!config[channel]) {
    console.log(`${channel} is not configured. Starting configuration...`);
    console.log('');
    const channelConfig = await connector.configure();
    config[channel] = channelConfig;
    writeConnectorsConfig(config);
    config = readConnectorsConfig();
  }

  const since = getSinceDate(channelArgs);
  console.log(`Pulling ${channel} signals since ${since}...`);
  const result = await connector.pull(config[channel], since);

  // Update last_pull — re-read fresh to avoid stale overwrites
  const freshConfig = readConnectorsConfig();
  freshConfig[channel].last_pull = new Date().toISOString();
  writeConnectorsConfig(freshConfig);

  printPullResult(channel, result);

  // Auto-index signals into content store after pull
  try {
    const signalStats = await contentStore.indexSignals({ embeddings: false });
    console.log(`\nSignals indexed: ${signalStats.newEntries} new, ${signalStats.updatedEntries} updated`);
  } catch (err) {
    console.log(`Signal indexing skipped: ${err.message}`);
  }
}

function runSignals() {
  const config = readConnectorsConfig();
  const channels = Object.keys(config);

  console.log('');
  if (channels.length === 0) {
    console.log('No signal channels configured.');
    console.log('');
    console.log('Available channels:');
    for (const name of connectors.list()) {
      console.log(`  ${name}`);
    }
    console.log('');
    console.log('Configure a channel:');
    console.log('  wayfind pull <channel> --configure');
    console.log('');
    return;
  }

  console.log('Signal Channels:');
  console.log('');
  for (const name of channels) {
    const ch = config[name];
    const lastPull = ch.last_pull ? new Date(ch.last_pull).toLocaleString() : 'never';
    const transport = ch.transport || 'unknown';
    if (ch.repos) {
      const repoCount = ch.repos.length || 0;
      console.log(`  ${name.padEnd(12)} ${repoCount} repo(s)  transport: ${transport}  last pull: ${lastPull}`);
    } else {
      const tagInfo = ch.tag_filter ? `tags: ${ch.tag_filter.join(', ')}` : 'all conversations';
      console.log(`  ${name.padEnd(12)} ${tagInfo}  transport: ${transport}  last pull: ${lastPull}`);
    }
  }
  console.log('');

  // Show unconfigured available channels
  const available = connectors.list().filter(n => !channels.includes(n));
  if (available.length > 0) {
    console.log('Available (not configured):');
    for (const name of available) {
      console.log(`  ${name}`);
    }
    console.log('');
  }
}

// ── Digest command ──────────────────────────────────────────────────────────

async function runDigest(args) {
  // --configure
  if (args.includes('--configure')) {
    const digestConfig = await digest.configure();
    const config = readConnectorsConfig();
    config.digest = digestConfig;
    writeConnectorsConfig(config);
    syncWebhookToTeamContext(digestConfig);
    console.log('\nDigest configured successfully.');
    return;
  }

  // scores subcommand
  if (args.includes('scores') || args.includes('--scores')) {
    const config = readConnectorsConfig();
    const storePath = (config.digest && config.digest.store_path) || undefined;
    const feedback = contentStore.getDigestFeedback({ storePath, limit: 20 });
    if (feedback.length === 0) {
      console.log('No digest feedback yet. Reactions on digest messages will appear here.');
      return;
    }
    console.log('Digest Feedback\n');
    for (const d of feedback) {
      const reactions = Object.entries(d.reactions)
        .map(([emoji, count]) => `:${emoji}: \u00d7 ${count}`)
        .join('  ');
      console.log(`  ${d.date} (${d.persona}): ${reactions || 'no reactions'} \u2014 total: ${d.totalReactions}`);
      if (d.comments.length > 0) {
        for (const c of d.comments) {
          console.log(`    \u2192 "${c.text}"`);
        }
      }
    }
    return;
  }

  // Read digest config
  const config = readConnectorsConfig();
  if (!config.digest) {
    console.log('Digest is not configured. Starting configuration...');
    console.log('');
    const digestConfig = await digest.configure();
    config.digest = digestConfig;
    writeConnectorsConfig(config);
    syncWebhookToTeamContext(digestConfig);
  }

  // Parse flags
  const personaIdx = args.indexOf('--persona');
  const sinceIdx = args.indexOf('--since');
  const deliver = args.includes('--deliver');
  const preview = args.includes('--preview');

  // Determine personas
  let personaIds;
  if (personaIdx !== -1 && args[personaIdx + 1]) {
    const val = args[personaIdx + 1];
    if (val.startsWith('--')) {
      console.error(`Invalid persona: "${val}". Did you forget the persona name after --persona?`);
      process.exit(1);
    }
    personaIds = [val];
  } else {
    personaIds = (config.digest.slack && config.digest.slack.default_personas)
      || ['unified'];
  }

  // Determine since date
  let sinceDate;
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    sinceDate = args[sinceIdx + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
      console.error(`Invalid date format: "${sinceDate}". Expected YYYY-MM-DD.`);
      process.exit(1);
    }
  } else {
    const d = new Date();
    d.setDate(d.getDate() - (config.digest.lookback_days || 7));
    sinceDate = d.toISOString().split('T')[0];
  }

  // Check API key is available before generating (skip in simulation mode)
  const apiKeyEnv = config.digest.llm && config.digest.llm.api_key_env;
  if (apiKeyEnv && !process.env[apiKeyEnv] && process.env.TEAM_CONTEXT_SIMULATE !== '1') {
    console.error(`Error: ${apiKeyEnv} is not set.`);
    console.error('');
    console.error('Fix: run "wayfind digest --configure" to save your API key,');
    console.error(`or set ${apiKeyEnv} in your shell environment.`);
    process.exit(1);
  }

  // Sanitize configured paths — connectors.json may have been written from inside a container
  // with paths like /home/node/... or /data/... that don't exist on the host. Fall back to
  // local defaults for any path that doesn't resolve on this machine.
  const digestConfig = { ...config.digest };
  if (digestConfig.store_path && !fs.existsSync(digestConfig.store_path)) {
    digestConfig.store_path = contentStore.resolveStorePath();
  }
  if (digestConfig.journal_dir && !fs.existsSync(digestConfig.journal_dir)) {
    digestConfig.journal_dir = contentStore.DEFAULT_JOURNAL_DIR;
  }
  if (digestConfig.signals_dir && !fs.existsSync(digestConfig.signals_dir)) {
    digestConfig.signals_dir = contentStore.resolveSignalsDir();
  }

  // Generate digests
  console.log(`Generating digests for: ${personaIds.join(', ')}`);
  console.log(`Period: ${sinceDate} to today`);
  console.log('');

  const result = await digest.generateDigest(digestConfig, personaIds, sinceDate, (progress) => {
    if (progress.phase === 'start') {
      process.stdout.write(`  ${progress.personaId} (${progress.index + 1}/${progress.total})... `);
    } else if (progress.phase === 'done') {
      process.stdout.write(`done (${progress.elapsed}s)\n`);
    }
  });

  console.log('');

  if (preview) {
    // Preview mode: print digest content and stats to stdout
    console.log('=== DIGEST PREVIEW ===');
    console.log('');
    if (result.inputStats) {
      const s = result.inputStats;
      console.log(`Input: ${s.journalEntries || 0} journal, ${s.signalEntries || 0} signal entries`);
      if (s.budgetStats) {
        console.log(`Budget: ${s.budgetStats.kept || 0} kept, ${s.budgetStats.dropped || 0} dropped`);
      }
      console.log('');
    }
    for (const f of result.files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        const personaId = path.basename(path.dirname(f)) || 'combined';
        console.log(`--- ${personaId} ---`);
        console.log(content);
        console.log('');
      } catch { /* skip unreadable */ }
    }
    console.log('=== END PREVIEW ===');
    return;
  }

  console.log('Digests generated:');
  for (const f of result.files) {
    console.log(`  ${f}`);
  }
  console.log('');

  // Update quality profile (piggyback on digest generation)
  try {
    const qualityProfile = contentStore.computeQualityProfile({ days: 30 });
    if (qualityProfile.totalDecisions > 0) {
      const existingProfile = readJSONFile(PROFILE_FILE) || {};
      existingProfile.quality_profile = {
        computed_at: new Date().toISOString(),
        days: 30,
        total_decisions: qualityProfile.totalDecisions,
        rich_rate: qualityProfile.richRate,
        reasoning_rate: qualityProfile.reasoning.rate,
        alternatives_rate: qualityProfile.alternatives.rate,
        focus: qualityProfile.focus,
      };
      writeJSONFile(PROFILE_FILE, existingProfile);
    }
  } catch {
    // Non-fatal — quality profile update failure shouldn't block digest
  }

  // Deliver to Slack
  if (deliver) {
    const webhookUrl = process.env.TEAM_CONTEXT_SLACK_WEBHOOK
      || (config.digest.slack && config.digest.slack.webhook_url);

    if (!webhookUrl) {
      console.error('No Slack webhook configured.');
      console.error('Set TEAM_CONTEXT_SLACK_WEBHOOK env var or run "wayfind digest --configure".');
      process.exit(1);
    }

    // Build per-persona @mentions from intelligence scores + member profiles
    const mentionsByPersona = {};
    if (result.scores) {
      const intelligence = require('./intelligence');
      const teamContextPath = getTeamContextPath();
      const membersDir = teamContextPath ? path.join(teamContextPath, 'members') : null;
      if (membersDir && fs.existsSync(membersDir)) {
        const memberFiles = fs.readdirSync(membersDir).filter(f => f.endsWith('.json'));
        const members = memberFiles.map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(membersDir, f), 'utf8')); }
          catch { return null; }
        }).filter(Boolean);

        for (const pid of personaIds) {
          const mentions = intelligence.buildMentions(result.scores, members, pid);
          const msg = intelligence.formatMentionsMessage(mentions);
          if (msg) mentionsByPersona[pid] = msg;
        }
      }
    }

    console.log('Delivering to Slack...');
    const deliveryResults = await slack.deliverAll(webhookUrl, result, personaIds, {
      botToken: process.env.SLACK_BOT_TOKEN,
      channel: process.env.SLACK_DIGEST_CHANNEL,
      mentionsByPersona,
    });
    let failures = 0;
    const dateStr = result.dateRange.to;
    for (const r of deliveryResults) {
      if (r.ok) {
        console.log(`  ${r.persona}: delivered`);
        telemetry.capture('digest_delivered', { persona: r.persona, channel: r.channel ? 'set' : 'unset' }, CLI_USER);
        if (r.ts) {
          contentStore.recordDigestDelivery({
            date: dateStr,
            persona: r.persona,
            channel: r.channel,
            ts: r.ts,
            storePath: (config.digest && config.digest.store_path) || undefined,
          });
        }
      } else {
        console.error(`  ${r.persona}: FAILED - ${r.error}`);
        failures++;
      }
    }
    console.log('');
    if (failures > 0) {
      console.error(`${failures} of ${deliveryResults.length} deliveries failed.`);
      process.exit(1);
    }
  }
}

// ── Content store commands ──────────────────────────────────────────────────

// Flags that take a value (consume the next arg)
const CS_VALUE_FLAGS = new Set(['--dir', '--store', '--limit', '--repo', '--since', '--until']);

function parseCSArgs(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (CS_VALUE_FLAGS.has(arg) && i + 1 < args.length) {
      opts[arg.replace(/^--/, '')] = args[++i];
    } else if (arg === '--text') {
      opts.text = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--drifted') {
      opts.drifted = true;
    } else if (arg === '--no-embeddings') {
      opts.noEmbeddings = true;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

async function runIndexJournals(args) {
  const { opts } = parseCSArgs(args);
  const journalDir = opts.dir || contentStore.DEFAULT_JOURNAL_DIR;
  const storePath = opts.store || contentStore.resolveStorePath();

  // Load team scope allowlist from context.json — only index repos bound to the active team.
  const ctxConfig = readContextConfig();
  const teamId = readRepoTeamBinding() || ctxConfig.default;
  const teamConfig = teamId && ctxConfig.teams && ctxConfig.teams[teamId];
  const repoAllowlist = (teamConfig && teamConfig.bound_repos && teamConfig.bound_repos.length > 0)
    ? teamConfig.bound_repos : undefined;

  console.log(`Indexing journals from: ${journalDir}`);
  console.log(`Store: ${storePath}`);
  if (repoAllowlist) console.log(`Team scope (${teamId}): ${repoAllowlist.join(', ')}`);
  console.log('');

  try {
    const stats = await contentStore.indexJournals({
      journalDir,
      storePath,
      embeddings: opts.noEmbeddings ? false : undefined,
      repoAllowlist,
    });

    console.log(`Indexed: ${stats.entryCount} entries`);
    console.log(`  New:       ${stats.newEntries}`);
    console.log(`  Updated:   ${stats.updatedEntries}`);
    console.log(`  Unchanged: ${stats.skippedEntries}`);
    console.log(`  Removed:   ${stats.removedEntries}`);
    console.log('');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function runIndexConversations(args) {
  const { opts } = parseCSArgs(args);
  const projectsDir = opts.dir || contentStore.DEFAULT_PROJECTS_DIR;
  const storePath = opts.store || contentStore.resolveStorePath();

  console.log(`Indexing conversations from: ${projectsDir}`);
  console.log(`Store: ${storePath}`);
  console.log('');

  try {
    const stats = await contentStore.indexConversations({
      projectsDir,
      storePath,
      embeddings: opts.noEmbeddings ? false : undefined,
      since: opts.since,
      onProgress: (p) => {
        if (p.phase === 'extracting') {
          console.log(`  Extracting: ${p.repo} ...`);
        }
      },
    });

    console.log('');
    console.log(`Scanned:    ${stats.transcriptsScanned} transcripts`);
    console.log(`Processed:  ${stats.transcriptsProcessed}`);
    console.log(`Decisions:  ${stats.decisionsExtracted}`);
    console.log(`Skipped:    ${stats.skipped}`);
    if (stats.errors > 0) {
      console.log(`Errors:     ${stats.errors}`);
    }
    console.log('');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function runReindex(args) {
  const { opts } = parseCSArgs(args);
  const journalsOnly = args.includes('--journals-only');
  const conversationsOnly = args.includes('--conversations-only');
  const signalsOnly = args.includes('--signals-only');
  const doExport = args.includes('--export');
  const detectShifts = args.includes('--detect-shifts');
  const force = args.includes('--force');

  if (force) {
    console.log('Force mode: clearing content store for full reindex...');
    try {
      const backend = contentStore.getBackend();
      const emptyIndex = { version: contentStore.INDEX_VERSION, entries: {}, lastUpdated: Date.now(), entryCount: 0 };
      backend.saveIndex(emptyIndex);
      // Clear conversation fingerprint cache so all transcripts are re-extracted
      backend.saveConversationIndex({});
    } catch (err) {
      console.log(`  Warning: could not clear store: ${err.message}`);
    }
  }

  if (!conversationsOnly && !signalsOnly) {
    console.log('=== Journals ===');
    await runIndexJournals(args);
  }

  if (!journalsOnly && !signalsOnly) {
    if (doExport) {
      console.log('=== Conversations (with journal export) ===');
      await runIndexConversationsWithExport(args, detectShifts);
    } else {
      console.log('=== Conversations ===');
      await runIndexConversations(args);
    }
  }

  if (!journalsOnly && !conversationsOnly) {
    console.log('=== Signals ===');
    await indexSignalsIfAvailable();
  }

  // Optional: run distillation after reindex
  if (args.includes('--distill')) {
    console.log('');
    console.log('=== Distillation ===');
    await runDistill(['--tier', 'daily']);
  }
}

async function runDistill(args) {
  const distill = require('./distill');
  const dryRun = args.includes('--dry-run');
  const tierIdx = args.indexOf('--tier');
  const tier = (tierIdx !== -1 && args[tierIdx + 1]) ? args[tierIdx + 1] : 'daily';

  console.log(`Distilling content (tier: ${tier}${dryRun ? ', dry run' : ''})...`);

  // Build LLM config from connectors
  let llmConfig = null;
  if (!dryRun) {
    const config = readConnectorsConfig();
    if (config.digest && config.digest.llm) {
      llmConfig = {
        provider: config.digest.llm.provider,
        model: config.digest.llm.intelligence?.model || 'claude-haiku-4-5-20251001',
        api_key_env: config.digest.llm.api_key_env,
      };
    }
  }

  const stats = await distill.distillEntries({ tier, dryRun, llmConfig });

  console.log('');
  console.log('Distillation results:');
  console.log(`  Groups: ${stats.grouped}`);
  console.log(`  Deduped: ${stats.deduped}`);
  console.log(`  Merged: ${stats.merged}`);
  console.log(`  LLM calls: ${stats.llmCalls}`);
}

/**
 * Build a repo-to-team resolver function.
 * Scans context.json teams and all known repo bindings to map repo names → team IDs.
 * Returns null for unbound repos — they are invisible to export/sync.
 * NOTE: config.default is intentionally NOT used here. The "default" field in context.json
 * exists for the `context bind` command's UX (pre-selecting a team), not for implicit
 * routing of unknown repos. Repos must opt in via .claude/wayfind.json to participate.
 * @returns {function(string): string|null} - Maps repo name (e.g. "acme-corp/api") to team ID, or null if unbound
 */
function buildRepoToTeamResolver() {
  const config = readContextConfig();
  if (!config.teams) return () => null;

  // Build a lookup: scan all known repo paths for .claude/wayfind.json bindings
  const repoToTeamMap = {};

  // Check common repo roots for bindings
  const envRoots = process.env.AI_MEMORY_SCAN_ROOTS;
  const roots = envRoots
    ? envRoots.split(':').filter(Boolean)
    : [path.join(HOME, 'repos')];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      // Two levels deep: root/org/repo
      const orgs = fs.readdirSync(root).filter(d => {
        try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
      });
      for (const org of orgs) {
        const orgDir = path.join(root, org);
        let repos;
        try { repos = fs.readdirSync(orgDir); } catch { continue; }
        for (const repo of repos) {
          const bindingFile = path.join(orgDir, repo, '.claude', 'wayfind.json');
          try {
            const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
            if (binding.team_id) {
              repoToTeamMap[`${org}/${repo}`] = binding.team_id;
            }
          } catch {
            // No binding file — skip
          }
        }
      }
    } catch {
      // Skip unreadable roots
    }
  }

  return (repoName) => {
    // Direct match
    if (repoToTeamMap[repoName]) return repoToTeamMap[repoName];

    // Try partial match (repo name might be "Org/Repo/SubDir" or just "Repo")
    for (const [key, teamId] of Object.entries(repoToTeamMap)) {
      if (repoName.startsWith(key + '/') || repoName === key) return teamId;
    }

    // No binding found — return null so unbound repos don't leak into
    // the default team's digest. Repos must have .claude/wayfind.json to
    // be routed. The "default" team in context.json is for the `context bind`
    // command's UX, not for implicit routing of unknown repos.
    return null;
  };
}

async function runIndexConversationsWithExport(args, detectShifts = false) {
  const { opts } = parseCSArgs(args);
  const projectsDir = opts.dir || contentStore.DEFAULT_PROJECTS_DIR;
  const storePath = opts.store || contentStore.resolveStorePath();
  const journalDir = opts.exportDir || contentStore.DEFAULT_JOURNAL_DIR;

  console.log(`Indexing conversations from: ${projectsDir}`);
  console.log(`Exporting decisions to: ${journalDir}`);
  console.log('');

  // Build repo→team resolver for per-team journal routing
  const repoToTeam = buildRepoToTeamResolver();

  try {
    const stats = await contentStore.indexConversationsWithExport({
      projectsDir,
      storePath,
      exportDir: journalDir,
      repoToTeam,
      author: getAuthorSlug(),
      embeddings: opts.noEmbeddings ? false : undefined,
      since: opts.since,
      onProgress: (p) => {
        if (p.phase === 'extracting') {
          console.log(`  Extracting: ${p.repo} ...`);
        }
      },
    });

    console.log('');
    console.log(`Scanned:    ${stats.transcriptsScanned} transcripts`);
    console.log(`Processed:  ${stats.transcriptsProcessed}`);
    const rich = stats.richCount || 0;
    const thin = stats.thinCount || 0;
    const qualitySuffix = (rich + thin) > 0 ? ` (${rich} rich, ${thin} thin)` : '';
    console.log(`Decisions:  ${stats.decisionsExtracted}${qualitySuffix}`);
    console.log(`Exported:   ${stats.exported}`);
    console.log(`Skipped:    ${stats.skipped}`);
    if (stats.errors > 0) {
      console.log(`Errors:     ${stats.errors}`);
    }

    // Write session stats JSON for status line display
    if (args.includes('--write-stats')) {
      const statsData = {
        decisions: stats.decisionsExtracted || 0,
        exported: stats.exported || 0,
        rich: rich,
        thin: thin,
        session_date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
      };
      const statsPath = path.join(HOME, '.claude', 'team-context', 'session-stats.json');
      try {
        fs.mkdirSync(path.dirname(statsPath), { recursive: true });
        fs.writeFileSync(statsPath, JSON.stringify(statsData, null, 2) + '\n');
      } catch (e) {
        // Non-fatal — status line just won't update
      }

      // Telemetry: decision quality per session
      if (stats.exported > 0) {
        telemetry.capture('decision_quality', {
          decisions: stats.decisionsExtracted || 0,
          exported: stats.exported || 0,
          rich: rich,
          thin: thin,
          rich_rate: (rich + thin) > 0 ? Math.round((rich / (rich + thin)) * 100) : 0,
        }, CLI_USER);
      }
    }

    // Context shift detection — single classification per reindex run.
    // Skip entirely when no new decisions were extracted (saves an LLM call).
    if (detectShifts && stats.decisionsExtracted > 0 && stats.pendingExports && stats.pendingExports.length > 0) {
      console.log('');
      console.log('=== Context Shift Detection ===');

      // Aggregate all decisions into one batch for a single LLM call
      const aggregated = [{
        date: stats.pendingExports[0].date,
        repo: stats.pendingExports.map(e => e.repo).filter((v, i, a) => a.indexOf(v) === i).join(', '),
        decisions: stats.pendingExports.flatMap(e => e.decisions),
      }];

      // Read current state for context
      const repoDir = process.cwd();
      const claudeDir = path.join(repoDir, '.claude');
      let stateContext = '';
      for (const f of ['team-state.md', 'personal-state.md', 'state.md']) {
        const p = path.join(claudeDir, f);
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf8');
          stateContext += `--- ${f} ---\n${content.slice(0, 2000)}\n\n`;
        }
      }

      const llmConfig = {
        provider: 'anthropic',
        model: process.env.TEAM_CONTEXT_SHIFT_MODEL || 'claude-haiku-4-5-20251001',
        api_key_env: 'ANTHROPIC_API_KEY',
      };

      const shift = await contentStore.detectContextShift(
        aggregated, llmConfig, stateContext
      );

      if (shift.hasShift) {
        console.log(`Shift detected: ${shift.summary}`);
        const applied = contentStore.applyContextShiftToState(
          shift.stateUpdates, repoDir, shift.summary
        );
        if (applied.teamUpdated) console.log('  Updated: team-state.md');
        if (applied.personalUpdated) console.log('  Updated: personal-state.md');
        if (!applied.teamUpdated && !applied.personalUpdated) {
          console.log('  No state files found to update (or shift already recorded today).');
        }
      } else {
        console.log('No significant context shift detected.');
      }
    }

    console.log('');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function runOnboard(args) {
  const { opts, positional } = parseCSArgs(args);
  const repoQuery = positional.join(' ');

  if (!repoQuery) {
    console.error('Usage: wayfind onboard <repo-name> [--days N] [--output <path>]');
    console.error('  e.g. wayfind onboard SellingService');
    console.error('  e.g. wayfind onboard acme-corp/web-api --days 30');
    process.exit(1);
  }

  const days = opts.days ? parseInt(opts.days, 10) : 90;
  const outputPath = opts.output;

  console.error(`Generating onboarding pack for "${repoQuery}" (last ${days} days)...`);
  console.error('');

  try {
    const pack = await contentStore.generateOnboardingPack(repoQuery, {
      storePath: opts.store || undefined,
      days,
    });

    if (outputPath) {
      fs.writeFileSync(outputPath, pack + '\n');
      console.error(`Written to: ${outputPath}`);
    } else {
      console.log(pack);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function runSearchJournals(args) {
  const { opts, positional } = parseCSArgs(args);
  const query = positional.join(' ');

  if (!query) {
    console.error('Usage: wayfind search-journals <query> [--text] [--limit N] [--repo <name>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--drifted]');
    process.exit(1);
  }

  const searchOpts = {
    storePath: opts.store || undefined,
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    repo: opts.repo,
    since: opts.since,
    until: opts.until,
    drifted: opts.drifted || undefined,
  };

  try {
    let results;
    if (opts.text) {
      results = contentStore.searchText(query, searchOpts);
    } else {
      results = await contentStore.searchJournals(query, searchOpts);
    }

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    console.log(`Found ${results.length} result(s):`);
    console.log('');
    for (const r of results) {
      const drift = r.entry.drifted ? ' [DRIFT]' : '';
      console.log(`  ${r.entry.date}  ${r.entry.repo} — ${r.entry.title}${drift}`);
      console.log(`           score: ${r.score}  tags: ${(r.entry.tags || []).join(', ')}`);
    }
    console.log('');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function runInsights(args) {
  const { opts } = parseCSArgs(args);
  const insights = contentStore.extractInsights({
    storePath: opts.store || undefined,
  });

  if (opts.json) {
    console.log(JSON.stringify(insights, null, 2));
    return;
  }

  console.log('');
  console.log('Journal Insights');
  console.log('================');
  console.log('');
  console.log(`Total sessions: ${insights.totalSessions}`);
  console.log(`Drift rate:     ${insights.driftRate}%`);
  console.log('');

  if (Object.keys(insights.repoActivity).length > 0) {
    console.log('Repo activity:');
    const sorted = Object.entries(insights.repoActivity).sort((a, b) => b[1] - a[1]);
    for (const [repo, count] of sorted) {
      console.log(`  ${repo.padEnd(30)} ${count} session(s)`);
    }
    console.log('');
  }

  if (Object.keys(insights.tagFrequency).length > 0) {
    console.log('Top tags:');
    const sorted = Object.entries(insights.tagFrequency).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [tag, count] of sorted) {
      console.log(`  ${tag.padEnd(20)} ${count}`);
    }
    console.log('');
  }

  if (insights.quality && insights.quality.totalDecisions > 0) {
    const q = insights.quality;
    console.log('Decision quality:');
    console.log(`  Total decisions: ${q.totalDecisions}`);
    console.log(`  Rich:            ${q.rich} (${q.richRate}%)`);
    console.log(`  Thin:            ${q.thin}`);
    console.log('');
  }

  if (insights.timeline.length > 0) {
    console.log('Timeline (last 14 days):');
    const recent = insights.timeline.slice(-14);
    for (const { date, sessions } of recent) {
      const bar = '\u2588'.repeat(Math.min(sessions, 40));
      console.log(`  ${date} ${bar} ${sessions}`);
    }
    console.log('');
  }
}

// ── Quality command ─────────────────────────────────────────────────────────

function runQuality(args) {
  const { opts } = parseCSArgs(args);
  const days = opts.days ? parseInt(opts.days, 10) : 30;
  const apply = args.includes('--apply');

  const profile = contentStore.computeQualityProfile({
    storePath: opts.store || undefined,
    days,
  });

  if (opts.json) {
    console.log(JSON.stringify(profile, null, 2));
    return;
  }

  console.log('');
  console.log('Decision Quality Profile');
  console.log('========================');
  console.log(`Period: last ${days} days`);
  console.log('');

  if (profile.totalDecisions === 0) {
    console.log('No decisions indexed yet. Run a few sessions, then try again.');
    console.log('');
    return;
  }

  console.log(`Total decisions:  ${profile.totalDecisions}`);
  console.log(`Rich:             ${profile.rich} (${profile.richRate}%)`);
  console.log(`Thin:             ${profile.thin}`);
  console.log('');
  console.log(`  Reasoning:      ${profile.reasoning.present}/${profile.totalDecisions} (${profile.reasoning.rate}%)`);
  console.log(`  Alternatives:   ${profile.alternatives.present}/${profile.totalDecisions} (${profile.alternatives.rate}%)`);
  console.log('');

  if (profile.weeklyTrend.length > 1) {
    console.log('Weekly trend:');
    for (const { week, richRate, count } of profile.weeklyTrend) {
      const bar = '\u2588'.repeat(Math.round(richRate / 5));
      console.log(`  ${week}  ${bar} ${richRate}% (${count} decisions)`);
    }
    console.log('');
  }

  if (profile.focus.length > 0) {
    console.log('Elicitation focus:');
    for (const f of profile.focus) {
      console.log(`  - ${f}`);
    }
    console.log('');
  }

  // Save quality profile to profile.json
  const existingProfile = readJSONFile(PROFILE_FILE) || {};
  existingProfile.quality_profile = {
    computed_at: new Date().toISOString(),
    days,
    total_decisions: profile.totalDecisions,
    rich_rate: profile.richRate,
    reasoning_rate: profile.reasoning.rate,
    alternatives_rate: profile.alternatives.rate,
    focus: profile.focus,
  };
  writeJSONFile(PROFILE_FILE, existingProfile);
  console.log(`Profile saved to ${PROFILE_FILE}`);

  // Generate and optionally apply elicitation focus to personal-state.md
  if (profile.focus.length > 0 && profile.focus[0] !== 'keep it up — your decision context is strong') {
    const focusBlock = [
      '## My Elicitation Focus',
      '',
      '<!-- Auto-generated by `wayfind quality`. Updated when you re-run the command. -->',
      '',
      'When making decisions in this repo, the AI should prioritize eliciting:',
      ...profile.focus.map(f => `- ${f}`),
      '',
    ].join('\n');

    if (apply) {
      // Find personal-state.md in current repo
      const personalState = path.join(process.cwd(), '.claude', 'personal-state.md');
      if (fs.existsSync(personalState)) {
        let content = fs.readFileSync(personalState, 'utf8');
        // Replace existing section or append
        if (content.includes('## My Elicitation Focus')) {
          content = content.replace(
            /## My Elicitation Focus[\s\S]*?(?=\n## |\n*$)/,
            focusBlock
          );
        } else {
          content = content.trimEnd() + '\n\n' + focusBlock;
        }
        fs.writeFileSync(personalState, content);
        console.log(`Applied elicitation focus to ${personalState}`);
      } else {
        console.log('No personal-state.md found in current repo. Run /init-memory first.');
      }
    } else {
      console.log('');
      console.log('To apply this focus to your personal-state.md, run:');
      console.log('  wayfind quality --apply');
    }
  }

  console.log('');

  telemetry.capture('quality_profile_viewed', {
    total_decisions: profile.totalDecisions,
    rich_rate: profile.richRate,
    reasoning_rate: profile.reasoning.rate,
    alternatives_rate: profile.alternatives.rate,
  }, CLI_USER);
}

// ── Journal command ─────────────────────────────────────────────────────────

/**
 * Derive an author slug from a profile name.
 * Uses the first name, lowercased. e.g. "Greg Leizerowicz" → "greg"
 */
function getAuthorSlug() {
  const profile = readJSONFile(PROFILE_FILE);
  if (!profile || !profile.name) return null;
  return profile.name.split(/\s+/)[0].toLowerCase();
}

function runJournal(args) {
  const sub = args[0];

  if (sub === 'migrate') {
    return journalMigrate(args.slice(1));
  }
  if (sub === 'sync') {
    return journalSync(args.slice(1));
  }
  if (sub === 'split') {
    return journalSplitByTeam(args.slice(1));
  }

  // Default: run legacy journal-summary.sh
  spawn('bash', [path.join(ROOT, 'journal-summary.sh'), ...args]);
}

/**
 * Rename YYYY-MM-DD.md → YYYY-MM-DD-{slug}.md in a journal directory.
 * Adds **Author:** line at the top of each file.
 * Usage: wayfind journal migrate [--dir <path>] [--author <slug>] [--dry-run]
 */
function journalMigrate(args) {
  const dryRun = args.includes('--dry-run');
  const dirIdx = args.indexOf('--dir');
  const journalDir = dirIdx !== -1 && args[dirIdx + 1]
    ? path.resolve(args[dirIdx + 1].replace(/^~/, HOME))
    : contentStore.DEFAULT_JOURNAL_DIR;

  const authorIdx = args.indexOf('--author');
  const author = authorIdx !== -1 && args[authorIdx + 1]
    ? args[authorIdx + 1]
    : getAuthorSlug();

  if (!author) {
    console.error('Could not determine author. Run "wayfind whoami --setup" or pass --author <slug>.');
    process.exit(1);
  }

  if (!fs.existsSync(journalDir)) {
    console.error(`Journal directory not found: ${journalDir}`);
    process.exit(1);
  }

  const plainDateRe = /^(\d{4}-\d{2}-\d{2})\.md$/;
  const files = fs.readdirSync(journalDir).filter(f => plainDateRe.test(f)).sort();

  if (files.length === 0) {
    console.log('No plain-date journal files to migrate.');
    return;
  }

  console.log(`Migrating ${files.length} journal files → author: ${author}`);
  if (dryRun) console.log('(dry run — no files will be changed)');
  console.log('');

  let count = 0;
  for (const file of files) {
    const date = file.match(plainDateRe)[1];
    const newName = `${date}-${author}.md`;
    const oldPath = path.join(journalDir, file);
    const newPath = path.join(journalDir, newName);

    if (fs.existsSync(newPath)) {
      console.log(`  SKIP ${file} → ${newName} (target exists)`);
      continue;
    }

    // Add **Author:** line at top if not already present
    let content = fs.readFileSync(oldPath, 'utf8');
    if (!content.match(/^\*\*Author:\*\*/m)) {
      content = `**Author:** ${author}\n\n${content}`;
    }

    if (dryRun) {
      console.log(`  ${file} → ${newName}`);
    } else {
      fs.writeFileSync(newPath, content, 'utf8');
      fs.unlinkSync(oldPath);
      console.log(`  ${file} → ${newName}`);
    }
    count++;
  }

  console.log(`\n${dryRun ? 'Would migrate' : 'Migrated'} ${count} file(s).`);
  if (!dryRun && count > 0) {
    console.log('Run "wayfind reindex --journals-only" to update the content store.');
  }
}

/**
 * Split existing journal files by team based on repo headers in entries.
 * Parses ## Org/Repo — headers, resolves repo→team, and creates per-team files.
 * Old files without team suffix are split; originals renamed to .bak.
 * Usage: wayfind journal split [--dir <path>] [--dry-run]
 */
function journalSplitByTeam(args) {
  const dryRun = args.includes('--dry-run');
  const dirIdx = args.indexOf('--dir');
  const journalDir = dirIdx !== -1 && args[dirIdx + 1]
    ? path.resolve(args[dirIdx + 1].replace(/^~/, HOME))
    : contentStore.DEFAULT_JOURNAL_DIR;

  if (!fs.existsSync(journalDir)) {
    console.error(`Journal directory not found: ${journalDir}`);
    process.exit(1);
  }

  const config = readContextConfig();
  if (!config.teams) {
    console.error('No multi-team config found. Run "wayfind context add" first.');
    process.exit(1);
  }

  const knownTeamIds = new Set(Object.keys(config.teams));
  const repoToTeam = buildRepoToTeamResolver();

  // Find files that DON'T already have a team suffix
  const allFiles = fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).sort();
  const filesToSplit = allFiles.filter(f => {
    const base = f.replace(/\.md$/, '');
    // Already has a team suffix?
    for (const id of knownTeamIds) {
      if (base.endsWith(`-${id}`)) return false;
    }
    return true;
  });

  if (filesToSplit.length === 0) {
    console.log('No journal files need splitting (all already have team suffixes).');
    return;
  }

  console.log(`Found ${filesToSplit.length} journal file(s) to split by team.`);
  if (dryRun) console.log('(dry run — no files will be modified)\n');

  let splitCount = 0;

  for (const file of filesToSplit) {
    const filePath = path.join(journalDir, file);
    const content = fs.readFileSync(filePath, 'utf8');

    // Split content into entries by ## headers
    const lines = content.split('\n');
    const header = []; // Lines before first ## entry (date header, author line)
    const entries = []; // { teamId, lines[] }
    let currentEntry = null;

    for (const line of lines) {
      const entryMatch = line.match(/^## (.+?) — /);
      if (entryMatch) {
        if (currentEntry) entries.push(currentEntry);
        const repo = entryMatch[1].trim();
        const teamId = repoToTeam(repo);
        currentEntry = { teamId, lines: [line] };
      } else if (currentEntry) {
        currentEntry.lines.push(line);
      } else {
        header.push(line);
      }
    }
    if (currentEntry) entries.push(currentEntry);

    if (entries.length === 0) continue;

    // Group entries by team
    const teamEntries = {};
    for (const entry of entries) {
      const tid = entry.teamId || config.default;
      if (!teamEntries[tid]) teamEntries[tid] = [];
      teamEntries[tid].push(entry.lines.join('\n'));
    }

    // Only one team? Just rename the file with the team suffix
    const teams = Object.keys(teamEntries);
    if (teams.length === 1 && teams[0] === config.default) {
      // All entries belong to default team — add suffix
      const base = file.replace(/\.md$/, '');
      const newName = `${base}-${teams[0]}.md`;
      if (dryRun) {
        console.log(`  ${file} → ${newName} (all entries → ${config.teams[teams[0]]?.name || teams[0]})`);
      } else {
        fs.renameSync(filePath, path.join(journalDir, newName));
        console.log(`  ${file} → ${newName}`);
      }
      splitCount++;
      continue;
    }

    // Multiple teams — write separate files
    const base = file.replace(/\.md$/, '');
    const headerText = header.join('\n').trim();

    for (const [teamId, entryTexts] of Object.entries(teamEntries)) {
      const newName = `${base}-${teamId}.md`;
      const teamContent = (headerText ? headerText + '\n' : '') + '\n' + entryTexts.join('\n');
      const teamName = (config.teams[teamId]) ? config.teams[teamId].name : teamId;

      if (dryRun) {
        console.log(`  ${file} → ${newName} (${entryTexts.length} entries → ${teamName})`);
      } else {
        fs.writeFileSync(path.join(journalDir, newName), teamContent, 'utf8');
        console.log(`  ${file} → ${newName} (${entryTexts.length} entries → ${teamName})`);
      }
    }

    // Rename original to .bak
    if (!dryRun) {
      fs.renameSync(filePath, filePath + '.bak');
      console.log(`  ${file} → ${file}.bak (original backed up)`);
    }
    splitCount++;
  }

  console.log(`\n${dryRun ? 'Would split' : 'Split'} ${splitCount} file(s).`);
  if (!dryRun && splitCount > 0) {
    console.log('Run "wayfind journal sync" to push split files to team repos.');
  }
}

/**
 * Sync local journals to team-context repo(s) journals/ directory.
 * Routes per-team journal files (YYYY-MM-DD-{teamId}.md or YYYY-MM-DD-{author}-{teamId}.md)
 * to the correct team-context repo based on the team ID suffix.
 * Files without a team suffix are skipped — repos must opt in via .claude/wayfind.json.
 * Usage: wayfind journal sync [--dir <path>] [--since YYYY-MM-DD]
 */
function journalSync(args) {
  const dirIdx = args.indexOf('--dir');
  const journalDir = dirIdx !== -1 && args[dirIdx + 1]
    ? path.resolve(args[dirIdx + 1].replace(/^~/, HOME))
    : contentStore.DEFAULT_JOURNAL_DIR;

  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx !== -1 ? args[sinceIdx + 1] : null;

  const config = readContextConfig();
  if (!config.teams && !getTeamContextPath()) {
    // Silent exit when called from session-end hook on machines without team-context
    return;
  }

  if (!fs.existsSync(journalDir)) {
    console.error(`Journal directory not found: ${journalDir}`);
    process.exit(1);
  }

  // Auto-migrate any plain-date files (YYYY-MM-DD.md) before syncing
  const plainDateRe = /^(\d{4}-\d{2}-\d{2})\.md$/;
  const plainFiles = fs.readdirSync(journalDir).filter(f => plainDateRe.test(f));
  if (plainFiles.length > 0) {
    const author = getAuthorSlug();
    if (author) {
      let migrated = 0;
      for (const file of plainFiles) {
        const date = file.match(plainDateRe)[1];
        const newName = `${date}-${author}.md`;
        const oldPath = path.join(journalDir, file);
        const newPath = path.join(journalDir, newName);
        if (fs.existsSync(newPath)) continue;
        let content = fs.readFileSync(oldPath, 'utf8');
        if (!content.match(/^\*\*Author:\*\*/m)) {
          content = `**Author:** ${author}\n\n${content}`;
        }
        fs.writeFileSync(newPath, content, 'utf8');
        fs.unlinkSync(oldPath);
        migrated++;
      }
      if (migrated > 0) {
        console.log(`Auto-migrated ${migrated} journal file(s) → author: ${author}`);
      }
    }
  }

  // Collect all journal files and group by team
  const allFiles = fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).sort();
  const knownTeamIds = config.teams ? new Set(Object.keys(config.teams)) : new Set();

  // Categorize files: { teamId → [{ file, srcPath }] }
  const teamFiles = {};
  for (const file of allFiles) {
    // Extract date for --since filtering
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    if (since && dateMatch[1] < since) continue;

    // Determine team from filename suffix
    // Pattern: YYYY-MM-DD-{teamId}.md or YYYY-MM-DD-{author}-{teamId}.md
    let teamId = null;
    const baseName = file.replace(/\.md$/, '');
    const parts = baseName.split('-');

    // Check if the last segment (or last N segments joined by -) is a known team ID
    // Team IDs can contain alphanumeric chars (e.g., "486cbeb4", "personal")
    if (parts.length > 3) {
      // Try matching known team IDs from the end of the filename
      for (const id of knownTeamIds) {
        if (baseName.endsWith(`-${id}`)) {
          teamId = id;
          break;
        }
      }
    }

    // No team suffix → skip. Repos must opt in via .claude/wayfind.json.
    if (!teamId) continue;

    if (!teamFiles[teamId]) teamFiles[teamId] = [];
    teamFiles[teamId].push({ file, srcPath: path.join(journalDir, file) });
  }

  // Always update member version stamp for all registered teams, even if no files to sync.
  // This ensures the stamp stays current regardless of whether journals are flowing.
  if (config.teams) {
    for (const teamId of Object.keys(config.teams)) {
      const teamPath = getTeamContextPath(teamId);
      if (teamPath) stampMemberVersion(teamPath);
    }
  }

  if (Object.keys(teamFiles).length === 0) {
    console.log('No journal files to sync.');
    return;
  }

  // Sync to each team's context repo
  let totalCopied = 0;
  let totalSkipped = 0;

  for (const [teamId, files] of Object.entries(teamFiles)) {
    const teamPath = getTeamContextPath(teamId);
    if (!teamPath) {
      console.log(`  Skipping ${files.length} file(s) for unknown team: ${teamId}`);
      continue;
    }

    const targetDir = path.join(teamPath, 'journals');
    fs.mkdirSync(targetDir, { recursive: true });

    let copied = 0;
    let skipped = 0;

    for (const { file, srcPath } of files) {
      // Strip team suffix from destination filename (team repo doesn't need it)
      const dstName = file.replace(new RegExp(`-${teamId}\\.md$`), '.md');
      // But keep author slug if present: YYYY-MM-DD-{author}-{teamId}.md → YYYY-MM-DD-{author}.md
      const dst = path.join(targetDir, dstName);

      // Skip if target is identical
      if (fs.existsSync(dst)) {
        const srcContent = fs.readFileSync(srcPath, 'utf8');
        const dstContent = fs.readFileSync(dst, 'utf8');
        if (srcContent === dstContent) {
          skipped++;
          continue;
        }
      }

      fs.copyFileSync(srcPath, dst);
      copied++;
    }

    const teamName = (config.teams && config.teams[teamId]) ? config.teams[teamId].name : teamId;
    console.log(`Synced to ${targetDir} (${teamName})`);
    console.log(`  ${copied} file(s) copied, ${skipped} unchanged`);

    totalCopied += copied;
    totalSkipped += skipped;

    if (copied > 0) {
      commitAndPushTeamJournals(teamPath, copied);
    } else {
      // Still stamp version even when no new journals (keeps last_active fresh)
      stampMemberVersion(teamPath);
    }
  }

  telemetry.capture('journal_sync', { file_count: totalCopied }, CLI_USER);
}

/**
 * Commit and push journal changes in a team-context repo.
 */
function commitAndPushTeamJournals(teamContextPath, copied) {
  const author = getAuthorSlug() || 'unknown';

  // Stamp current version into member profile
  stampMemberVersion(teamContextPath);

  try {
    const gitAdd = spawnSync('git', ['add', 'journals/', 'members/', '.wayfind-api-key'], { cwd: teamContextPath, stdio: 'pipe' });
    if (gitAdd.status !== 0) {
      console.error(`git add failed: ${(gitAdd.stderr || '').toString().trim()}`);
      return;
    }

    // Check if there's anything to commit
    const diffIndex = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: teamContextPath, stdio: 'pipe' });
    if (diffIndex.status === 0) {
      console.log('  Nothing new to commit.');
      return;
    }

    const msg = `Sync ${author} journals (${copied} file${copied > 1 ? 's' : ''})`;
    const gitCommit = spawnSync('git', ['commit', '-m', msg], { cwd: teamContextPath, stdio: 'pipe' });
    if (gitCommit.status !== 0) {
      console.error(`git commit failed: ${(gitCommit.stderr || '').toString().trim()}`);
      return;
    }
    console.log(`  Committed: ${msg}`);

    const gitPush = spawnSync('git', ['push'], { cwd: teamContextPath, stdio: 'pipe', timeout: 30000 });
    if (gitPush.status !== 0) {
      const stderr = (gitPush.stderr || '').toString().trim();
      if (stderr.includes('fetch first') || stderr.includes('non-fast-forward')) {
        console.log('  Remote has new changes — rebasing...');
        const gitPull = spawnSync('git', ['pull', '--rebase'], { cwd: teamContextPath, stdio: 'pipe', timeout: 30000 });
        if (gitPull.status !== 0) {
          console.error(`  git pull --rebase failed: ${(gitPull.stderr || '').toString().trim()}`);
          return;
        }
        const retry = spawnSync('git', ['push'], { cwd: teamContextPath, stdio: 'pipe', timeout: 30000 });
        if (retry.status !== 0) {
          console.error(`  git push retry failed: ${(retry.stderr || '').toString().trim()}`);
          return;
        }
      } else {
        console.error(`  git push failed: ${stderr}`);
        return;
      }
    }
    console.log('  Pushed to remote.');
  } catch (err) {
    console.error(`  Git sync failed: ${err.message}`);
  }
}

// ── Features command ─────────────────────────────────────────────────────────

/**
 * Get the repo slug (org/repo) from the git remote origin URL.
 * Falls back to the directory name if git remote is unavailable.
 * @returns {string}
 */
function getRepoSlug() {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  if (result.status === 0) {
    const url = result.stdout.toString().trim();
    // Extract org/repo from https or ssh URLs
    const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  return path.basename(process.cwd());
}

/**
 * Compile features.json in the team-context repo from the local repo's wayfind.json.
 * Reads existing features.json, merges/updates the entry for this repo, writes back.
 * @param {string} teamContextPath
 * @param {string} repoSlug
 * @param {Object} features - { tags, description }
 */
function updateFeaturesJson(teamContextPath, repoSlug, features) {
  const featuresFile = path.join(teamContextPath, 'features.json');

  // Pull latest before modifying to reduce conflicts
  spawnSync('git', ['pull', '--rebase'], { cwd: teamContextPath, stdio: 'pipe', timeout: 30000 });

  const existing = readJSONFile(featuresFile) || {};
  existing[repoSlug] = {
    ...(existing[repoSlug] || {}),
    ...features,
    updated_at: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(featuresFile, JSON.stringify(existing, null, 2) + '\n');

  // Commit and push
  const gitAdd = spawnSync('git', ['add', 'features.json'], { cwd: teamContextPath, stdio: 'pipe' });
  if (gitAdd.status !== 0) {
    console.error('git add features.json failed');
    return;
  }
  const diffIndex = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: teamContextPath, stdio: 'pipe' });
  if (diffIndex.status === 0) {
    console.log('  features.json up to date — nothing to commit.');
    return;
  }
  const msg = `Update features: ${repoSlug}`;
  const gitCommit = spawnSync('git', ['commit', '-m', msg], { cwd: teamContextPath, stdio: 'pipe' });
  if (gitCommit.status !== 0) {
    console.error('git commit features.json failed');
    return;
  }
  const gitPush = spawnSync('git', ['push'], { cwd: teamContextPath, stdio: 'pipe', timeout: 30000 });
  if (gitPush.status !== 0) {
    const stderr = (gitPush.stderr || '').toString().trim();
    if (stderr.includes('fetch first') || stderr.includes('non-fast-forward')) {
      spawnSync('git', ['pull', '--rebase'], { cwd: teamContextPath, stdio: 'pipe', timeout: 30000 });
      spawnSync('git', ['push'], { cwd: teamContextPath, stdio: 'pipe', timeout: 30000 });
    }
  }
  console.log('  Synced features.json to team-context repo.');
}

/**
 * Features command: manage per-repo feature tags for Slack bot routing.
 * Usage:
 *   wayfind features add <tag1> [tag2] ...   — append tags
 *   wayfind features set <tag1> [tag2] ...   — replace all tags
 *   wayfind features describe <text>         — set description
 *   wayfind features list                    — list all repos in team features map
 *   wayfind features search <query>          — keyword search over features map
 *   wayfind features suggest                 — suggest tags via LLM
 */
async function runFeatures(args) {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === 'help') {
    console.log(`wayfind features — manage feature-to-repo map for Slack bot routing

Commands:
  add <tag1> [tag2...]   Add tags to this repo (appends to existing)
  set <tag1> [tag2...]   Replace all tags for this repo
  describe <text>        Set a description for this repo
  list                   Show all repos in the team features map
  search <query>         Search repos by tag or description keyword
  suggest                Use AI to suggest tags based on repo content`);
    return;
  }

  if (sub === 'list') {
    const teamPath = getTeamContextPath();
    if (!teamPath) {
      console.error('No team configured. Run "wayfind context add" first.');
      process.exit(1);
    }
    const featuresFile = path.join(teamPath, 'features.json');
    const map = readJSONFile(featuresFile);
    if (!map || Object.keys(map).length === 0) {
      console.log('No feature map found. Run "wayfind features add" in a repo to get started.');
      return;
    }
    for (const [repo, entry] of Object.entries(map).sort()) {
      const tags = (entry.tags || []).join(', ') || '—';
      const desc = entry.description ? `  ${entry.description}` : '';
      console.log(`${repo}\n  tags: ${tags}${desc}\n`);
    }
    return;
  }

  if (sub === 'search') {
    if (rest.length === 0) {
      console.error('Usage: wayfind features search <query>');
      process.exit(1);
    }
    const query = rest.join(' ').toLowerCase();
    const teamPath = getTeamContextPath();
    if (!teamPath) {
      console.error('No team configured.');
      process.exit(1);
    }
    const featuresFile = path.join(teamPath, 'features.json');
    const map = readJSONFile(featuresFile) || {};
    const matches = Object.entries(map).filter(([repo, entry]) => {
      const text = [
        repo,
        ...(entry.tags || []),
        entry.description || '',
      ].join(' ').toLowerCase();
      return text.includes(query);
    });
    if (matches.length === 0) {
      console.log(`No repos match "${query}".`);
      return;
    }
    for (const [repo, entry] of matches) {
      const tags = (entry.tags || []).join(', ') || '—';
      console.log(`${repo} — ${tags}${entry.description ? ' — ' + entry.description : ''}`);
    }
    return;
  }

  if (sub === 'suggest') {
    const llm = require('./connectors/llm');
    const repoSlug = getRepoSlug();
    const repoName = path.basename(process.cwd());

    // Gather context from multiple signals for better suggestions
    let context = `Repository: ${repoSlug}\n`;

    // 1. team-state.md (richest signal — architecture, domain language, sprint focus)
    const teamStatePath = path.join(process.cwd(), '.claude', 'team-state.md');
    if (fs.existsSync(teamStatePath)) {
      const teamState = fs.readFileSync(teamStatePath, 'utf8');
      context += `Team state (first 2000 chars):\n${teamState.slice(0, 2000)}\n`;
    }

    // 2. README
    const readmePath = ['README.md', 'readme.md', 'Readme.md'].find(f => fs.existsSync(path.join(process.cwd(), f)));
    if (readmePath) {
      const readme = fs.readFileSync(path.join(process.cwd(), readmePath), 'utf8');
      context += `README (first 1000 chars):\n${readme.slice(0, 1000)}\n`;
    }

    // 3. package.json (Node repos)
    const packagePath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(packagePath)) {
      const pkg = readJSONFile(packagePath);
      if (pkg && pkg.description) context += `package.json description: ${pkg.description}\n`;
      if (pkg && pkg.keywords) context += `keywords: ${(pkg.keywords || []).join(', ')}\n`;
    }

    // 4. Top-level directory listing (reveals project structure)
    try {
      const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
      const files = entries.filter(e => e.isFile() && !e.name.startsWith('.')).map(e => e.name);
      context += `Top-level dirs: ${dirs.join(', ')}\n`;
      context += `Top-level files: ${files.slice(0, 20).join(', ')}\n`;
    } catch { /* best effort */ }

    // 5. Recent journal entries mentioning this repo (from team-context)
    const teamPath = getTeamContextPath();
    if (teamPath) {
      const journalsDir = path.join(teamPath, 'journals');
      if (fs.existsSync(journalsDir)) {
        try {
          const journalFiles = fs.readdirSync(journalsDir)
            .filter(f => f.endsWith('.md'))
            .sort()
            .slice(-10); // last 10 journals
          const repoBasename = path.basename(process.cwd());
          let journalContext = '';
          for (const jf of journalFiles) {
            const content = fs.readFileSync(path.join(journalsDir, jf), 'utf8');
            if (content.includes(repoBasename) || content.includes(repoSlug)) {
              // Extract lines mentioning this repo (± context)
              const lines = content.split('\n');
              const relevant = lines.filter(l =>
                l.includes(repoBasename) || l.includes(repoSlug)
              );
              if (relevant.length > 0) {
                journalContext += relevant.slice(0, 10).join('\n') + '\n';
              }
            }
          }
          if (journalContext) {
            context += `Recent journal mentions:\n${journalContext.slice(0, 1500)}\n`;
          }
        } catch { /* best effort */ }
      }
    }

    const llmConfig = {
      provider: 'anthropic',
      model: process.env.TEAM_CONTEXT_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
      api_key_env: 'ANTHROPIC_API_KEY',
    };

    const systemPrompt = `You suggest concise feature tags for a software repository. These tags help non-engineers (PMs, designers) find the right repo when asking questions like "how do RFPs work?" or "what changed with hotel matching?"

Prioritize business/domain language (rfp, bookings, hotel import, proposals) over technical terms (azure-functions, cosmos-db). Include a few technical tags for engineers, but lead with what the product DOES, not how it's built.

Return a JSON object with two fields: "tags" (array of 5-15 short lowercase tags, business terms first) and "description" (one sentence describing the repo's purpose in product language). Return only valid JSON, no markdown.`;

    console.log(`Analyzing ${repoSlug}...`);
    try {
      let raw = await llm.call(llmConfig, systemPrompt, context);
      // Strip markdown code fences if the LLM wraps the JSON
      raw = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/,'');
      const parsed = JSON.parse(raw.trim());
      console.log(`\nSuggested tags: ${(parsed.tags || []).join(', ')}`);
      if (parsed.description) console.log(`Description: ${parsed.description}`);
      console.log(`\nTo apply: wayfind features set ${(parsed.tags || []).join(' ')}`);
      if (parsed.description) console.log(`           wayfind features describe "${parsed.description}"`);
    } catch (err) {
      console.error(`Suggestion failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // add / set / describe — all require writing to .claude/wayfind.json and syncing
  if (sub === 'add' || sub === 'set' || sub === 'describe') {
    if (rest.length === 0) {
      console.error(`Usage: wayfind features ${sub} <value...>`);
      process.exit(1);
    }

    const claudeDir = path.join(process.cwd(), '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const bindingFile = path.join(claudeDir, 'wayfind.json');
    const binding = readJSONFile(bindingFile) || {};

    if (sub === 'describe') {
      binding.features = binding.features || {};
      binding.features.description = rest.join(' ');
    } else if (sub === 'set') {
      binding.features = binding.features || {};
      binding.features.tags = rest.map(t => t.toLowerCase().replace(/^#/, ''));
    } else if (sub === 'add') {
      binding.features = binding.features || {};
      const newTags = rest.map(t => t.toLowerCase().replace(/^#/, ''));
      const existing = binding.features.tags || [];
      binding.features.tags = [...new Set([...existing, ...newTags])];
    }

    fs.writeFileSync(bindingFile, JSON.stringify(binding, null, 2) + '\n');

    const repoSlug = getRepoSlug();
    const tags = binding.features.tags || [];
    const description = binding.features.description || '';

    if (sub === 'describe') {
      console.log(`Set description for ${repoSlug}: "${description}"`);
    } else {
      console.log(`Tags for ${repoSlug}: ${tags.join(', ')}`);
    }

    // Sync to team-context repo if configured
    const teamPath = getTeamContextPath();
    if (teamPath) {
      updateFeaturesJson(teamPath, repoSlug, { tags, description });
    } else {
      console.log('  (No team configured — skipping team-context sync)');
    }
    return;
  }

  console.error(`Unknown subcommand: ${sub}. Run "wayfind features help" for usage.`);
  process.exit(1);
}

// ── Standup command ─────────────────────────────────────────────────────────

/**
 * Find and parse the most recent journal entry.
 * @param {string} journalDir - Journal directory path
 * @param {string} [repoFilter] - If set, only match entries whose repo header
 *   matches this name (case-insensitive). Skips non-matching entries.
 * @returns {{ date: string, repo: string, title: string, what: string } | null}
 */
function getLastJournalEntry(journalDir, repoFilter) {
  if (!journalDir || !fs.existsSync(journalDir)) return null;

  const files = fs.readdirSync(journalDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}/.test(f) && f.endsWith('.md'))
    .sort()
    .reverse();

  const filterLower = repoFilter ? repoFilter.toLowerCase() : null;

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(journalDir, file), 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');

    // Find all entry start indices (## Repo — Title or ## Repo)
    const entryStarts = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^## /.test(lines[i])) entryStarts.push(i);
    }
    if (entryStarts.length === 0) continue;

    // Walk entries in reverse (most recent first within each file)
    for (let e = entryStarts.length - 1; e >= 0; e--) {
      const start = entryStarts[e];
      const end = e + 1 < entryStarts.length ? entryStarts[e + 1] : lines.length;
      const entryLines = lines.slice(start, end);

      const headerMatch = entryLines[0].match(/^## (.+?)(?:\s*[—–-]\s*(.+))?$/);
      const repo = headerMatch ? headerMatch[1].trim() : '';
      const title = headerMatch && headerMatch[2] ? headerMatch[2].trim() : '';

      // Apply repo filter if set
      if (filterLower && repo.toLowerCase() !== filterLower) continue;

      // Extract **What:** field
      let what = '';
      for (let i = 1; i < entryLines.length; i++) {
        const match = entryLines[i].match(/^\*\*What:\*\*\s*(.*)$/);
        if (match) {
          what = match[1].trim();
          if (!what) {
            for (let j = i + 1; j < entryLines.length; j++) {
              if (!entryLines[j].trim() || /^\*\*/.test(entryLines[j])) break;
              what += (what ? ' ' : '') + entryLines[j].trim();
            }
          }
          break;
        }
      }

      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : '';

      if (repo || what) return { date, repo, title, what };
    }
  }

  return null;
}

/**
 * Emit a daily standup summary.
 * Default: scoped to the current repo. --all scans every repo with state files.
 * Shows: what was done last (from journal), what's planned, and blockers.
 * @param {string[]} args - CLI arguments (supports --all)
 */
function runStandup(args) {
  const explicitAll = args.includes('--all');
  const journalDir = contentStore.DEFAULT_JOURNAL_DIR;
  const cwd = process.cwd();

  // Detect if we're inside a repo (.git + .claude/ state files)
  // Home dir may have ~/.claude/state.md but isn't a repo
  const claudeDir = path.join(cwd, '.claude');
  const hasGit = fs.existsSync(path.join(cwd, '.git'));
  const inRepo = hasGit && fs.existsSync(claudeDir) && (
    fs.existsSync(path.join(claudeDir, 'team-state.md')) ||
    fs.existsSync(path.join(claudeDir, 'state.md')) ||
    fs.existsSync(path.join(claudeDir, 'personal-state.md'))
  );

  // If not in a repo, behave like --all
  const showAll = explicitAll || !inRepo;

  const PLAN_HEADERS = [
    ...rebuildStatus.NEXT_HEADERS,
    'My Current Focus',
    'Current Sprint Focus',
    'Current Focus',
  ];

  // Determine which state files to read
  let stateEntries;
  if (showAll) {
    const envRoots = process.env.AI_MEMORY_SCAN_ROOTS;
    const roots = envRoots
      ? envRoots.split(':').filter(Boolean)
      : rebuildStatus.DEFAULT_ROOTS;
    stateEntries = rebuildStatus.scanStateFiles(roots);
  } else {
    // Current repo only — look for .claude/ state files in cwd
    stateEntries = [];
    const teamState = path.join(claudeDir, 'team-state.md');
    const personalState = path.join(claudeDir, 'personal-state.md');
    const plainState = path.join(claudeDir, 'state.md');

    let stateFile = null;
    if (fs.existsSync(teamState)) stateFile = teamState;
    else if (fs.existsSync(plainState)) stateFile = plainState;
    else if (fs.existsSync(personalState)) stateFile = personalState;

    if (stateFile) {
      const entry = { repoDir: cwd, stateFile };
      if (stateFile !== personalState && fs.existsSync(personalState)) {
        entry.personalStateFile = personalState;
      }
      stateEntries.push(entry);
    }
  }

  // Gather next steps and blockers from state files
  const nextItems = [];
  const blockerItems = [];
  const seenNext = new Set();
  const seenBlockers = new Set();

  for (const { stateFile, personalStateFile } of stateEntries) {
    const filesToCheck = [stateFile, personalStateFile].filter(Boolean);
    for (const filePath of filesToCheck) {
      let fileContent;
      try {
        fileContent = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const lines = fileContent.split('\n').map(l => l.replace(/\r$/, ''));

      const h1 = lines.find(l => /^# /.test(l));
      const project = h1
        ? h1.replace(/^# /, '').replace(/\s*[—–-].*$/, '').trim()
        : path.basename(path.dirname(path.dirname(filePath)));

      const next = extractStandupSection(lines, PLAN_HEADERS);
      if (next && !seenNext.has(next)) {
        seenNext.add(next);
        nextItems.push({ project, text: next });
      }

      const blocker = extractStandupSection(lines, rebuildStatus.BLOCKER_HEADERS);
      if (blocker && !seenBlockers.has(blocker)) {
        seenBlockers.add(blocker);
        blockerItems.push({ project, text: blocker });
      }
    }
  }

  // Filter journal to current repo when scoped, global when --all or home dir
  const repoName = !showAll ? path.basename(cwd) : null;
  const lastEntry = getLastJournalEntry(journalDir, repoName);
  const scope = showAll ? 'all repos' : repoName;

  console.log('');
  console.log(`━━━ Standup (${scope}) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log('');

  // Last session
  if (lastEntry) {
    const dateStr = lastEntry.date ? ` (${lastEntry.date})` : '';
    const repoStr = lastEntry.repo ? ` [${lastEntry.repo}]` : '';
    console.log(`▶ Last session${dateStr}${repoStr}:`);
    const summary = lastEntry.what || lastEntry.title || '(no details recorded)';
    console.log(`  ${summary}`);
  } else {
    console.log('▶ Last session:');
    console.log('  (no journal entries found)');
  }

  // Plan for today
  console.log('');
  console.log('▶ Plan for today:');
  if (nextItems.length > 0) {
    for (const item of nextItems) {
      const prefix = showAll ? `${item.project}: ` : '';
      console.log(`  ${prefix}${item.text}`);
    }
  } else {
    console.log('  (no next steps recorded — update your state file to set a goal)');
  }

  // Blockers
  console.log('');
  console.log('▶ Blockers:');
  if (blockerItems.length > 0) {
    for (const item of blockerItems) {
      const prefix = showAll ? `${item.project}: ` : '';
      console.log(`  ${prefix}${item.text}`);
    }
  } else {
    console.log('  None');
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (!showAll && inRepo) {
    console.log('  Use --all for a cross-repo standup.');
  }
  console.log('');
}

/**
 * Like extractSection but without the 120-char truncation used for status tables.
 * Returns full paragraph text for standup display.
 */
function extractStandupSection(lines, headers) {
  for (const header of headers) {
    const idx = lines.findIndex(l => {
      const match = l.match(/^#{2,3}\s+(.+)$/);
      return match && match[1].trim() === header;
    });
    if (idx === -1) continue;

    const para = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^#{1,3}\s/.test(line)) break;
      if (line.trim() === '' && para.length > 0) break;
      if (line.trim() === '') continue;
      para.push(line.trim());
    }

    if (para.length === 0) continue;

    let text = para.join(' ');
    text = text.replace(/\*\*/g, '').replace(/`/g, '');
    return text;
  }
  return '';
}

// ── Update command ─────────────────────────────────────────────────────────

/**
 * Re-sync hooks and commands from the installed Wayfind package to ~/.claude/.
 * Copies hook scripts and slash-command files, overwriting stale copies.
 */
function runUpdate() {
  const specDir = path.join(ROOT, 'specializations', 'claude-code');
  const hooksDir = path.join(HOME, '.claude', 'hooks');
  const commandsDir = path.join(HOME, '.claude', 'commands');

  // Ensure target dirs exist
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
  if (!fs.existsSync(commandsDir)) fs.mkdirSync(commandsDir, { recursive: true });

  let updated = 0;
  let skipped = 0;

  // Hook files to sync
  const hookFiles = ['check-global-state.sh', 'session-end.sh'];
  const sourceHooksDir = path.join(specDir, 'hooks');

  for (const file of hookFiles) {
    const src = path.join(sourceHooksDir, file);
    const dest = path.join(hooksDir, file);
    if (!fs.existsSync(src)) continue;

    const srcContent = fs.readFileSync(src, 'utf8');
    const destContent = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';

    if (srcContent === destContent) {
      skipped++;
      continue;
    }

    fs.writeFileSync(dest, srcContent);
    fs.chmodSync(dest, 0o755);
    console.log(`  Updated: ${file}`);
    updated++;
  }

  // Command files to sync
  const sourceCommandsDir = path.join(specDir, 'commands');
  if (fs.existsSync(sourceCommandsDir)) {
    const cmdFiles = fs.readdirSync(sourceCommandsDir).filter(f => f.endsWith('.md'));
    for (const file of cmdFiles) {
      const src = path.join(sourceCommandsDir, file);
      const dest = path.join(commandsDir, file);

      const srcContent = fs.readFileSync(src, 'utf8');
      const destContent = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';

      if (srcContent === destContent) {
        skipped++;
        continue;
      }

      fs.writeFileSync(dest, srcContent);
      console.log(`  Updated: ${file}`);
      updated++;
    }
  }

  // Write version marker
  const versionFile = path.join(HOME, '.claude', 'team-context', '.wayfind-version');
  try {
    const pkg = require(path.join(ROOT, 'package.json'));
    const versionDir = path.dirname(versionFile);
    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(versionFile, pkg.version);
  } catch { /* ignore */ }

  if (updated > 0) {
    console.log(`\n  ${updated} file(s) updated, ${skipped} already current.`);
  } else {
    console.log('  Everything up to date.');
  }
}

// ── Migrate to plugin ───────────────────────────────────────────────────────

function runMigrateToPlugin(args) {
  const dryRun = args.includes('--dry-run');
  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  const hooksDir = path.join(HOME, '.claude', 'hooks');
  const commandsDir = path.join(HOME, '.claude', 'commands');

  console.log('Wayfind — Migrate to Plugin');
  console.log('===========================\n');

  if (dryRun) console.log('(dry run — no changes will be made)\n');

  let changes = 0;

  // Step 1: Remove hook entries from settings.json
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hooks = settings.hooks || {};
    let hooksModified = false;

    // Remove SessionStart hooks that reference check-global-state
    if (hooks.SessionStart) {
      const before = hooks.SessionStart.length;
      hooks.SessionStart = hooks.SessionStart.filter(group => {
        const cmds = (group.hooks || []);
        return !cmds.some(h => (h.command || '').includes('check-global-state'));
      });
      if (hooks.SessionStart.length === 0) delete hooks.SessionStart;
      if ((hooks.SessionStart || []).length !== before) hooksModified = true;
    }

    // Remove Stop hooks that reference session-end.sh or wayfind reindex
    if (hooks.Stop) {
      const before = hooks.Stop.length;
      hooks.Stop = hooks.Stop.filter(group => {
        const cmds = (group.hooks || []);
        return !cmds.some(h => {
          const cmd = h.command || '';
          return cmd.includes('session-end.sh') || cmd.includes('wayfind reindex') || cmd.includes('team-context.js reindex');
        });
      });
      if (hooks.Stop.length === 0) delete hooks.Stop;
      if ((hooks.Stop || []).length !== before) hooksModified = true;
    }

    if (hooksModified) {
      settings.hooks = hooks;
      if (Object.keys(hooks).length === 0) delete settings.hooks;
      if (!dryRun) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      }
      console.log(`  ${dryRun ? 'Would remove' : 'Removed'} Wayfind hook entries from ~/.claude/settings.json`);
      changes++;
    } else {
      console.log('  No Wayfind hook entries in settings.json (already clean)');
    }
  } else {
    console.log('  No ~/.claude/settings.json found');
  }

  // Step 2: Remove old hook scripts
  const oldHookFiles = ['check-global-state.sh', 'session-end.sh'];
  for (const file of oldHookFiles) {
    const hookPath = path.join(hooksDir, file);
    if (fs.existsSync(hookPath)) {
      if (!dryRun) fs.unlinkSync(hookPath);
      console.log(`  ${dryRun ? 'Would remove' : 'Removed'} ~/.claude/hooks/${file}`);
      changes++;
    }
  }

  // Step 3: Remove old command files (plugin skills replace these)
  const oldCommandFiles = ['init-memory.md', 'init-team.md', 'init-folder.md', 'doctor.md', 'journal.md', 'standup.md', 'review-prs.md'];
  for (const file of oldCommandFiles) {
    const cmdPath = path.join(commandsDir, file);
    if (fs.existsSync(cmdPath)) {
      if (!dryRun) fs.unlinkSync(cmdPath);
      console.log(`  ${dryRun ? 'Would remove' : 'Removed'} ~/.claude/commands/${file}`);
      changes++;
    }
  }

  // Step 4: Summary
  console.log('');
  if (changes === 0) {
    console.log('Nothing to migrate — already clean.');
  } else if (dryRun) {
    console.log(`Would make ${changes} change(s). Run without --dry-run to apply.`);
  } else {
    console.log(`Done — ${changes} change(s) applied.`);
    console.log('');
    console.log('The Wayfind plugin now handles hooks and skills.');
    console.log('Verify with: /wayfind:doctor');
    console.log('');
    console.log('Your old /standup, /doctor, etc. are now /wayfind:standup, /wayfind:doctor, etc.');
    console.log('The CLI (wayfind digest, wayfind reindex, etc.) still works — only hooks and skills moved.');
  }
}

// ── Status command ──────────────────────────────────────────────────────────

function runStatus(args) {
  const doWrite = args.includes('--write');
  const doJson = args.includes('--json');
  const quiet = args.includes('--quiet');

  // Configurable scan roots via env or default
  const envRoots = process.env.AI_MEMORY_SCAN_ROOTS;
  const roots = envRoots
    ? envRoots.split(':').filter(Boolean)
    : rebuildStatus.DEFAULT_ROOTS;

  const stateFiles = rebuildStatus.scanStateFiles(roots);

  if (stateFiles.length === 0 && !quiet) {
    console.log('No state files found.');
    console.log(`Scanned: ${roots.join(', ')}`);
    return;
  }

  const entries = [];
  for (const { stateFile } of stateFiles) {
    const parsed = rebuildStatus.parseStateFile(stateFile);
    if (parsed) entries.push(parsed);
  }

  if (doJson) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  const table = rebuildStatus.buildStatusTable(entries);

  if (doWrite) {
    const globalPath = process.env.TEAM_CONTEXT_GLOBAL_STATE || rebuildStatus.DEFAULT_GLOBAL_STATE;
    try {
      const result = rebuildStatus.updateGlobalState(globalPath, table);
      if (!quiet) {
        console.log(`Active Projects rebuilt in ${result.path} (${entries.length} repos)`);
      }
    } catch (err) {
      if (!quiet) {
        console.error(`Error: ${err.message}`);
      }
      process.exit(1);
    }
    return;
  }

  // Default: print to stdout
  if (!quiet) {
    console.log('');
    console.log('Cross-project status:');
    console.log('');
    console.log(table);
    console.log('');
    console.log(`${entries.length} repos scanned from: ${roots.join(', ')}`);
    console.log('');
  }
}

// ── Bot command ─────────────────────────────────────────────────────────────

async function runBot(args) {
  // --configure: interactive setup
  if (args.includes('--configure')) {
    const botConfig = await slackBot.configure();
    const config = readConnectorsConfig();
    config.slack_bot = botConfig;
    writeConnectorsConfig(config);
    console.log('Slack bot configuration saved to connectors.json.');
    return;
  }

  // Default: start the bot
  const config = readConnectorsConfig();
  if (!config.slack_bot) {
    console.error('Slack bot is not configured. Run "wayfind bot --configure" first.');
    process.exit(1);
  }

  // Validate tokens are in environment
  const botTokenEnv = config.slack_bot.bot_token_env || 'SLACK_BOT_TOKEN';
  const appTokenEnv = config.slack_bot.app_token_env || 'SLACK_APP_TOKEN';

  if (!process.env[botTokenEnv]) {
    console.error(`Error: ${botTokenEnv} is not set.`);
    console.error('Run "wayfind bot --configure" to save your tokens.');
    process.exit(1);
  }
  if (!process.env[appTokenEnv]) {
    console.error(`Error: ${appTokenEnv} is not set.`);
    console.error('Run "wayfind bot --configure" to save your tokens.');
    process.exit(1);
  }

  // Check content store has entries (warn if empty)
  const index = contentStore.loadIndex(
    config.slack_bot.store_path || contentStore.resolveStorePath()
  );
  if (!index || index.entryCount === 0) {
    console.log('Warning: Content store is empty. Run "wayfind index-journals" first for best results.');
    console.log('The bot will still work but may not find relevant results.');
    console.log('');
  }

  // Check LLM config
  const llmConfig = config.slack_bot.llm || {};
  if (llmConfig.api_key_env && !process.env[llmConfig.api_key_env]) {
    console.error(`Error: ${llmConfig.api_key_env} is not set.`);
    console.error('The bot needs an LLM API key for answer synthesis.');
    console.error('Run "wayfind bot --configure" or set the key in your environment.');
    process.exit(1);
  }

  console.log('Starting Wayfind Slack bot...');
  console.log(`Mode: ${config.slack_bot.mode || 'local'}`);
  console.log('');
  await slackBot.start(config.slack_bot);
}

// ── Context command ─────────────────────────────────────────────────────────

const CONTEXT_CONFIG_FILE = path.join(WAYFIND_DIR, 'context.json');

function readContextConfig() {
  const raw = readJSONFile(CONTEXT_CONFIG_FILE) || {};
  // Auto-migrate legacy single-team format → multi-team registry
  if (raw.repo_path && !raw.teams) {
    const team = readJSONFile(TEAM_FILE) || {};
    const teamId = team.id || team.teamId || 'default';
    const teamName = team.name || 'default';
    const migrated = {
      teams: {
        [teamId]: { path: raw.repo_path, name: teamName, configured_at: raw.configured_at || new Date().toISOString() },
      },
      default: teamId,
      _migrated_from_repo_path: raw.repo_path,
    };
    writeContextConfig(migrated);
    return migrated;
  }
  return raw;
}

function writeContextConfig(config) {
  ensureWayfindDir();
  fs.writeFileSync(CONTEXT_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Read repo-level team binding from .claude/wayfind.json in cwd.
 * @returns {string|null} Team ID or null
 */
function readRepoTeamBinding() {
  const bindingFile = path.join(process.cwd(), '.claude', 'wayfind.json');
  const binding = readJSONFile(bindingFile);
  return binding ? binding.team_id : null;
}

/**
 * Write repo-level team binding to .claude/wayfind.json in cwd.
 * Also ensures .claude/wayfind.json is gitignored.
 * @param {string} teamId
 */
function writeRepoTeamBinding(teamId) {
  const claudeDir = path.join(process.cwd(), '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const bindingFile = path.join(claudeDir, 'wayfind.json');
  const existing = readJSONFile(bindingFile) || {};
  existing.team_id = teamId;
  existing.bound_at = new Date().toISOString();
  fs.writeFileSync(bindingFile, JSON.stringify(existing, null, 2) + '\n');

  // Ensure gitignored
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    if (!content.includes('.claude/wayfind.json')) {
      fs.appendFileSync(gitignorePath, '\n.claude/wayfind.json\n');
    }
  }
}

/**
 * Resolve the team-context repo path.
 * Priority: 1) repo-level .claude/wayfind.json team binding
 *           2) explicit teamId parameter
 *           3) default team from context.json
 *           4) legacy repo_path fallback
 * @param {string} [teamId] - Explicit team ID override
 * @returns {string|null}
 */
function getTeamContextPath(teamId) {
  const config = readContextConfig();

  // Legacy fallback
  if (!config.teams) {
    return config.repo_path || null;
  }

  // Check repo-level team binding if no explicit teamId
  if (!teamId) {
    const repoBinding = readRepoTeamBinding();
    if (repoBinding) teamId = repoBinding;
  }

  // Fall back to default team
  if (!teamId) teamId = config.default;
  if (!teamId) return null;

  const team = config.teams[teamId];
  return team ? team.path : null;
}

/**
 * Compare two semver strings. Returns -1, 0, or 1.
 */
function compareSemver(a, b) {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

/**
 * Stamp the current user's version and last_active timestamp into their
 * member profile in the team-context repo. Called during journal sync.
 */
function stampMemberVersion(teamContextPath) {
  const profile = readJSONFile(PROFILE_FILE);
  if (!profile || !profile.name) return;

  const slug = profile.name.toLowerCase().replace(/\s+/g, '-');
  const memberFile = path.join(teamContextPath, 'members', `${slug}.json`);
  if (!fs.existsSync(memberFile)) return;

  const member = readJSONFile(memberFile);
  if (!member) return;

  const version = telemetry.getWayfindVersion();
  const now = new Date().toISOString();

  // Only write if something changed
  if (member.wayfind_version === version && member.last_active && member.last_active.slice(0, 10) === now.slice(0, 10)) {
    return;
  }

  member.wayfind_version = version;
  member.last_active = now;
  fs.writeFileSync(memberFile, JSON.stringify(member, null, 2) + '\n');
}

/**
 * Read min_version from the team-context repo's wayfind.json.
 * @param {string} [teamId] - Specific team, or default
 * @returns {string|null}
 */
function getTeamMinVersion(teamId) {
  const repoPath = getTeamContextPath(teamId);
  if (!repoPath) return null;
  const sharedConfig = readJSONFile(path.join(repoPath, 'wayfind.json'));
  return sharedConfig ? sharedConfig.min_version || null : null;
}

/**
 * Check installed version against team min_version.
 * Returns { ok, installed, required } or null if no min_version set.
 */
function checkMinVersion(teamId) {
  const minVersion = getTeamMinVersion(teamId);
  if (!minVersion) return null;
  const installed = telemetry.getWayfindVersion();
  return {
    ok: compareSemver(installed, minVersion) >= 0,
    installed,
    required: minVersion,
  };
}

function syncMemberToRegistry(profile, teamId) {
  const repoPath = getTeamContextPath();
  if (!repoPath) {
    console.log('  (No team-context repo configured — skipping central registry)');
    return;
  }

  const slug = profile.name.toLowerCase().replace(/\s+/g, '-');
  const membersDir = path.join(repoPath, 'members');
  fs.mkdirSync(membersDir, { recursive: true });

  const memberFile = path.join(membersDir, `${slug}.json`);
  const memberData = {
    name: profile.name,
    personas: profile.personas,
    joined: profile.created || new Date().toISOString(),
    teamId,
    wayfind_version: telemetry.getWayfindVersion(),
    last_active: new Date().toISOString(),
  };
  if (profile.slack_user_id) {
    memberData.slack_user_id = profile.slack_user_id;
  }
  fs.writeFileSync(memberFile, JSON.stringify(memberData, null, 2) + '\n');

  try {
    const { execSync } = require('child_process');
    execSync(
      `git -C "${repoPath}" pull --rebase 2>/dev/null; git -C "${repoPath}" add "members/${slug}.json" && git -C "${repoPath}" commit -m "Add ${profile.name} to team" && git -C "${repoPath}" push`,
      { stdio: 'pipe' }
    );
    console.log(`  Registered in team registry: members/${slug}.json`);
  } catch {
    console.log('  Could not sync to team registry (git push failed). Your profile is saved locally.');
  }
}

function syncWebhookToTeamContext(digestConfig) {
  const webhookUrl =
    digestConfig && digestConfig.slack && digestConfig.slack.webhook_url;
  if (!webhookUrl) return;

  const repoPath = getTeamContextPath();
  if (!repoPath) return;

  const sharedConfigPath = path.join(repoPath, 'wayfind.json');
  const existing = readJSONFile(sharedConfigPath) || {};
  if (existing.slack_webhook_url === webhookUrl) return; // already in sync

  existing.slack_webhook_url = webhookUrl;
  fs.writeFileSync(sharedConfigPath, JSON.stringify(existing, null, 2) + '\n');

  try {
    const { execSync } = require('child_process');
    execSync(
      `git -C "${repoPath}" add wayfind.json && git -C "${repoPath}" commit -m "Update shared Slack webhook for team announcements" && git -C "${repoPath}" push`,
      { stdio: 'pipe' }
    );
  } catch {
    // Non-fatal — webhook is saved locally in the repo at least
  }
}

function getTeamWebhookUrl() {
  // 1. Local connectors config (creator's machine)
  const config = readConnectorsConfig();
  const localUrl =
    config.digest && config.digest.slack && config.digest.slack.webhook_url;
  if (localUrl) return localUrl;

  // 2. Shared team-context repo config (works for joiners)
  const repoPath = getTeamContextPath();
  if (repoPath) {
    const sharedConfig = readJSONFile(path.join(repoPath, 'wayfind.json'));
    if (sharedConfig && sharedConfig.slack_webhook_url) {
      return sharedConfig.slack_webhook_url;
    }
  }

  return null;
}

async function announceToSlack(profile, teamId) {
  try {
    const webhookUrl = getTeamWebhookUrl();
    if (!webhookUrl) return;

    const personas = Array.isArray(profile.personas)
      ? profile.personas.join(', ')
      : '';
    await slack.postToWebhook(webhookUrl, {
      text: `:wave: *${profile.name}* joined the team — personas: ${personas}`,
    });
    console.log('  Announced in Slack.');
  } catch (err) {
    console.log(`  Slack announcement failed: ${err.message}`);
  }
}

async function runContext(args) {
  const sub = args[0] || 'show';
  const subArgs = args.slice(1);

  switch (sub) {
    case 'init':
      await contextInit(subArgs);
      break;
    case 'sync':
      contextSync();
      break;
    case 'show':
      contextShow();
      break;
    case 'add':
      contextAdd(subArgs);
      break;
    case 'bind':
      contextBind(subArgs);
      break;
    case 'list':
      contextList();
      break;
    case 'default':
      contextSetDefault(subArgs);
      break;
    case 'pull':
      contextPull(subArgs);
      break;
    default:
      console.error(`Unknown context subcommand: ${sub}`);
      console.error('Available: init, sync, show, add, bind, list, default, pull');
      process.exit(1);
  }
}

async function contextInit(args) {
  let repoPath = args[0];

  if (!repoPath) {
    repoPath = await ask('Path to team context repo (e.g. ~/repos/my-org/team-context): ');
  }

  // Expand ~ to HOME
  if (repoPath.startsWith('~')) {
    repoPath = path.join(HOME, repoPath.slice(1));
  }
  repoPath = path.resolve(repoPath);

  if (!fs.existsSync(repoPath)) {
    console.error(`Directory not found: ${repoPath}`);
    process.exit(1);
  }

  const contextDir = path.join(repoPath, 'context');
  if (!fs.existsSync(contextDir)) {
    console.error(`No context/ directory found in ${repoPath}`);
    console.error('Create context/ with .md files (e.g. context/product.md) and try again.');
    process.exit(1);
  }

  const files = fs.readdirSync(contextDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.error('No .md files found in context/');
    process.exit(1);
  }

  // Register in multi-team context config
  const config = readContextConfig();
  const team = readJSONFile(TEAM_FILE) || {};
  const teamId = team.id || team.teamId || 'default';
  const teamName = team.name || 'default';
  if (!config.teams) config.teams = {};
  config.teams[teamId] = {
    path: repoPath,
    name: teamName,
    configured_at: new Date().toISOString(),
  };
  // Set as default if it's the first team
  if (!config.default || Object.keys(config.teams).length === 1) {
    config.default = teamId;
  }
  writeContextConfig(config);

  // Ensure prompts/ directory exists with README
  const promptsDir = path.join(repoPath, 'prompts');
  if (!fs.existsSync(promptsDir)) {
    fs.mkdirSync(promptsDir, { recursive: true });
    const readmeSrc = path.join(ROOT, 'templates', 'prompts-readme.md');
    if (fs.existsSync(readmeSrc)) {
      fs.copyFileSync(readmeSrc, path.join(promptsDir, 'README.md'));
    }
    console.log('Created prompts/ directory with README.');
  }

  console.log(`Team context repo: ${repoPath}`);
  console.log(`Found ${files.length} context file(s):`);
  for (const f of files) {
    console.log(`  ${f}`);
  }
  console.log('');
  console.log('Run "wayfind context sync" in any repo to pull context files.');
}

function contextSync() {
  const repoPath = getTeamContextPath();
  if (!repoPath) {
    console.error('No team context repo configured. Run "wayfind context init <path>" first.');
    process.exit(1);
  }

  const sourceDir = path.join(repoPath, 'context');
  if (!fs.existsSync(sourceDir)) {
    console.error(`context/ directory not found in ${repoPath}`);
    process.exit(1);
  }

  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.log('No context files to sync.');
    return;
  }

  // Target: .claude/context/ in the current repo
  const targetDir = path.join(process.cwd(), '.claude', 'context');
  fs.mkdirSync(targetDir, { recursive: true });

  let synced = 0;
  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dest = path.join(targetDir, file);
    const srcContent = fs.readFileSync(src, 'utf8');

    // Only write if changed
    let existing = '';
    try { existing = fs.readFileSync(dest, 'utf8'); } catch {}
    if (existing === srcContent) {
      console.log(`  ${file} — up to date`);
      continue;
    }

    fs.writeFileSync(dest, srcContent);
    console.log(`  ${file} — synced`);
    synced++;
  }

  // Ensure .claude/context/ is gitignored (it's a copy, not source of truth)
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const entry = '.claude/context/';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    if (!content.split('\n').some(line => line.trim() === entry)) {
      fs.appendFileSync(gitignorePath, `\n# Shared team context (synced by wayfind)\n${entry}\n`);
      console.log('  Added .claude/context/ to .gitignore');
    }
  }

  // Ensure CLAUDE.md references context files
  const claudeMdPath = path.join(process.cwd(), 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
    if (!claudeMd.includes('.claude/context/')) {
      const contextBlock = '\n\n## Shared Team Context\n\n' +
        'Context files synced from the team context repo (run `wayfind context sync` to update):\n' +
        files.map(f => `- \`.claude/context/${f}\``).join('\n') + '\n' +
        '\nThese files are loaded at session start and provide org-wide product, engineering, and strategy context.\n';
      fs.appendFileSync(claudeMdPath, contextBlock);
      console.log('  Added context reference to CLAUDE.md');
    }
  }

  console.log(`\nSynced ${synced} file(s) to .claude/context/`);
}

/**
 * Pull latest from the team-context repo so session state reflects
 * other engineers' recent work. Called by the session-start hook.
 *
 * Behavior:
 *   - Pulls the team-context repo (journals, signals, shared context)
 *   - Skips gracefully if offline, if pull fails, or if repo is dirty
 *   - Does NOT touch the current working repo — devs handle that themselves
 *   - Designed to run within the session-start hook's timeout
 *
 * @param {string[]} args - CLI arguments (--quiet suppresses output)
 */
function contextPull(args) {
  const quiet = args.includes('--quiet');
  const background = args.includes('--background');
  const log = quiet ? () => {} : console.log;

  const teamPath = getTeamContextPath();
  if (!teamPath || !fs.existsSync(path.join(teamPath, '.git'))) {
    if (!quiet) log('[wayfind] No team-context repo configured — skipping pull');
    return;
  }

  const markerFile = path.join(teamPath, '.last-pull');

  if (background) {
    // Fire-and-forget — don't block session start
    const child = require('child_process').spawn(
      process.execPath,
      [__filename, 'context', 'pull', '--quiet'],
      { stdio: 'ignore', detached: true, env: { ...process.env } }
    );
    child.unref();
    return;
  }

  const result = spawnSync('git', ['-C', teamPath, 'pull', '--rebase', '--autostash', '--quiet'], {
    stdio: 'pipe',
    timeout: 10000,
  });

  if (result.status === 0) {
    log('[wayfind] Pulled latest team-context');
    // Mark success — doctor checks this to warn on prolonged failures
    try { fs.writeFileSync(markerFile, new Date().toISOString()); } catch {}
  } else if (result.error && result.error.code === 'ETIMEDOUT') {
    log('[wayfind] Team-context pull timed out — using local state');
  } else {
    const stderr = (result.stderr || '').toString().trim();
    if (stderr && !quiet) {
      console.error(`[wayfind] Team-context pull skipped: ${stderr.split('\n')[0]}`);
    }
  }
}

function contextShow() {
  const config = readContextConfig();
  const repoBinding = readRepoTeamBinding();

  console.log('Team context configuration:');
  if (config.teams && Object.keys(config.teams).length > 0) {
    for (const [id, team] of Object.entries(config.teams)) {
      const isDefault = id === config.default;
      const isBound = id === repoBinding;
      const markers = [isDefault ? 'default' : '', isBound ? 'this repo' : ''].filter(Boolean).join(', ');
      console.log(`  ${team.name} (${id})${markers ? ` [${markers}]` : ''}`);
      console.log(`    Path: ${team.path}`);
      const sourceDir = path.join(team.path, 'context');
      if (fs.existsSync(sourceDir)) {
        const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.md'));
        console.log(`    Context files: ${files.length}`);
      }
    }
  } else {
    console.log('  Not configured. Run "wayfind context init <path>" to set up.');
  }

  // Check current repo
  const localDir = path.join(process.cwd(), '.claude', 'context');
  if (fs.existsSync(localDir)) {
    const local = fs.readdirSync(localDir).filter(f => f.endsWith('.md'));
    console.log(`\nLocal context (.claude/context/):`);
    for (const f of local) {
      console.log(`  ${f}`);
    }
  } else {
    console.log('\nNo local context in this repo. Run "wayfind context sync" to pull.');
  }
}

function contextAdd(args) {
  const teamId = args[0];
  const repoPath = args[1];

  if (!teamId || !repoPath) {
    console.error('Usage: wayfind context add <team-id> <path>');
    console.error('Example: wayfind context add a1b2c3d4 ~/repos/Acme/team-context');
    process.exit(1);
  }

  const resolved = path.resolve(repoPath.replace(/^~/, HOME));
  if (!fs.existsSync(resolved)) {
    console.error(`Directory not found: ${resolved}`);
    process.exit(1);
  }

  const config = readContextConfig();
  if (!config.teams) config.teams = {};

  // Read and update wayfind.json in the repo — write team_id/team_name so joiners
  // can read them without needing to know the ID out of band
  const sharedConfigPath = path.join(resolved, 'wayfind.json');
  const sharedConfig = readJSONFile(sharedConfigPath) || {};
  const teamName = sharedConfig.team_name || teamId;
  if (!sharedConfig.team_id || !sharedConfig.team_name) {
    sharedConfig.team_id = teamId;
    sharedConfig.team_name = teamName;
    try {
      fs.writeFileSync(sharedConfigPath, JSON.stringify(sharedConfig, null, 2) + '\n');
    } catch (err) {
      console.error(`Warning: could not write wayfind.json: ${err.message}`);
    }
  }

  config.teams[teamId] = {
    path: resolved,
    name: teamName,
    configured_at: new Date().toISOString(),
  };
  if (!config.default) config.default = teamId;
  writeContextConfig(config);

  console.log(`Added team "${teamName}" (${teamId})`);
  console.log(`  Path: ${resolved}`);
  if (Object.keys(config.teams).length === 1) {
    console.log('  Set as default (only team).');
  }

  // Generate first search API key if one doesn't exist yet
  const keyFile = path.join(resolved, '.wayfind-api-key');
  if (!fs.existsSync(keyFile)) {
    const key = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(keyFile, key + '\n', 'utf8');
      // Resolve token for git push (CLI context — use gh CLI)
      const token = detectGitHubToken();
      if (token && !process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = token;
      pushApiKey(resolved);
      console.log('  Generated initial search API key → committed to team repo.');
      console.log('  Teammates who join will read it automatically. It rotates daily.');
    } catch (err) {
      console.error(`  Warning: could not generate API key: ${err.message}`);
    }
  }
}

function contextBind(args) {
  const teamId = args[0];
  const config = readContextConfig();

  if (!teamId) {
    // Show current binding
    const binding = readRepoTeamBinding();
    if (binding && config.teams && config.teams[binding]) {
      console.log(`This repo is bound to: ${config.teams[binding].name} (${binding})`);
    } else if (binding) {
      console.log(`This repo is bound to team ID: ${binding} (not found in registry)`);
    } else {
      console.log('This repo has no team binding. Using default team.');
      console.log('Usage: wayfind context bind <team-id>');
    }
    return;
  }

  if (!config.teams || !config.teams[teamId]) {
    console.error(`Team "${teamId}" not found in registry.`);
    console.error('Available teams:');
    if (config.teams) {
      for (const [id, t] of Object.entries(config.teams)) {
        console.error(`  ${t.name} (${id})`);
      }
    }
    process.exit(1);
  }

  writeRepoTeamBinding(teamId);
  console.log(`Bound this repo to: ${config.teams[teamId].name} (${teamId})`);
  console.log('Journals from this repo will sync to that team\'s context repo.');

  // Derive repo label (e.g., "acme/api") and add to the team's bound_repos allowlist.
  const cwdParts = process.cwd().split(path.sep);
  const reposIdx = cwdParts.lastIndexOf('repos');
  const repoLabel = (reposIdx >= 0 && reposIdx + 2 <= cwdParts.length)
    ? cwdParts.slice(reposIdx + 1).join('/')
    : cwdParts[cwdParts.length - 1];

  const team = config.teams[teamId];
  if (!team.bound_repos) team.bound_repos = [];
  if (!team.bound_repos.includes(repoLabel)) {
    team.bound_repos.push(repoLabel);
    writeContextConfig(config);
    console.log(`Added "${repoLabel}" to team scope.`);
  }
}

function contextList() {
  const config = readContextConfig();
  const repoBinding = readRepoTeamBinding();

  if (!config.teams || Object.keys(config.teams).length === 0) {
    console.log('No teams configured. Run "wayfind context init <path>" to set up.');
    return;
  }

  console.log('Registered teams:\n');
  for (const [id, team] of Object.entries(config.teams)) {
    const isDefault = id === config.default;
    const isBound = id === repoBinding;
    const markers = [isDefault ? 'default' : '', isBound ? 'this repo' : ''].filter(Boolean).join(', ');
    console.log(`  ${team.name} (${id})${markers ? `  ← ${markers}` : ''}`);
    console.log(`    ${team.path}`);
  }

  console.log('');
  console.log('Commands:');
  console.log('  wayfind context add <team-id> <path>   Register a new team');
  console.log('  wayfind context bind <team-id>         Bind this repo to a team');
  console.log('  wayfind context default <team-id>      Change default team');
}

function contextSetDefault(args) {
  const teamId = args[0];
  if (!teamId) {
    console.error('Usage: wayfind context default <team-id>');
    process.exit(1);
  }

  const config = readContextConfig();
  if (!config.teams || !config.teams[teamId]) {
    console.error(`Team "${teamId}" not found.`);
    process.exit(1);
  }

  config.default = teamId;
  writeContextConfig(config);
  console.log(`Default team set to: ${config.teams[teamId].name} (${teamId})`);
}

/**
 * Try to detect a GitHub token for container use.
 * Checks: GITHUB_TOKEN env var → `gh auth token` for the team-context remote's org.
 * Returns the token string or null.
 */
function detectGitHubToken() {
  // 1. Already in environment
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // 2. Try gh CLI — use the org-specific account if configured
  try {
    const teamContextPath = getTeamContextPath();
    if (teamContextPath) {
      // Read the remote URL to determine the GitHub org
      const remoteResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
        cwd: teamContextPath, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const remoteUrl = (remoteResult.stdout || '').toString().trim();
      const orgMatch = remoteUrl.match(/github\.com[:/]([^/]+)\//);
      if (orgMatch) {
        // Check org-accounts.json for the right gh account
        const orgAccountsFile = path.join(HOME, '.config', 'gh', 'org-accounts.json');
        let ghUser = null;
        try {
          const orgAccounts = JSON.parse(fs.readFileSync(orgAccountsFile, 'utf8'));
          ghUser = orgAccounts[orgMatch[1]] || null;
        } catch { /* no org-accounts mapping */ }

        // Get token for the right account
        const ghArgs = ghUser ? ['auth', 'token', '--user', ghUser] : ['auth', 'token'];
        const result = spawnSync('gh', ghArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        const token = (result.stdout || '').toString().trim();
        if (token && result.status === 0) return token;
      }
    }

    // Fallback: default gh auth token
    const result = spawnSync('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const token = (result.stdout || '').toString().trim();
    if (token && result.status === 0) return token;
  } catch { /* gh not installed or not authenticated */ }

  return null;
}

// ── Prompts command ─────────────────────────────────────────────────────────

function runPrompts(args) {
  // Find prompts directory
  const teamDir = process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR || '';
  let promptsDir = teamDir ? path.join(teamDir, 'prompts') : '';

  // Fallback: check context config for team context repo path
  if (!promptsDir || !fs.existsSync(promptsDir)) {
    const configDir = getTeamContextPath() || '';
    if (configDir) promptsDir = path.join(configDir, 'prompts');
  }

  // Fallback: check connectors config for team_context_dir
  if (!promptsDir || !fs.existsSync(promptsDir)) {
    const config = readConnectorsConfig();
    const configDir = (config.digest && config.digest.team_context_dir) || '';
    if (configDir) promptsDir = path.join(configDir, 'prompts');
  }

  if (!promptsDir || !fs.existsSync(promptsDir)) {
    console.log('No prompts directory found. Create a prompts/ directory in your team-context repo.');
    return;
  }

  const files = fs.readdirSync(promptsDir)
    .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();

  // Show specific prompt
  const name = args.filter(a => !a.startsWith('-')).join(' ').trim();
  if (name) {
    const match = files.find(f =>
      f === name ||
      f === name + '.md' ||
      f.replace('.md', '') === name
    );
    if (!match) {
      console.log(`Prompt "${name}" not found. Available: ${files.map(f => f.replace('.md', '')).join(', ')}`);
      return;
    }
    const content = fs.readFileSync(path.join(promptsDir, match), 'utf8');
    telemetry.capture('prompt_viewed', { prompt_name: match.replace('.md', '') }, CLI_USER);
    console.log(content);
    return;
  }

  // List all prompts
  if (files.length === 0) {
    console.log('No prompts yet. Add .md files to your team-context/prompts/ directory.');
    return;
  }

  telemetry.capture('prompts_listed', { prompt_count: files.length }, CLI_USER);
  console.log('Available prompts:\n');
  for (const file of files) {
    const content = fs.readFileSync(path.join(promptsDir, file), 'utf8');
    const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#')) || '';
    const label = file.replace('.md', '');
    console.log(`  ${label}`);
    if (firstLine.trim()) {
      console.log(`    ${firstLine.trim()}`);
    }
  }
  console.log(`\nRun "wayfind prompts <name>" to view a specific prompt.`);
}

// ── Deploy command ──────────────────────────────────────────────────────────

const DEPLOY_TEMPLATES_DIR = path.join(ROOT, 'templates', 'deploy');

async function runDeploy(args) {
  // Parse --team <teamId> flag
  const teamIdx = args.indexOf('--team');
  const teamId = teamIdx !== -1 ? args[teamIdx + 1] : null;
  const portIdx = args.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : null;

  const filteredArgs = args.filter((a, i) => {
    if (a === '--team' || a === '--port') return false;
    if (i > 0 && (args[i - 1] === '--team' || args[i - 1] === '--port')) return false;
    return true;
  });
  const sub = filteredArgs[0] || 'init';

  switch (sub) {
    case 'init':
      if (teamId) {
        deployTeamInit(teamId, { port });
      } else {
        deployInit();
      }
      break;
    case 'list':
      deployList();
      break;
    case 'status':
      deployStatus();
      break;
    case 'set-endpoint': {
      const endpointTeamId = teamId || (readContextConfig().default);
      const endpointUrl = filteredArgs[1];
      if (!endpointTeamId || !endpointUrl) {
        console.error('Usage: wayfind deploy set-endpoint <url> --team <id>');
        console.error('Example: wayfind deploy set-endpoint http://gregs-laptop:3141 --team abc123');
        process.exit(1);
      }
      const cfg = readContextConfig();
      if (!cfg.teams || !cfg.teams[endpointTeamId]) {
        console.error(`Team "${endpointTeamId}" not found in context.json`);
        process.exit(1);
      }
      cfg.teams[endpointTeamId].container_endpoint = endpointUrl;
      writeContextConfig(cfg);
      console.log(`Set container_endpoint for team "${endpointTeamId}" to ${endpointUrl}`);
      break;
    }
    default:
      console.error(`Unknown deploy subcommand: ${sub}`);
      console.error('Available: init [--team <id>], list, status, set-endpoint');
      process.exit(1);
  }
}

/**
 * Scaffold a per-team container config in the team's registered repo (deploy/ subdir).
 * Falls back to ~/.claude/team-context/teams/<teamId>/deploy/ if no repo is registered.
 */
function deployTeamInit(teamId, { port } = {}) {
  if (!HOME) {
    console.error('Cannot resolve home directory.');
    process.exit(1);
  }

  // Resolve deploy dir: team repo path first, fallback to store-adjacent
  const config = readContextConfig();
  const teamEntry = config.teams && config.teams[teamId];
  const teamContextPath = teamEntry ? teamEntry.path : null;
  const deployDir = teamContextPath
    ? path.join(teamContextPath, 'deploy')
    : path.join(HOME, '.claude', 'team-context', 'teams', teamId, 'deploy');

  // Ensure the per-team store dir exists
  const storeDir = path.join(HOME, '.claude', 'team-context', 'teams', teamId, 'content-store');

  // Check for duplicate running container
  const psResult = spawnSync('docker', ['ps', '--filter', `label=com.wayfind.team=${teamId}`, '--format', '{{.Names}}'], { stdio: 'pipe' });
  const running = (psResult.stdout || '').toString().trim();
  if (running) {
    console.log(`Warning: container already running for team "${teamId}": ${running}`);
    console.log('Use "docker compose down" in the deploy directory before re-initializing.');
    process.exit(1);
  }

  fs.mkdirSync(deployDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  console.log(`Scaffolding deploy config for team: ${teamId}`);
  console.log(`Deploy dir: ${deployDir}`);

  // Auto-detect port: find all wayfind containers, pick next available
  const containerName = `wayfind-${teamId}`;
  let assignedPort = port;
  if (!assignedPort) {
    const usedPorts = new Set();
    // Check labeled containers
    const portsResult = spawnSync('docker', [
      'ps', '--filter', 'label=com.wayfind.team',
      '--format', '{{.Ports}}',
    ], { stdio: 'pipe' });
    // Also check legacy container named "wayfind"
    const legacyPortsResult = spawnSync('docker', [
      'ps', '--filter', 'name=^wayfind',
      '--format', '{{.Ports}}',
    ], { stdio: 'pipe' });
    const allPortOutput = [
      (portsResult.stdout || '').toString(),
      (legacyPortsResult.stdout || '').toString(),
    ].join('\n');
    // Extract host ports from "0.0.0.0:3141->3141/tcp" patterns
    for (const match of allPortOutput.matchAll(/:(\d+)->/g)) {
      usedPorts.add(parseInt(match[1], 10));
    }
    assignedPort = 3141;
    while (usedPorts.has(assignedPort)) assignedPort++;
    if (assignedPort !== 3141) {
      console.log(`Port 3141 in use — assigning port ${assignedPort}`);
    }
  }

  // Build docker-compose.yml content with per-team overrides
  const templatePath = path.join(DEPLOY_TEMPLATES_DIR, 'docker-compose.yml');
  let composeContent = fs.readFileSync(templatePath, 'utf8');
  composeContent = composeContent
    .replace(/container_name: wayfind/, `container_name: ${containerName}`)
    .replace(/- "3141:3141"/, `- "${assignedPort}:3141"`)
    .replace(/^(services:)/m, `name: ${containerName}\n\n$1`);

  // Inject Docker label for discovery
  composeContent = composeContent.replace(
    /restart: unless-stopped/,
    `restart: unless-stopped\n    labels:\n      com.wayfind.team: "${teamId}"`
  );

  const composePath = path.join(deployDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) {
    fs.writeFileSync(composePath, composeContent, 'utf8');
    console.log('  docker-compose.yml — created');
  } else {
    console.log('  docker-compose.yml — already exists, skipping');
  }

  // .env.example — full reference with all options
  const envExampleSrc = path.join(DEPLOY_TEMPLATES_DIR, '.env.example');
  const envExampleDst = path.join(deployDir, '.env.example');
  if (!fs.existsSync(envExampleDst) && fs.existsSync(envExampleSrc)) {
    fs.copyFileSync(envExampleSrc, envExampleDst);
    console.log('  .env.example — created (full reference)');
  }

  // .env — minimal seed with only required keys
  const envPath = path.join(deployDir, '.env');
  if (!fs.existsSync(envPath)) {
    const ghToken = detectGitHubToken();
    const lines = [
      '# Wayfind — required configuration',
      '# See .env.example for all available options.',
      '',
      '# Anthropic API key (for digests and bot answers)',
      'ANTHROPIC_API_KEY=sk-ant-your-key',
      '',
      '# GitHub token (for pulling team journals and signals)',
      `GITHUB_TOKEN=${ghToken || ''}`,
      '',
      `TEAM_CONTEXT_TENANT_ID=${teamId}`,
    ];
    // Set volume mount path so docker-compose.yml resolves correctly
    if (teamContextPath) {
      lines.push(`TEAM_CONTEXT_TEAM_CONTEXT_PATH=${teamContextPath}`);
    }
    fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
    console.log('  .env — created (fill in ANTHROPIC_API_KEY)');
    if (ghToken) {
      console.log('  GITHUB_TOKEN — auto-detected from gh CLI');
    }
  } else {
    console.log('  .env — already exists, skipping');
  }

  // Ensure deploy/.env is gitignored if we're in a repo
  if (teamContextPath) {
    const gitignorePath = path.join(teamContextPath, '.gitignore');
    const gitignoreEntry = 'deploy/.env';
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      if (!content.includes(gitignoreEntry)) {
        fs.appendFileSync(gitignorePath, `\n${gitignoreEntry}\n`);
        console.log('  .gitignore — added deploy/.env');
      }
    }
  }

  // Store container_endpoint in context.json so team members' MCP can discover it
  const updatedConfig = readContextConfig();
  if (updatedConfig.teams && updatedConfig.teams[teamId]) {
    updatedConfig.teams[teamId].container_endpoint = `http://localhost:${assignedPort}`;
    writeContextConfig(updatedConfig);
    console.log(`  context.json — set container_endpoint to http://localhost:${assignedPort}`);
    console.log('  Tip: update the hostname if team members connect over a network (e.g. Tailscale).');
  }

  console.log('');
  console.log('Next steps:');
  console.log(`  1. Set ANTHROPIC_API_KEY in ${deployDir}/.env`);
  console.log(`  2. cd "${deployDir}" && docker compose up -d`);
  console.log(`  3. Verify: curl http://localhost:${assignedPort}/healthz`);
  console.log('');
  console.log('See .env.example for optional config (Slack, embeddings, signals, schedules).');
  console.log(`Tip: run "wayfind deploy list" to see all running team containers.`);

  telemetry.capture('deploy_team_init', { teamId }, CLI_USER);
}

/**
 * List all running Wayfind team containers.
 */
function deployList() {
  const psResult = spawnSync('docker', [
    'ps',
    '--filter', 'label=com.wayfind.team',
    '--format', '{{.Names}}\t{{.Status}}\t{{.Label "com.wayfind.team"}}',
  ], { stdio: 'pipe' });

  if (psResult.error) {
    console.log('Docker not available.');
    return;
  }

  const rows = (psResult.stdout || '').toString().trim();
  if (!rows) {
    console.log('No Wayfind team containers running.');
    console.log('Start one with: wayfind deploy --team <teamId>');
    return;
  }

  console.log('Running Wayfind team containers:');
  console.log('');
  for (const row of rows.split('\n')) {
    const [name, status, team] = row.split('\t');
    console.log(`  ${name} (team: ${team || 'unknown'}) — ${status}`);
  }
}

function deployInit() {
  const deployDir = path.join(process.cwd(), 'deploy');

  if (fs.existsSync(deployDir)) {
    console.log('deploy/ directory already exists. Checking for missing files...');
  } else {
    fs.mkdirSync(deployDir, { recursive: true });
    console.log('Created deploy/ directory.');
  }

  // Copy template files
  const files = ['docker-compose.yml', '.env.example', 'slack-app-manifest.json'];
  let copied = 0;
  for (const file of files) {
    const dest = path.join(deployDir, file);
    if (fs.existsSync(dest)) {
      console.log(`  ${file} — already exists, skipping`);
      continue;
    }
    const src = path.join(DEPLOY_TEMPLATES_DIR, file);
    fs.copyFileSync(src, dest);
    console.log(`  ${file} — created`);
    copied++;
  }

  // Pre-fill .env.example with values from connectors.json if available
  if (copied > 0 && fs.existsSync(CONNECTORS_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONNECTORS_FILE, 'utf8'));
      const envPath = path.join(deployDir, '.env.example');
      let envContent = fs.readFileSync(envPath, 'utf8');

      // Substitute placeholder values with real env var names from config
      if (config.slack_bot) {
        const botEnv = config.slack_bot.bot_token_env || 'SLACK_BOT_TOKEN';
        const appEnv = config.slack_bot.app_token_env || 'SLACK_APP_TOKEN';
        if (process.env[botEnv]) {
          envContent = envContent.replace('SLACK_BOT_TOKEN=xoxb-your-bot-token', `SLACK_BOT_TOKEN=${process.env[botEnv]}`);
        }
        if (process.env[appEnv]) {
          envContent = envContent.replace('SLACK_APP_TOKEN=xapp-your-app-token', `SLACK_APP_TOKEN=${process.env[appEnv]}`);
        }
      }
      if (config.slack_bot && config.slack_bot.llm && config.slack_bot.llm.api_key_env) {
        const apiEnv = config.slack_bot.llm.api_key_env;
        if (process.env[apiEnv]) {
          envContent = envContent.replace('ANTHROPIC_API_KEY=sk-ant-your-key', `ANTHROPIC_API_KEY=${process.env[apiEnv]}`);
        }
      }

      // Auto-detect GITHUB_TOKEN from gh CLI (needed for container git pull)
      const ghToken = detectGitHubToken();
      if (ghToken) {
        envContent = envContent.replace('GITHUB_TOKEN=', `GITHUB_TOKEN=${ghToken}`);
      }

      fs.writeFileSync(envPath, envContent, 'utf8');
    } catch (e) {
      // Non-fatal — pre-fill is best-effort
    }
  }

  // Ensure deploy/.env is in .gitignore
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const gitignoreEntry = 'deploy/.env';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    if (!content.split('\n').some(line => line.trim() === gitignoreEntry)) {
      fs.appendFileSync(gitignorePath, `\n${gitignoreEntry}\n`);
      console.log('  Added deploy/.env to .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, `${gitignoreEntry}\n`);
    console.log('  Created .gitignore with deploy/.env');
  }

  // Auto-create .env from .env.example if it doesn't exist
  const envPath = path.join(deployDir, '.env');
  const envExamplePath = path.join(deployDir, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    console.log('  .env — created from .env.example (fill in your tokens)');
  }

  // Ensure GITHUB_TOKEN is set in .env (needed for container journal sync)
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    const hasToken = envContent.split('\n').some(l => {
      const trimmed = l.trim();
      return trimmed.startsWith('GITHUB_TOKEN=') && trimmed !== 'GITHUB_TOKEN=' && !trimmed.startsWith('#');
    });
    if (!hasToken) {
      const ghToken = detectGitHubToken();
      if (ghToken) {
        envContent = envContent.replace(/^GITHUB_TOKEN=.*$/m, `GITHUB_TOKEN=${ghToken}`);
        // If no GITHUB_TOKEN line exists at all, append it
        if (!envContent.includes('GITHUB_TOKEN=')) {
          envContent += `\nGITHUB_TOKEN=${ghToken}\n`;
        }
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log('  GITHUB_TOKEN — auto-detected from gh CLI');
      } else {
        console.log('  GITHUB_TOKEN — not detected. Set it in deploy/.env for journal sync.');
      }
    }
  }

  console.log('');
  console.log('Next steps:');
  console.log('');
  console.log('  1. Create your Slack app:');
  console.log('     Go to api.slack.com/apps → Create New App → From a manifest');
  console.log('     Paste the contents of deploy/slack-app-manifest.json');
  console.log('');
  console.log('  2. Get your tokens:');
  console.log('     Bot token (xoxb-): OAuth & Permissions → Bot User OAuth Token');
  console.log('     App token (xapp-): Basic Information → App-Level Tokens → Generate');
  console.log('       (add the "connections:write" scope when generating)');
  console.log('');
  console.log('  3. Fill in deploy/.env with your tokens');
  console.log('');
  console.log('  4. Start the services:');
  console.log('     cd deploy && docker compose up -d');
  console.log('');
  console.log('  5. Verify:');
  console.log('     curl http://localhost:3141/healthz');
  console.log('');

  telemetry.capture('deploy_init_completed', { has_github_token: !!detectGitHubToken(), has_embeddings: !!(process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT) }, CLI_USER);
}

function deployStatus() {
  const deployDir = path.join(process.cwd(), 'deploy');
  const envPath = path.join(deployDir, '.env');

  if (!fs.existsSync(deployDir)) {
    console.log('No deploy/ directory found. Run "wayfind deploy init" first.');
    process.exit(1);
  }

  console.log('Deploy files:');
  const files = ['docker-compose.yml', '.env.example', '.env', 'slack-app-manifest.json'];
  for (const file of files) {
    const exists = fs.existsSync(path.join(deployDir, file));
    console.log(`  ${file}: ${exists ? 'present' : 'MISSING'}`);
  }

  if (!fs.existsSync(envPath)) {
    console.log('');
    console.log('.env not found. Copy the example and fill in your values:');
    console.log('  cp deploy/.env.example deploy/.env');
    return;
  }

  // Parse .env and show what's configured vs missing
  console.log('');
  console.log('Configuration:');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'];
  const optional = ['TEAM_CONTEXT_TENANT_ID', 'SLACK_DIGEST_CHANNEL', 'TEAM_CONTEXT_ENCRYPTION_KEY'];

  const envVars = {};
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    envVars[key] = val;
  }

  console.log('  Required:');
  for (const key of required) {
    const val = envVars[key];
    const isPlaceholder = !val || val.includes('your-');
    console.log(`    ${key}: ${isPlaceholder ? 'NOT SET' : 'configured'}`);
  }
  console.log('  Optional:');
  for (const key of optional) {
    const val = envVars[key];
    console.log(`    ${key}: ${val ? 'configured' : 'not set'}`);
  }
}

// ── API key management ──────────────────────────────────────────────────────

/**
 * Read or generate the API key for container search endpoints.
 * Key is stored in the team-context repo so team members can read it.
 */
function getOrCreateApiKey() {
  const teamDir = process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR;
  if (!teamDir) return null;

  const keyFile = path.join(teamDir, '.wayfind-api-key');
  try {
    if (fs.existsSync(keyFile)) {
      const key = fs.readFileSync(keyFile, 'utf8').trim();
      if (key.length >= 32) return key;
    }
  } catch (_) {}

  // Generate a new key
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFile, key + '\n', 'utf8');
    console.log(`[${new Date().toISOString()}] Generated new API key in ${keyFile}`);
  } catch (err) {
    console.error(`Failed to write API key: ${err.message}`);
    return null;
  }
  return key;
}

/**
 * Rotate the API key and commit/push it to the team-context repo.
 */
function rotateApiKey() {
  const teamDir = process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR;
  if (!teamDir) return;

  const key = crypto.randomBytes(32).toString('hex');
  const keyFile = path.join(teamDir, '.wayfind-api-key');
  try {
    fs.writeFileSync(keyFile, key + '\n', 'utf8');
    currentApiKey = key;
    console.log(`[${new Date().toISOString()}] Rotated API key`);
    pushApiKey(teamDir);
  } catch (err) {
    console.error(`Key rotation failed: ${err.message}`);
  }
}

/**
 * Git add/commit/push the API key file.
 */
function pushApiKey(teamDir) {
  const token = process.env.GITHUB_TOKEN;
  const env = { ...process.env };
  const gitConfig = [['safe.directory', teamDir]];
  if (token) {
    env.GIT_ASKPASS = 'echo';
    env.GIT_TERMINAL_PROMPT = '0';
    gitConfig.push(['credential.helper', '']);
    gitConfig.push([`url.https://x-access-token:${token}@github.com/.insteadOf`, 'https://github.com/']);
  }
  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  for (let i = 0; i < gitConfig.length; i++) {
    env[`GIT_CONFIG_KEY_${i}`] = gitConfig[i][0];
    env[`GIT_CONFIG_VALUE_${i}`] = gitConfig[i][1];
  }

  try {
    spawnSync('git', ['add', '.wayfind-api-key'], { cwd: teamDir, env, stdio: 'pipe' });
    const diff = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: teamDir, env, stdio: 'pipe' });
    if (diff.status === 0) return; // Nothing to commit
    spawnSync('git', ['commit', '-m', 'Rotate Wayfind API key'], { cwd: teamDir, env, stdio: 'pipe' });
    const push = spawnSync('git', ['push'], { cwd: teamDir, env, stdio: 'pipe', timeout: 30000 });
    if (push.status !== 0) {
      // Rebase and retry on conflict
      spawnSync('git', ['pull', '--rebase'], { cwd: teamDir, env, stdio: 'pipe', timeout: 30000 });
      spawnSync('git', ['push'], { cwd: teamDir, env, stdio: 'pipe', timeout: 30000 });
    }
  } catch (err) {
    console.error(`API key push failed: ${err.message}`);
  }
}

// Current in-memory API key (loaded on startup, updated on rotation)
let currentApiKey = null;

// ── Health + API endpoint ───────────────────────────────────────────────────

let healthStatus = { ok: true, mode: null, started: null, services: {} };

/**
 * Parse JSON body from an incoming request.
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * Check Authorization header against the current API key.
 * Returns true if authorized, false otherwise (and sends 401).
 */
function checkApiAuth(req, res) {
  if (!currentApiKey) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API key not configured' }));
    return false;
  }
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token !== currentApiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired API key' }));
    return false;
  }
  return true;
}

function startHealthServer() {
  const port = parseInt(process.env.TEAM_CONTEXT_HEALTH_PORT || '3141', 10);

  // Load API key for search endpoints
  const teamDir = process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR;
  const keyExisted = teamDir && fs.existsSync(path.join(teamDir, '.wayfind-api-key'));
  currentApiKey = getOrCreateApiKey();
  if (currentApiKey) {
    console.log('API search endpoints enabled (key loaded)');
    // Push newly generated key so team members can pull it
    if (!keyExisted && teamDir) pushApiKey(teamDir);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/healthz' && req.method === 'GET') {
      // Enrich with index freshness
      const storePath = contentStore.resolveStorePath();
      const index = contentStore.loadIndex(storePath);
      const indexInfo = index ? {
        entryCount: index.entryCount || 0,
        lastUpdated: index.lastUpdated ? new Date(index.lastUpdated).toISOString() : null,
        stale: index.lastUpdated ? (Date.now() - index.lastUpdated > 2 * 60 * 60 * 1000) : true,
      } : { entryCount: 0, lastUpdated: null, stale: true };

      // Check Slack WebSocket connection if bot is expected to be running
      const slackStatus = slackBot.getConnectionStatus();
      const botExpected = healthStatus.services.bot === 'running';
      const slackHealthy = !botExpected || slackStatus.connected;

      const response = {
        ...healthStatus,
        index: indexInfo,
        slack: slackStatus,
        api: { enabled: !!currentApiKey },
      };
      const status = (healthStatus.ok && slackHealthy) ? 200 : 503;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    // ── Search API: POST /api/search ──
    if (url.pathname === '/api/search' && req.method === 'POST') {
      if (!checkApiAuth(req, res)) return;
      try {
        const body = await parseJsonBody(req);
        const { query, limit = 10, repo, since, mode } = body;
        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'query is required' }));
          return;
        }

        const opts = { limit, repo, since };
        let results;
        if (mode === 'text') {
          results = contentStore.searchText(query, opts);
        } else {
          results = await contentStore.searchJournals(query, opts);
        }

        const mapped = (results || []).map(r => ({
          id: r.id,
          score: r.score ? Math.round(r.score * 1000) / 1000 : null,
          date: r.entry.date,
          repo: r.entry.repo,
          title: r.entry.title,
          source: r.entry.source,
          tags: r.entry.tags || [],
          summary: r.entry.summary || null,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: mapped.length, results: mapped }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── Entry API: GET /api/entry/:id ──
    if (url.pathname.startsWith('/api/entry/') && req.method === 'GET') {
      if (!checkApiAuth(req, res)) return;
      try {
        const id = decodeURIComponent(url.pathname.slice('/api/entry/'.length));
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'entry id is required' }));
          return;
        }

        const storePath = contentStore.resolveStorePath();
        const journalDir = process.env.TEAM_CONTEXT_JOURNALS_DIR || contentStore.DEFAULT_JOURNAL_DIR;
        const index = contentStore.getBackend(storePath).loadIndex();

        if (!index || !index.entries || !index.entries[id]) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Entry not found: ${id}` }));
          return;
        }

        const entry = index.entries[id];
        const fullContent = contentStore.getEntryContent(id, { storePath, journalDir });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id,
          date: entry.date,
          repo: entry.repo,
          title: entry.title,
          source: entry.source,
          tags: entry.tags || [],
          content: fullContent || entry.summary || null,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => {
    console.log(`Health + API endpoint: http://0.0.0.0:${port}/healthz`);
    if (currentApiKey) {
      console.log(`  Search API: POST http://0.0.0.0:${port}/api/search`);
      console.log(`  Entry API:  GET  http://0.0.0.0:${port}/api/entry/:id`);
    }
  });
  return server;
}

// ── Start command (Docker entrypoint) ───────────────────────────────────────

async function runStart() {
  const mode = process.env.TEAM_CONTEXT_MODE || 'all-in-one';
  console.log(`Wayfind starting in ${mode} mode`);

  // Validate required env vars before proceeding
  const missing = [];
  // Slack tokens are only required for modes that run the bot
  const needsSlack = ['bot', 'all-in-one'].includes(mode) && !process.env.TEAM_CONTEXT_NO_SLACK;
  if (needsSlack && !process.env.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
  if (needsSlack && !process.env.SLACK_APP_TOKEN) missing.push('SLACK_APP_TOKEN');
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length > 0) {
    console.error('');
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('');
    console.error('If running via Docker Compose, create deploy/.env from deploy/.env.example:');
    console.error('  cp deploy/.env.example deploy/.env');
    console.error('  # Fill in your tokens, then: docker compose up -d');
    console.error('');
    console.error('Tip: set TEAM_CONTEXT_NO_SLACK=1 to run without Slack integration.');
    console.error('');
    process.exit(1);
  }

  healthStatus.mode = mode;
  healthStatus.started = new Date().toISOString();
  startHealthServer();

  switch (mode) {
    case 'bot':
      await runStartBot();
      break;

    case 'worker':
      await runStartWorker();
      process.exit(0);
      break;

    case 'scheduler':
      runStartScheduler();
      break;

    case 'all-in-one':
      await runStartAllInOne();
      break;

    default:
      console.error(`Unknown TEAM_CONTEXT_MODE: ${mode}`);
      console.error('Valid modes: bot, worker, scheduler, all-in-one');
      process.exit(1);
  }
}

async function runStartBot() {
  ensureContainerConfig();
  const config = buildBotConfigFromEnv();
  healthStatus.services.bot = 'starting';
  console.log('Starting Slack bot (Socket Mode)...');
  await slackBot.start(config);
  healthStatus.services.bot = 'running';
  console.log('Slack bot connected.');
}

async function runStartWorker() {
  const job = process.env.TEAM_CONTEXT_JOB;
  if (!job) {
    console.error('TEAM_CONTEXT_JOB is required in worker mode.');
    console.error('Valid jobs: digest, pull, index-journals, index-conversations, reindex');
    process.exit(1);
  }

  // Ensure connectors config exists from env vars (no interactive prompts in container)
  ensureContainerConfig();

  healthStatus.services.worker = `running:${job}`;
  console.log(`Running job: ${job}`);

  switch (job) {
    case 'digest':
      await runDigest(buildDigestArgsFromEnv());
      break;
    case 'pull':
      await runPull(['--all']);
      break;
    case 'index-journals':
      await runIndexJournals([]);
      break;
    case 'index-conversations':
      await runIndexConversations([]);
      break;
    case 'reindex':
      await runReindex([]);
      break;
    default:
      console.error(`Unknown job: ${job}`);
      process.exit(1);
  }

  healthStatus.services.worker = `completed:${job}`;
}

function runStartScheduler() {
  const nodeSchedule = (() => {
    // Simple cron-like scheduler using setTimeout
    // Parses standard 5-field cron expressions
    return { schedule: scheduleCron };
  })();

  const digestSchedule = process.env.TEAM_CONTEXT_DIGEST_SCHEDULE || '0 12 * * *';
  const signalSchedule = process.env.TEAM_CONTEXT_SIGNAL_SCHEDULE || '0 6 * * *';

  console.log(`Digest schedule: ${digestSchedule}`);
  console.log(`Signal schedule: ${signalSchedule}`);

  healthStatus.services.scheduler = 'running';

  scheduleCron(digestSchedule, async () => {
    console.log(`[${new Date().toISOString()}] Triggering digest...`);
    try {
      await runDigest(buildDigestArgsFromEnv());
      console.log(`[${new Date().toISOString()}] Digest complete.`);
    } catch (err) {
      console.error(`Digest failed: ${err.message}`);
    }
  });

  scheduleCron(signalSchedule, async () => {
    console.log(`[${new Date().toISOString()}] Triggering signal pull...`);
    try {
      await runPull(['--all']);
      console.log(`[${new Date().toISOString()}] Signal pull complete.`);
    } catch (err) {
      console.error(`Signal pull failed: ${err.message}`);
    }
  });

  // Re-index all sources hourly so the bot sees new entries
  const reindexSchedule = process.env.TEAM_CONTEXT_REINDEX_SCHEDULE || '0 * * * *';
  console.log(`Reindex schedule: ${reindexSchedule}`);
  scheduleCron(reindexSchedule, async () => {
    await pullTeamContext();
    console.log(`[${new Date().toISOString()}] Re-indexing journals...`);
    await indexJournalsIfAvailable();
    console.log(`[${new Date().toISOString()}] Re-indexing conversations...`);
    await indexConversationsIfAvailable();
    console.log(`[${new Date().toISOString()}] Re-indexing signals...`);
    await indexSignalsIfAvailable();
  });

  // Rotate API key daily (default 2am)
  const keyRotateSchedule = process.env.TEAM_CONTEXT_KEY_ROTATE_SCHEDULE || '0 2 * * *';
  console.log(`API key rotation schedule: ${keyRotateSchedule}`);
  scheduleCron(keyRotateSchedule, () => {
    console.log(`[${new Date().toISOString()}] Rotating API key...`);
    rotateApiKey();
  });

  console.log('Scheduler running. Waiting for scheduled events...');
}

/**
 * Pull latest changes from the team-context repo inside the container.
 * Uses GITHUB_TOKEN for HTTPS auth if the remote is GitHub.
 * Skipped silently if TEAM_CONTEXT_TEAM_CONTEXT_DIR is not set or not a git repo.
 */
async function pullTeamContext() {
  const teamDir = process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR;
  if (!teamDir || !fs.existsSync(path.join(teamDir, '.git'))) return;

  const token = process.env.GITHUB_TOKEN;
  const env = { ...process.env };

  // Build git config entries via environment
  const gitConfig = [
    // Mark the mounted directory as safe (owned by host user, not container user)
    ['safe.directory', teamDir],
  ];

  // Configure git to use GITHUB_TOKEN for HTTPS pulls
  if (token) {
    env.GIT_ASKPASS = 'echo';
    env.GIT_TERMINAL_PROMPT = '0';
    gitConfig.push(['credential.helper', '']);
    gitConfig.push([`url.https://x-access-token:${token}@github.com/.insteadOf`, 'https://github.com/']);
  }

  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  for (let i = 0; i < gitConfig.length; i++) {
    env[`GIT_CONFIG_KEY_${i}`] = gitConfig[i][0];
    env[`GIT_CONFIG_VALUE_${i}`] = gitConfig[i][1];
  }

  try {
    const result = spawnSync('git', ['pull', '--ff-only', '-q'], {
      cwd: teamDir,
      env,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      const output = (result.stdout || '').toString().trim();
      if (output && output !== 'Already up to date.') {
        console.log(`[${new Date().toISOString()}] Team context updated: ${output}`);
      }
    } else {
      const stderr = (result.stderr || '').toString().trim();
      console.error(`[${new Date().toISOString()}] git pull failed: ${stderr}`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] git pull error: ${err.message}`);
  }
}

async function indexJournalsIfAvailable() {
  const journalDir = process.env.TEAM_CONTEXT_JOURNALS_DIR || '/data/journals';
  if (!fs.existsSync(journalDir)) {
    console.log(`No journals at ${journalDir} — skipping index.`);
    return;
  }
  const entries = fs.readdirSync(journalDir).filter(f => f.endsWith('.md'));
  if (entries.length === 0) {
    console.log('No journal files found — skipping index.');
    return;
  }
  const hasEmbeddingKey = !!(process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT);
  console.log(`Indexing ${entries.length} journal files from ${journalDir}${hasEmbeddingKey ? ' (with embeddings)' : ''}...`);
  try {
    const stats = await contentStore.indexJournals({
      journalDir,
      embeddings: hasEmbeddingKey,
    });
    console.log(`Indexed ${stats.entryCount} entries (${stats.newEntries} new, ${stats.updatedEntries} updated).`);
  } catch (err) {
    console.error(`Journal indexing failed: ${err.message}`);
  }
}

async function indexConversationsIfAvailable() {
  const projectsDir = process.env.TEAM_CONTEXT_CONVERSATIONS_DIR || contentStore.DEFAULT_PROJECTS_DIR;
  if (!projectsDir || !fs.existsSync(projectsDir)) {
    console.log(`No conversations at ${projectsDir} — skipping.`);
    return;
  }
  const hasLlmKey = !!process.env.ANTHROPIC_API_KEY;
  if (!hasLlmKey) {
    console.log('No ANTHROPIC_API_KEY — skipping conversation extraction.');
    return;
  }
  try {
    const stats = await contentStore.indexConversations({
      projectsDir,
      embeddings: !!(process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT),
    });
    console.log(`Conversations: ${stats.transcriptsProcessed} processed, ${stats.decisionsExtracted} decisions extracted (${stats.skipped} skipped).`);
  } catch (err) {
    console.error(`Conversation indexing failed: ${err.message}`);
  }
}

async function indexSignalsIfAvailable() {
  const signalsDir = contentStore.resolveSignalsDir();
  if (!signalsDir || !fs.existsSync(signalsDir)) {
    console.log(`No signals at ${signalsDir} — skipping index.`);
    return;
  }
  const hasEmbeddingKey = !!(process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT);
  console.log(`Indexing signals from ${signalsDir}${hasEmbeddingKey ? ' (with embeddings)' : ''}...`);
  try {
    const stats = await contentStore.indexSignals({
      signalsDir,
      embeddings: hasEmbeddingKey,
    });
    console.log(`Signals: ${stats.fileCount} files (${stats.newEntries} new, ${stats.updatedEntries} updated, ${stats.skippedEntries} skipped).`);
  } catch (err) {
    console.error(`Signal indexing failed: ${err.message}`);
  }
}

async function runStartAllInOne() {
  // Start bot in background, run scheduler in foreground
  console.log('All-in-one mode: starting bot + scheduler');

  // Pull latest journals from team-context repo before indexing
  await pullTeamContext();

  // Pull signals at startup so the bot has signal data immediately
  try {
    const config = readConnectorsConfig();
    const channels = Object.keys(config).filter((k) => connectors.get(k));
    if (channels.length > 0) {
      console.log('Pulling signals at startup...');
      await runPull(['--all']);
    }
  } catch (err) {
    console.error(`Startup signal pull failed: ${err.message}`);
  }

  // Index journals, conversations, and signals before starting bot so it has content to search
  await indexJournalsIfAvailable();
  await indexConversationsIfAvailable();
  await indexSignalsIfAvailable();

  // Start bot
  try {
    await runStartBot();
  } catch (err) {
    console.error(`Bot failed to start: ${err.message}`);
    console.log('Continuing with scheduler only...');
    healthStatus.services.bot = `error:${err.message}`;
  }

  // Start scheduler
  runStartScheduler();
}

function ensureContainerConfig() {
  // In container mode, build connectors.json from environment variables
  // so existing commands work without interactive setup
  const config = readConnectorsConfig();
  let changed = false;

  // Digest config
  if (!config.digest && process.env.ANTHROPIC_API_KEY) {
    config.digest = {
      llm: {
        provider: 'anthropic',
        model: process.env.TEAM_CONTEXT_LLM_MODEL || 'claude-sonnet-4-5-20250929',
        api_key_env: 'ANTHROPIC_API_KEY',
      },
      lookback_days: 7,
      store_path: contentStore.resolveStorePath(),
      journal_dir: process.env.TEAM_CONTEXT_JOURNALS_DIR || '/data/journals',
      signals_dir: contentStore.resolveSignalsDir(),
      team_context_dir: process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR || '',
      slack: {
        webhook_url: process.env.TEAM_CONTEXT_SLACK_WEBHOOK || '',
        default_personas: ['unified'],
      },
    };
    changed = true;
  }

  // Override container-specific paths in digest config — the mounted connectors.json
  // may have host paths that don't exist inside the container
  if (config.digest) {
    const containerPaths = {
      store_path: contentStore.resolveStorePath(),
      journal_dir: process.env.TEAM_CONTEXT_JOURNALS_DIR || '/data/journals',
      signals_dir: contentStore.resolveSignalsDir(),
      team_context_dir: process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR || '',
    };
    for (const [key, val] of Object.entries(containerPaths)) {
      if (config.digest[key] !== val) {
        config.digest[key] = val;
        changed = true;
      }
    }
  }

  // Slack bot config
  if (!config.slack_bot && process.env.SLACK_BOT_TOKEN) {
    config.slack_bot = {
      bot_token_env: 'SLACK_BOT_TOKEN',
      app_token_env: 'SLACK_APP_TOKEN',
      mode: process.env.TEAM_CONTEXT_BOT_MODE || 'local',
      store_path: contentStore.resolveStorePath(),
      journal_dir: process.env.TEAM_CONTEXT_JOURNALS_DIR || '/data/journals',
      llm: {
        provider: 'anthropic',
        model: process.env.TEAM_CONTEXT_LLM_MODEL || 'claude-sonnet-4-5-20250929',
        api_key_env: 'ANTHROPIC_API_KEY',
      },
    };
    changed = true;
  }

  // Override container-specific paths in bot config (same reason as digest above)
  if (config.slack_bot) {
    const botPaths = {
      store_path: contentStore.resolveStorePath(),
      journal_dir: process.env.TEAM_CONTEXT_JOURNALS_DIR || '/data/journals',
    };
    for (const [key, val] of Object.entries(botPaths)) {
      if (config.slack_bot[key] !== val) {
        config.slack_bot[key] = val;
        changed = true;
      }
    }
  }

  // GitHub connector — create if missing, or fix transport if mounted config has gh-cli
  if (process.env.GITHUB_TOKEN) {
    const repos = process.env.TEAM_CONTEXT_GITHUB_REPOS;
    if (!config.github && repos) {
      config.github = {
        transport: 'https',
        token: process.env.GITHUB_TOKEN,
        token_env: 'GITHUB_TOKEN',
        repos: repos.split(',').map((r) => r.trim()),
        last_pull: null,
      };
      changed = true;
    } else if (config.github) {
      // Override gh-cli transport in container context — gh binary isn't available
      if (config.github.transport === 'gh-cli') {
        config.github.transport = 'https';
        config.github.token = process.env.GITHUB_TOKEN;
        config.github.token_env = 'GITHUB_TOKEN';
        changed = true;
      }
      // Backfill repos from env if config has none or env specifies them
      if (repos && (!config.github.repos || config.github.repos.length === 0)) {
        config.github.repos = repos.split(',').map((r) => r.trim());
        changed = true;
      }
    }
  }

  // Intercom connector
  if (!config.intercom && process.env.INTERCOM_TOKEN) {
    const tagFilter = process.env.TEAM_CONTEXT_INTERCOM_TAGS;
    config.intercom = {
      transport: 'https',
      token_env: 'INTERCOM_TOKEN',
      token: process.env.INTERCOM_TOKEN,
      tag_filter: tagFilter ? tagFilter.split(',').map((t) => t.trim()) : null,
      last_pull: null,
    };
    changed = true;
  }

  // Notion connector
  if (!config.notion && process.env.NOTION_TOKEN) {
    const databases = process.env.TEAM_CONTEXT_NOTION_DATABASES;
    const pages = process.env.TEAM_CONTEXT_NOTION_PAGES;
    config.notion = {
      transport: 'https',
      token: process.env.NOTION_TOKEN,
      token_env: 'NOTION_TOKEN',
      databases: databases ? databases.split(',').map((d) => d.trim()) : null,
      pages: pages ? pages.split(',').map((p) => p.trim().replace(/-/g, '')) : null,
      last_pull: null,
    };
    changed = true;
  }

  if (changed) {
    ensureWayfindDir();
    writeConnectorsConfig(config);
    console.log('Container config: connectors.json built from environment variables.');
  }
}

function buildBotConfigFromEnv() {
  return {
    bot_token_env: 'SLACK_BOT_TOKEN',
    app_token_env: 'SLACK_APP_TOKEN',
    mode: process.env.TEAM_CONTEXT_BOT_MODE || 'local',
    store_path: contentStore.resolveStorePath(),
    journal_dir: process.env.TEAM_CONTEXT_JOURNALS_DIR || '/data/journals',
    llm: {
      provider: 'anthropic',
      model: process.env.TEAM_CONTEXT_LLM_MODEL || 'claude-sonnet-4-5-20250929',
      api_key_env: 'ANTHROPIC_API_KEY',
    },
  };
}

function buildDigestArgsFromEnv() {
  const args = [];
  if (process.env.SLACK_DIGEST_CHANNEL) {
    args.push('--deliver');
  }
  return args;
}

// ── Cron parser (minimal, no external deps) ─────────────────────────────────

function scheduleCron(expression, callback) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    console.error(`Invalid cron expression: ${expression}`);
    return;
  }

  function matches(field, value) {
    if (field === '*') return true;
    // Handle lists: 1,3,5
    const parts = field.split(',');
    for (const part of parts) {
      // Handle ranges: 1-5
      if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        if (value >= lo && value <= hi) return true;
      }
      // Handle step: */5
      else if (part.includes('/')) {
        const [, step] = part.split('/');
        if (value % parseInt(step, 10) === 0) return true;
      }
      // Exact match
      else if (parseInt(part, 10) === value) return true;
    }
    return false;
  }

  function check() {
    const now = new Date();
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    if (
      matches(minute, now.getMinutes()) &&
      matches(hour, now.getHours()) &&
      matches(dayOfMonth, now.getDate()) &&
      matches(month, now.getMonth() + 1) &&
      matches(dayOfWeek, now.getDay())
    ) {
      callback();
    }
  }

  // Check every 60 seconds, aligned to the start of each minute
  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000;
  setTimeout(() => {
    check();
    setInterval(check, 60 * 1000);
  }, msUntilNextMinute);
}

// ── Members command ─────────────────────────────────────────────────────────

function runMembers(args) {
  const config = readContextConfig();
  const currentVersion = telemetry.getWayfindVersion();
  const doJson = args.includes('--json');
  const doSetMinVersion = args.includes('--set-min-version');

  // wayfind members --set-min-version 1.8.28
  if (doSetMinVersion) {
    const vIdx = args.indexOf('--set-min-version');
    const version = args[vIdx + 1];
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      console.error('Usage: wayfind members --set-min-version <X.Y.Z>');
      process.exit(1);
    }
    const repoPath = getTeamContextPath();
    if (!repoPath) {
      console.error('No team-context repo configured.');
      process.exit(1);
    }
    const sharedConfigPath = path.join(repoPath, 'wayfind.json');
    const existing = readJSONFile(sharedConfigPath) || {};
    existing.min_version = version;
    fs.writeFileSync(sharedConfigPath, JSON.stringify(existing, null, 2) + '\n');

    try {
      spawnSync('git', ['add', 'wayfind.json'], { cwd: repoPath, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', `Set minimum Wayfind version to v${version}`], { cwd: repoPath, stdio: 'pipe' });
      spawnSync('git', ['push'], { cwd: repoPath, stdio: 'pipe' });
    } catch { /* non-fatal */ }

    console.log(`Minimum version set to v${version}`);
    telemetry.capture('min_version_set', { min_version: version }, CLI_USER);
    return;
  }

  // Gather members from all teams (or default team)
  const allMembers = [];
  const teamIds = config.teams ? Object.keys(config.teams) : [];

  if (teamIds.length === 0) {
    const repoPath = getTeamContextPath();
    if (repoPath) teamIds.push('_default');
  }

  for (const teamId of teamIds) {
    const repoPath = teamId === '_default' ? getTeamContextPath() : getTeamContextPath(teamId);
    if (!repoPath) continue;

    const membersDir = path.join(repoPath, 'members');
    if (!fs.existsSync(membersDir)) continue;

    const minVersion = getTeamMinVersion(teamId === '_default' ? undefined : teamId);
    const teamName = config.teams && config.teams[teamId] ? config.teams[teamId].name : 'default';

    for (const file of fs.readdirSync(membersDir).filter(f => f.endsWith('.json'))) {
      const member = readJSONFile(path.join(membersDir, file));
      if (!member) continue;

      const version = member.wayfind_version || 'unknown';
      const outdated = minVersion && version !== 'unknown' ? compareSemver(version, minVersion) < 0 : false;

      allMembers.push({
        name: member.name || file.replace('.json', ''),
        version,
        last_active: member.last_active || null,
        personas: member.personas || [],
        team: teamName,
        teamId: teamId === '_default' ? null : teamId,
        outdated,
        min_version: minVersion,
      });
    }
  }

  if (allMembers.length === 0) {
    console.log('No team members found.');
    console.log('Run "wayfind whoami --setup" to create your profile.');
    return;
  }

  if (doJson) {
    console.log(JSON.stringify(allMembers, null, 2));
    return;
  }

  // Table output
  const minVersion = allMembers[0] && allMembers[0].min_version;
  if (minVersion) {
    console.log(`Minimum version: v${minVersion}  |  Your version: v${currentVersion}`);
    console.log('');
  }

  console.log(
    '  ' +
    'Name'.padEnd(22) +
    'Version'.padEnd(14) +
    'Last Active'.padEnd(14) +
    'Personas'
  );
  console.log('  ' + '─'.repeat(62));

  for (const m of allMembers) {
    const versionStr = m.version === 'unknown' ? '?' : `v${m.version}`;
    const flag = m.outdated ? ' !' : '  ';
    const lastActive = m.last_active ? m.last_active.slice(0, 10) : '—';
    const personas = m.personas.join(', ');
    console.log(
      flag +
      m.name.padEnd(22) +
      versionStr.padEnd(14) +
      lastActive.padEnd(14) +
      personas
    );
  }

  const outdatedCount = allMembers.filter(m => m.outdated).length;
  if (outdatedCount > 0) {
    console.log('');
    console.log(`  ! = below minimum version (v${minVersion})`);
    console.log(`  ${outdatedCount} member(s) need to run: npm update -g wayfind`);
  }
}

/**
 * Check min_version at session start. Called from the session-start hook
 * via `wayfind check-version`. Prints a warning and fires telemetry
 * if the installed version is below the team minimum.
 */
function runCheckVersion() {
  // Stamp member profile on every session start so version/last_active stay current
  const config = readContextConfig();
  const teamIds = config.teams ? Object.keys(config.teams) : [];
  for (const teamId of teamIds) {
    const repoPath = getTeamContextPath(teamId);
    if (repoPath) stampMemberVersion(repoPath);
  }
  if (teamIds.length === 0) {
    const repoPath = getTeamContextPath();
    if (repoPath) stampMemberVersion(repoPath);
  }

  const result = checkMinVersion();
  if (!result) return; // no min_version configured
  if (result.ok) return; // version is fine

  console.error(`\x1b[33m⚠ Wayfind v${result.installed} is below team minimum v${result.required}\x1b[0m`);
  console.error('  Run: npm update -g wayfind');

  telemetry.capture('version_outdated', {
    installed_version: result.installed,
    required_version: result.required,
  }, CLI_USER);
}

// ── Container doctor ────────────────────────────────────────────────────────

/**
 * Detect if we're running inside a Docker container.
 */
function isRunningInContainer() {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

/**
 * Container-specific health checks. Prints PASS/WARN lines and exits with
 * appropriate code. Useful as a post-startup self-check or via
 * `docker exec wayfind npx wayfind doctor --container`.
 */
async function runContainerDoctor() {
  const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', RESET = '\x1b[0m';
  const pass = (msg) => console.log(`${GREEN}PASS${RESET}  ${msg}`);
  const warn = (msg) => console.log(`${YELLOW}WARN${RESET}  ${msg}`);
  let issues = 0;

  console.log('');
  console.log('Wayfind — Container Doctor');
  console.log('══════════════════════════════');

  // 1. Backend type — is SQLite active or JSON fallback?
  const storePath = path.join(EFFECTIVE_DIR, 'content-store');
  try {
    const storage = require('./storage/index.js');
    storage.getBackend(storePath);
    const info = storage.getBackendInfo(storePath);
    if (!info) {
      warn('Storage backend: not initialized');
      issues++;
    } else if (info.type === 'sqlite' && !info.fallback) {
      pass(`Storage backend: sqlite`);
    } else if (info.type === 'json' && info.fallback) {
      warn('Storage backend: JSON (fallback — SQLite failed to load)');
      console.log('       Install better-sqlite3 or rebuild the container image');
      issues++;
    } else if (info.type === 'json') {
      warn('Storage backend: JSON (not SQLite)');
      issues++;
    } else {
      pass(`Storage backend: ${info.type}`);
    }
  } catch (e) {
    warn(`Storage backend: error — ${e.message}`);
    issues++;
  }

  // 2. Entry count — are there entries in the content store?
  let entryCount = 0;
  try {
    const storage = require('./storage/index.js');
    const backend = storage.getBackend(storePath);
    const idx = backend.loadIndex();
    if (idx && idx.entries) {
      entryCount = Object.keys(idx.entries).length;
    }
    if (entryCount > 0) {
      pass(`Content store: ${entryCount} entries`);
    } else {
      warn('Content store: 0 entries — no signals have been indexed');
      console.log('       Run: wayfind pull --all');
      issues++;
    }
  } catch (e) {
    warn(`Content store: error — ${e.message}`);
    issues++;
  }

  // 3. Embedding coverage — what % of entries have embeddings?
  if (entryCount > 0) {
    try {
      const storage = require('./storage/index.js');
      const backend = storage.getBackend(storePath);
      const idx = backend.loadIndex();
      let total = 0, embedded = 0;
      if (idx && idx.entries) {
        for (const e of Object.values(idx.entries)) {
          total++;
          if (e.hasEmbedding) embedded++;
        }
      }
      const pct = total > 0 ? Math.round(100 * embedded / total) : 0;
      if (pct >= 50) {
        pass(`Embedding coverage: ${embedded}/${total} (${pct}%)`);
      } else {
        warn(`Embedding coverage: ${embedded}/${total} (${pct}%) — search quality degraded`);
        console.log('       Run: wayfind reindex');
        issues++;
      }
    } catch (e) {
      warn(`Embedding coverage: error — ${e.message}`);
      issues++;
    }
  }

  // 4. Signal freshness — are there signal files from today?
  const signalsDir = path.join(EFFECTIVE_DIR, 'signals');
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    if (!fs.existsSync(signalsDir)) {
      warn('Signal freshness: no signals directory');
      issues++;
    } else {
      const channels = fs.readdirSync(signalsDir).filter((f) => {
        try { return fs.statSync(path.join(signalsDir, f)).isDirectory(); } catch { return false; }
      });
      if (channels.length === 0) {
        warn('Signal freshness: no signal channels found');
        issues++;
      } else {
        let freshCount = 0;
        for (const ch of channels) {
          const chDir = path.join(signalsDir, ch);
          const files = fs.readdirSync(chDir).filter((f) => f.endsWith('.md')).sort().reverse();
          const newest = files[0] || '';
          // Signal files are named with date prefix, e.g. 2026-03-28-....md
          if (newest.startsWith(today)) {
            freshCount++;
          }
        }
        if (freshCount === channels.length) {
          pass(`Signal freshness: ${freshCount}/${channels.length} channels have signals from today`);
        } else {
          warn(`Signal freshness: ${freshCount}/${channels.length} channels have signals from today`);
          console.log('       Run: wayfind pull --all');
          issues++;
        }
      }
    }
  } catch (e) {
    warn(`Signal freshness: error — ${e.message}`);
    issues++;
  }

  // 5. Slack bot / health endpoint — is /healthz responding?
  const healthPort = parseInt(process.env.TEAM_CONTEXT_HEALTH_PORT || '3141', 10);
  try {
    const healthResult = await new Promise((resolve) => {
      const req = http.get(`http://localhost:${healthPort}/healthz`, { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    });

    if (healthResult.status === 200) {
      let detail = '';
      try {
        const data = JSON.parse(healthResult.body);
        if (data.slack && data.slack.connected) {
          detail = ' (Slack connected)';
        } else if (data.slack && !data.slack.connected) {
          detail = ' (Slack disconnected)';
        }
      } catch { /* ignore parse errors */ }
      pass(`Health endpoint: http://localhost:${healthPort}/healthz${detail}`);
    } else if (healthResult.status > 0) {
      warn(`Health endpoint: responded with ${healthResult.status}`);
      issues++;
    } else {
      warn(`Health endpoint: not reachable — ${healthResult.error}`);
      console.log('       Is the container running? Check: docker ps');
      issues++;
    }
  } catch (e) {
    warn(`Health endpoint: error — ${e.message}`);
    issues++;
  }

  console.log('');
  console.log('══════════════════════════════');
  if (issues === 0) {
    console.log(`${GREEN}All container checks passed${RESET}`);
  } else {
    console.log(`${YELLOW}${issues} issue(s) found${RESET}`);
    process.exit(1);
  }
}

// ── Store management ────────────────────────────────────────────────────────

async function runStoreTrim(args) {
  const ctxConfig = readContextConfig();
  const teamId = args[0] || readRepoTeamBinding() || ctxConfig.default;
  if (!teamId) {
    console.error('No team ID resolved. Usage: wayfind store trim [team-id]');
    process.exit(1);
  }
  const team = ctxConfig.teams && ctxConfig.teams[teamId];
  if (!team) {
    console.error(`Team "${teamId}" not found.`);
    process.exit(1);
  }
  const allowedPatterns = team.bound_repos;
  if (!allowedPatterns || allowedPatterns.length === 0) {
    console.error(`Team "${teamId}" has no bound_repos in context.json. Configure them first.`);
    process.exit(1);
  }
  const storePath = contentStore.resolveStorePath(teamId);
  console.log(`Team:     ${team.name} (${teamId})`);
  console.log(`Store:    ${storePath}`);
  console.log(`Patterns: ${allowedPatterns.join(', ')}`);
  console.log('');
  const stats = await contentStore.trimStore(storePath, allowedPatterns);
  console.log(`Kept:    ${stats.kept}`);
  console.log(`Removed: ${stats.removed}`);
  if (stats.removedRepos.length > 0) {
    console.log(`Repos removed:`);
    stats.removedRepos.forEach(r => console.log(`  ${r}`));
  }
}

async function runStore(args) {
  const [sub, ...subArgs] = args;
  switch (sub) {
    case 'trim':
      await runStoreTrim(subArgs);
      break;
    default:
      console.error(`Unknown store subcommand: ${sub || ''}`);
      console.error('Available: trim');
      process.exit(1);
  }
}

// ── Command registry ────────────────────────────────────────────────────────

const COMMANDS = {
  start: {
    desc: 'Start Wayfind in container mode (reads TEAM_CONTEXT_MODE env var)',
    run: () => runStart(),
  },
  init: {
    desc: 'Install Wayfind for your AI tool (Claude Code, Cursor, or generic)',
    run: (args) => {
      const hasToolFlag = args.some((a) => a === '--tool' || a.startsWith('--tool='));
      const toolArgs = hasToolFlag ? args : ['--tool', 'claude-code', ...args];
      spawn('bash', [path.join(ROOT, 'setup.sh'), ...toolArgs]);
    },
  },
  'init-cursor': {
    desc: 'Install Wayfind for Cursor',
    run: (args) => {
      spawn('bash', [path.join(ROOT, 'setup.sh'), '--tool', 'cursor', ...args]);
    },
  },
  update: {
    desc: 'Update Wayfind to latest version',
    run: (args) => {
      // Step 1: Pull latest from npm
      const skipNpm = args.includes('--skip-npm');
      if (!skipNpm) {
        console.log('Updating wayfind from npm...');
        const npmResult = spawnSync('npm', ['install', '-g', 'wayfind@latest'], {
          stdio: 'inherit',
        });
        if (npmResult.error || (npmResult.status && npmResult.status !== 0)) {
          console.error('npm install failed. Try running: npm install -g wayfind@latest');
          console.error('Then re-run: wayfind update --skip-npm');
          process.exit(1);
        }
      }

      // Step 2: Re-run setup in update mode with the (now current) version
      const versionFile = path.join(HOME, '.claude', 'team-context', '.wayfind-version');
      let oldVersion = '';
      try {
        oldVersion = fs.readFileSync(versionFile, 'utf8').trim();
      } catch (e) {
        // No version file — fresh install or pre-version install
      }
      let newVersion = '';
      try {
        // After npm install, ROOT still points to the old code in memory.
        // Resolve the freshly installed package path from npm global root.
        const globalRoot = spawnSync('npm', ['root', '-g'], { stdio: 'pipe' });
        const freshPkgPath = path.join((globalRoot.stdout || '').toString().trim(), 'wayfind', 'package.json');
        if (fs.existsSync(freshPkgPath)) {
          newVersion = JSON.parse(fs.readFileSync(freshPkgPath, 'utf8')).version;
        } else {
          newVersion = require(path.join(ROOT, 'package.json')).version;
        }
      } catch (e) {
        // Can't read package.json
      }
      const env = { ...process.env };
      if (oldVersion) env.WAYFIND_OLD_VERSION = oldVersion;
      if (newVersion) env.WAYFIND_NEW_VERSION = newVersion;
      const tool = args.includes('--tool') ? args : ['--tool', 'claude-code', ...args];
      const filteredArgs = tool.filter(a => a !== '--skip-npm');
      const result = spawnSync('bash', [path.join(ROOT, 'setup.sh'), '--update', ...filteredArgs], {
        stdio: 'inherit',
        env,
      });
      if (result.error) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (result.status && result.status !== 0) {
        process.exit(result.status);
      }

      // Step 3: Update all Wayfind containers (per-team labeled + legacy 'wayfind')
      const dockerCheck = spawnSync('docker', ['compose', 'version'], { stdio: 'pipe' });
      if (!dockerCheck.error && dockerCheck.status === 0) {
        // Discover containers: prefer com.wayfind.team label, fall back to legacy 'wayfind' name
        const labeledResult = spawnSync('docker', [
          'ps',
          '--filter', 'label=com.wayfind.team',
          '--format', '{{.Names}}\t{{index .Labels "com.wayfind.team"}}',
        ], { stdio: 'pipe' });
        const legacyResult = spawnSync('docker', ['ps', '--filter', 'name=^wayfind$', '--format', '{{.Names}}\t'], { stdio: 'pipe' });

        const containerRows = [
          ...(labeledResult.stdout || '').toString().trim().split('\n').filter(Boolean),
          ...(legacyResult.stdout || '').toString().trim().split('\n').filter(Boolean),
        ];

        if (containerRows.length > 0) {
          console.log(`\nWayfind container(s) detected — updating ${containerRows.length} container(s)...`);

          for (const row of containerRows) {
            const [containerName] = row.split('\t');
            if (!containerName) continue;

            // Find compose dir via docker label
            const inspectResult = spawnSync('docker', [
              'inspect', containerName,
              '--format', '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
            ], { stdio: 'pipe' });
            const labelDir = (inspectResult.stdout || '').toString().trim();

            let composeDir = '';
            if (labelDir && fs.existsSync(path.join(labelDir, 'docker-compose.yml'))) {
              composeDir = labelDir;
            } else {
              // Check team repo paths from context.json first
              const updateConfig = readContextConfig();
              if (updateConfig.teams) {
                for (const [tid, entry] of Object.entries(updateConfig.teams)) {
                  if (!entry.path) continue;
                  const candidate = path.join(entry.path, 'deploy');
                  if (fs.existsSync(path.join(candidate, 'docker-compose.yml'))) {
                    const checkResult = spawnSync('docker', ['compose', 'ps', '--format', '{{.Name}}'], { cwd: candidate, stdio: 'pipe' });
                    const composeContainers = (checkResult.stdout || '').toString();
                    if (composeContainers.includes(containerName)) {
                      composeDir = candidate;
                      break;
                    }
                  }
                }
              }
              // Fallback: check store-adjacent deploy dirs
              if (!composeDir) {
                const teamsBase = HOME ? path.join(HOME, '.claude', 'team-context', 'teams') : '';
                if (teamsBase && fs.existsSync(teamsBase)) {
                  for (const tid of fs.readdirSync(teamsBase)) {
                    const candidate = path.join(teamsBase, tid, 'deploy');
                    if (fs.existsSync(path.join(candidate, 'docker-compose.yml'))) {
                      const checkResult = spawnSync('docker', ['compose', 'ps', '--format', '{{.Name}}'], { cwd: candidate, stdio: 'pipe' });
                      const composeContainers = (checkResult.stdout || '').toString();
                      if (composeContainers.includes(containerName)) {
                        composeDir = candidate;
                        break;
                      }
                    }
                  }
                }
              }
              // Legacy fallback
              if (!composeDir) {
                const legacyCandidates = [process.cwd(), path.join(HOME || '', 'team-context', 'deploy')];
                for (const dir of legacyCandidates) {
                  if (dir && fs.existsSync(path.join(dir, 'docker-compose.yml'))) {
                    composeDir = dir;
                    break;
                  }
                }
              }
            }

            if (composeDir) {
              console.log(`\nUpdating ${containerName} (compose: ${composeDir})...`);
              const pullResult = spawnSync('docker', ['compose', 'pull'], { cwd: composeDir, stdio: 'inherit' });
              if (!pullResult.error && pullResult.status === 0) {
                spawnSync('docker', ['compose', 'up', '-d'], { cwd: composeDir, stdio: 'inherit' });
                console.log(`${containerName} updated.`);

                // Post-deploy smoke check
                spawnSync('sleep', ['5']);
                const logsResult = spawnSync('docker', ['logs', '--tail', '50', containerName], { stdio: 'pipe' });
                const logOutput = (logsResult.stdout || '').toString() + (logsResult.stderr || '').toString();
                const warnings = logOutput.split('\n').filter(l => /Warning:|Error:|failed|fallback/i.test(l) && l.trim());
                if (warnings.length > 0) {
                  warnings.forEach(w => console.log(`  \u26A0 ${w.trim()}`));
                  console.log('  Post-deploy warnings detected — review above');
                } else {
                  console.log('  Post-deploy check: no warnings');
                }
              } else {
                console.error(`Docker pull failed for ${containerName}.`);
              }
            } else {
              console.log(`Could not locate docker-compose.yml for ${containerName}. Update manually.`);
            }
          }
        }
      }
    },
  },
  digest: {
    desc: 'Generate persona-specific digests from signals + journals',
    run: (args) => runDigest(args),
  },
  journal: {
    desc: 'Journal management (summary, migrate, sync)',
    run: (args) => runJournal(args),
  },
  personas: {
    desc: 'List, add, or remove personas',
    run: (args) => runPersonas(args),
  },
  team: {
    desc: 'Manage your team (create, join, status)',
    run: (args) => runTeam(args),
  },
  whoami: {
    desc: 'Show or set up your Wayfind profile and personas',
    run: (args) => runWhoami(args),
  },
  autopilot: {
    desc: 'Show or configure persona autopilot mode',
    run: (args) => runAutopilot(args),
  },
  members: {
    desc: 'Show team members with versions and activity',
    run: (args) => runMembers(args),
  },
  'check-version': {
    desc: 'Check if installed version meets team minimum (used by hooks)',
    run: () => runCheckVersion(),
  },
  resync: {
    desc: 'Re-sync hooks and commands without npm update (used internally by setup.sh)',
    run: () => runUpdate(),
  },
  'migrate-to-plugin': {
    desc: 'Remove old hooks/commands — let the Claude Code plugin handle them',
    run: (args) => runMigrateToPlugin(args),
  },
  doctor: {
    desc: 'Check your Wayfind installation for issues (--container for container checks)',
    run: (args) => {
      if (args.includes('--container') || isRunningInContainer()) {
        runContainerDoctor();
      } else {
        spawn('bash', [path.join(ROOT, 'doctor.sh'), ...args]);
      }
    },
  },
  version: {
    desc: 'Print installed Wayfind version',
    run: () => {
      // Primary: read from package.json (always accurate after npm install)
      try {
        const pkg = require(path.join(ROOT, 'package.json'));
        console.log(`Wayfind v${pkg.version}`);
      } catch (e) {
        // Fallback: cached version file (may be stale after update)
        const versionFile = path.join(HOME, '.claude', 'team-context', '.wayfind-version');
        try {
          const version = fs.readFileSync(versionFile, 'utf8').trim();
          console.log(`Wayfind v${version}`);
        } catch (err) {
          console.error('Version unknown');
          process.exit(1);
        }
      }
    },
  },
  pull: {
    desc: 'Pull signals from a channel (see "wayfind signals" for available)',
    run: (args) => runPull(args),
  },
  status: {
    desc: 'Show cross-project status (or rebuild Active Projects table)',
    run: (args) => runStatus(args),
  },
  features: {
    desc: 'Manage feature-to-repo map for Slack bot routing (add, set, describe, list, search, suggest)',
    run: (args) => runFeatures(args),
  },
  standup: {
    desc: 'Show a daily standup summary (last session, plan, blockers)',
    run: (args) => runStandup(args),
  },
  signals: {
    desc: 'Show configured signal channels and last pull times',
    run: () => runSignals(),
  },
  bot: {
    desc: 'Start the Wayfind Slack bot for decision trail queries',
    run: (args) => runBot(args),
  },
  context: {
    desc: 'Manage shared team context (init, sync, show)',
    run: (args) => runContext(args),
  },
  prompts: {
    desc: 'List or show shared team prompts',
    run: (args) => runPrompts(args),
  },
  deploy: {
    desc: 'Scaffold Docker deployment in your team context repo',
    run: (args) => runDeploy(args),
  },
  store: {
    desc: 'Manage content store (trim)',
    run: (args) => runStore(args),
  },
  onboard: {
    desc: 'Generate an onboarding context pack for a repo',
    run: (args) => runOnboard(args),
  },
  reindex: {
    desc: 'Index all signal sources (journals + conversations)',
    run: (args) => runReindex(args),
  },
  distill: {
    desc: 'Distill content store: dedup, merge, and compact entries',
    run: (args) => runDistill(args),
  },
  'index-journals': {
    desc: 'Index journal entries into the content store',
    run: (args) => runIndexJournals(args),
  },
  'index-conversations': {
    desc: 'Extract and index decision points from Claude Code transcripts',
    run: (args) => runIndexConversations(args),
  },
  'search-journals': {
    desc: 'Search indexed entries (journals + conversations, semantic or full-text)',
    run: (args) => runSearchJournals(args),
  },
  'memory-compare': {
    desc: 'Compare Claude Code auto-memory vs Wayfind memory systems',
    run: () => require('./memory-compare').compare(),
  },
  insights: {
    desc: 'Show insights from indexed journal data',
    run: (args) => runInsights(args),
  },
  quality: {
    desc: 'View your decision quality profile and elicitation focus',
    run: (args) => runQuality(args),
  },
  'sync-public': {
    desc: 'Sync code to the public usewayfind/wayfind repo',
    run: () => {
      // Source must be the repo checkout you're working in, not the npm global install.
      // Use cwd if it looks like a wayfind repo, otherwise fall back to ROOT.
      const cwdPkg = path.join(process.cwd(), 'package.json');
      let sourceRoot = ROOT;
      if (fs.existsSync(cwdPkg)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(cwdPkg, 'utf8'));
          if (pkg.name === 'wayfind') sourceRoot = process.cwd();
        } catch {}
      }
      if (sourceRoot === ROOT && ROOT !== process.cwd()) {
        console.log(`Syncing from: ${sourceRoot}`);
        console.log('Tip: run from your wayfind repo checkout to sync local changes.');
      }

      const tmpDir = path.join(os.tmpdir(), 'wayfind-public-sync');
      const publicRepo = process.env.WAYFIND_PUBLIC_REPO || 'https://github.com/usewayfind/wayfind.git';

      // Clone or pull public repo
      if (fs.existsSync(tmpDir)) {
        console.log('Updating existing clone...');
        const pullResult = spawnSync('git', ['pull', '--rebase'], { cwd: tmpDir, stdio: 'inherit' });
        if (pullResult.status !== 0) {
          console.error('git pull failed — try removing ' + tmpDir);
          process.exit(1);
        }
      } else {
        console.log('Cloning usewayfind/wayfind...');
        const cloneResult = spawnSync('git', ['clone', publicRepo, tmpDir], { stdio: 'inherit' });
        if (cloneResult.status !== 0) {
          console.error('Clone failed — check your GitHub access to usewayfind/wayfind');
          process.exit(1);
        }
      }

      // Files and directories to sync
      const syncItems = [
        'bin/', 'templates/', 'specializations/', 'plugin/', 'tests/', 'simulation/',
        'backup/', '.github/', '.claude-plugin/', 'Dockerfile', 'package.json', 'setup.sh',
        'install.sh', 'uninstall.sh', 'doctor.sh', 'journal-summary.sh',
        'BOOTSTRAP_PROMPT.md', '.gitattributes', '.gitignore', 'VERSIONS.md',
      ];

      // Workflows that only belong on the private repo
      const privateOnlyWorkflows = ['sync-public.yml', 'simulation.yml'];

      // Also sync public-staging docs if they exist
      const publicDocsDir = path.join(sourceRoot, 'public-staging', 'docs');

      // Keep plugin.json version in sync with package.json before syncing
      const pluginJsonPath = path.join(sourceRoot, 'plugin', '.claude-plugin', 'plugin.json');
      const pkgJsonPath = path.join(sourceRoot, 'package.json');
      if (fs.existsSync(pluginJsonPath) && fs.existsSync(pkgJsonPath)) {
        try {
          const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          if (pluginJson.version !== pkgJson.version) {
            pluginJson.version = pkgJson.version;
            fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + '\n');
            console.log(`Updated plugin.json version to ${pkgJson.version}`);
          }
        } catch {}
      }

      console.log('Syncing files...');
      for (const item of syncItems) {
        const isDir = item.endsWith('/');
        const name = item.replace(/\/$/, '');
        const src = path.join(sourceRoot, name);
        if (!fs.existsSync(src)) continue;
        if (isDir) {
          // rsync without trailing slash on source copies the directory itself into dest
          const result = spawnSync('rsync', ['-a', '--delete', src, tmpDir + '/'], { stdio: 'inherit' });
          if (result.status !== 0) console.error(`Failed to sync ${item}`);
        } else {
          const result = spawnSync('cp', [src, path.join(tmpDir, name)], { stdio: 'inherit' });
          if (result.status !== 0) console.error(`Failed to sync ${item}`);
        }
      }

      // Remove private-only workflows from the public copy
      for (const wf of privateOnlyWorkflows) {
        const wfPath = path.join(tmpDir, '.github', 'workflows', wf);
        if (fs.existsSync(wfPath)) fs.unlinkSync(wfPath);
      }

      // Sync public-staging/ → public repo root (recursive)
      // This overlays LICENSE, README, CHANGELOG, SECURITY, CONTRIBUTING, docs/, etc.
      const publicStagingDir = path.join(sourceRoot, 'public-staging');
      if (fs.existsSync(publicStagingDir)) {
        spawnSync('rsync', ['-a', publicStagingDir + '/', tmpDir + '/'], { stdio: 'inherit' });
      }

      // ── Sanitization gate ───────────────────────────────────────────────
      // Scan all tracked text files for proprietary patterns before pushing.
      // Patterns loaded from .sync-blocklist (not synced to public repo).
      const blocklistPath = path.join(sourceRoot, '.sync-blocklist');
      const BLOCKED_PATTERNS = [];
      if (fs.existsSync(blocklistPath)) {
        for (const line of fs.readFileSync(blocklistPath, 'utf8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          // Each line is a regex pattern, optionally with /flags
          const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
          if (m) {
            BLOCKED_PATTERNS.push(new RegExp(m[1], m[2]));
          } else {
            // Plain string → case-insensitive word boundary match
            BLOCKED_PATTERNS.push(new RegExp('\\b' + trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'));
          }
        }
      }
      if (BLOCKED_PATTERNS.length === 0) {
        console.warn('⚠️  No .sync-blocklist found — skipping sanitization scan.');
        console.warn('   Create .sync-blocklist with one pattern per line to enable leak detection.');
      }
      // Files/dirs exempt from scanning
      const SCAN_EXEMPT = [
        /\/\.git\//,
        /node_modules\//,
        /clean-machine-onboard\.sh$/, // contains negative assertions checking for org-name leaks
      ];

      console.log('Running sanitization scan...');
      const violations = [];
      const scanDir = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(tmpDir, full);
          if (SCAN_EXEMPT.some(r => r.test(full))) continue;
          if (entry.isDirectory()) { scanDir(full); continue; }
          // Skip binary files
          const ext = path.extname(entry.name).toLowerCase();
          if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.tgz', '.gz', '.zip'].includes(ext)) continue;
          try {
            const content = fs.readFileSync(full, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              for (const pat of BLOCKED_PATTERNS) {
                if (pat.test(lines[i])) {
                  violations.push({ file: rel, line: i + 1, pattern: pat.source, text: lines[i].trim().slice(0, 120) });
                }
              }
            }
          } catch { /* binary file, skip */ }
        }
      };
      scanDir(tmpDir);

      if (violations.length > 0) {
        console.error('\n❌ Sanitization FAILED — proprietary content detected:\n');
        for (const v of violations) {
          console.error(`  ${v.file}:${v.line}  [${v.pattern}]`);
          console.error(`    ${v.text}\n`);
        }
        console.error(`${violations.length} violation(s) found. Fix these before syncing to the public repo.`);
        process.exit(1);
      }
      console.log('Sanitization passed — no proprietary content detected.');

      // Refresh git index so status detects copied files reliably
      spawnSync('git', ['add', '-A'], { cwd: tmpDir, stdio: 'pipe' });
      const diffResult = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: tmpDir, stdio: 'pipe' });
      const changes = (diffResult.stdout || '').toString().trim();

      if (!changes) {
        console.log('Public repo is already up to date.');
        return;
      }

      console.log('\nChanges to push:');
      console.log(changes);

      // Get version for commit message
      let version = 'unknown';
      try { version = require(path.join(sourceRoot, 'package.json')).version; } catch {}

      // Commit and push
      spawnSync('git', ['add', '-A'], { cwd: tmpDir, stdio: 'inherit' });
      const commitResult = spawnSync('git', ['commit', '-m', `Sync v${version} from private repo`], { cwd: tmpDir, stdio: 'inherit' });
      if (commitResult.status !== 0) {
        console.error('Commit failed');
        process.exit(1);
      }

      console.log('Pushing to usewayfind/wayfind...');
      // Allow override for SSH-based multi-account routing
      if (process.env.WAYFIND_PUBLIC_REPO) {
        spawnSync('git', ['remote', 'set-url', 'origin', process.env.WAYFIND_PUBLIC_REPO], { cwd: tmpDir });
      }
      const pushResult = spawnSync('git', ['push'], { cwd: tmpDir, stdio: 'inherit' });
      if (pushResult.status !== 0) {
        console.error('Push failed — check your access to usewayfind/wayfind');
        process.exit(1);
      }

      console.log(`\nSynced v${version} to usewayfind/wayfind`);
      console.log('GitHub Actions will publish npm + Docker automatically.');
    },
  },
  help: {
    desc: 'Show this help message',
    run: () => showHelp(),
  },
};

function showHelp() {
  console.log('');
  console.log('Wayfind — Team decision trail for AI-assisted development');
  console.log('');
  console.log('Usage: wayfind <command> [options]');
  console.log('');
  console.log('Commands:');
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(16)} ${cmd.desc}`);
  }
  console.log('');
  console.log('Getting started:');
  console.log('  npx wayfind init          Install for Claude Code');
  console.log('  npx wayfind init-cursor   Install for Cursor');
  console.log('');
  console.log('In a Claude Code session:');
  console.log('  /init-memory                   Set up memory for current repo');
  console.log('  /init-folder                   Set up memory for a non-repo folder');
  console.log('  /init-team                     Set up team context (journals, digests, Notion)');
  console.log('  /journal                       View your session journal digest');
  console.log('  /doctor                        Check installation health');
  console.log('');
  console.log('Team setup:');
  console.log('  wayfind team create                    Create a new team');
  console.log('  wayfind team join <repo-url-or-path>  Join an existing team');
  console.log('  wayfind team status           Show current team info');
  console.log('  wayfind whoami                Show your profile');
  console.log('  wayfind whoami --setup        Set up your profile and personas');
  console.log('');
  console.log('Personas:');
  console.log('  wayfind personas              List configured personas');
  console.log('  wayfind personas --add <id> <name> [description]');
  console.log('  wayfind personas --remove <id>');
  console.log('  wayfind personas --reset      Restore default personas');
  console.log('');
  console.log('Autopilot:');
  console.log('  wayfind autopilot status              Which personas are human vs. autopilot');
  console.log('  wayfind autopilot enable <persona>    Enable autopilot for a persona');
  console.log('  wayfind autopilot disable <persona>   Disable autopilot for a persona');
  console.log('');
  console.log('Digests:');
  console.log('  wayfind digest                           Generate all persona digests');
  console.log('  wayfind digest --persona engineering     Generate one persona only');
  console.log('  wayfind digest --deliver                 Generate + post to Slack');
  console.log('  wayfind digest --since 2026-02-24        Override lookback period');
  console.log('  wayfind digest --configure               Set up LLM + Slack config');
  console.log('  wayfind journal [--last-week]            Plain-text journal summary');
  console.log('  wayfind journal migrate [--dry-run]      Rename journals to YYYY-MM-DD-{author}.md');
  console.log('  wayfind journal sync [--since DATE]      Copy authored journals to team-context repo');
  console.log('');
  console.log('Signal channels:');
  console.log('  wayfind pull github             Pull GitHub signals');
  console.log('  wayfind pull github --configure  Configure GitHub connector');
  console.log('  wayfind pull github --since YYYY-MM-DD');
  console.log('  wayfind pull github --add-repo owner/repo');
  console.log('  wayfind pull github --remove-repo owner/repo');
  console.log('  wayfind pull intercom           Pull Intercom signals');
  console.log('  wayfind pull intercom --configure  Configure Intercom connector');
  console.log('  wayfind pull --all              Pull all configured channels');
  console.log('  wayfind signals                 Show configured channels');
  console.log('');
  console.log('Prompts:');
  console.log('  wayfind prompts               List shared team prompts');
  console.log('  wayfind prompts <name>        Show a specific prompt');
  console.log('');
  console.log('Bot:');
  console.log('  wayfind bot                   Start the Slack bot (Socket Mode)');
  console.log('  wayfind bot --configure       Set up Slack app tokens + LLM config');
  console.log('');
  console.log('Deployment:');
  console.log('  wayfind deploy init           Scaffold Docker deployment files');
  console.log('  wayfind deploy status         Check deployment configuration');
  console.log('');
  console.log('Members:');
  console.log('  wayfind members                          Show team members with versions');
  console.log('  wayfind members --json                   Machine-readable output');
  console.log('  wayfind members --set-min-version X.Y.Z  Set minimum required version');
  console.log('');
  console.log('Status:');
  console.log('  wayfind status                Print cross-project status table');
  console.log('  wayfind status --write        Rebuild Active Projects in global-state.md');
  console.log('  wayfind status --json         Machine-readable output');
  console.log('  wayfind status --quiet        Suppress output (for hooks)');
  console.log('  wayfind standup               Daily standup for current repo (last session, plan, blockers)');
  console.log('  wayfind standup --all          Daily standup across all repos');
  console.log('');
  console.log('Maintenance:');
  console.log('  wayfind update                Update from npm, re-sync hooks, update container');
  console.log('  wayfind migrate-to-plugin     Remove old hooks/commands — let the plugin handle them');
  console.log('  wayfind doctor                Check installation health');
  console.log('  wayfind doctor --container    Container-specific health checks (auto-detected in Docker)');
  console.log('');
  console.log('Publishing:');
  console.log('  wayfind sync-public           Sync code to usewayfind/wayfind (triggers npm + Docker publish)');
  console.log('');
  console.log('Content store:');
  console.log('  wayfind index-journals                        Index journal entries');
  console.log('  wayfind index-journals --dir <path>           Custom journal directory');
  console.log('  wayfind index-journals --no-embeddings        Skip embedding generation');
  console.log('  wayfind search-journals <query>               Semantic search (needs OPENAI_API_KEY)');
  console.log('  wayfind search-journals <query> --text        Full-text search (no API key)');
  console.log('  wayfind search-journals <query> --repo wayfind --since 2026-02-01');
  console.log('  wayfind insights                              Show journal insights');
  console.log('  wayfind insights --json                       JSON output');
  console.log('');
}

function spawn(cmd, args) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (result.error) {
    console.error(`Error: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status == null ? 1 : result.status);
}

// --- Update notifier --------------------------------------------------------
// Checks npm registry in the background, caches the result for 24h,
// and prints a one-liner on next run if a newer version is available.
// Users can silence with NO_UPDATE_NOTIFIER=1.

const UPDATE_CHECK_FILE = path.join(WAYFIND_DIR, '.update-check.json');
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

function checkForUpdateBackground() {
  if (process.env.NO_UPDATE_NOTIFIER) return;
  try {
    if (fs.existsSync(UPDATE_CHECK_FILE)) {
      const cached = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf8'));
      if (Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL) return;
    }
  } catch { /* check anyway */ }
  // Fire and forget — don't block the CLI
  const child = spawnChild('npm', ['view', 'wayfind', 'version'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.on('close', () => {
    const latest = stdout.trim();
    if (!latest || !/^\d+\.\d+\.\d+/.test(latest)) return;
    try {
      fs.mkdirSync(WAYFIND_DIR, { recursive: true });
      fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ latest, checkedAt: Date.now() }));
    } catch { /* best effort */ }
  });
  child.unref();
}

function showUpdateNotice() {
  if (process.env.NO_UPDATE_NOTIFIER) return;
  try {
    if (!fs.existsSync(UPDATE_CHECK_FILE)) return;
    const { latest } = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf8'));
    const pkg = require(path.join(ROOT, 'package.json'));
    if (!latest || latest === pkg.version) return;
    // Simple semver comparison: split, compare numerically
    const cur = pkg.version.split('.').map(Number);
    const lat = latest.split('.').map(Number);
    const isNewer = lat[0] > cur[0] || (lat[0] === cur[0] && lat[1] > cur[1]) ||
      (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2]);
    if (isNewer) {
      console.error(`\n\x1b[33m  Update available: v${pkg.version} → v${latest}\x1b[0m`);
      console.error(`\x1b[33m  Run \x1b[1mnpm update -g wayfind\x1b[22m to update\x1b[0m\n`);
    }
  } catch { /* best effort */ }
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0] || 'help';
const commandArgs = args.slice(1);

async function main() {
  checkForUpdateBackground();
  telemetry.capture('command_run', { command }, CLI_USER);
  if (COMMANDS[command]) {
    await COMMANDS[command].run(commandArgs);
    showUpdateNotice();
    await telemetry.flush();
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Run "wayfind help" for available commands.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
