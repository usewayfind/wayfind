'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const contentStore = require('./content-store');
const llm = require('./connectors/llm');
const { markdownToMrkdwn } = require('./slack');
const telemetry = require('./telemetry');

// ── Slack connection state (for healthcheck) ────────────────────────────────
let slackConnected = false;

let slackLastConnected = null;
let slackLastDisconnected = null;

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE;
const WAYFIND_DIR = path.join(HOME, '.claude', 'team-context');
const ENV_FILE = path.join(WAYFIND_DIR, '.env');

/** Slack mrkdwn has a practical limit; split responses over this threshold. */
const MAX_RESPONSE_LENGTH = 3000;

/** Maximum thread exchanges to include as conversation context. */
const MAX_THREAD_EXCHANGES = 5;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Split a long message into chunks that fit within Slack's size limits.
 * Tries to split at paragraph boundaries when possible.
 * @param {string} text - Text to split
 * @param {number} maxLen - Maximum chunk length
 * @returns {string[]}
 */
function chunkMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at a paragraph break
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      // Paragraph break is too early — try a single newline
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // No good break point — hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Thread history ──────────────────────────────────────────────────────────

/**
 * Fetch recent thread messages for conversation context.
 * Returns array of { role: 'user'|'bot', text: string }.
 * @param {Object} client - Slack Web API client
 * @param {string} channel - Channel ID
 * @param {string} threadTs - Thread timestamp
 * @param {string} botUserId - Bot's Slack user ID
 * @param {string} currentTs - Current message ts (excluded from history)
 * @returns {Promise<Array<{ role: string, text: string }>>}
 */
async function fetchThreadHistory(client, channel, threadTs, botUserId, currentTs) {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });
    const messages = (result.messages || [])
      .filter(m => m.ts !== threadTs && m.ts !== currentTs) // exclude root + current
      .slice(-(MAX_THREAD_EXCHANGES * 2)); // keep last N exchanges

    return messages.map(m => ({
      role: m.user === botUserId ? 'bot' : 'user',
      text: m.text || '',
    }));
  } catch {
    return [];
  }
}

// ── Query pipeline ───────────────────────────────────────────────────────────

/**
 * Extract the actual query from a Slack message text.
 * Strips bot mention patterns like <@U12345> and @wayfind prefix.
 * @param {string} text - Raw message text from Slack
 * @param {string} [botUserId] - Bot's Slack user ID
 * @returns {string} - Cleaned query text
 */
function extractQuery(text, botUserId) {
  let query = text;

  // Strip Slack user mention: <@U12345>
  if (botUserId) {
    query = query.replace(new RegExp(`<@${botUserId}>`, 'g'), '');
  }
  // Strip any remaining <@...> mentions
  query = query.replace(/<@[A-Z0-9]+>/g, '');

  // Trim before checking @wayfind prefix so leading spaces don't prevent match
  query = query.trim();

  // Strip @wayfind prefix (case-insensitive)
  query = query.replace(/^@wayfind\s*/i, '');

  return query.trim();
}

// ── Tool-use relay query handler ────────────────────────────────────────────


/** Build system prompt for the tool-use relay. */
function buildBotSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Wayfind, a team context assistant. Answer questions about the team's engineering decisions, work sessions, and project history using the provided tools.

Today's date is ${today}.

Rules:
- Use search_context to find relevant entries. Use get_entry to read full content.
- For time-range questions ("this week", "yesterday"), use mode=browse with since/until date filters.
- For topical questions, use mode=semantic with a query string.
- For person-specific questions ("what did Nick do"), set the user parameter to their first name lowercase.
- You may call search_context multiple times with different parameters if needed.
- Be concise and specific. Under 500 words. Cite dates and repos.
- Each entry has an Author field. When asked about a specific person, use the user parameter to filter, don't just search for their name.
- Format your response in markdown. Use bullet points for lists.
- Do not invent information that isn't in the provided context.`;
}

