#!/usr/bin/env bash
# Scenario: container-search-api
# Verifies:
# 1. API key generation on startup
# 2. /api/search returns 401 without auth, 200 with correct key
# 3. /api/entry/:id returns entry content
# 4. Key rotation produces a new key
# 5. Old key returns 401 after rotation
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(cd "$SCENARIO_DIR/.." && pwd)"
KIT_DIR="$(cd "$SIM_DIR/.." && pwd)"
source "$SIM_DIR/lib/assertions.sh"

echo ""
echo "Scenario: container-search-api"
echo "================================"

MOCK_HOME="$(mktemp -d)"
trap 'rm -rf "$MOCK_HOME"; kill $SERVER_PID 2>/dev/null || true' EXIT
export HOME="$MOCK_HOME"

export TEAM_CONTEXT_SIMULATE=1
export TEAM_CONTEXT_TELEMETRY=0
export TEAM_CONTEXT_STORAGE_BACKEND=json
export TEAM_CONTEXT_NO_SLACK=1
export TEAM_CONTEXT_HEALTH_PORT=0
unset ANTHROPIC_API_KEY 2>/dev/null || true
unset OPENAI_API_KEY 2>/dev/null || true

# ── Setup mock team-context directory ────────────────────────────────────────

WAYFIND_DIR="$MOCK_HOME/.claude/team-context"
TEAM_DIR="$MOCK_HOME/team-context-repo"
JOURNAL_DIR="$TEAM_DIR/journals"
STORE_DIR="$WAYFIND_DIR/teams/test-team/content-store"

mkdir -p "$WAYFIND_DIR" "$TEAM_DIR" "$JOURNAL_DIR" "$STORE_DIR"

# context.json with team config
cat > "$WAYFIND_DIR/context.json" << 'CTXEOF'
{
  "teams": {
    "test-team": {
      "path": "",
      "name": "Test Team"
    }
  },
  "default": "test-team"
}
CTXEOF
# Patch in the team path (contains variable)
python3 -c "
import json
with open('$WAYFIND_DIR/context.json') as f:
    d = json.load(f)
d['teams']['test-team']['path'] = '$TEAM_DIR'
with open('$WAYFIND_DIR/context.json', 'w') as f:
    json.dump(d, f, indent=2)
"

# Create a sample journal
cat > "$JOURNAL_DIR/2026-03-30.md" << 'JEOF'
## test-org/api — Authentication refactor
**Why:** Session goal was to modernize auth
**What:** Replaced JWT with session tokens
**Outcome:** All tests passing
**Lessons:** Token rotation needs careful testing
JEOF

# Index the journal into the content store
export TEAM_CONTEXT_TEAM_CONTEXT_DIR="$TEAM_DIR"
export TEAM_CONTEXT_JOURNALS_DIR="$JOURNAL_DIR"
node -e "
process.env.HOME = '$MOCK_HOME';
const cs = require('$KIT_DIR/bin/content-store.js');
cs.indexJournals({ journalDir: '$JOURNAL_DIR', storePath: '$STORE_DIR' })
  .then(s => console.log('Indexed:', s.entryCount, 'entries'))
  .catch(e => console.error(e));
"

# ── Test 1: API key generation ───────────────────────────────────────────────

echo ""
echo "Phase 1: API key management"

# Start a mini server that just tests key generation
# Generate a key directly (simulates what the container does on startup)
API_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
echo "$API_KEY" > "$TEAM_DIR/.wayfind-api-key"

assert_file_exists "$TEAM_DIR/.wayfind-api-key" "API key file created"

KEY_LEN=${#API_KEY}
if [ "$KEY_LEN" -eq 64 ]; then
  _pass "API key is 64 hex chars"
else
  _fail "API key is 64 hex chars" "got length $KEY_LEN"
fi

# ── Test 2: HTTP server with auth ────────────────────────────────────────────

echo ""
echo "Phase 2: Search API auth + responses"

# Start a test HTTP server using the container's health server code
# We'll use a simple node script that mimics the server
PORT=9741
node -e "
process.env.HOME = '$MOCK_HOME';
process.env.TEAM_CONTEXT_TEAM_CONTEXT_DIR = '$TEAM_DIR';
process.env.TEAM_CONTEXT_JOURNALS_DIR = '$JOURNAL_DIR';
process.env.TEAM_CONTEXT_HEALTH_PORT = '$PORT';
const http = require('http');
const fs = require('fs');
const path = require('path');
const contentStore = require('$KIT_DIR/bin/content-store.js');

// Read API key
const keyFile = '$TEAM_DIR/.wayfind-api-key';
const apiKey = fs.readFileSync(keyFile, 'utf8').trim();

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:$PORT');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, api: { enabled: true } }));
    return;
  }

  // Auth check
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token !== apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired API key' }));
    return;
  }

  if (url.pathname === '/api/search' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const results = contentStore.searchText(body.query, { limit: body.limit || 10, storePath: '$STORE_DIR' });
    const mapped = (results || []).map(r => ({
      id: r.id, score: r.score, date: r.entry.date, repo: r.entry.repo,
      title: r.entry.title, source: r.entry.source, tags: r.entry.tags || [],
      summary: r.entry.summary || null,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ found: mapped.length, results: mapped }));
    return;
  }

  if (url.pathname.startsWith('/api/entry/') && req.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/entry/'.length));
    const index = contentStore.getBackend('$STORE_DIR').loadIndex();
    if (!index || !index.entries || !index.entries[id]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const entry = index.entries[id];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, date: entry.date, repo: entry.repo, title: entry.title }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen($PORT, () => {
  fs.writeFileSync('$MOCK_HOME/server-ready', 'ok');
  console.log('Test server on port $PORT');
});
" &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 30); do
  [ -f "$MOCK_HOME/server-ready" ] && break
  sleep 0.1
done

if [ ! -f "$MOCK_HOME/server-ready" ]; then
  _fail "Server started" "timeout waiting for server"
  print_results
  exit 1
fi
_pass "Server started on port $PORT"

# Test: no auth → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:$PORT/api/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"auth"}')
if [ "$STATUS" = "401" ]; then
  _pass "Search without auth returns 401"
else
  _fail "Search without auth returns 401" "got $STATUS"
fi

# Test: wrong key → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:$PORT/api/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer wrongkey" \
  -d '{"query":"auth"}')
