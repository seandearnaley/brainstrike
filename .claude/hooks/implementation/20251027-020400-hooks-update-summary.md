# Hooks Update Summary - Now BLOCKING! 🔒

## What Changed

Your Claude Code hooks have been upgraded from **non-blocking** (warnings only) to **BLOCKING** (errors stop Claude).

---

## Before (Non-Blocking) ⚠️

```bash
# Biome found errors
echo "⚠️  Biome check failed" >&2
exit 0  # Don't block, just warn
```

**Result**: Claude could continue even with lint/type errors → errors slipped through to commits

---

## After (BLOCKING) ✅

```bash
# Biome found errors
echo "❌ Biome check FAILED" >&2
echo "$output" >&2  # Show actual errors
exit 1  # BLOCK Claude until fixed!
```

**Result**: Claude CANNOT continue until all errors are fixed → zero errors in commits

---

## Updated Files

### 1. biome-check.sh (v2.0 - BLOCKING)

**Changes**:
- ✅ Now exits with code 1 (blocks) when Biome finds unfixable errors
- ✅ Captures and displays full error output
- ✅ Shows clear visual separator (━━━━)
- ✅ Provides command to run manually
- ✅ Better progress feedback

**Behavior**:
```bash
# On success:
🔍 Running Biome check on my-file.tsx...
✓ Biome check passed for my-file.tsx

# On error:
🔍 Running Biome check on my-file.tsx...

❌ Biome check FAILED for /path/to/my-file.tsx
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Full Biome error output here]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Fix the errors above before continuing.
Run manually: pnpm biome check --write /path/to/my-file.tsx

[BLOCKS Claude from continuing]
```

### 2. type-check.sh (v2.0 - BLOCKING)

**Changes**:
- ✅ Now exits with code 1 (blocks) when TypeScript errors found
- ✅ Captures and displays full type error output
- ✅ Shows clear visual separator (━━━━)
- ✅ Provides command to run manually
- ✅ Better progress feedback
- ✅ Works for both package-level and file-level checks

**Behavior**:
```bash
# On success:
🔍 Type checking apps/web...
✓ Type check passed for web

# On error:
🔍 Type checking apps/web...

❌ Type check FAILED for apps/web
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Full TypeScript error output here]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Fix the type errors above before continuing.
Run manually: pnpm turbo run type-check --filter=./apps/web

[BLOCKS Claude from continuing]
```

---

## What This Means

### Before Update

1. Claude edits `my-component.tsx`
2. Hook runs: `⚠️ Biome check failed` (warning)
3. Claude continues working
4. You commit → **errors in repo** ❌

### After Update

1. Claude edits `my-component.tsx`
2. Hook runs: `❌ Biome check FAILED` (blocking error)
3. **Claude CANNOT continue**
4. Claude must fix errors first
5. Hook runs again: `✓ Biome check passed`
6. Claude can now continue
7. You commit → **zero errors** ✅

---

## Benefits

| Aspect | Before | After |
|--------|--------|-------|
| **Lint errors** | Could slip through | **Caught immediately** |
| **Type errors** | Could slip through | **Caught immediately** |
| **Error visibility** | Warning only | **Full error output** |
| **Commit quality** | Variable | **Always clean** |
| **Fix time** | Later (harder) | **Immediately (easier)** |
| **Technical debt** | Accumulates | **Prevented** |

---

## Configuration

Hooks are configured in `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/biome-check.sh",
            "timeout": 30
          },
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

Both hooks run in **parallel** after every `Write` or `Edit` operation.

---

## Testing

### Test Biome Hook

```bash
# Create a file with errors
echo 'const x=1; const y=2' > /tmp/test.ts

# Test the hook
echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/test.ts"}}' | \
  ./.claude/hooks/biome-check.sh

# Expected: Auto-fixes formatting, passes check
```

### Test Type Check Hook

```bash
# Test with actual project file
echo '{"tool_name":"Write","tool_input":{"file_path":"apps/web/src/main.tsx"}}' | \
  ./.claude/hooks/type-check.sh

# Expected: Runs type check for apps/web
```

---

## Troubleshooting

### Hook Still Not Blocking

**Check**:
1. Are you running latest version? `grep "exit 1" .claude/hooks/*.sh`
2. Is Claude Code restarted? (hooks load at startup)
3. Are hooks executable? `ls -la .claude/hooks/*.sh`

### Too Strict / Interrupts Workflow

If blocking hooks are too disruptive, you can:

**Option 1**: Increase timeout
```json
{
  "timeout": 120  // Give more time for complex fixes
}
```

**Option 2**: Temporarily disable for complex work
```json
{
  "hooks": {
    // Comment out PostToolUse hooks temporarily
  }
}
```

**Option 3**: Make specific error types non-blocking
Edit the hook script to only block on critical errors.

### Hook Errors Are Unclear

If hook output isn't helpful:

1. Run command manually (shown in error message)
2. Check full output for details
3. Ensure you're in project root

---

## Error Examples

### Biome Error Example

```
❌ Biome check FAILED for apps/web/src/components/user.tsx
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
apps/web/src/components/user.tsx:15:10 lint/correctness/noUnusedVariables ━━━

  ✖ This variable is unused.
  
    13 │ export const UserComponent = () => {
    14 │   const [name, setName] = useState('');
  > 15 │   const unusedVar = 'test';
       │         ^^^^^^^^^
    16 │   return <div>{name}</div>;
    17 │ };
  
  ℹ If this is intentional, prefix it with an underscore:
    _unusedVar
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Fix the errors above before continuing.
Run manually: pnpm biome check --write apps/web/src/components/user.tsx
```

### Type Error Example

```
❌ Type check FAILED for apps/web
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
apps/web/src/components/user.tsx:20:5 - error TS2322: Type 'number' is not assignable to type 'string'.

20     setName(123);
       ~~~~~~~~

  Expected type comes from property 'name' which is declared here on type 'User'

Found 1 error in apps/web/src/components/user.tsx:20
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Fix the type errors above before continuing.
Run manually: pnpm turbo run type-check --filter=./apps/web
```

---

## Next Steps

### Immediate

1. ✅ Hooks are now BLOCKING - no action needed
2. ✅ Claude will be forced to fix errors immediately
3. ✅ All commits will be error-free

### Optional Enhancements

Consider adding a **final check** before commits (Stop hook):

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

This runs comprehensive checks (Biome + TypeScript) on all changes before Claude stops.

See `HOOKS-CONFIGURATION.md` for details on creating `final-check.sh`.

---

## Summary

**Problem**: Hooks were non-blocking → errors could slip through

**Solution**: Made hooks BLOCKING → errors must be fixed immediately

**Result**: 
- ✅ Zero lint errors in commits
- ✅ Zero type errors in commits
- ✅ Immediate error feedback
- ✅ Higher code quality
- ✅ Less technical debt

**Status**: ✅ Complete and active!

**Date**: 2025-01-27
**Version**: Hooks v2.0 - BLOCKING