/** Tool definitions for the bot's LLM relay — mirrors MCP search_context + get_entry. */
const BOT_TOOLS = [
  {
    name: 'search_context',
    description: 'Search team decision history. Use mode=browse with date filters for time-range queries ("what happened this week"). Use mode=semantic with a query for topical searches ("what did we decide about retry logic").',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (optional for browse mode)' },
        since: { type: 'string', description: 'Start date filter (YYYY-MM-DD)' },
        until: { type: 'string', description: 'End date filter (YYYY-MM-DD)' },
        user: { type: 'string', description: 'Author slug filter (lowercase first name)' },
        repo: { type: 'string', description: 'Repository name filter' },
        source: { type: 'string', enum: ['journal', 'conversation', 'signal'], description: 'Entry source type filter' },
        mode: { type: 'string', enum: ['semantic', 'browse'], description: 'Search strategy. semantic (default) uses embeddings. browse returns entries sorted by date.' },
        limit: { type: 'number', description: 'Max results to return (default 10)' },
      },
    },
  },
  {
    name: 'get_entry',
    description: 'Retrieve the full content of a specific entry by ID. Use IDs returned by search_context.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry ID from search_context results' },
      },
      required: ['id'],
    },
  },
];

/**
 * Handle a bot query using LLM tool-use relay.
 * Instead of parsing intent ourselves, we give Claude the user's question
 * and let it decide which search_context/get_entry calls to make.
 * @param {string} query - User's question
 * @param {Object} config - Bot configuration from connectors.json
 * @param {Array<{ role: string, text: string }>} [threadHistory] - Prior thread messages
 * @returns {Promise<{ text: string }>}
 */
async function handleQuery(query, config, threadHistory) {
  const llmConfig = config.llm || {};
  const storePath = config.store_path;
  const journalDir = config.journal_dir;

  // Handle tool calls by calling content-store directly (same container, no HTTP round-trip)
  async function handleToolCall(name, input) {
    if (name === 'search_context') {
      const opts = {
        limit: input.limit || 10,
        storePath,
        journalDir,
      };
      if (input.since) opts.since = input.since;
      if (input.until) opts.until = input.until;
      if (input.user) opts.user = input.user;
      if (input.repo) opts.repo = input.repo;
      if (input.source) opts.source = input.source;

      let results;
      if (input.mode === 'browse' || (!input.query && !input.mode)) {
        results = contentStore.queryMetadata(opts);
        return results.slice(0, opts.limit).map(r => ({
          id: r.id,
          date: r.entry.date,
          repo: r.entry.repo,
          title: r.entry.title,
          user: r.entry.user,
          source: r.entry.source,
          tags: r.entry.tags || [],
        }));
      }

      try {
        results = await contentStore.searchJournals(input.query || '', opts);
      } catch {
        results = contentStore.queryMetadata(opts);
      }

      return (results || []).slice(0, opts.limit).map(r => ({
        id: r.id,
        score: r.score != null ? Math.round(r.score * 1000) / 1000 : null,
        date: r.entry.date,
        repo: r.entry.repo,
        title: r.entry.title,
        user: r.entry.user,
        source: r.entry.source,
        tags: r.entry.tags || [],
      }));
    }

    if (name === 'get_entry') {
      const content = contentStore.getEntryContent(input.id, { storePath, journalDir });
      return content || { error: `Entry not found: ${input.id}` };
    }

    return { error: `Unknown tool: ${name}` };
  }

  // Build user message with thread context if available
  let userMessage = query;
  if (threadHistory && threadHistory.length > 0) {
    const context = threadHistory
      .map(t => `${t.role === 'bot' ? 'Wayfind' : 'User'}: ${t.text}`)
      .join('\n');
    userMessage = `Previous conversation:\n${context}\n\nNew question: ${query}`;
  }

  try {
    const answer = await llm.callWithTools(
      { ...llmConfig, provider: 'anthropic', api_key_env: llmConfig.api_key_env || 'ANTHROPIC_API_KEY', model: process.env.WAYFIND_BOT_MODEL || llmConfig.query_model || llmConfig.model || 'claude-haiku-4-5-20251001' },
      buildBotSystemPrompt(),
      userMessage,
      BOT_TOOLS,
      handleToolCall
    );

    const text = markdownToMrkdwn(answer);
    return { text };
  } catch (err) {
    console.error(`Tool-use query failed: ${err.message}`);
    return { text: `I had trouble answering that question: ${err.message}. Try asking in Claude Code or claude.ai where you can use the Wayfind MCP tools directly.` };
  }
}

