# Hook Configuration Analysis & Recommendations

## Current State

### Hooks Are Non-Blocking ⚠️

Both hooks currently **warn** but **don't block** when errors are found:

**biome-check.sh** (line 57-60):
```bash
pnpm biome check --write "$file_path" 2>&1 || {
  echo "⚠️  Biome check failed for $file_path" >&2
  exit 0  # ← Doesn't block!
}
```

**type-check.sh** (line 77-81):
```bash
pnpm turbo run type-check --filter="./$package_path" ... || {
  echo "⚠️  Type check found issues in $package_path" >&2
  exit 0  # ← Doesn't block!
}
```

**Result**: Claude can continue even if lint/type errors exist.

---

## Problem

When hooks are non-blocking:
- ✅ Biome auto-fixes formatting and safe linting issues
- ⚠️ Unfixable linting errors are **warned** but not blocked
- ⚠️ Type errors are **warned** but not blocked
- ❌ Errors can slip through to commits

---

## Solution Options

### Option 1: Make Hooks Blocking (Recommended)

**Change hooks to fail (exit 1) when errors found:**

```bash
# biome-check.sh - BLOCKING version
pnpm biome check --write "$file_path" 2>&1 || {
  echo "❌ Biome check failed for $file_path" >&2
  echo "Fix the errors before continuing" >&2
  exit 1  # ← BLOCKS Claude!
}
```

```bash
# type-check.sh - BLOCKING version
pnpm turbo run type-check --filter="./$package_path" ... || {
  echo "❌ Type check found issues in $package_path" >&2
  echo "Fix the errors before continuing" >&2
  exit 1  # ← BLOCKS Claude!
}
```

**Pros**:
- ✅ Prevents bad code from being committed
- ✅ Forces immediate error fixes
- ✅ Maintains code quality

**Cons**:
- ❌ Can interrupt workflow if errors are complex
- ❌ May be frustrating during rapid iteration

### Option 2: Enhanced Error Visibility (Current + Improvements)

Keep non-blocking but make errors VERY visible:

```bash
pnpm biome check --write "$file_path" 2>&1 || {
  echo "" >&2
  echo "╔════════════════════════════════════════════════════════════╗" >&2
  echo "║  ❌ BIOME CHECK FAILED - ERRORS MUST BE FIXED!           ║" >&2
  echo "╚════════════════════════════════════════════════════════════╝" >&2
  echo "" >&2
  echo "File: $file_path" >&2
  echo "Run manually to see full errors:" >&2
  echo "  pnpm biome check $file_path" >&2
  echo "" >&2
  exit 0  # Still non-blocking
}
```

**Pros**:
- ✅ Warnings are hard to miss
- ✅ Provides clear instructions
- ✅ Doesn't interrupt workflow

**Cons**:
- ⚠️ Still allows errors to slip through

### Option 3: Hybrid Approach (Best of Both)

**Block on critical errors, warn on minor issues:**

```bash
# Check Biome with --write
output=$(pnpm biome check --write "$file_path" 2>&1)
exit_code=$?

if [ $exit_code -eq 0 ]; then
  echo "✓ Biome check passed for $(basename "$file_path")"
  exit 0
fi

# Biome failed - check if it's formatting-only or actual errors
if echo "$output" | grep -q "error"; then
  # Has actual errors - BLOCK
  echo "❌ CRITICAL: Biome found errors in $file_path" >&2
  echo "$output" >&2
  echo "" >&2
  echo "Fix these errors before continuing:" >&2
  echo "  pnpm biome check --write $file_path" >&2
  exit 1  # BLOCK
else
  # Only warnings - don't block
  echo "⚠️  Biome warnings in $file_path" >&2
  echo "$output" >&2
  exit 0  # Don't block
fi
```

---

## Recommended Configuration

### For Maximum Code Quality (Recommended)

**Use Option 1: Blocking Hooks**

This ensures:
- ✅ All Biome errors fixed before commit
- ✅ All type errors fixed before commit
- ✅ No errors slip through
- ✅ Consistent code quality

Trade-off: May slow down workflow slightly, but prevents technical debt.

### For Flexible Workflow

**Use Option 3: Hybrid Approach**

This ensures:
- ✅ Critical errors blocked
- ⚠️ Warnings visible but don't block
- ✅ Balance between quality and speed

---

## Additional Improvements

### 1. Show Actual Errors

Current hooks don't show the actual errors. Improve:

```bash
# Capture and display full output
output=$(pnpm biome check --write "$file_path" 2>&1)
exit_code=$?

if [ $exit_code -ne 0 ]; then
  echo "❌ Biome check failed for $file_path" >&2
  echo "" >&2
  echo "Errors:" >&2
  echo "$output" | grep -A 5 "error" >&2  # Show error details
  echo "" >&2
  exit 1
fi
```

