#!/usr/bin/env bash
# Tests for journal-summary.sh (issue #14)
# Covers: parsing, date filtering, drift detection, recurring lessons,
#         team mode, markdown format, edge cases, and error handling.
set -euo pipefail

PASS=0; FAIL=0; ERRORS=()

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        PASS=$((PASS + 1)); echo "  ✓ $desc"
    else
        FAIL=$((FAIL + 1))
        ERRORS+=("FAIL: $desc — expected '$expected', got '$actual'")
        echo "  ✗ $desc"
    fi
}

assert_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -qF -- "$needle"; then
        PASS=$((PASS + 1)); echo "  ✓ $desc"
    else
        FAIL=$((FAIL + 1))
        ERRORS+=("FAIL: $desc — '$needle' not found in output")
        echo "  ✗ $desc"
    fi
}

assert_not_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if ! echo "$haystack" | grep -qF -- "$needle"; then
        PASS=$((PASS + 1)); echo "  ✓ $desc"
    else
        FAIL=$((FAIL + 1))
        ERRORS+=("FAIL: $desc — '$needle' should NOT be present")
        echo "  ✗ $desc"
    fi
}

assert_exit_code() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        PASS=$((PASS + 1)); echo "  ✓ $desc"
    else
        FAIL=$((FAIL + 1))
        ERRORS+=("FAIL: $desc — expected exit $expected, got $actual")
        echo "  ✗ $desc"
    fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$SCRIPT_DIR/journal-summary.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Fixtures ─────────────────────────────────────────────────────────────────

JOURNAL_DIR="$TMP/journal"
mkdir -p "$JOURNAL_DIR"

# 2026-01-05 — on-track session
cat > "$JOURNAL_DIR/2026-01-05.md" <<'ENTRY'
# Journal — 2026-01-05

## MyRepo — Feature work
**Why:** Add the widget component to the dashboard
**What:**
- Built Widget.tsx with tests
- Updated storybook
**Outcome:** Widget shipped and tested. PR merged.
**On track?:** Yes — focused session, no drift.
**Lessons:**
- Always add storybook stories alongside components
- TypeScript generics make reusable components cleaner
ENTRY

# 2026-01-06 — drifted session
cat > "$JOURNAL_DIR/2026-01-06.md" <<'ENTRY'
# Journal — 2026-01-06

## MyRepo — Bug investigation
**Why:** Fix the login timeout bug
**What:**
- Investigated timeout issue
- Got sidetracked refactoring auth module
- Started new feature halfway through
**Outcome:** Bug partially fixed. Auth refactor incomplete. No clean commit.
**On track?:** Drifted significantly — started refactoring auth when that wasn't the goal.
**Lessons:**
- Always add storybook stories alongside components
- Keep scope tight: one bug per session
- Log out of scope ideas immediately to avoid rabbit holes
ENTRY

# 2026-01-07 — another drift (different phrase)
cat > "$JOURNAL_DIR/2026-01-07.md" <<'ENTRY'
# Journal — 2026-01-07

## OtherRepo — Performance work
**Why:** Optimize the query planner
**What:**
- Added indexes
- Scope creep into cache layer
**Outcome:** Indexes added, cache not done.
**On track?:** No — went off track to investigate caching, which wasn't in scope.
**Lessons:**
- Investigate before implementing: understand the bottleneck first
- Keep scope tight: one bug per session
ENTRY

# 2026-01-08 — clean session, recurring lessons appear
cat > "$JOURNAL_DIR/2026-01-08.md" <<'ENTRY'
# Journal — 2026-01-08

## OtherRepo — Caching implementation
**Why:** Implement the cache layer identified yesterday
**What:**
- Implemented Redis cache with TTL
- Added integration tests
**Outcome:** Cache live, 3x speedup measured.
**On track?:** Yes — exactly the goal. No drift.
**Lessons:**
- Investigate before implementing: understand the bottleneck first
- Redis TTL should match your read frequency, not your write frequency
ENTRY

# 2026-01-10 — outside our date range (for filtering tests)
cat > "$JOURNAL_DIR/2026-01-10.md" <<'ENTRY'
# Journal — 2026-01-10

## MyRepo — Cleanup
**Why:** Remove dead code
**What:** Deleted unused files
**Outcome:** Done.
**On track?:** Yes.
**Lessons:**
- Delete dead code aggressively
ENTRY

