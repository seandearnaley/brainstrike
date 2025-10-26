# Quick Start: Biome Hooks for Claude Code

## What was added

✅ **Automatic code formatting and linting** using Biome after every file write or edit by Claude Code

## How to activate

### Step 1: Restart Claude Code

The hooks are loaded when Claude Code starts. You need to restart your current session:

1. Exit Claude Code completely
2. Start Claude Code again in the brainstrike directory
3. Or run: `/reload` command in Claude Code

### Step 2: Verify the hook is registered

In Claude Code, run:
```
/hooks
```

You should see the Biome hook listed under `PostToolUse` events.

## How to use

### It runs automatically!

Once activated, the hook runs automatically whenever Claude Code:
- **Writes** a new file
- **Edits** an existing file

Supported file types:
- TypeScript: `.ts`, `.tsx`, `.mts`, `.cts`
- JavaScript: `.js`, `.jsx`, `.mjs`, `.cjs`
- JSON: `.json`, `.jsonc`
- CSS: `.css`

### See it in action

Press `Ctrl+R` in Claude Code to toggle transcript mode and watch the hook execute:

```
✓ Biome check passed for my-component.tsx
```

## What it does

1. **Formats code** according to your `biome.json` configuration:
   - 2-space indentation
   - Single quotes
   - Semicolons
   - Trailing commas

2. **Fixes linting issues** automatically:
   - Removes unused imports
   - Fixes unused variables
   - Applies safe code improvements

3. **Reports errors** without blocking:
   - If Biome can't fix an issue, it warns but doesn't stop
   - Check transcript mode (Ctrl+R) for details

## Example workflow

```
You: "Create a new React component called UserProfile"

Claude Code:
1. Writes file: apps/web/src/components/user-profile.tsx
2. Hook automatically runs: pnpm biome check --write user-profile.tsx
3. Code is formatted and linted
4. ✓ Biome check passed for user-profile.tsx

You: "Add a prop for the user's email"

Claude Code:
1. Edits file: user-profile.tsx
2. Hook runs again automatically
3. Changes are formatted
4. ✓ Biome check passed for user-profile.tsx
```

## Troubleshooting

### Hook not running?

```bash
# 1. Check if Claude Code is running from the project root
pwd  # Should show: /Users/seandearnaley/Documents/GitHub/brainstrike

# 2. Verify the hook script is executable
ls -la .claude/hooks/biome-check.sh
# Should show: -rwxr-xr-x (executable permissions)

# If not executable, fix it:
chmod +x .claude/hooks/biome-check.sh

# 3. Restart Claude Code session
```

### Want to see what's happening?

```bash
# Run Claude Code in debug mode
claude --debug
```

This shows detailed hook execution logs.

## Testing manually

Want to test the hook without Claude Code?

```bash
# Navigate to project directory
cd /Users/seandearnaley/Documents/GitHub/brainstrike

# Create a test file with intentionally bad formatting
cat > /tmp/test.ts << 'EOF'
const  x=1
const y =  2
const   z    =    3
EOF

# Test the hook (simulate Claude Code's JSON input)
echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/test.ts"}}' | ./.claude/hooks/biome-check.sh

# Check the formatted output
cat /tmp/test.ts
# Should show properly formatted code
```

## Next steps

- Read [README.md](./README.md) for detailed documentation
- Read [IMPLEMENTATION.md](./IMPLEMENTATION.md) for technical details
- Check [Claude Code Hooks Documentation](https://docs.claude.com/en/docs/claude-code/hooks)

## Summary

✅ Hook script created: `.claude/hooks/biome-check.sh`  
✅ Configuration added: `.claude/settings.local.json`  
✅ Documentation created: README, IMPLEMENTATION, QUICKSTART  
✅ Validation passed: Shell syntax ✓, JSON syntax ✓  

**Next: Restart Claude Code and start coding!** 🚀

