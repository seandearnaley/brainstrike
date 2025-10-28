# Guides & How-To Documentation

This folder contains practical guides for understanding and working with the hooks system.

## Available Guides

### Getting Started
- **`00-20251027-020400-quickstart.md`** - Quick start guide for developers
  - First-time setup
  - Common tasks
  - Troubleshooting checklist

### Hook-Specific Guides

- **`01-20251027-020400-type-check-guide.md`** - Complete TypeScript type-checking guide
  - How type-check works
  - Smart package detection in monorepos
  - Workflow examples
  - Performance optimization

## Learning Path

**New to the project?**
1. Start with `quickstart.md`
2. Read about your specific workflow (testing, linting, etc.)
3. Check `reference/` folder for detailed configurations

**Need to fix a hook?**
1. Review `guides/quickstart.md` troubleshooting section
2. Check `reference/hooks-configuration.md` for settings
3. See `implementation/` for known issues and fixes

**Adding a new hook?**
1. Read `config/README.md` for naming conventions
2. Look at existing hook scripts in `config/`
3. Document in new file: `YYYYMMDD-HHMMSS-hook-name.md`

## Writing New Guides

When adding a new guide:

1. **Naming**: `YYYYMMDD-HHMMSS-descriptive-name.md`
2. **Structure**:
   - Clear overview
   - Step-by-step instructions
   - Real-world examples
   - Troubleshooting section
3. **Update this README** with the new guide

---

**Last Updated**: 2025-10-28  
**Audience**: Developers, DevOps, and AI assistants
