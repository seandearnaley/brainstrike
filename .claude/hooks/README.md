# Claude Code Hooks for Brainstrike

This directory contains hooks that run automatically when Claude Code performs certain operations.

## Active Hooks

1. **Biome Code Quality Hook** - Automatic formatting and linting
2. **TypeScript Type Checking Hook** - Automatic type error detection

---

## Biome Code Quality Hook

### What it does

The `biome-check.sh` hook automatically runs Biome's formatting and linting on files after they are written or edited by Claude Code. This ensures all code modifications maintain consistent formatting and pass linting checks.

### When it runs

- **Trigger**: After `Write` or `Edit` tool operations
- **Files**: TypeScript, JavaScript, JSON, and CSS files (`.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.jsonc`, `.css`, `.mjs`, `.cjs`, `.mts`, `.cts`)
- **Timeout**: 30 seconds

### What it checks

1. **Formatting**: Applies Biome's formatting rules (2-space indentation, single quotes, semicolons, etc.)
2. **Linting**: Checks for code quality issues, unused variables, incorrect patterns, etc.
3. **Auto-fixes**: Automatically fixes safe issues like formatting, unused imports, etc.

### Configuration

The hook is configured in `.claude/settings.local.json`:

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
          }
        ]
      }
    ]
  }
}
```

### How to view hook execution

1. **In Claude Code**: Press `Ctrl+R` to toggle transcript mode and see hook execution progress
2. **Debug mode**: Run `claude --debug` to see detailed hook execution logs

### Troubleshooting

#### Hook not running
1. Check if the hook is registered: Run `/hooks` in Claude Code
2. Verify the script is executable: `ls -la .claude/hooks/biome-check.sh`
3. Check debug logs: `claude --debug`

#### Biome errors
If Biome fails, the hook will log a warning but won't block the operation. Check:
- The file is in a path covered by `biome.json` includes
- Biome is installed: `pnpm list @biomejs/biome`
- You can run Biome manually: `pnpm biome check <file>`

#### Permission errors
If you see "permission denied" errors:
```bash
chmod +x .claude/hooks/biome-check.sh
```

### Disabling the hook

To temporarily disable the hook:
1. Comment out the hook configuration in `.claude/settings.local.json`
2. Restart Claude Code session

### Related documentation

- [Claude Code Hooks Documentation](https://docs.claude.com/en/docs/claude-code/hooks)
- [Biome Documentation](https://biomejs.dev)
- [Project Biome Configuration](../../biome.json)

---

## TypeScript Type Checking Hook

### What it does

The `type-check.sh` hook automatically runs TypeScript type checking on files after they are written or edited by Claude Code. This catches type errors early, before they become problems.

### When it runs

- **Trigger**: After `Write` or `Edit` tool operations
- **Files**: TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`)
- **Timeout**: 60 seconds
- **Runs in parallel** with Biome hook for faster execution

### What it checks

1. **Package-level type checking** (preferred): Runs `pnpm turbo run type-check --filter=./package` for the affected package
2. **File-level type checking** (fallback): Runs `pnpm tsc --noEmit` on individual files if package detection fails
3. **Leverages Turborepo caching**: Instant results if nothing changed

### How it works

**Smart package detection:**
```
Edit: apps/web/src/components/user.tsx
  ↓
Hook detects: apps/web
  ↓
Runs: pnpm turbo run type-check --filter=./apps/web
  ↓
✓ Type check passed for web (0.5s - cached!)
```

**Comprehensive checking:**
- Checks the entire package, not just one file
- Catches cross-file type errors
- Uses TypeScript compiler with full project context

### Configuration

The hook is configured in `.claude/settings.local.json`:

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

### Output examples

**Success:**
```
🔍 Type checking packages/ui...
✓ Type check passed for ui
```

**Type errors found:**
```
🔍 Type checking apps/web...
⚠️  Type check found issues in apps/web
Run: pnpm turbo run type-check --filter=./apps/web
```

Hook warns but **doesn't block** - Claude can continue working.

### Performance

- **With cache**: ~0.1-0.5 seconds (instant)
- **Without cache**: ~2-10 seconds (depends on package size)
- **Parallel execution**: Runs simultaneously with Biome hook

### Troubleshooting

#### Type errors reported
1. Press `Ctrl+R` to see full error details
2. Run suggested command: `pnpm turbo run type-check --filter=./package`
3. Fix type errors
4. Re-run operation

#### Slow type checking
1. Check Turborepo cache is enabled (`.turbo/` directory exists)
2. Increase timeout if needed (edit `.claude/settings.local.json`)
3. Consider optimizing `tsconfig.json` with `skipLibCheck: true`

#### Hook not detecting package
Check file path matches monorepo structure: `apps/*/` or `packages/*/`

### Related documentation

- [Detailed Type Checking Guide](./TYPE-CHECK.md)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Turborepo Type Checking](https://turbo.build/repo/docs/handbook/linting)

---

## How Both Hooks Work Together

### Execution Flow

```
Claude Code: Write/Edit file.tsx
    ↓
    ├─→ biome-check.sh (30s)    ┐
    │   ✓ Format & lint         │ Run in
    │                            │ parallel
    └─→ type-check.sh (60s)     │
        ✓ Type checking          ┘
    ↓
Total time ≈ max(30s, 60s) = ~60s worst case
Typical: ~2-5s with caching
```

### What Each Hook Does

| Hook | Checks | Auto-fixes | Speed | Timeout |
|------|--------|------------|-------|---------|
| **Biome** | Formatting, linting, imports | Yes | Very fast (~0.5-2s) | 30s |
| **TypeScript** | Type errors, interfaces | No | Fast with cache (~0.5-5s) | 60s |

### Combined Benefits

✅ **Consistent formatting** - Code always follows style guide  
✅ **Early error detection** - Type errors caught immediately  
✅ **Fast feedback** - Parallel execution + caching  
✅ **Non-blocking** - Warnings don't interrupt workflow  
✅ **CI/CD alignment** - Same checks as your pipeline  

---

## Related Documentation

- [Claude Code Hooks Documentation](https://docs.claude.com/en/docs/claude-code/hooks)
- [Biome Documentation](https://biomejs.dev)
- [TypeScript Documentation](https://www.typescriptlang.org)
- [Project Biome Configuration](../../biome.json)
- [Project Type Check Configuration](../../tsconfig.json)

## Adding new hooks

To add more hooks:

1. Create a new shell script in `.claude/hooks/`
2. Make it executable: `chmod +x .claude/hooks/your-hook.sh`
3. Add configuration to `.claude/settings.local.json`
4. Test with `claude --debug`

See the [hooks reference](https://docs.claude.com/en/docs/claude-code/hooks) for available hook events and options.

