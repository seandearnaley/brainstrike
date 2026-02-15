# Mermaid Validation Scripts

This directory contains validation and testing scripts for Mermaid diagrams.

## Scripts

### validate-mermaid.mjs

**Purpose**: Validates all Mermaid diagrams in the project's architecture documentation.

**Usage**:
```bash
node .claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs
```

**What it checks**:
- Unquoted parentheses in labels (most common error)
- Invalid comments in ER diagrams
- Other common syntax violations

**Output**:
- ✅ Success: All diagrams pass validation
- ❌ Error: Lists specific syntax errors with line numbers

**Dependencies**:
- `glob` - For finding markdown files
- Node.js built-in modules (`fs/promises`, `child_process`, `util`)

**Project Integration**:
- Scans `apps/docs/docs/architecture/*.md` files by default
- Can be customized to scan other directories by modifying the glob pattern

### test-one-diagram.mjs

**Purpose**: Test a single Mermaid diagram in isolation during development.

**Usage**:
1. Edit the `testDiagram` constant in the script with your diagram
2. Run: `node .claude/skills/mermaid-diagrams/scripts/test-one-diagram.mjs`

**What it does**:
- Uses Mermaid's parser to validate syntax
- Provides immediate feedback on diagram validity
- Useful for rapid iteration when creating complex diagrams

**Dependencies**:
- `mermaid` - Official Mermaid library for parsing

**Example**:
```javascript
const testDiagram = `flowchart LR
  A["Node A"]
  B["Node B"]
  A --> B
`;
```

## Installation

These scripts require the following npm packages:

```bash
pnpm add -D mermaid glob
```

These dependencies are already installed in the BrainStrike project.

## Self-Contained Design

This skill folder is designed to be self-contained and shareable:

- ✅ **All scripts included** - No external script dependencies
- ✅ **Clear documentation** - Usage instructions in this README
- ✅ **Minimal dependencies** - Only requires `mermaid` and `glob` packages

### Project-Specific Integration

The validation script is configured for the BrainStrike project structure:
- Scans `apps/docs/docs/architecture/*.md` by default
- Can be customized for other project structures by editing the glob pattern in `validate-mermaid.mjs`

When sharing this skill with other projects, update the glob pattern to match their documentation structure.

## Contributing

When adding new validation rules:
1. Update `validate-mermaid.mjs` with the new check
2. Add examples to `../EXAMPLES.md`
3. Update `../SKILL.md` with the new pattern
4. Test with real diagrams to ensure accuracy
