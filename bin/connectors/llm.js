'use strict';

const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 60000;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// ── Simulation mode ─────────────────────────────────────────────────────────

function isSimulation() {
  return process.env.TEAM_CONTEXT_SIMULATE === '1';
}

function getRepoRoot() {
  // Walk up from this file's directory to find the repo root
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function loadDigestFixture(personaId) {
  const fixturesDir = process.env.TEAM_CONTEXT_SIM_DIGEST_DIR
    || path.join(getRepoRoot(), 'simulation', 'fixtures', 'digests');

  const fixturePath = path.join(fixturesDir, `${personaId}.md`);
  try {
    return fs.readFileSync(fixturePath, 'utf8');
  } catch {
    return `[Simulated digest for ${personaId}]`;
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * Make an HTTP/HTTPS POST request using Node.js built-ins.
 * @param {string} url - Full URL to POST to
 * @param {Object} headers - Request headers
 * @param {string} body - JSON string body
 * @returns {Promise<{ statusCode: number, headers: Object, body: string }>}
 */
function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;

    // Wall-clock deadline covers entire lifecycle (connect + response body)
    const deadline = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    };

    const req = transport.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(deadline);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
      res.on('error', (err) => {
        clearTimeout(deadline);
        reject(new Error(`Response read error: ${err.message}`));
      });
    });

    req.on('error', (err) => {
      clearTimeout(deadline);
      reject(new Error(`Network error: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Check an HTTP response for common error conditions and throw descriptive errors.
 * @param {Object} res - Response from httpPost
 * @param {string} provider - Provider name for error messages
 */
function checkResponse(res, provider) {
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new Error(`${provider}: Authentication failed (${res.statusCode}). Check your API key.`);
  }
  if (res.statusCode === 429) {
    const retryAfter = res.headers['retry-after'];
    const msg = retryAfter
      ? `${provider}: Rate limited. Retry after ${retryAfter} seconds.`
      : `${provider}: Rate limited. Try again later.`;
    throw new Error(msg);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const snippet = (res.body || '').slice(0, 500);
    throw new Error(`${provider}: API returned ${res.statusCode}: ${snippet}`);
  }
}

// ── Provider: Anthropic ──────────────────────────────────────────────────────

async function callAnthropic(config, systemPrompt, userContent) {
  const apiKey = process.env[config.api_key_env];
  if (!apiKey) {
    throw new Error(`Anthropic: Missing API key. Set ${config.api_key_env} environment variable.`);
  }

  const payload = JSON.stringify({
    model: config.model,
    max_tokens: config.max_tokens || DEFAULT_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };

  const res = await httpPost(ANTHROPIC_API_URL, headers, payload);
  checkResponse(res, 'Anthropic');

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error('Anthropic: Failed to parse response JSON.');
  }

  if (!data.content || !Array.isArray(data.content) || data.content.length === 0) {
    throw new Error('Anthropic: Response missing content array.');
  }

  const textBlock = data.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error('Anthropic: Response contains no text content block.');
  }
  return textBlock.text;
}

// ── Provider: OpenAI-compatible ──────────────────────────────────────────────

async function callOpenAI(config, systemPrompt, userContent) {
  const baseUrl = config.base_url || OPENAI_API_URL.replace('/chat/completions', '');
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const headers = {};
  if (config.api_key_env) {
    const apiKey = process.env[config.api_key_env];
    if (!apiKey) {
      throw new Error(`OpenAI: Missing API key. Set ${config.api_key_env} environment variable.`);
    }
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const payload = JSON.stringify({
    model: config.model,
    max_tokens: config.max_tokens || DEFAULT_MAX_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  const res = await httpPost(url, headers, payload);
  checkResponse(res, 'OpenAI');

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error('OpenAI: Failed to parse response JSON.');
  }

  if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error('OpenAI: Response missing choices array.');
  }

  if (!data.choices[0].message || !data.choices[0].message.content) {
    throw new Error('OpenAI: Response missing message content.');
  }

  return data.choices[0].message.content;
}

// ── Provider: CLI ────────────────────────────────────────────────────────────

async function callCLI(config, systemPrompt, userContent) {
  const command = config.command;
  if (!command) {
    throw new Error('CLI: No command configured. Set config.command (e.g. "ollama run llama3.2").');
  }

  // Split command on first space: binary + remaining args
  const spaceIdx = command.indexOf(' ');
  const binary = spaceIdx === -1 ? command : command.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? [] : command.slice(spaceIdx + 1).split(/\s+/).filter(Boolean);

  const input = systemPrompt + '\n---\n' + userContent;

  return new Promise((resolve, reject) => {
    const proc = execFile(binary, args, {
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          reject(new Error(`CLI: Command timed out after ${REQUEST_TIMEOUT_MS}ms.`));
        } else {
          reject(new Error(`CLI: Command failed: ${stderr || err.message}`));
        }
        return;
      }

      const output = stdout.trim();
      if (!output) {
        reject(new Error('CLI: Command produced no output.'));
        return;
      }

      resolve(output);
    });

    // Pipe input to stdin
    if (proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

// ── Main call() function ─────────────────────────────────────────────────────

/**
 * Call an LLM provider with a system prompt and user content.
 * @param {Object} config - Provider configuration
 * @param {string} config.provider - 'anthropic' | 'openai' | 'cli' | 'simulate'
 * @param {string} config.model - Model identifier
 * @param {string} [config.api_key_env] - Environment variable name for API key
 * @param {string} [config.base_url] - Override URL for OpenAI-compatible providers
 * @param {string} [config.command] - CLI command for 'cli' provider
 * @param {string} [config._personaId] - Persona ID for simulation mode
 * @param {string} systemPrompt - System prompt
 * @param {string} userContent - User content
 * @returns {Promise<string>} - LLM response text
 */
async function call(config, systemPrompt, userContent) {
  // Simulation mode overrides any provider setting
  if (isSimulation() || config.provider === 'simulate') {
    const personaId = config._personaId || 'engineering';
    return loadDigestFixture(personaId);
  }

  switch (config.provider) {
    case 'anthropic':
      return callAnthropic(config, systemPrompt, userContent);
    case 'openai':
      return callOpenAI(config, systemPrompt, userContent);
    case 'cli':
      return callCLI(config, systemPrompt, userContent);
    default:
      throw new Error(`Unknown LLM provider: "${config.provider}". Expected: anthropic, openai, cli, simulate.`);
  }
}

// ── Auto-detect available provider ───────────────────────────────────────────

/**
 * Detect the best available LLM provider from environment.
 * @returns {Promise<{ provider: string, model: string, api_key_env: string|null, base_url: string|null, command: string|null }|null>}
 */
async function detect() {
  // 1. Check for Anthropic API key
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      api_key_env: 'ANTHROPIC_API_KEY',
      base_url: null,
      command: null,
    };
  }

  // 2. Check for OpenAI API key
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      model: 'gpt-4o-mini',
      api_key_env: 'OPENAI_API_KEY',
      base_url: null,
      command: null,
    };
  }

  // 3. Check if ollama binary is available
  const ollamaAvailable = await new Promise((resolve) => {
    execFile('which', ['ollama'], (err) => {
      resolve(!err);
    });
  });

  if (ollamaAvailable) {
    return {
      provider: 'openai',
      model: 'llama3.2',
      api_key_env: null,
      base_url: 'http://localhost:11434/v1',
      command: null,
    };
  }

  // 4. Nothing found
  return null;
}

// ── Embeddings ────────────────────────────────────────────────────────────────

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Generate an embedding vector for the given text.
 * Uses the OpenAI embeddings API (works with any OpenAI-compatible endpoint).
 * @param {string} text - Text to embed
 * @param {Object} [options] - Optional configuration
 * @param {string} [options.model] - Embedding model (default: text-embedding-3-small)
 * @param {string} [options.apiKeyEnv] - Env var name for API key (default: OPENAI_API_KEY)
 * @param {string} [options.baseUrl] - Override base URL for OpenAI-compatible endpoints
 * @returns {Promise<number[]>} - Embedding vector
 */
async function generateEmbedding(text, options = {}) {
  // Simulation mode: return a deterministic fake vector
  if (isSimulation()) {
    const dim = 1536;
    const vec = [];
    let seed = 0;
    for (let i = 0; i < text.length; i++) seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
    for (let i = 0; i < dim; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      vec.push((seed / 0x7fffffff) * 2 - 1);
    }
    // Normalize
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map(v => v / mag);
  }

  // Azure OpenAI: uses different URL pattern and api-key header
  const isAzure = !!(options.azureEndpoint || process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT);
  if (isAzure) {
    return generateEmbeddingAzure(text, options);
  }

  const apiKeyEnv = options.apiKeyEnv || 'OPENAI_API_KEY';
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Embeddings: Missing API key. Set ${apiKeyEnv} environment variable.`);
  }

  const baseUrl = options.baseUrl || OPENAI_EMBEDDINGS_URL.replace('/embeddings', '');
  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
  const model = options.model || DEFAULT_EMBEDDING_MODEL;

  const payload = JSON.stringify({
    model,
    input: text,
  });

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
  };

  const res = await httpPost(url, headers, payload);
  checkResponse(res, 'Embeddings');

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error('Embeddings: Failed to parse response JSON.');
  }

  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error('Embeddings: Response missing data array.');
  }

  if (!data.data[0].embedding || !Array.isArray(data.data[0].embedding)) {
    throw new Error('Embeddings: Response missing embedding vector.');
  }

  return data.data[0].embedding;
}

