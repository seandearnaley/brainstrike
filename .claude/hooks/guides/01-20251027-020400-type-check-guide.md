# TypeScript Type Checking Hook

## Overview

This hook automatically runs TypeScript type checking on files after Claude Code writes or edits them, catching type errors early in the development process.

## Features

✅ **Smart package detection**: Automatically identifies which package/app a file belongs to  
✅ **Optimized checking**: Runs `turbo run type-check` only for the affected package (fast)  
✅ **Fallback strategy**: Falls back to individual file checking with `tsc` if package detection fails  
✅ **Non-blocking**: Reports errors but doesn't stop Claude's workflow  
✅ **Turborepo integration**: Leverages Turborepo's caching for faster subsequent checks  

## How It Works

### 1. Package-Level Type Checking (Preferred)

When you edit a file in `apps/web/src/components/user-profile.tsx`:

```bash
# Hook detects: apps/web
# Runs: pnpm turbo run type-check --filter=./apps/web
🔍 Type checking apps/web...
✓ Type check passed for web
```

**Benefits:**
- Checks all related files in the package
- Catches cross-file type errors
- Uses Turborepo caching (instant if nothing changed)
- Comprehensive validation

### 2. File-Level Type Checking (Fallback)

If package detection fails, checks the individual file:

```bash
# Finds nearest tsconfig.json
# Runs: pnpm tsc --noEmit --project tsconfig.json file.ts
🔍 Type checking user-profile.tsx...
✓ Type check passed for user-profile.tsx
```

## Supported Files

Only TypeScript files:
- `.ts` - TypeScript
- `.tsx` - TypeScript + JSX
- `.mts` - TypeScript ES Module
- `.cts` - TypeScript CommonJS

JavaScript files (`.js`, `.jsx`) are skipped.

## Configuration

### Hook Settings

Located in `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/type-check.sh",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

**Timeout**: 60 seconds (longer than Biome because type checking can be slower)

### Execution Order

Hooks run in parallel by default. Both Biome and TypeScript checks happen simultaneously:

```
Write file.tsx
    ↓
    ├─→ biome-check.sh (30s timeout) → ✓ Formatting & linting
    └─→ type-check.sh (60s timeout)  → ✓ Type checking
```

## Output Examples

### Success

```
🔍 Type checking packages/ui...
✓ Type check passed for ui
```

### Type Errors Found

```
🔍 Type checking apps/web...
⚠️  Type check found issues in apps/web
Run: pnpm turbo run type-check --filter=./apps/web
```

The hook **does not fail** - it warns and continues. Check the details:
- Press `Ctrl+R` for full output in transcript mode
- Or run the suggested command manually

## Performance

### Fast Path (Package-Level with Cache)

```bash
# First run (cold)
🔍 Type checking apps/web...
✓ Type check passed for web  (2.5s)

# Second run (cached, no changes)
🔍 Type checking apps/web...
✓ Type check passed for web  (0.1s)  # ← Turborepo cache hit!
```

### Slow Path (Cache Miss)

```bash
# Changes detected, full type check
🔍 Type checking apps/web...
✓ Type check passed for web  (5-10s)
```

## Integration with Biome Hook

Both hooks work together seamlessly:

1. **Biome** (30s timeout): Formats and lints the code
2. **TypeScript** (60s timeout): Checks types

Both run in parallel, so total time ≈ max(Biome time, TypeScript time).

## Troubleshooting

### Hook Not Running

**Issue**: Type checking doesn't execute after editing TypeScript files

**Solutions:**
1. Restart Claude Code to load new hook configuration
2. Check hook registration: `/hooks` command
3. Verify script permissions: `ls -la .claude/hooks/type-check.sh`
4. Enable debug mode: `claude --debug`

### "Type check found issues"

**Issue**: Hook reports type errors

**What to do:**
1. Press `Ctrl+R` to see full error details in transcript mode
2. Run the suggested command to see all errors:
   ```bash
   pnpm turbo run type-check --filter=./apps/web
   ```
3. Fix the type errors in your code
4. Re-run Claude Code operation to verify

### Slow Type Checking

**Issue**: Hook takes >30 seconds

**Possible causes:**
- First run (no Turborepo cache)
- Large package with many files
- Complex type inference

**Solutions:**
1. Increase timeout in `.claude/settings.local.json`:
   ```json
   {
     "type": "command",
     "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/type-check.sh",
     "timeout": 120  // 2 minutes
   }
   ```
2. Split large packages into smaller ones
3. Use `skipLibCheck: true` in `tsconfig.json` (speeds up but less safe)

### Package Not Detected

**Issue**: Hook falls back to file-level checking instead of package-level

**Debug:**
1. Check file path matches pattern: `apps/*/` or `packages/*/`
2. Verify package directory exists and has `package.json`
3. Check output in transcript mode (Ctrl+R)

**Example:**
```bash
# If you see this (file-level):
🔍 Type checking user-profile.tsx...

# Instead of this (package-level):
🔍 Type checking apps/web...

