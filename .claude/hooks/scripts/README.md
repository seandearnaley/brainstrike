# Hook Configuration Files

This folder contains the actual hook scripts and testing utilities that run as part of Claude Code and Git workflows.

## Scripts

### Hook Scripts (Auto-Run)

These scripts are triggered automatically by Claude Code's `PostToolUse` hook on `Write|Edit` operations:

- **`biome-check.sh`** - Runs Biome code formatter and linter
  - Triggered: After every file edit/write
  - Checks: JavaScript, TypeScript, JSON, CSS, and other Biome-supported files
  - Blocks: If unfixable errors found
  - Speed: ~0.5-2s per file

- **`type-check.sh`** - Runs TypeScript type checking
  - Triggered: After TypeScript file edits
  - Checks: Only affected packages (smart monorepo detection)
  - Blocks: If type errors found
  - Speed: ~0.5-3s (with Turborepo caching)

### Utility Scripts

- **`test-hooks.sh`** - Testing and validation script
  - Purpose: Verify hooks are working correctly
  - Usage: `bash scripts/test-hooks.sh`
  - Useful: For debugging hook issues locally

## How Hooks Are Configured

Hooks are defined in `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/scripts/biome-check.sh",
            "timeout": 30
          },
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/scripts/type-check.sh",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

## Adding New Hooks

To add a new hook script:

1. Create script: `hook-name.sh` (use descriptive name, no timestamp)
2. Make executable: `chmod +x script.sh`
3. Add to `.claude/settings.local.json` in the `PostToolUse` hooks array
4. Document in this README with description and purpose
5. Add tests to `test-hooks.sh` if applicable

## Pre-Commit Hooks

Git pre-commit hooks are configured in `lefthook.yml` (in repo root):

- **biome** - Code formatting and linting
- **type-check** - TypeScript validation (only changed packages)

See `guides/` folder for lefthook configuration details.

---

**Last Updated**: 2025-10-28  
**Timestamp Format**: YYYYMMDD-HHMMSS (UTC) for file ordering
