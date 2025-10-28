# Biome Hooks Implementation for Brainstrike

## Overview

This implementation adds automatic code formatting and linting using Biome whenever Claude Code writes or edits files in your project.

## What was implemented

### 1. Hook Script: `biome-check.sh`

**Location**: `.claude/hooks/biome-check.sh`

**Purpose**: Automatically runs Biome's `check --write` command on files after they're modified by Claude Code.

**Features**:
- ✅ Automatically formats code according to Biome configuration
- ✅ Fixes safe linting issues (unused imports, etc.)
- ✅ Reports errors but doesn't block operations
- ✅ Only processes supported file types (TS, JS, JSON, CSS)
- ✅ Handles both absolute and relative file paths
- ✅ 30-second timeout to prevent hanging
- ✅ Gracefully handles missing files or unsupported types

**Supported file extensions**:
- TypeScript: `.ts`, `.tsx`, `.mts`, `.cts`
- JavaScript: `.js`, `.jsx`, `.mjs`, `.cjs`
- JSON: `.json`, `.jsonc`
- CSS: `.css`

### 2. Hook Configuration

**Location**: `.claude/settings.local.json`

**Configuration**:
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

**How it works**:
1. Claude Code uses `Write` or `Edit` tool to modify a file
2. Hook receives JSON input via stdin with file path
3. Script extracts the file path from the JSON
4. If file type is supported, runs `pnpm biome check --write <file>`
5. Reports success/failure but never blocks the operation

### 3. Documentation

Created three documentation files:
- `README.md` - User guide for the hooks
- `IMPLEMENTATION.md` - This file, implementation details
- Comments in `biome-check.sh` - Inline documentation

## How to use

### Automatic usage

Once you **restart your Claude Code session**, the hook will automatically run whenever Claude writes or edits a file. You'll see messages like:

```
✓ Biome check passed for my-file.ts
```

### View hook execution

Press `Ctrl+R` in Claude Code to toggle transcript mode and see hook execution in real-time.

### Debug mode

Run Claude Code with debug flag to see detailed execution:
```bash
claude --debug
```

## Testing the hook

To manually test the hook:

```bash
cd /path/to/brainstrike

# Create test input
echo '{"tool_name":"Write","tool_input":{"file_path":"apps/web/src/main.tsx"}}' | ./.claude/hooks/biome-check.sh
```

Expected output:
```
✓ Biome check passed for main.tsx
```

## What happens when Biome finds issues

### Auto-fixable issues
These are automatically fixed:
- Formatting (indentation, quotes, semicolons)
- Unused imports
- Unsafe type assertions that can be removed
- Style issues with safe fixes

### Non-fixable issues
These are reported but don't block the operation:
```
⚠️  Biome check failed for my-file.ts
```

Check the full Biome output in transcript mode (Ctrl+R).

## Configuration

The hook respects all settings in `biome.json`:
- Formatting rules (indent width, quotes, semicolons)
- Linting rules (enabled rules, severity levels)
- File includes/excludes
- Override configurations for specific paths

See: `biome.json` in the project root

## Troubleshooting

### Hook not running

**Issue**: Hook doesn't execute after Write/Edit operations

**Solutions**:
1. Restart Claude Code session (hooks are loaded at startup)
2. Check hook registration: `/hooks` command in Claude Code
3. Verify script is executable: `ls -la .claude/hooks/biome-check.sh`
4. Check logs with `claude --debug`

### Permission denied

**Issue**: `permission denied` error when running hook

**Solution**:
```bash
chmod +x .claude/hooks/biome-check.sh
```

### Biome not found

**Issue**: Hook reports "command not found: pnpm" or "command not found: biome"

**Solution**:
1. Ensure you're in the project directory where `pnpm` is available
2. Run `pnpm install` to install dependencies
3. Verify Biome is installed: `pnpm list @biomejs/biome`

### Hook times out

**Issue**: Hook exceeds 30-second timeout

**Solution**:
1. Check if Biome is hanging on a specific file
2. Increase timeout in `.claude/settings.local.json`:
   ```json
   {
     "type": "command",
     "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/biome-check.sh",
     "timeout": 60  // Increase to 60 seconds
   }
   ```

### Files not being formatted

**Issue**: Files are modified but not formatted by Biome

**Possible causes**:
1. File type not supported (check extension list above)
2. File excluded in `biome.json` configuration
3. Biome check failed (check transcript mode)

**Solutions**:
1. Check file extension is supported
2. Review `biome.json` includes/excludes
3. Press `Ctrl+R` to see hook output
4. Run Biome manually: `pnpm biome check --write <file>`

## Customization

### Add more file types

Edit `.claude/hooks/biome-check.sh` and add extensions to the case statement:

```bash
case "$file_path" in
  *.js|*.jsx|*.ts|*.tsx|*.json|*.jsonc|*.css|*.mjs|*.cjs|*.mts|*.cts|*.html)  # Added .html
    # ...
    ;;
esac
```

### Change Biome options

Modify the `pnpm biome check` command in the script:

```bash
# Example: Don't auto-fix, just check
pnpm biome check "$file_path" 2>&1

# Example: More verbose output
pnpm biome check --write --verbose "$file_path" 2>&1
```

### Run on different events

Move the hook to a different event in `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PreToolUse": [  // Run before instead of after
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

## Integration with CI/CD

The hook uses the same Biome configuration as your CI/CD pipeline (`biome.json`), ensuring:
- Consistent formatting between local and CI
- Early detection of linting issues
- Reduced CI failures due to formatting

## Performance

**Typical execution time**: 1-3 seconds per file

The hook:
- Only runs on modified files (not the entire project)
- Uses Biome's fast Rust-based parser
- Runs in parallel with Claude Code (doesn't block)
- Times out after 30 seconds to prevent hanging

## Future improvements

Potential enhancements:
- [ ] Batch multiple file changes into a single Biome run
- [ ] Cache Biome results to avoid redundant checks
- [ ] Add pre-commit hook for manual edits
- [ ] Integrate with `.git/hooks` for git operations
- [ ] Add notification for critical linting errors

## References

- [Claude Code Hooks Documentation](https://docs.claude.com/en/docs/claude-code/hooks)
- [Biome CLI Documentation](https://biomejs.dev/reference/cli/)
- [Project Biome Configuration](../../biome.json)
- [Brainstrike Coding Standards](../../AGENTS.md)

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review hook execution with `claude --debug`
3. Test Biome manually: `pnpm biome check --write <file>`
4. Review Claude Code hooks documentation

