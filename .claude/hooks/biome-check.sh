#!/usr/bin/env bash
# Biome formatting and linting hook for Claude Code
# Runs after Write and Edit operations to ensure code quality
#
# Security: Uses jq for JSON parsing to prevent injection attacks.
# Grep/sed-based parsing is vulnerable to malformed JSON with shell metacharacters.

set -euo pipefail

# Set project directory (CLAUDE_PROJECT_DIR is set by Claude Code, fallback to PWD for testing)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# Check for jq dependency (required for secure JSON parsing)
if ! command -v jq >/dev/null 2>&1; then
  echo "Warning: jq not installed - cannot parse JSON securely" >&2
  echo "Install jq: brew install jq (macOS) or apt-get install jq (Ubuntu)" >&2
  exit 0
fi

# Read JSON input from stdin
input=$(cat)

# Validate JSON input before parsing
# This prevents injection attacks from malformed JSON
if ! echo "$input" | jq empty 2>/dev/null; then
  echo "Warning: Invalid JSON input received in biome-check hook" >&2
  exit 0
fi

# Extract the file path from the tool input using jq (secure JSON parser)
# For Write tool: tool_input.file_path
# For Edit tool: tool_input.file_path
# Using jq with -r (raw output) and // empty (default to empty if field missing)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

# If no file path found, exit gracefully
if [ -z "$file_path" ]; then
  exit 0
fi

# Get the absolute path
if [[ "$file_path" != /* ]]; then
  file_path="$PROJECT_DIR/$file_path"
fi

# Check if the file exists and is a file Biome can handle
if [ ! -f "$file_path" ]; then
  exit 0
fi

# Check if the file extension is one that Biome can process
# Biome supports: .js, .jsx, .ts, .tsx, .json, .jsonc, .css
case "$file_path" in
  *.js|*.jsx|*.ts|*.tsx|*.json|*.jsonc|*.css|*.mjs|*.cjs|*.mts|*.cts)
    # Run Biome check with --write to format and fix issues
    cd "$PROJECT_DIR"
    pnpm biome check --write "$file_path" 2>&1 || {
      # If Biome fails, print a warning but don't fail the hook
      echo "⚠️  Biome check failed for $file_path" >&2
      exit 0
    }
    echo "✓ Biome check passed for $(basename "$file_path")"
    ;;
  *)
    # Unsupported file type, exit gracefully
    exit 0
    ;;
esac

exit 0

