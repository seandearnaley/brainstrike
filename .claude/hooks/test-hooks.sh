#!/usr/bin/env bash
# Test script for Claude Code hooks
# Tests security improvements and error handling

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Set up environment
export CLAUDE_PROJECT_DIR="$PROJECT_DIR"

# Function to run a test
run_test() {
  local test_name="$1"
  local hook_script="$2"
  local input_json="$3"
  local expected_exit_code="${4:-0}"
  local should_warn="${5:-false}"

  TESTS_RUN=$((TESTS_RUN + 1))
  echo -e "\n${YELLOW}Test $TESTS_RUN: $test_name${NC}"

  # Run the hook with the test input
  local output
  local exit_code
  output=$(echo "$input_json" | "$hook_script" 2>&1) || exit_code=$?
  exit_code=${exit_code:-0}

  # Check exit code
  if [ "$exit_code" -ne "$expected_exit_code" ]; then
    echo -e "${RED}✗ FAILED${NC}: Expected exit code $expected_exit_code, got $exit_code"
    echo "Output: $output"
    TESTS_FAILED=$((TESTS_FAILED + 1))
    return 1
  fi

  # Check for warning if expected
  if [ "$should_warn" = "true" ]; then
    if echo "$output" | grep -q "Warning:"; then
      echo -e "${GREEN}✓ PASSED${NC}: Hook warned as expected"
    else
      echo -e "${RED}✗ FAILED${NC}: Expected warning message"
      echo "Output: $output"
      TESTS_FAILED=$((TESTS_FAILED + 1))
      return 1
    fi
  else
    echo -e "${GREEN}✓ PASSED${NC}"
  fi

  TESTS_PASSED=$((TESTS_PASSED + 1))
  return 0
}

echo "========================================"
echo "Testing Claude Code Hooks Security"
echo "========================================"

# Test 1: Valid JSON with valid file path
run_test \
  "Valid JSON with TypeScript file" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"file_path": "packages/ui/src/button.tsx"}}' \
  0 \
  false

# Test 2: Valid JSON with non-TypeScript file (should exit gracefully)
run_test \
  "Valid JSON with non-TypeScript file" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"file_path": "README.md"}}' \
  0 \
  false

# Test 3: Malformed JSON (should warn and exit gracefully)
run_test \
  "Malformed JSON - missing closing brace" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"file_path": "test.ts"}' \
  0 \
  true

# Test 4: Malformed JSON with quotes
run_test \
  "Malformed JSON - unescaped quotes" \
  "$SCRIPT_DIR/type-check.sh" \
  '{invalid json with "quotes"}' \
  0 \
  true

# Test 5: Empty JSON
run_test \
  "Empty JSON object" \
  "$SCRIPT_DIR/type-check.sh" \
  '{}' \
  0 \
  false

# Test 6: Missing file_path field
run_test \
  "Missing file_path field" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"other_field": "value"}}' \
  0 \
  false

# Test 7: Injection attempt - shell metacharacters
run_test \
  "Injection attempt - shell command in file path" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"file_path": "test.ts\"; rm -rf /tmp/test; echo \""}}' \
  0 \
  false

# Test 8: Injection attempt - command substitution
run_test \
  "Injection attempt - command substitution" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"file_path": "$(whoami).ts"}}' \
  0 \
  false

# Test 9: Injection attempt - backticks
run_test \
  "Injection attempt - backticks" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"file_path": "`echo dangerous`.ts"}}' \
  0 \
  false

# Test 10: Special characters in path (legitimate)
run_test \
  "Legitimate special characters in path" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"file_path": "path/with spaces/file-name.ts"}}' \
  0 \
  false

# Test 11: Null file_path
run_test \
  "Null file_path value" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"file_path": null}}' \
  0 \
  false

# Test 12: Empty string file_path
run_test \
  "Empty string file_path" \
  "$SCRIPT_DIR/type-check.sh" \
  '{"tool_input": {"file_path": ""}}' \
  0 \
  false

echo ""
echo "========================================"
echo "Testing Biome Hook"
echo "========================================"

# Test 13: Valid JSON with JavaScript file
run_test \
  "Valid JSON with JavaScript file" \
  "$SCRIPT_DIR/biome-check.sh" \
  '{"tool_input": {"file_path": "src/index.js"}}' \
  0 \
  false

# Test 14: Malformed JSON (Biome hook)
run_test \
  "Malformed JSON - Biome hook" \
  "$SCRIPT_DIR/biome-check.sh" \
  '{"malformed": }' \
  0 \
  true

# Test 15: Injection attempt (Biome hook)
run_test \
  "Injection attempt - Biome hook" \
  "$SCRIPT_DIR/biome-check.sh" \
  '{"tool_input": {"file_path": "test.js; rm -rf /tmp/test"}}' \
  0 \
  false

echo ""
echo "========================================"
echo "Test Results"
echo "========================================"
echo -e "Total tests run:    $TESTS_RUN"
echo -e "${GREEN}Tests passed:       $TESTS_PASSED${NC}"

if [ $TESTS_FAILED -gt 0 ]; then
  echo -e "${RED}Tests failed:       $TESTS_FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
