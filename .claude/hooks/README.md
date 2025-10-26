# Claude Code Hooks for Brainstrike

This directory contains hooks that run automatically when Claude Code performs certain operations.

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

## Adding new hooks

To add more hooks:

1. Create a new shell script in `.claude/hooks/`
2. Make it executable: `chmod +x .claude/hooks/your-hook.sh`
3. Add configuration to `.claude/settings.local.json`
4. Test with `claude --debug`

See the [hooks reference](https://docs.claude.com/en/docs/claude-code/hooks) for available hook events and options.