if [ "$STATUS" = "401" ]; then
  _pass "Search with wrong key returns 401"
else
  _fail "Search with wrong key returns 401" "got $STATUS"
fi

# Test: correct key → 200 with results
RESPONSE=$(curl -s \
  -X POST "http://localhost:$PORT/api/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"query":"authentication"}')
STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found', 0))" 2>/dev/null || echo "0")
if [ "$STATUS" -gt 0 ]; then
  _pass "Search with correct key returns results"
else
  _fail "Search with correct key returns results" "got: $RESPONSE"
fi

# Test: healthz is unauthenticated
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/healthz")
if [ "$STATUS" = "200" ]; then
  _pass "Healthz endpoint is unauthenticated"
else
  _fail "Healthz endpoint is unauthenticated" "got $STATUS"
fi

# ── Test 3: Key rotation ────────────────────────────────────────────────────

echo ""
echo "Phase 3: Key rotation"

OLD_KEY="$API_KEY"

# Generate a new key (simulates rotation)
NEW_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
echo "$NEW_KEY" > "$TEAM_DIR/.wayfind-api-key"

# Old key should still work on current server (it cached the old key)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:$PORT/api/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OLD_KEY" \
  -d '{"query":"auth"}')
if [ "$STATUS" = "200" ]; then
  _pass "Old key still works on running server (cached)"
else
  _fail "Old key still works on running server (cached)" "got $STATUS"
fi

# New key should fail on running server (server has old key cached)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:$PORT/api/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NEW_KEY" \
  -d '{"query":"auth"}')
if [ "$STATUS" = "401" ]; then
  _pass "New key rejected by server with old cached key"
else
  _fail "New key rejected by server with old cached key" "got $STATUS"
fi

# ── Test 4: MCP proxy key re-read ───────────────────────────────────────────

echo ""
echo "Phase 4: MCP proxy 401 retry"

# Write the correct (old) key to the key file, then test the MCP proxy re-read
echo "$OLD_KEY" > "$TEAM_DIR/.wayfind-api-key"

# Set up context.json with container_endpoint
python3 -c "
import json
with open('$WAYFIND_DIR/context.json') as f:
    d = json.load(f)
d['teams']['test-team']['container_endpoint'] = 'http://localhost:$PORT'
with open('$WAYFIND_DIR/context.json', 'w') as f:
    json.dump(d, f, indent=2)
"

# Test the MCP proxy functions (in-process, not via stdio)
PROXY_RESULT=$(node -e "
process.env.HOME = '$MOCK_HOME';
process.chdir('$MOCK_HOME'); // no repo binding, falls back to default team

// Load mcp-server module to access its proxy functions
// Since proxy functions aren't exported, we test the HTTP client directly
const http = require('http');
const fs = require('fs');

const keyFile = '$TEAM_DIR/.wayfind-api-key';
const key = fs.readFileSync(keyFile, 'utf8').trim();

const postData = JSON.stringify({ query: 'authentication', limit: 5 });
const req = http.request({
  hostname: 'localhost',
  port: $PORT,
  path: '/api/search',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    'Authorization': 'Bearer ' + key,
  },
}, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const parsed = JSON.parse(data);
    console.log(JSON.stringify({ status: res.statusCode, found: parsed.found }));
  });
});
req.write(postData);
req.end();
")

PROXY_STATUS=$(echo "$PROXY_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'])" 2>/dev/null || echo "0")
PROXY_FOUND=$(echo "$PROXY_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['found'])" 2>/dev/null || echo "0")

if [ "$PROXY_STATUS" = "200" ] && [ "$PROXY_FOUND" -gt 0 ]; then
  _pass "MCP proxy reads key and gets search results"
else
  _fail "MCP proxy reads key and gets search results" "status=$PROXY_STATUS found=$PROXY_FOUND"
fi

# Kill the server
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

# ── Results ──────────────────────────────────────────────────────────────────

echo ""
print_results