### 2. Add Error Count

```bash
# Count errors
error_count=$(echo "$output" | grep -c "error" || true)

if [ "$error_count" -gt 0 ]; then
  echo "❌ Found $error_count error(s) in $file_path" >&2
  exit 1
fi
```

### 3. Separate Auto-fixable vs Manual Fixes

```bash
# Try auto-fix first
pnpm biome check --write "$file_path" >/dev/null 2>&1

# Check if errors remain
if ! pnpm biome check "$file_path" >/dev/null 2>&1; then
  echo "❌ Biome found errors that couldn't be auto-fixed" >&2
  echo "Run: pnpm biome check $file_path" >&2
  exit 1
fi
```

### 4. Add Pre-Commit Hook

In addition to PostToolUse hooks, add a Stop hook:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/final-check.sh",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

This runs a comprehensive check before Claude stops (before commit).

---

## Implementation Plan

### Step 1: Update Biome Hook to be Blocking

```bash
#!/usr/bin/env bash
# Updated biome-check.sh - BLOCKING VERSION

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# ... (JSON parsing code stays the same) ...

case "$file_path" in
  *.js|*.jsx|*.ts|*.tsx|*.json|*.jsonc|*.css|*.mjs|*.cjs|*.mts|*.cts)
    cd "$PROJECT_DIR"
    
    # Capture output for better error reporting
    echo "🔍 Running Biome check on $(basename "$file_path")..."
    output=$(pnpm biome check --write "$file_path" 2>&1)
    exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
      echo "✓ Biome check passed for $(basename "$file_path")"
      exit 0
    else
      # BLOCKING: Fail when Biome finds errors
      echo "" >&2
      echo "❌ Biome check FAILED for $file_path" >&2
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
      echo "$output" >&2
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
      echo "" >&2
      echo "Fix the errors above before continuing." >&2
      echo "Run: pnpm biome check --write $file_path" >&2
      echo "" >&2
      exit 1  # BLOCK!
    fi
    ;;
  *)
    exit 0
    ;;
esac
```

### Step 2: Update Type-Check Hook to be Blocking

```bash
#!/usr/bin/env bash
# Updated type-check.sh - BLOCKING VERSION

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# ... (JSON parsing code stays the same) ...

case "$file_path" in
  *.ts|*.tsx|*.mts|*.cts)
    # ... (package detection code stays the same) ...
    
    if [ -n "$package_path" ] && [ -d "$package_path" ]; then
      echo "🔍 Type checking $package_path..."
      
      # Capture output
      output=$(pnpm turbo run type-check --filter="./$package_path" --log-order=grouped 2>&1)
      exit_code=$?
      
      if [ $exit_code -eq 0 ]; then
        echo "✓ Type check passed for $(basename "$package_path")"
        exit 0
      else
        # BLOCKING: Fail when type errors found
        echo "" >&2
        echo "❌ Type check FAILED for $package_path" >&2
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
        echo "$output" | grep -v "cache hit" >&2
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
        echo "" >&2
        echo "Fix the type errors above before continuing." >&2
        echo "Run: pnpm turbo run type-check --filter=./$package_path" >&2
        echo "" >&2
        exit 1  # BLOCK!
      fi
    fi
    ;;
esac
```

### Step 3: Add Final Check Hook (Pre-Commit Safety)

Create `.claude/hooks/final-check.sh`:

```bash
#!/usr/bin/env bash
# Final comprehensive check before commit

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$PROJECT_DIR"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 Running final checks before commit..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check 1: Biome (all changed files)
echo ""
echo "1️⃣  Checking Biome (formatting & linting)..."
if ! pnpm biome check . --changed 2>&1; then
  echo "❌ Biome check failed" >&2
  echo "Run: pnpm biome check . --write" >&2
  exit 1
fi
echo "✓ Biome check passed"

# Check 2: Type checking (full monorepo)
echo ""
echo "2️⃣  Checking TypeScript types..."
if ! pnpm type-check 2>&1; then
  echo "❌ Type check failed" >&2
  echo "Run: pnpm type-check" >&2
  exit 1
fi
echo "✓ Type check passed"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All checks passed! Safe to commit."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```

---

## Summary

**Current Issue**: Hooks warn but don't block → errors can slip through

**Recommended Fix**: Make hooks blocking (Option 1)

**Additional Safety**: Add final pre-commit check (Stop hook)

**Result**: 
- ✅ Immediate error feedback on every file
- ✅ Comprehensive check before commit
- ✅ No errors slip through
- ✅ Maintains high code quality

Would you like me to implement the blocking hooks now?