# Team fixture: two users
TEAM_DIR="$TMP/team"
mkdir -p "$TEAM_DIR/alice/journal" "$TEAM_DIR/bob/journal"

cat > "$TEAM_DIR/alice/journal/2026-01-06.md" <<'ENTRY'
# Journal — 2026-01-06

## AuthService — OAuth integration
**Why:** Add Google OAuth
**What:** Implemented OAuth flow
**Outcome:** OAuth working.
**On track?:** Yes — focused, no drift.
**Lessons:**
- OAuth scopes must be explicit — never use wildcard scopes in production
ENTRY

cat > "$TEAM_DIR/bob/journal/2026-01-06.md" <<'ENTRY'
# Journal — 2026-01-06

## AuthService — Session management
**Why:** Fix session expiry bug
**What:** Investigated and fixed session store
**Outcome:** Bug fixed.
**On track?:** Drifted — spent 30 min investigating wrong component first.
**Lessons:**
- OAuth scopes must be explicit — never use wildcard scopes in production
ENTRY

# ── Tests ─────────────────────────────────────────────────────────────────────

echo ""
echo "journal-summary.sh — basic output"

OUT=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-05 --to 2026-01-08)

assert_contains "shows repo name"         "MyRepo"           "$OUT"
assert_contains "shows session date"      "2026-01-05"       "$OUT"
assert_contains "shows session title"     "Feature work"     "$OUT"
assert_contains "shows goal text"         "widget component" "$OUT"
assert_contains "shows outcome text"      "Widget shipped"   "$OUT"
assert_contains "shows sessions by repo header" "Sessions by Repo" "$OUT"

echo ""
echo "journal-summary.sh — date filtering"

# Only dates 01-05 to 01-06
OUT2=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-05 --to 2026-01-06)
assert_contains     "includes in-range date"    "2026-01-05" "$OUT2"
assert_contains     "includes boundary date"    "2026-01-06" "$OUT2"
assert_not_contains "excludes after-range date" "2026-01-07" "$OUT2"
assert_not_contains "excludes out-of-range 08"  "2026-01-08" "$OUT2"

# --all includes everything
OUT_ALL=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --all)
assert_contains "all mode includes 01-10" "2026-01-10" "$OUT_ALL"

echo ""
echo "journal-summary.sh — drift detection"

OUT_DRIFT=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-05 --to 2026-01-08)

# Drift detected
assert_contains "drift section header present"    "Drift Log"             "$OUT_DRIFT"
assert_contains "drifted session appears in log"  "Bug investigation"     "$OUT_DRIFT"
assert_contains "off-track session in drift log"  "Performance work"      "$OUT_DRIFT"
assert_contains "drift details shown"             "Drifted significantly" "$OUT_DRIFT"
assert_contains "off-track details shown"         "off track"             "$OUT_DRIFT"

# Non-drift session NOT in drift log
# The drift log section only shows drifted sessions; 2026-01-05 should not appear there
DRIFT_SECTION=$(echo "$OUT_DRIFT" | awk '/Drift Log/,/Recurring/')
assert_not_contains "clean session not in drift log" "Feature work" "$DRIFT_SECTION"

# False-positive prevention: "No drift" should NOT be flagged
assert_not_contains "no-drift phrase not flagged" "⚠" \
    "$(echo "$OUT_DRIFT" | grep "2026-01-05")"
assert_not_contains "yes-no-drift not flagged" "⚠" \
    "$(echo "$OUT_DRIFT" | grep "2026-01-08")"

echo ""
echo "journal-summary.sh — drift stats"

# Session counts
STATS=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-05 --to 2026-01-08 | grep -E "^\(|^\(")
# Should show 2 drifts out of 4 sessions
assert_contains "total session count in stats" "4 sessions" \
    "$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-05 --to 2026-01-08 | head -10)"
assert_contains "drift count in stats" "2 drifts" \
    "$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-05 --to 2026-01-08 | head -10)"

echo ""
echo "journal-summary.sh — recurring lessons"

OUT_LESSONS=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-05 --to 2026-01-08)

# "Always add storybook stories" appears in 01-05 and 01-06
assert_contains "recurring lesson detected"         "Recurring Lessons"                     "$OUT_LESSONS"
assert_contains "storybook lesson listed as recur"  "storybook stories"                    "$OUT_LESSONS"
# "Keep scope tight" appears in 01-06 and 01-07
assert_contains "scope-tight lesson listed"         "Keep scope tight"                     "$OUT_LESSONS"
# "Investigate before implementing" appears in 01-07 and 01-08
assert_contains "investigate lesson listed"         "Investigate before implementing"       "$OUT_LESSONS"