# The package detection failed
```

### "No tsconfig.json found"

**Issue**: Fallback mode can't find TypeScript configuration

**Solution:**
Ensure every package/app has a `tsconfig.json`:
```bash
# Check for tsconfig.json
ls packages/*/tsconfig.json
ls apps/*/tsconfig.json
```

## Customization

### Check Different Scope

Edit `.claude/hooks/type-check.sh` to change checking behavior:

```bash
# Current: Package-level
pnpm turbo run type-check --filter="./$package_path"

# Alternative 1: Check entire monorepo
pnpm turbo run type-check

# Alternative 2: Check only changed files (requires git)
pnpm turbo run type-check --filter="[HEAD^1]"
```

### Add More Verbose Output

```bash
# Add --verbose flag
pnpm turbo run type-check --filter="./$package_path" --verbose
```

### Skip Type Checking for Specific Packages

```bash
# Add package filter
if [[ "$package_path" == "packages/legacy" ]]; then
  echo "⏭️  Skipping type check for legacy package"
  exit 0
fi
```

## Performance Tips

### 1. Use Turborepo Caching

Turborepo caches type check results. If files haven't changed, type checking is instant:

```bash
# Cache is stored in: .turbo/
# Keep this directory in .gitignore but don't delete it locally
```

### 2. Optimize tsconfig.json

```json
{
  "compilerOptions": {
    // Speed up type checking (but check less)
    "skipLibCheck": true,
    
    // Use incremental compilation
    "incremental": true,
    
    // Store build info for faster subsequent checks
    "tsBuildInfoFile": ".tsbuildinfo"
  }
}
```

### 3. Split Large Packages

Instead of one giant package, split into:
```
packages/ui          → packages/ui-core
                        packages/ui-components
                        packages/ui-layouts
```

Each package type-checks faster independently.

## When Type Checking Fails

The hook **never blocks** Claude Code operations. It only warns:

```
⚠️  Type check found issues in apps/web
Run: pnpm turbo run type-check --filter=./apps/web
```

**Philosophy:** Let Claude continue working, then fix type errors in batch.

**Alternative:** If you want to block on type errors, change the hook to exit with error:

```bash
# Change this line in type-check.sh:
exit 0  # Current: don't fail

# To:
exit 1  # Fail the hook if type errors found
```

⚠️ **Warning:** Blocking hooks can interrupt Claude's workflow.

## Best Practices

### 1. Fix Type Errors Promptly

Don't let type errors accumulate:
```bash
# After Claude finishes, run:
pnpm type-check

# Fix all errors before committing
```

### 2. Use Strict Mode

In `tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true
  }
}
```

### 3. Monitor Hook Performance

Check transcript (Ctrl+R) for slow type checks:
```
🔍 Type checking apps/web...
✓ Type check passed for web  (15s)  ← Too slow?
```

If consistently >10s, investigate why.

### 4. Combine with CI/CD

Hook provides **fast feedback**, CI provides **comprehensive validation**:

```yaml
# .github/workflows/ci.yml
- name: Type check
  run: pnpm type-check  # Full monorepo check
```

## Integration with Other Tools

### ESLint Type-Aware Rules

If you use ESLint with TypeScript rules, type checking happens twice:
1. This hook → `tsc --noEmit`
2. ESLint → Type-aware rules

**Optimization:** Disable type checking in ESLint for speed:
```js
// eslint.config.js
{
  parserOptions: {
    project: false,  // Disable type checking in ESLint
  }
}
```

Let this hook handle type checking instead.

### Biome Integration

Biome and TypeScript checks are complementary:
- **Biome**: Formatting, basic linting, import sorting
- **TypeScript**: Type safety, type errors, interface compliance

Both should run together for comprehensive code quality.

## Debugging

### See Full Type Check Output

```bash
# Enable debug mode
claude --debug

# Or manually run the command from the warning:
pnpm turbo run type-check --filter=./apps/web
```

### Test Hook Manually

```bash
cd /path/to/brainstrike

# Simulate Claude Code's JSON input
echo '{"tool_name":"Write","tool_input":{"file_path":"apps/web/src/main.tsx"}}' | ./.claude/hooks/type-check.sh
```

### Check Turborepo Cache

```bash
# See cache status
pnpm turbo run type-check --filter=./apps/web --dry-run

# Clear cache if needed
rm -rf .turbo
```

## Advanced: Multiple Check Strategies

You can configure different checking strategies based on the event:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/type-check.sh",
            "timeout": 60
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pnpm type-check",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

This runs:
- **Fast package-level check** after each file edit
- **Full monorepo check** when Claude stops (comprehensive)

## References

- [TypeScript Compiler Options](https://www.typescriptlang.org/tsconfig)
- [Turborepo Caching](https://turbo.build/repo/docs/core-concepts/caching)
- [Claude Code Hooks](https://docs.claude.com/en/docs/claude-code/hooks)
- [Project Type Check Script](../../package.json) (line 53)

## Summary

✅ **Smart**: Detects package and runs optimized checks  
✅ **Fast**: Uses Turborepo caching, typically <1s with cache  
✅ **Comprehensive**: Checks all related files in package  
✅ **Non-blocking**: Warns but doesn't interrupt workflow  
✅ **Integrated**: Works seamlessly with Biome hook  

**Result:** Catch type errors immediately after Claude Code edits! 🎯

