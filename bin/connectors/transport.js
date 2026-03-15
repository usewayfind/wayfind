'use strict';

const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Simulation mode ─────────────────────────────────────────────────────────

function isSimulation() {
  return process.env.TEAM_CONTEXT_SIMULATE === '1';
}

function loadFixture(fixturesDir, endpoint) {
  if (endpoint.includes('/issues')) {
    return JSON.parse(fs.readFileSync(path.join(fixturesDir, 'issues.json'), 'utf8'));
  }
  if (endpoint.includes('/pulls')) {
    return JSON.parse(fs.readFileSync(path.join(fixturesDir, 'pull_requests.json'), 'utf8'));
  }
  if (endpoint.includes('/actions/runs')) {
    const data = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'workflow_runs.json'), 'utf8'));
    return data.workflow_runs || data;
  }
  return [];
}

function getFixturesDir() {
  return process.env.TEAM_CONTEXT_SIM_FIXTURES || '';
}

// ── gh CLI transport ────────────────────────────────────────────────────────

const ghCli = {
  /**
   * Check whether the gh CLI is authenticated and available.
   * @returns {Promise<boolean>}
   */
  available() {
    return new Promise((resolve) => {
      execFile('gh', ['auth', 'status'], (err) => {
        resolve(!err);
      });
    });
  },

  /**
   * List authenticated gh CLI accounts.
   * @returns {Promise<string[]>} Array of usernames
   */
  listAccounts() {
    return new Promise((resolve) => {
      execFile('gh', ['auth', 'status'], (err, stdout, stderr) => {
        const output = stderr || stdout || '';
        const accounts = [];
        const re = /Logged in to github\.com account (\S+)/g;
        let m;
        while ((m = re.exec(output)) !== null) {
          accounts.push(m[1]);
        }
        resolve(accounts);
      });
    });
  },

  /**
   * Get the auth token for a specific gh CLI user.
   * @param {string} username
   * @returns {Promise<string>}
   */
  tokenForUser(username) {
    return new Promise((resolve, reject) => {
      execFile('gh', ['auth', 'token', '-u', username], (err, stdout) => {
        if (err) {
          reject(new Error(`Failed to get token for gh user "${username}": ${err.message}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  },

  /**
   * Fetch a paginated GitHub API endpoint via gh CLI.
   * @param {string} endpoint - e.g. /repos/{owner}/{repo}/issues
   * @param {Object} [params] - query string parameters
   * @param {Object} [opts] - options
   * @param {string} [opts.ghUser] - specific gh CLI user to authenticate as
   * @returns {Promise<Array>}
   */
  get(endpoint, params, opts) {
    if (isSimulation()) {
      return Promise.resolve(loadFixture(getFixturesDir(), endpoint));
    }

    const resolveToken = (opts && opts.ghUser)
      ? ghCli.tokenForUser(opts.ghUser)
      : Promise.resolve(null);

    return resolveToken.then((token) => new Promise((resolve, reject) => {
      // Build query string into the URL — using -f flags would send POST form
      // fields, causing GET endpoints to 422 or 404.
      let fullEndpoint = endpoint;
      if (params) {
        const qs = Object.entries(params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&');
        fullEndpoint += (endpoint.includes('?') ? '&' : '?') + qs;
      }
      const args = ['api', '--paginate', fullEndpoint];

      const execOpts = { maxBuffer: 50 * 1024 * 1024 };
      if (token) {
        execOpts.env = { ...process.env, GH_TOKEN: token };
      }

      execFile('gh', args, execOpts, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gh api failed: ${stderr || err.message}`));
          return;
        }

        const trimmed = stdout.trim();
        try {
          // gh --paginate may emit multiple JSON arrays — one per page.
          // Concatenate them into a single array.
          if (!trimmed) {
            resolve([]);
            return;
          }

          // Try parsing as a single JSON value first
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            resolve(parsed);
          } else if (parsed && typeof parsed === 'object') {
            // Unwrap GitHub API wrapper objects like { workflow_runs: [...] }
            const arrayProp = Object.values(parsed).find(v => Array.isArray(v));
            resolve(arrayProp || [parsed]);
          } else {
            resolve([parsed]);
          }
        } catch (_parseErr) {
          // gh --paginate may output multiple JSON values concatenated
          // together: arrays (][), objects (}{), or newline-separated.
          try {
            const results = [];
            // Split into individual JSON values by tracking brace/bracket depth
            let depth = 0;
            let start = 0;
            let inString = false;
            let escape = false;
            for (let i = 0; i < trimmed.length; i++) {
              const c = trimmed[i];
              if (escape) { escape = false; continue; }
              if (c === '\\' && inString) { escape = true; continue; }
              if (c === '"') { inString = !inString; continue; }
              if (inString) continue;
              if (c === '{' || c === '[') depth++;
              else if (c === '}' || c === ']') {
                depth--;
                if (depth === 0) {
                  const chunk = trimmed.slice(start, i + 1);
                  const val = JSON.parse(chunk);
                  if (Array.isArray(val)) {
                    results.push(...val);
                  } else if (val && typeof val === 'object') {
                    const arrayProp = Object.values(val).find(v => Array.isArray(v));
                    if (arrayProp) {
                      results.push(...arrayProp);
                    } else {
                      results.push(val);
                    }
                  } else {
                    results.push(val);
                  }
                  start = i + 1;
                }
              }
            }
            resolve(results);
          } catch (mergeErr) {
            reject(new Error(`Failed to parse gh api output: ${mergeErr.message}`));
          }
        }
      });
    }));
  },
};