/**
 * Generate embedding via Azure OpenAI.
 * URL pattern: {endpoint}/openai/deployments/{deployment}/embeddings?api-version=2024-02-01
 * Auth: api-key header
 */
async function generateEmbeddingAzure(text, options = {}) {
  const endpoint = (options.azureEndpoint || process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT || '').replace(/\/+$/, '');
  const apiKeyEnv = options.azureApiKeyEnv || 'AZURE_OPENAI_EMBEDDING_KEY';
  const apiKey = process.env[apiKeyEnv];
  const deployment = options.azureDeployment || process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small';
  const apiVersion = options.azureApiVersion || '2024-02-01';

  if (!endpoint) {
    throw new Error('Azure OpenAI Embeddings: Set AZURE_OPENAI_EMBEDDING_ENDPOINT environment variable.');
  }
  if (!apiKey) {
    throw new Error(`Azure OpenAI Embeddings: Set ${apiKeyEnv} environment variable.`);
  }

  const url = `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`;
  const payload = JSON.stringify({ input: text });
  const headers = { 'api-key': apiKey };

  const res = await httpPost(url, headers, payload);
  checkResponse(res, 'Azure OpenAI Embeddings');

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error('Azure OpenAI Embeddings: Failed to parse response JSON.');
  }

  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error('Azure OpenAI Embeddings: Response missing data array.');
  }

  if (!data.data[0].embedding || !Array.isArray(data.data[0].embedding)) {
    throw new Error('Azure OpenAI Embeddings: Response missing embedding vector.');
  }

  return data.data[0].embedding;
}

module.exports = {
  call,
  detect,
  generateEmbedding,
  isSimulation,
};