// ── Bot lifecycle ────────────────────────────────────────────────────────────

/**
 * Resolve the team-context members directory from environment or config.
 * @param {Object} config - Bot config
 * @returns {string|null}
 */
function resolveMembersDir(config) {
  const teamDir = config.team_context_dir || process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR || '';
  if (teamDir) {
    const dir = path.join(teamDir, 'members');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Start the Slack bot using Socket Mode.
 * Connects to Slack, listens for @mentions, and runs the query pipeline.
 * @param {Object} config - Bot configuration from connectors.json (slack_bot key)
 * @returns {Promise<{ app: Object, stop: Function }>}
 */
async function start(config) {
  // Lazy-require @slack/bolt so the module can be loaded without it installed
  // (e.g. for configure-only flows or testing)
  let App, LogLevel;
  try {
    const bolt = require('@slack/bolt');
    App = bolt.App;
    LogLevel = bolt.LogLevel;
  } catch {
    throw new Error(
      '@slack/bolt is not installed. Run "npm install @slack/bolt" in the Wayfind directory.'
    );
  }

  // Ensure journal_dir has a default for configs saved before this field existed
  if (!config.journal_dir) {
    config.journal_dir = process.env.TEAM_CONTEXT_JOURNALS_DIR || '/data/journals';
  }

  // Resolve tokens from environment
  const botTokenEnv = config.bot_token_env || 'SLACK_BOT_TOKEN';
  const appTokenEnv = config.app_token_env || 'SLACK_APP_TOKEN';
  const botToken = process.env[botTokenEnv];
  const appToken = process.env[appTokenEnv];

  if (!botToken) {
    throw new Error(
      `Missing ${botTokenEnv}. Run "wayfind bot --configure" or set it in your environment.`
    );
  }
  if (!appToken) {
    throw new Error(
      `Missing ${appTokenEnv}. Run "wayfind bot --configure" or set it in your environment.`
    );
  }

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });

  // Get bot user ID for mention detection
  let botUserId;
  try {
    const auth = await app.client.auth.test();
    botUserId = auth.user_id;
  } catch (err) {
    console.error(`Warning: Could not get bot user ID: ${err.message}`);
  }

  // Build members directory path for Slack user identity resolution
  const teamContextDir = config.team_context_dir || process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR || null;
  const membersDir = teamContextDir ? path.join(teamContextDir, 'members') : null;

  // Handle @mentions
  app.event('app_mention', async ({ event, client }) => {
    const channel = event.channel;
    const threadTs = event.thread_ts || event.ts;

    // Acknowledge with eyes emoji
    try {
      await client.reactions.add({
        channel,
        timestamp: event.ts,
        name: 'eyes',
      });
    } catch {
      // Non-critical — continue even if reaction fails
    }

    // Extract and validate query
    const query = extractQuery(event.text, botUserId);
    if (!query) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: 'What would you like to know? Mention me with a question about your team\'s decision trail.',
      });
      return;
    }

    try {
      // Handle onboard command
      const onboardMatch = query.match(/^onboard\s+(.+)/i);
      if (onboardMatch) {
        const repoQuery = onboardMatch[1].trim();
        await client.reactions.add({ channel, timestamp: event.ts, name: 'hourglass_flowing_sand' }).catch(() => {});
        try {
          const pack = await contentStore.generateOnboardingPack(repoQuery, {
            storePath: config.store_path || undefined,
            journalDir: config.journal_dir || undefined,
            llmConfig: config.llm || undefined,
          });
          const formatted = markdownToMrkdwn(pack);
          const chunks = chunkMessage(formatted, MAX_RESPONSE_LENGTH);
          for (const chunk of chunks) {
            await client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
          }
        } catch (err) {
          await client.chat.postMessage({
            channel, thread_ts: threadTs,
            text: `Onboarding pack failed: ${err.message}`,
          });
        }
        return;
      }

      // Handle reindex command
      if (query.toLowerCase().match(/^reindex\b/)) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: 'Re-indexing all sources... this may take a few minutes.',
        });
        try {
          const journalStats = await contentStore.indexJournals({
            storePath: config.store_path || undefined,
            journalDir: config.journal_dir || undefined,
          });
          const convStats = await contentStore.indexConversations({
            storePath: config.store_path || undefined,
          });
          let signalStats = { fileCount: 0, newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
          const signalsDir = process.env.TEAM_CONTEXT_SIGNALS_DIR || contentStore.DEFAULT_SIGNALS_DIR;
          if (signalsDir && fs.existsSync(signalsDir)) {
            signalStats = await contentStore.indexSignals({ signalsDir });
          }
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `Reindex complete.\n` +
              `Journals: ${journalStats.entryCount} entries (${journalStats.newEntries} new)\n` +
              `Conversations: ${convStats.transcriptsProcessed} processed, ${convStats.decisionsExtracted} decisions extracted\n` +
              `Signals: ${signalStats.fileCount} files (${signalStats.newEntries} new, ${signalStats.updatedEntries} updated)`,
          });
        } catch (reindexErr) {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `Reindex failed: ${reindexErr.message}`,
          });
        }
        return;
      }

      // Fetch thread history for conversation context
      let threadHistory = [];
      if (event.thread_ts && botUserId) {
        threadHistory = await fetchThreadHistory(client, channel, event.thread_ts, botUserId, event.ts);
      }

      const result = await handleQuery(query, config, threadHistory);
      const authorSlug = telemetry.resolveSlackUser(event.user, membersDir);
      telemetry.capture('bot_query', { response_length: result.text.length }, authorSlug);

      // Split long responses into chunks
      const chunks = chunkMessage(result.text, MAX_RESPONSE_LENGTH);
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: chunk,
        });
      }
    } catch (err) {
      console.error(`Query failed: ${err.message}`);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Something went wrong while processing your query: ${err.message}`,
      });
    }
  });

  // Listen for threaded replies in conversations the bot is already in.
  // This lets users ask follow-up questions without re-mentioning @Wayfind.
  app.event('message', async ({ event, client }) => {
    // Only respond to threaded replies (not top-level messages)
    if (!event.thread_ts) return;
    // Ignore bot's own messages
    if (event.user === botUserId || event.bot_id) return;
    // Ignore messages that mention the bot (handled by app_mention)
    if (event.text && event.text.includes(`<@${botUserId}>`)) return;
    // Ignore messages that @mention other users — the message is directed at a person, not the bot.
    // Slack encodes mentions as <@U...>. If any mention is present and none is the bot, skip.
    if (event.text && /<@U[A-Z0-9]+>/.test(event.text)) return;
    // Ignore message subtypes (edits, joins, etc.)
    if (event.subtype) return;

    // Check if this is a reply to a digest message — capture as feedback
    const feedbackRecorded = contentStore.recordDigestFeedbackText({
      messageTs: event.thread_ts,
      user: event.user,
      text: event.text ? event.text.trim() : '',
      storePath: config.store_path,
    });
    if (feedbackRecorded) {
      const feedbackAuthor = telemetry.resolveSlackUser(event.user, membersDir);
      telemetry.capture('digest_feedback', { text_length: event.text ? event.text.length : 0 }, feedbackAuthor);
      try {
        await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'memo' });
      } catch { /* non-critical */ }
      return; // Don't process as a bot query
    }

    // Check if the bot has already replied in this thread
    let botInThread = false;
    try {
      const result = await client.conversations.replies({
        channel: event.channel,
        ts: event.thread_ts,
        limit: 20,
      });
      botInThread = (result.messages || []).some(
        (m) => m.user === botUserId || (m.bot_id && m.user === botUserId)
      );
    } catch {
      // Can't read thread — skip
      return;
    }

    if (!botInThread) return;

    const channel = event.channel;
    const threadTs = event.thread_ts;
    const query = event.text ? event.text.trim() : '';
    if (!query) return;

    // Acknowledge
    try {
      await client.reactions.add({ channel, timestamp: event.ts, name: 'eyes' });
    } catch { /* non-critical */ }

    try {
      // Fetch thread history for context
      const threadHistory = await fetchThreadHistory(client, channel, threadTs, botUserId, event.ts);
      const result = await handleQuery(query, config, threadHistory);
      const authorSlug = telemetry.resolveSlackUser(event.user, membersDir);
      telemetry.capture('bot_query', { response_length: result.text.length }, authorSlug);

      const chunks = chunkMessage(result.text, MAX_RESPONSE_LENGTH);
      for (const chunk of chunks) {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
      }
    } catch (err) {
      console.error(`Thread reply query failed: ${err.message}`);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Something went wrong: ${err.message}`,
      });
    }
  });

  // ── Reaction tracking for digest feedback ──────────────────────────────────
  app.event('reaction_added', async ({ event }) => {
    try {
      const recorded = contentStore.recordDigestReaction({
        messageTs: event.item.ts,
        reaction: event.reaction,
        delta: 1,
        storePath: config.store_path,
      });
      if (recorded) {
        const reactionAuthor = telemetry.resolveSlackUser(event.user, membersDir);
        telemetry.capture('digest_reaction', { reaction_emoji: event.reaction, delta: 1 }, reactionAuthor);
      }
    } catch (err) {
      // Silently ignore — reaction may not be on a tracked digest message
    }
  });

  app.event('reaction_removed', async ({ event }) => {
    try {
      const recorded = contentStore.recordDigestReaction({
        messageTs: event.item.ts,
        reaction: event.reaction,
        delta: -1,
        storePath: config.store_path,
      });
      if (recorded) {
        const reactionAuthor = telemetry.resolveSlackUser(event.user, membersDir);
        telemetry.capture('digest_reaction', { reaction_emoji: event.reaction, delta: -1 }, reactionAuthor);
      }
    } catch (err) {
      // Silently ignore
    }
  });

  await app.start();

  // Track Socket Mode WebSocket connection state for healthcheck
  slackConnected = true;
  slackLastConnected = new Date().toISOString();
  if (app.receiver && app.receiver.client) {
    const socketClient = app.receiver.client;
    socketClient.on('connected', () => {
      slackConnected = true;
      slackLastConnected = new Date().toISOString();
      console.log(`[${slackLastConnected}] Slack WebSocket reconnected`);
    });
    socketClient.on('disconnected', () => {
      slackConnected = false;
      slackLastDisconnected = new Date().toISOString();
      console.log(`[${slackLastDisconnected}] Slack WebSocket disconnected`);
    });
  }

  console.log('Wayfind bot connected to Slack (Socket Mode)');
  if (botUserId) {
    console.log(`Bot user ID: ${botUserId}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down Wayfind bot...');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    app,
    stop: () => app.stop(),
  };
}

/**
 * Returns current Slack WebSocket connection state for healthcheck integration.
 */
function getConnectionStatus() {
  return {
    connected: slackConnected,
    lastConnected: slackLastConnected,
    lastDisconnected: slackLastDisconnected,
  };
}

// ── Configure ────────────────────────────────────────────────────────────────

/**
 * Interactive setup for the Slack bot.
 * Prompts for tokens, validates format, saves to .env and returns config.
 * @returns {Promise<Object>} - Bot configuration for connectors.json
 */
async function configure() {
  console.log('');
  console.log('Wayfind Slack Bot Configuration');
  console.log('================================');
  console.log('');
  console.log('Prerequisites:');
  console.log('  1. Create a Slack app at https://api.slack.com/apps');
  console.log('  2. Enable Socket Mode (Settings > Socket Mode)');
  console.log('  3. Add an App-Level Token with "connections:write" scope');
  console.log('  4. Add Bot Token Scopes: app_mentions:read, chat:write, reactions:read, reactions:write');
  console.log('  5. Subscribe to bot events: app_mention, reaction_added, reaction_removed');
  console.log('  6. Install the app to your workspace');
  console.log('');

  // App-Level Token
  const appToken = await ask('App-Level Token (xapp-...): ');
  if (!appToken.startsWith('xapp-')) {
    console.error('Error: App-Level Token must start with "xapp-".');
    process.exit(1);
  }

  // Bot Token
  const botToken = await ask('Bot User OAuth Token (xoxb-...): ');
  if (!botToken.startsWith('xoxb-')) {
    console.error('Error: Bot Token must start with "xoxb-".');
    process.exit(1);
  }

  // Save tokens to .env
  saveEnvKey('SLACK_APP_TOKEN', appToken);
  saveEnvKey('SLACK_BOT_TOKEN', botToken);

  // LLM config — detect or reuse from digest
  let llmConfig = {};
  const connectorsFile = path.join(WAYFIND_DIR, 'connectors.json');
  try {
    const connectors = JSON.parse(fs.readFileSync(connectorsFile, 'utf8'));
    if (connectors.digest && connectors.digest.llm) {
      console.log(`\nFound existing LLM config from digest: ${connectors.digest.llm.provider}`);
      const reuse = await ask('Reuse this LLM config for the bot? (Y/n): ');
      if (!reuse || reuse.toLowerCase() !== 'n') {
        llmConfig = { ...connectors.digest.llm };
      }
    }
  } catch {
    // No existing config — detect
  }

  if (!llmConfig.provider) {
    const detected = await llm.detect();
    if (detected) {
      console.log(`\nDetected: ${detected.provider} (${detected.model || 'default model'})`);
      const useDetected = await ask(`Use ${detected.provider}? (Y/n): `);
      if (!useDetected || useDetected.toLowerCase() !== 'n') {
        llmConfig = detected;
      }
    }

    if (!llmConfig.provider) {
      console.log('\nAvailable providers: anthropic, openai, cli');
      const provider = await ask('LLM provider: ');
      llmConfig.provider = provider;

      if (provider === 'anthropic') {
        llmConfig.model = (await ask('Model (default: claude-sonnet-4-5-20250929): ')) || 'claude-sonnet-4-5-20250929';
        llmConfig.api_key_env = 'ANTHROPIC_API_KEY';
      } else if (provider === 'openai') {
        llmConfig.model = (await ask('Model (default: gpt-4o-mini): ')) || 'gpt-4o-mini';
        llmConfig.api_key_env = (await ask('API key env var (default: OPENAI_API_KEY): ')) || 'OPENAI_API_KEY';
      } else if (provider === 'cli') {
        llmConfig.command = await ask('Command (e.g. "ollama run llama3.2"): ');
      }
    }
  }

  const config = {
    mode: 'local',
    bot_token_env: 'SLACK_BOT_TOKEN',
    app_token_env: 'SLACK_APP_TOKEN',
    llm: llmConfig,
    store_path: null,
    configured_at: new Date().toISOString(),
  };

  console.log('');
  console.log('Slack bot configured successfully.');
  console.log('');
  console.log('Start the bot with:');
  console.log('  wayfind bot');
  console.log('');

  return config;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  configure,
  start,
  getConnectionStatus,
  handleQuery,
  extractQuery,
  chunkMessage,
  fetchThreadHistory,
};