// ── HTTPS transport ─────────────────────────────────────────────────────────

const httpsTransport = {
  /**
   * Fetch a paginated GitHub API endpoint via Node's built-in https module.
   * @param {string} token - GitHub personal access token
   * @param {string} endpoint - e.g. /repos/{owner}/{repo}/issues
   * @param {Object} [params] - query string parameters
   * @returns {Promise<Array>}
   */
  get(token, endpoint, params) {
    if (isSimulation()) {
      return Promise.resolve(loadFixture(getFixturesDir(), endpoint));
    }

    const results = [];

    function buildPath(ep, p) {
      const qs = p ? Object.entries(p).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
      return qs ? `${ep}?${qs}` : ep;
    }

    function fetchPage(url) {
      return new Promise((resolve, reject) => {
        const opts = typeof url === 'string' && url.startsWith('https://')
          ? new URL(url)
          : {
              hostname: 'api.github.com',
              path: buildPath(endpoint, params),
              method: 'GET',
            };

        const reqOpts = {
          hostname: opts.hostname || 'api.github.com',
          path: opts.pathname ? opts.pathname + (opts.search || '') : opts.path,
          method: 'GET',
          headers: {
            'User-Agent': 'wayfind',
            Accept: 'application/vnd.github+json',
            Authorization: `token ${token}`,
          },
        };

        const req = https.request(reqOpts, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`GitHub API returned ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
              return;
            }

            try {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              let items;
              if (Array.isArray(body)) {
                items = body;
              } else if (body && typeof body === 'object') {
                // Unwrap GitHub API wrapper objects like { workflow_runs: [...] }
                const arrayProp = Object.values(body).find(v => Array.isArray(v));
                items = arrayProp || [body];
              } else {
                items = [body];
              }
              results.push(...items);

              // Follow pagination via Link header
              const linkHeader = res.headers.link;
              const nextUrl = parseLinkNext(linkHeader);
              if (nextUrl) {
                // Clear params for subsequent pages — the URL already contains them
                fetchPage(nextUrl).then(resolve).catch(reject);
              } else {
                resolve(results);
              }
            } catch (parseErr) {
              reject(new Error(`Failed to parse GitHub API response: ${parseErr.message}`));
            }
          });
        });

        req.on('error', reject);
        req.end();
      });
    }

    return fetchPage(null);
  },
};

/**
 * Parse the `next` URL from a GitHub Link header.
 * @param {string|undefined} header
 * @returns {string|null}
 */
function parseLinkNext(header) {
  if (!header) return null;
  const parts = header.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

// ── Auto-detect transport ───────────────────────────────────────────────────

/**
 * Detect the best available transport method.
 * Prefers gh CLI; falls back to HTTPS with a token from gh or environment.
 * @returns {Promise<{ type: 'gh-cli' } | { type: 'https', token: string }>}
 */
async function detect() {
  const hasGh = await ghCli.available();
  if (hasGh) {
    return { type: 'gh-cli' };
  }

  // Fall back to HTTPS — look for a token in the environment
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (token) {
    return { type: 'https', token };
  }

  // No transport available
  return { type: 'https', token: '' };
}

module.exports = {
  detect,
  ghCli,
  https: httpsTransport,
  loadFixture,
  isSimulation,
};