# Single-occurrence lessons should NOT appear in recurring section
RECUR_SECTION=$(echo "$OUT_LESSONS" | awk '/Recurring Lessons/,/All Lessons/')
assert_not_contains "unique lesson not in recurring" "Redis TTL" "$RECUR_SECTION"

# All lessons section
assert_contains "all lessons section present"    "All Lessons"                  "$OUT_LESSONS"
assert_contains "all lessons has content"        "TypeScript generics"          "$OUT_LESSONS"
assert_contains "recurring marker in all lessons" "♻" \
    "$(echo "$OUT_LESSONS" | grep -i "storybook" || true)"

echo ""
echo "journal-summary.sh — markdown format"

MD=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-05 --to 2026-01-06 --format markdown)

assert_contains "markdown h1 header"    "# AI Session Journal Summary" "$MD"
assert_contains "markdown h2 section"  "## Sessions by Repo"          "$MD"
assert_contains "markdown h2 drift"    "## Drift Log"                 "$MD"
assert_contains "markdown h2 lessons"  "## Recurring Lessons"         "$MD"
assert_contains "markdown bullet"      "- 2026-01-05"                 "$MD"
assert_contains "markdown footer"      "journal-summary.sh"           "$MD"
assert_contains "markdown divider"     "---"                          "$MD"

echo ""
echo "journal-summary.sh — team mode"

TEAM_OUT=$(bash "$SCRIPT" --team "$TEAM_DIR" --from 2026-01-06 --to 2026-01-06)

assert_contains "team shows contributors section" "Contributors"   "$TEAM_OUT"
assert_contains "team shows alice"                "alice"          "$TEAM_OUT"
assert_contains "team shows bob"                  "bob"            "$TEAM_OUT"
assert_contains "team shows alice's repo"         "AuthService"    "$TEAM_OUT"
assert_contains "team shows user label in bullet" "[alice]"        "$TEAM_OUT"
assert_contains "team shows user label in bullet" "[bob]"          "$TEAM_OUT"

# Bob drifted, Alice didn't
TEAM_DRIFT=$(echo "$TEAM_OUT" | awk '/Drift Log/,/Recurring/')
assert_contains     "team drift shows bob's session"   "bob"         "$TEAM_DRIFT"
assert_not_contains "team drift doesn't show alice"    "[alice]"     "$TEAM_DRIFT"

# Shared lesson from both alice and bob appears as recurring
assert_contains "team recurring lesson detected" "OAuth scopes" "$TEAM_OUT"

echo ""
echo "journal-summary.sh — error handling"

# Missing journal dir: collect_files will find nothing, emits "No journal files found"
OUT_ERR=$(bash "$SCRIPT" --dir /nonexistent/path 2>&1) || true
assert_contains "error on missing dir" "No journal files found" "$OUT_ERR"

# No files in date range
OUT_EMPTY=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2020-01-01 --to 2020-01-07)
assert_contains "reports no files found" "No journal files found" "$OUT_EMPTY"

# Invalid format
ERR_FMT=0
bash "$SCRIPT" --dir "$JOURNAL_DIR" --all --format json 2>&1 | grep -q "must be" || ERR_FMT=$?
OUT_FMTERR=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --all --format json 2>&1 || true)
assert_contains "rejects invalid format" "must be" "$OUT_FMTERR"

# --help exits 0
HELP_EXIT=0
bash "$SCRIPT" --help > /dev/null 2>&1 || HELP_EXIT=$?
assert_exit_code "--help exits 0" "0" "$HELP_EXIT"
assert_contains "--help shows usage" "Usage:" "$(bash "$SCRIPT" --help 2>&1)"

# Unknown option
UNK_EXIT=0
bash "$SCRIPT" --unknown-opt 2>/dev/null || UNK_EXIT=$?
assert_exit_code "unknown option exits 1" "1" "$UNK_EXIT"

echo ""
echo "journal-summary.sh — edge cases"

# Journal file with no entries (just a header line)
cat > "$TMP/journal/2026-01-09.md" <<'EDGE'
# Journal — 2026-01-09

No entries today.
EDGE

