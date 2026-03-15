'use strict';

const fs = require('fs');
const path = require('path');

const POSTHOG_KEY = 'phc_oqq6aZm92XPcWGHLFPmAhtIYeknQV2eygUowP43LJzD';
const POSTHOG_HOST = 'https://us.i.posthog.com';

let client = null;
let enabled = false;

function init() {
  if (client !== null) return; // already initialized (or disabled)

  enabled = (process.env.TEAM_CONTEXT_TELEMETRY || '').toLowerCase() === 'true';
  if (!enabled) {
    client = false; // marker: checked but disabled
    return;
  }

  try {
    const { PostHog } = require('posthog-node');
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 10,
      flushInterval: 30000, // 30 seconds
    });
  } catch (err) {
    // posthog-node not available (shouldn't happen since it's a dependency, but be safe)
    client = false;
    enabled = false;
  }
}

function getTeamId() {
  return process.env.TEAM_CONTEXT_TENANT_ID || 'anonymous';
}

function getUserId() {
  return process.env.TEAM_CONTEXT_AUTHOR || null;
}

// Back-compat alias
function getDistinctId() {
  return getTeamId();
}

/**
 * Track an event.
 * @param {string} event - Event name (e.g. 'digest_generated')
 * @param {Object} [properties] - Event properties
 * @param {string} [userId] - Optional user-level distinct ID (author slug)
 */
function capture(event, properties, userId) {
  init();
  if (!client || !enabled) return;

  const distinctId = userId || getUserId() || getTeamId();
  const teamId = getTeamId();
  const props = {
    ...properties,
    wayfind_version: getWayfindVersion(),
    $groups: { team: teamId },
    // Always include user and team as properties for easier querying
    wayfind_user: userId || getUserId() || 'unknown',
    wayfind_team: teamId,
  };

  try {
    client.capture({ distinctId, event, properties: props });
  } catch {
    // Never let telemetry break the app
  }
}

/**
 * Identify a group (team).
 * @param {Object} properties - Group properties (team_size, tool, etc.)
 */
function identifyTeam(properties) {
  init();
  if (!client || !enabled) return;

  try {
    client.groupIdentify({
      groupType: 'team',
      groupKey: getDistinctId(),
      properties,
    });
  } catch {
    // Never let telemetry break the app
  }
}

/**
 * Flush pending events. Call before process exit.
 */
async function flush() {
  if (!client || !enabled) return;
  try {
    await client.flush();
  } catch {
    // Ignore flush errors
  }
}

let _version = null;
function getWayfindVersion() {
  if (_version) return _version;
  try {
    const pkg = require('../package.json');
    _version = pkg.version || 'unknown';
  } catch {
    _version = 'unknown';
  }
  return _version;
}

// ── Slack user identity resolution ──────────────────────────────────────────

let _slackUserMap = null;

function buildSlackUserMap(membersDir) {
  if (!membersDir || !fs.existsSync(membersDir)) return {};
  const map = {};
  for (const file of fs.readdirSync(membersDir).filter(f => f.endsWith('.json'))) {
    try {
      const member = JSON.parse(fs.readFileSync(path.join(membersDir, file), 'utf8'));
      if (member.slack_user_id) {
        map[member.slack_user_id] = file.replace('.json', '');
      }
    } catch {
      // Skip malformed member files
    }
  }
  return map;
}

/**
 * Resolve a Slack user ID to an author slug using the members directory.
 * Falls back to the raw Slack ID if no match is found.
 * @param {string} slackUserId - Slack user ID (e.g. 'U01ABC123')
 * @param {string} membersDir - Path to team-context/members/ directory
 * @returns {string} Author slug or raw Slack ID
 */
function resolveSlackUser(slackUserId, membersDir) {
  if (!slackUserId) return null;
  if (!_slackUserMap) _slackUserMap = buildSlackUserMap(membersDir);
  return _slackUserMap[slackUserId] || slackUserId;
}

module.exports = {
  capture,
  identifyTeam,
  flush,
  getDistinctId,
  getWayfindVersion,
  resolveSlackUser,
};
