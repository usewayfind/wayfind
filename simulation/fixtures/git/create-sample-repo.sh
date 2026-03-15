#!/usr/bin/env bash
# Creates a minimal git repo with realistic commits for simulation testing.
# Usage: bash create-sample-repo.sh <target-dir>
set -euo pipefail

TARGET="${1:?Usage: create-sample-repo.sh <target-dir>}"

rm -rf "$TARGET"
mkdir -p "$TARGET"
cd "$TARGET"

git init -q
git config user.email "dev@example.com"
git config user.name "Sim Developer"

# Commit 1: Initial project setup
cat > README.md <<'EOF'
# Sample Project

A minimal project used for Wayfind simulation testing.
EOF
cat > package.json <<'EOF'
{ "name": "sample-project", "version": "0.1.0", "private": true }
EOF
git add -A && git commit -q -m "Initial project setup"

# Commit 2: Add authentication module
mkdir -p src
cat > src/auth.js <<'EOF'
function login(username, password) {
  if (!username || !password) throw new Error('Missing credentials');
  return { token: 'mock-token', user: username };
}
module.exports = { login };
EOF
git add -A && git commit -q -m "Add authentication module"

# Commit 3: Add user profile endpoint
cat > src/profile.js <<'EOF'
function getProfile(userId) {
  return { id: userId, name: 'Test User', email: 'test@example.com' };
}
module.exports = { getProfile };
EOF
git add -A && git commit -q -m "Add user profile endpoint"

# Commit 4: Fix login error handling
cat > src/auth.js <<'EOF'
function login(username, password) {
  if (!username || !password) {
    throw new Error('Username and password are required');
  }
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new TypeError('Credentials must be strings');
  }
  return { token: 'mock-token', user: username };
}
module.exports = { login };
EOF
git add -A && git commit -q -m "Fix login error handling for non-string inputs"

# Commit 5: Add CI configuration
cat > .github-actions.yml <<'EOF'
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
EOF
git add -A && git commit -q -m "Add CI workflow configuration"

# Commit 6: Add tests
mkdir -p tests
cat > tests/auth.test.js <<'EOF'
const { login } = require('../src/auth');

console.log('Test: login with valid credentials');
const result = login('user', 'pass');
console.assert(result.token === 'mock-token');
console.assert(result.user === 'user');

console.log('Test: login with missing credentials');
try { login('', ''); console.assert(false); } catch (e) { console.assert(e.message.includes('required')); }

console.log('All auth tests passed');
EOF
git add -A && git commit -q -m "Add unit tests for authentication"

# Commit 7: Bump version and update docs
cat > package.json <<'EOF'
{ "name": "sample-project", "version": "0.2.0", "private": true }
EOF
cat >> README.md <<'EOF'

## Changelog

### 0.2.0
- Authentication module with error handling
- User profile endpoint
- CI workflow
- Unit tests
EOF
git add -A && git commit -q -m "Release v0.2.0 — auth, profiles, CI, tests"

echo "Sample repo created at $TARGET with $(git rev-list --count HEAD) commits"