# File with no ## entries is parsed as 0 sessions; script reports "No journal files found"
# because FILE_RECORDS contains the file but Python emits 0 entries — the bash "0 files" path.
# Actually: collect_files includes the .md file, so FILE_RECORDS has 1 record.
# Python parses 0 entries. Summary shows "0 sessions" stat.
OUT_EDGE=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-09 --to 2026-01-09)
assert_contains "handles no-entry file gracefully: shows 0 sessions" "0 sessions" "$OUT_EDGE"

# Entry without "On track?" field — should not be flagged as drift
cat > "$TMP/journal/2026-01-11.md" <<'EDGE2'
# Journal — 2026-01-11

## ProjectX — Quick fix
**Why:** Fix typo in config
**What:** Fixed it
**Outcome:** Done.
**Lessons:**
- Check config files at end of each session
EDGE2

OUT_EDGE2=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-11 --to 2026-01-11)
DRIFT_SEC=$(echo "$OUT_EDGE2" | awk '/Drift Log/,/Recurring/')
assert_not_contains "missing ontrack field not flagged as drift" "⚠" "$DRIFT_SEC"
assert_contains     "entry without ontrack still appears"        "ProjectX" "$OUT_EDGE2"

# Multi-entry file
cat > "$TMP/journal/2026-01-12.md" <<'MULTI'
# Journal — 2026-01-12

## RepoA — Work A
**Why:** Goal A
**What:** Did A
**Outcome:** A done.
**On track?:** Yes.
**Lessons:**
- Lesson from A

## RepoB — Work B
**Why:** Goal B
**What:** Did B
**Outcome:** B done.
**On track?:** Drifted into unrelated territory.
**Lessons:**
- Lesson from B
MULTI

OUT_MULTI=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-12 --to 2026-01-12)
assert_contains     "multi-entry: RepoA present"          "RepoA"           "$OUT_MULTI"
assert_contains     "multi-entry: RepoB present"          "RepoB"           "$OUT_MULTI"
assert_contains     "multi-entry: RepoB drift detected"   "Work B"          \
    "$(echo "$OUT_MULTI" | awk '/Drift Log/,/Recurring/')"
assert_not_contains "multi-entry: RepoA not in drift log" "Work A"          \
    "$(echo "$OUT_MULTI" | awk '/Drift Log/,/Recurring/')"
assert_eq           "multi-entry: 2 sessions counted" \
    "2" \
    "$(echo "$OUT_MULTI" | grep -oE '[0-9]+ sessions' | grep -oE '^[0-9]+')"

echo ""
echo "journal-summary.sh — discovery field"

# Entry with Discovery field
cat > "$TMP/journal/2026-01-13.md" <<'DISC'
# Journal — 2026-01-13

## ServiceA — Data model rework
**Why:** Add batch export
**What:** Built export endpoint
**Outcome:** Working but revealed a schema issue
**On track?:** Yes
**Lessons:**
- Schema migrations need a rollback plan
**Discovery:** The data model assumes 1:1 user-to-org but three customers have multi-org setups. April needs to decide if we support this in v1 or scope it out explicitly.
DISC

OUT_DISC=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-13 --to 2026-01-13)
assert_contains     "discovery: appears in session detail"    "DISCOVERY:"     "$OUT_DISC"
assert_contains     "discovery: content parsed"               "multi-org"      "$OUT_DISC"
assert_contains     "discovery: section header present"       "Discoveries"    "$OUT_DISC"
assert_contains     "discovery: 1 session counted"            "1 session"      \
    "$(echo "$OUT_DISC" | grep -E 'Discover.*session')"

# Entry without Discovery — section should say "No discoveries"
OUT_NODISC=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-11 --to 2026-01-11)
assert_contains     "no-discovery: section shows none"        "No discoveries" "$OUT_NODISC"

# Discovery shows in markdown format too
OUT_DISC_MD=$(bash "$SCRIPT" --dir "$JOURNAL_DIR" --from 2026-01-13 --to 2026-01-13 --format markdown)
assert_contains     "discovery: markdown format has section"  "## Discoveries" "$OUT_DISC_MD"
assert_contains     "discovery: markdown format has content"  "multi-org"      "$OUT_DISC_MD"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "─────────────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
echo "─────────────────────────────────────────"

if [ ${#ERRORS[@]} -gt 0 ]; then
    echo ""
    for e in "${ERRORS[@]}"; do echo "  $e"; done
    echo ""
    exit 1
fi
