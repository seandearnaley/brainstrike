#!/usr/bin/env bash
# TypeScript type checking hook for Claude Code
# Runs after Write and Edit operations to catch type errors early
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
  echo "Warning: Invalid JSON input received in type-check hook" >&2
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

# Check if the file exists
if [ ! -f "$file_path" ]; then
  exit 0
fi

# Only check TypeScript files
case "$file_path" in
  *.ts|*.tsx|*.mts|*.cts)
    # Determine which package this file belongs to
    # Extract package path (apps/* or packages/*)
    package_path=""
    
    if [[ "$file_path" == *"/apps/"* ]]; then
      # Extract: apps/web or apps/desktop
      # Uses parameter expansion instead of sed for consistency with security improvements
      temp="${file_path#*/apps/}"
      package_path="apps/${temp%%/*}"
    elif [[ "$file_path" == *"/packages/"* ]]; then
      # Extract: packages/ui, packages/db, etc.
      # Uses parameter expansion instead of sed for consistency with security improvements
      temp="${file_path#*/packages/}"
      package_path="packages/${temp%%/*}"
    fi
    
    cd "$PROJECT_DIR"
    
    if [ -n "$package_path" ] && [ -d "$package_path" ]; then
      # Run type-check for the specific package (faster than whole monorepo)
      echo "🔍 Type checking $package_path..."
      
      # Use turbo to run type-check for just this package
      pnpm turbo run type-check --filter="./$package_path" --log-order=grouped 2>&1 | grep -v "cache hit" || {
        echo "⚠️  Type check found issues in $package_path" >&2
        echo "Run: pnpm turbo run type-check --filter=./$package_path" >&2
        # Don't fail the hook - just warn
        exit 0
      }
      
      echo "✓ Type check passed for $(basename "$package_path")"
    else
      # Fallback: check the file individually using tsc
      # Find the nearest tsconfig.json
      dir=$(dirname "$file_path")
      tsconfig=""
      
      while [ "$dir" != "/" ] && [ "$dir" != "." ]; do
        if [ -f "$dir/tsconfig.json" ]; then
          tsconfig="$dir/tsconfig.json"
          break
        fi
        dir=$(dirname "$dir")
      done
      
      if [ -n "$tsconfig" ]; then
        echo "🔍 Type checking $(basename "$file_path")..."
        
        # Run tsc on the specific file with the nearest tsconfig
        pnpm tsc --noEmit --project "$tsconfig" "$file_path" 2>&1 || {
          echo "⚠️  Type check found issues in $(basename "$file_path")" >&2
          echo "Run: pnpm tsc --noEmit --project $tsconfig $file_path" >&2
          exit 0
        }
        
        echo "✓ Type check passed for $(basename "$file_path")"
      else
        # No tsconfig found, skip
        exit 0
      fi
    fi
    ;;
  *)
    # Not a TypeScript file, skip
    exit 0
    ;;
esac

exit 0

