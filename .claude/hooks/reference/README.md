# Technical Reference

This folder contains detailed technical reference documentation for hooks configuration and patterns.

## Configuration Reference

- **`00-20251027-020400-hooks-configuration.md`** - Complete hooks configuration reference
  - Claude Code hook setup (.claude/settings.local.json)
  - Hook syntax and options
  - Permissions configuration
  - Timeout and retry settings

## Pattern Library

### lefthook Patterns

- **`01-20251028-020600-lefthook-fix.md`** - The problem and solution for lefthook type-checking
  - Issue: Type-check ran on entire monorepo
  - Solution: Added canonical filtering pattern
  - What changed in lefthook.yml

- **`02-20251028-020700-lefthook-canonical-pattern.md`** - Deep dive into the canonical pattern
  - How `glob` filters work
  - How Turborepo `[HEAD]` filtering works
  - Comparison of filtering strategies
  - Performance metrics
  - Alternative patterns and when to use them

## Using This Reference

**Looking for a specific configuration option?**
- Check `hooks-configuration.md`

**Need to understand how a pattern works?**
- See the pattern-specific file (e.g., `lefthook-canonical-pattern.md`)

**Want to implement a similar pattern?**
1. Understand the canonical pattern (lefthook docs)
2. Adapt to your use case
3. Test locally before committing
4. Document in a new reference file

## Adding New Reference Documentation

When documenting a new pattern or configuration:

1. **Naming**: `YYYYMMDD-HHMMSS-topic-name.md`
2. **Structure**:
   - Problem statement
   - Solution overview
   - Detailed explanation
   - Code examples
   - Trade-offs and alternatives
3. **Link** from this README in appropriate section
4. **Cross-reference** from related guides

---

**Last Updated**: 2025-10-28  
**Audience**: Engineers, DevOps, hook developers  
**Depth**: Technical - for understanding and implementing patterns
