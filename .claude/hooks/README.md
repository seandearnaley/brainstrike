# Claude Code & Git Hooks System

Comprehensive hooks system for Brainstrike, including Claude Code hooks for formatting/linting and Git pre-commit hooks for type-checking.

## 📁 Directory Structure

```
.claude/hooks/
├── README.md                          # This file - navigation & overview
├── scripts/                            # Hook scripts & utilities
│   ├── README.md                      # Hook script documentation
├── implementation/                    # Implementation history & fixes
│   ├── README.md                      # Timeline of changes
├── guides/                            # How-to guides & tutorials
│   ├── README.md                      # Learning paths
└── reference/                         # Technical reference
    ├── README.md                      # Pattern library index
```

## 🚀 Quick Navigation

### 👤 I'm a Developer - Where Do I Start?

1. **First time?** → `guides/00-20251027-020400-quickstart.md`
2. **Hook not working?** → Troubleshooting section in quickstart
3. **Want to understand hooks?** → `guides/01-20251027-020400-type-check-guide.md`
4. **Need configuration details?** → `reference/00-20251027-020400-hooks-configuration.md`

### 🔧 I Need to Add/Fix a Hook

1. **Adding new hook?** → `scripts/README.md` (naming conventions)
2. **Current implementation broken?** → `implementation/` (timeline of known issues)
3. **Need pattern examples?** → `reference/` (canonical patterns)

### 📚 I'm Researching/Documenting

1. **How did we get here?** → `implementation/README.md` (timeline)
2. **What patterns are we using?** → `reference/` (pattern library)
3. **Finding a specific fix?** → Look for timestamp in `implementation/`

## 📋 What Hooks Do

### Claude Code Hooks (Auto-Run on Edit)

**Biome** - Code formatting & linting
- Runs: On every file edit/write
- Blocks: If unfixable errors found
- Files: `.js`, `.ts`, `.tsx`, `.json`, `.css`, etc.

**TypeScript Type-Check** - Static type validation
- Runs: On TypeScript file edits
- Blocks: If type errors found
- Smart: Only checks affected packages (monorepo aware)

### Git Pre-Commit Hooks (lefthook)

**biome** - Same as above, runs on staged files
**type-check** - TypeScript validation (canonical pattern with filtering)

## 🎯 Current Status

✅ **Biome hook** - Production ready  
✅ **Type-check hook** - Production ready (with canonical Turborepo filtering)  
✅ **Pre-commit integration** - Complete with performance optimizations  
⚠️ **Known issue**: `packages/ui` has test type errors (see `implementation/`)

## 📖 Key Documentation

| Document | Purpose | Audience |
|----------|---------|----------|
| `STRUCTURE.md` | Directory organization & overview | Everyone |
| `guides/00-...-quickstart.md` | Getting started | Developers |
| `scripts/README.md` | Hook scripts | Hook developers |
| `implementation/README.md` | Change history | Everyone |
| `reference/00-...-hooks-configuration.md` | Configuration details | Engineers |
| `reference/02-...-lefthook-canonical-pattern.md` | Pattern deep-dive | Advanced users |

## 🔍 File Naming Convention

### Scripts (Stable Names)
- Hook scripts in `scripts/` use **stable names** without timestamps
- **Example**: `biome-check.sh`, `type-check.sh`
- **Why**: Configuration references remain constant

### Documentation (Timestamped)
- **Implementation** docs use timestamps only (historical records)
  - **Example**: `20251028-061100-type-check-fix-final.md`
- **Guides & Reference** docs use padded ordering + timestamps
  - **Example**: `00-20251027-020400-quickstart.md`, `01-20251027-020400-type-check-guide.md`
  - **Why**: Padding ensures proper sort order, timestamps show when created

**Timestamp Format**: YYYYMMDD-HHMMSS (UTC)

## 🚦 Performance Notes

- **Biome**: ~0.5-2s per file
- **Type-check**: ~0.5-3s (with Turborepo caching, much faster on repeat runs)
- **Pre-commit**: Usually <5s total with caching

With canonical pattern filtering:
- ✅ Skips checks when irrelevant (e.g., no .ts files)
- ✅ Only checks affected packages
- ✅ Turborepo caching speeds up repeated runs

## 📝 Adding New Hooks in the Future

When adding a new hook:

1. **Create script** in `scripts/` with timestamp naming
2. **Update** `.claude/settings.local.json` to register hook
3. **Document** in `scripts/README.md`
4. **Test** using existing test framework
5. **Create reference doc** in `reference/` if it's a new pattern
6. **Update** this README if needed

The timestamp-based naming ensures files sort chronologically and future hooks integrate seamlessly.

## 🔗 External References

- **lefthook configuration** - `lefthook.yml` in repo root
- **Claude Code hooks** - `.claude/settings.local.json`
- **Project guidelines** - `AGENTS.md` in repo root

## 📞 Troubleshooting

**Hook not running?**
- Check `.claude/settings.local.json` has correct paths
- Verify script is executable: `chmod +x scripts/*.sh`
- See `guides/quickstart.md` for more

**Hook timing out?**
- Increase timeout in `.claude/settings.local.json`
- Check package dependencies are built
- See `reference/hooks-configuration.md`

**Type-check too slow?**
- Turborepo caching helps - runs twice before cache helps
- Canonical pattern should skip irrelevant checks
- See `reference/lefthook-canonical-pattern.md` for optimization

---

**Last Updated**: 2025-10-28  
**Next Steps**: See your learning path above 👆

