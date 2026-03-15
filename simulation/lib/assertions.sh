#!/usr/bin/env bash
# Wayfind simulation — assertion helpers
# Source this file in scenario scripts.
#
# Each assertion increments PASS or FAIL and appends to ERRORS[].
# Call print_results at the end of a scenario to print the summary.

PASS=0
FAIL=0
ERRORS=()

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
RESET='\033[0m'

_pass() {
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}PASS${RESET} $1"
}

_fail() {
    FAIL=$((FAIL + 1))
    ERRORS+=("FAIL: $1 — $2")
    echo -e "  ${RED}FAIL${RESET} $1"
    echo -e "       ${YELLOW}$2${RESET}"
}

# assert_file_exists <path> <description>
assert_file_exists() {
    local path="$1" desc="$2"
    if [ -f "$path" ]; then
        _pass "$desc"
    else
        _fail "$desc" "file not found: $path"
    fi
}

# assert_dir_exists <path> <description>
assert_dir_exists() {
    local path="$1" desc="$2"
    if [ -d "$path" ]; then
        _pass "$desc"
    else
        _fail "$desc" "directory not found: $path"
    fi
}

# assert_file_contains <path> <needle> <description>
assert_file_contains() {
    local path="$1" needle="$2" desc="$3"
    if [ ! -f "$path" ]; then
        _fail "$desc" "file not found: $path"
        return
    fi
    if grep -qF "$needle" "$path" 2>/dev/null; then
        _pass "$desc"
    else
        _fail "$desc" "'$needle' not found in $path"
    fi
}

# assert_file_not_contains <path> <needle> <description>
assert_file_not_contains() {
    local path="$1" needle="$2" desc="$3"
    if [ ! -f "$path" ]; then
        _pass "$desc (file does not exist)"
        return
    fi
    if grep -qF "$needle" "$path" 2>/dev/null; then
        _fail "$desc" "'$needle' unexpectedly found in $path"
    else
        _pass "$desc"
    fi
}

# assert_json_field <file> <field> <expected> <description>
# Uses python3 to extract a top-level field from a JSON file or array element.
# For arrays, <field> can be "length" to check array length, or "[0].field" for nested access.
assert_json_field() {
    local file="$1" field="$2" expected="$3" desc="$4"
    if [ ! -f "$file" ]; then
        _fail "$desc" "file not found: $file"
        return
    fi
    local actual
    actual=$(python3 -c "
import json, sys, re
with open(sys.argv[1]) as f:
    data = json.load(f)
field = sys.argv[2]
if field == 'length':
    print(len(data))
elif re.search(r'[\[.]', field):
    # Path traversal: .personas[0].id, [0].name, etc. — safe, no eval
    parts = re.findall(r'\[(\d+)\]|\.?(\w+)', field)
    obj = data
    for idx, attr in parts:
        if idx:
            obj = obj[int(idx)]
        elif attr:
            obj = obj[attr]
    print(obj)
else:
    print(data[field])
" "$file" "$field" 2>&1) || {
        _fail "$desc" "python3 JSON parse error: $actual"
        return
    }
    if [ "$actual" = "$expected" ]; then
        _pass "$desc"
    else
        _fail "$desc" "expected '$expected', got '$actual'"
    fi
}

# assert_json_valid <file> <description>
# Verifies a file contains valid JSON.
assert_json_valid() {
    local file="$1" desc="$2"
    if [ ! -f "$file" ]; then
        _fail "$desc" "file not found: $file"
        return
    fi
    if python3 -c "import json, sys; json.load(open(sys.argv[1]))" "$file" 2>/dev/null; then
        _pass "$desc"
    else
        _fail "$desc" "invalid JSON in $file"
    fi
}

# assert_json_array_not_empty <file> <description>
# Verifies a JSON file contains a non-empty array.
assert_json_array_not_empty() {
    local file="$1" desc="$2"
    if [ ! -f "$file" ]; then
        _fail "$desc" "file not found: $file"
        return
    fi
    local length
    length=$(python3 -c "import json, sys; print(len(json.load(open(sys.argv[1]))))" "$file" 2>&1) || {
        _fail "$desc" "JSON parse error: $length"
        return
    }
    if [ "$length" -gt 0 ] 2>/dev/null; then
        _pass "$desc ($length items)"
    else
        _fail "$desc" "array is empty"
    fi
}

# assert_json_fields_present <file> <comma-separated-fields> <description>
# Checks that every element in a JSON array has the given top-level keys.
assert_json_fields_present() {
    local file="$1" fields="$2" desc="$3"
    if [ ! -f "$file" ]; then
        _fail "$desc" "file not found: $file"
        return
    fi
    local result
    result=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
required = [f.strip() for f in sys.argv[2].split(',')]
if not isinstance(data, list):
    print('NOT_ARRAY')
    sys.exit(0)
for i, item in enumerate(data):
    for field in required:
        if field not in item:
            print(f'item[{i}] missing field: {field}')
            sys.exit(0)
print('OK')
" "$file" "$fields" 2>&1) || {
        _fail "$desc" "python3 error: $result"
        return
    }
    if [ "$result" = "OK" ]; then
        _pass "$desc"
    else
        _fail "$desc" "$result"
    fi
}

# assert_exit_code <expected> <command...>
assert_exit_code() {
    local expected="$1" desc="$2"
    shift 2
    local actual=0
    "$@" >/dev/null 2>&1 || actual=$?
    if [ "$actual" -eq "$expected" ]; then
        _pass "$desc (exit $actual)"
    else
        _fail "$desc" "expected exit $expected, got $actual"
    fi
}

# assert_output_contains <needle> <description> <command...>
assert_output_contains() {
    local needle="$1" desc="$2"
    shift 2
    local output
    output=$("$@" 2>&1) || true
    if echo "$output" | grep -qF "$needle"; then
        _pass "$desc"
    else
        _fail "$desc" "'$needle' not found in output"
    fi
}

# assert_output_not_contains <needle> <description> <command...>
assert_output_not_contains() {
    local needle="$1" desc="$2"
    shift 2
    local output
    output=$("$@" 2>&1) || true
    if echo "$output" | grep -qF "$needle"; then
        _fail "$desc" "'$needle' unexpectedly found in output"
    else
        _pass "$desc"
    fi
}

# print_results — call at end of scenario
print_results() {
    echo ""
    echo "  Results: $PASS passed, $FAIL failed"
    if [ "${#ERRORS[@]}" -gt 0 ]; then
        for err in "${ERRORS[@]}"; do
            echo -e "    ${RED}$err${RESET}"
        done
    fi
}

# reset_counters — reset between scenarios when running in-process
reset_counters() {
    PASS=0
    FAIL=0
    ERRORS=()
}
