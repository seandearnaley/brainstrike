# Claude Code Agent Skills for BrainStrike

This directory contains Agent Skills that extend Claude Code's capabilities with project-specific expertise.

## What Are Agent Skills?

Agent Skills are **model-invoked** capabilities that Claude automatically uses when relevant. Unlike slash commands (user-invoked), Skills activate based on context:

- Claude reads the skill's description and decides when it's relevant
- Skills provide expert guidance for specific domains
- Multiple Skills can work together for complex tasks
- Skills are shared via git with the team

## Available Skills

### 1. Mermaid Diagram Validation

**Location**: `.claude/skills/mermaid-diagrams/`

**Purpose**: Expert guidance for creating and validating Mermaid diagrams

**Activates when**: Working with Mermaid diagrams, flowcharts, sequence diagrams, ER diagrams, architecture documentation

**What it does**:
- Applies best practices from project experience
- Runs validation scripts automatically
- Prevents common syntax errors
- Ensures diagrams pass GitHub rendering
- Follows project conventions

**Files**:
- `SKILL.md` - Main skill document with comprehensive guide
- `EXAMPLES.md` - 8 real-world before/after examples
- `QUICK-REFERENCE.md` - Fast lookup for common patterns
- `README.md` - Skill documentation and usage guide
- `validate-mermaid.mjs` - Validation script for Mermaid diagram syntax

**Try it**: "Create a flowchart showing the authentication flow"

Claude will automatically:
1. Create a syntactically valid diagram
2. Quote labels with special characters
3. Run `node .claude/skills/mermaid-diagrams/validate-mermaid.mjs`
4. Report validation results

## How Skills Work

### Model-Invoked vs User-Invoked

| Feature | Agent Skills | Slash Commands |
|---------|--------------|----------------|
| **Invocation** | Automatic (Claude decides) | Manual (you type `/command`) |
| **Discovery** | Via description | Via menu |
| **Scope** | Broad capabilities | Specific actions |
| **Composition** | Multiple Skills can combine | One at a time |

### Progressive Disclosure

Skills use progressive disclosure to avoid overwhelming Claude's context:

1. **Description** checked first (when to use?)
2. **Main skill** loaded when activated
3. **Supporting files** loaded only when needed
4. **External docs** referenced for deep dives

Example:
```
You: "Create a sequence diagram"
  ↓
Claude sees: "mermaid-diagram-validation" description
  ↓
Matches: "sequence diagram" trigger
  ↓
Loads: SKILL.md (main guidance)
  ↓
Needs examples?: Loads EXAMPLES.md
  ↓
Creates: Valid diagram + runs validation
```

## Viewing Available Skills

### Ask Claude

```
What Skills are available?
```

Claude will list all Skills from:
- Personal Skills: `~/.claude/skills/`
- Project Skills: `.claude/skills/` (this directory)
- Plugin Skills: From installed plugins

### Check Filesystem

```bash
# List project Skills
ls .claude/skills/

# View a specific Skill
cat .claude/skills/mermaid-diagrams/SKILL.md
```

## Using Skills

### Automatic Activation

**You don't need to explicitly invoke Skills.** Claude decides when they're relevant:

```
You: "Fix the authentication diagram"
  ↓
Claude: Activates mermaid-diagram-validation
  ↓
Result: Fixed diagram + validation
```

### Explicit Hints (Optional)

If a Skill isn't activating when expected, be more explicit:

```
# Generic (might not activate)
"Create a diagram"

# Specific (likely to activate)
"Create a Mermaid flowchart showing the auth flow"
```

## Creating New Skills

### When to Create a Skill

Create a Skill when:
- ✅ You have domain expertise to capture
- ✅ The knowledge applies across multiple scenarios
- ✅ Team members would benefit from shared expertise
- ✅ There are common pitfalls to avoid

**Good candidates**:
- Testing patterns for a specific framework
- API design conventions
- Database migration procedures
- Documentation standards

**Not good candidates**:
- One-time tasks
- Project setup (use scripts instead)
- Simple lookups (use documentation)

### Skill Template

```bash
mkdir .claude/skills/my-skill
```

Create `SKILL.md`:
```yaml
---
name: my-skill-name
description: What it does and when to use it (include trigger words!)
allowed-tools: Read, Write, Bash  # Optional: restrict tool access
---

# My Skill Name

## Quick Reference
Key information Claude needs immediately

## Instructions
Step-by-step guidance for Claude

## Best Practices
Lessons learned, common pitfalls

## Resources
Links to full documentation
```

**Key principles**:
1. **Specific description** - Include trigger words users will mention
2. **Focused scope** - One skill = one capability
3. **Clear instructions** - Tell Claude exactly what to do
4. **Examples** - Show before/after patterns
5. **Validation** - How to verify the skill worked

## Skill Best Practices

### 1. Write Effective Descriptions

**Good** ✅:
```yaml
description: Analyze Excel spreadsheets, create pivot tables, and generate
             charts. Use when working with Excel files, spreadsheets, or
             analyzing tabular data in .xlsx format.
```

**Vague** ❌:
```yaml
description: For files
```

**Why**: Good descriptions include:
- What the skill does
- When to use it
- Trigger words (Excel, spreadsheet, .xlsx)

### 2. Keep Skills Focused

**Good** ✅:
- "PDF form filling"
- "Git commit message generation"
- "React component testing"

**Too broad** ❌:
- "Document processing" (split into PDF, Word, Excel skills)
- "Testing" (split by framework/type)

### 3. Use Progressive Disclosure

**Structure**:
```
my-skill/
├── SKILL.md          # Main guidance (always loaded)
├── REFERENCE.md      # Detailed reference (loaded when needed)
├── EXAMPLES.md       # Examples (loaded for complex cases)
└── scripts/          # Helper scripts (referenced from SKILL.md)
    └── helper.py
```

**Benefits**:
- Faster activation (loads only what's needed)
- Less context consumption
- Better performance

### 4. Provide Validation

Every skill should include a way to verify success:

```markdown
## Validation

After applying this skill, verify:
1. Run the validation script: `npm run validate`
2. Check output for errors
3. Confirm all tests pass
```

## Team Workflow

### Sharing Skills

Skills in `.claude/skills/` are automatically shared via git:

```bash
# Create/edit skill
vim .claude/skills/new-skill/SKILL.md

# Commit and push
git add .claude/skills/new-skill/
git commit -m "feat(skills): add new-skill for X"
git push
```

### Getting Team Skills

Team members automatically get Skills on pull:

```bash
git pull
# Skills immediately available in Claude Code
```

### Updating Skills

```bash
# Edit skill
vim .claude/skills/mermaid-diagrams/SKILL.md

# Commit changes
git add .claude/skills/
git commit -m "docs(skills): update mermaid validation rules"
git push
```

**Note**: Claude Code loads Skills at startup. Restart after pulling updates.

## Troubleshooting

### Skill Not Activating

**Check**:
1. Description includes trigger words you're using?
2. YAML frontmatter valid?
3. Skill file named `SKILL.md`?

**Fix**:
- Make description more specific
- Use trigger words in your request
- Validate YAML syntax

### Skill Has Errors

**Check**:
1. All referenced files exist?
2. Scripts are executable? (`chmod +x script.sh`)
3. Dependencies installed?

**Debug**:
```bash
# Run Claude in debug mode
claude --debug

# Check for Skill loading errors in output
```

### Multiple Skills Conflict

**Fix**: Make descriptions more distinct

**Before** ❌:
```yaml
# Skill 1
description: For data analysis

# Skill 2
description: For analyzing data
```

**After** ✅:
```yaml
# Skill 1
description: Analyze sales data in Excel files and CRM exports.
             Use for sales reports, pipeline analysis.

# Skill 2
description: Analyze log files and system metrics.
             Use for debugging, performance monitoring.
```

## Resources

### Documentation

- **Agent Skills Guide**: https://docs.claude.com/en/docs/claude-code/skills
- **Skills Overview**: https://docs.anthropic.com/en/docs/agent-skills
- **Blog Post**: [Equipping agents with Agent Skills](https://www.anthropic.com/engineering-blog/agent-skills)

### In This Project

- Example Skill: `.claude/skills/mermaid-diagrams/`
- Validation Scripts: `scripts/`
- Architecture Docs: `docs/architecture/`

### External Resources

- Mermaid Documentation: https://mermaid.js.org/
- Claude Code Hooks: https://docs.claude.com/en/docs/claude-code/hooks

## Examples from This Project

### Mermaid Skill Workflow

**User**: "Update the architecture diagram to show the new cache layer"

**Claude** (using mermaid-diagram-validation skill):
1. Reads existing diagram with `Read` tool
2. Applies best practices (quote labels, proper syntax)
3. Edits diagram with cache layer
4. Runs `node scripts/validate-mermaid.mjs`
5. Shows validation output
6. Confirms success ✅

**User sees**: Valid diagram, already validated, ready to commit!

## Future Skills

Ideas for additional skills:

- **Testing Patterns** - Vitest test generation for packages
- **TypeScript Migrations** - Safe refactoring patterns
- **Git Workflow** - Conventional commits, branch naming
- **Documentation** - JSDoc/TSDoc generation
- **Performance** - Optimization patterns, benchmarking

## Summary

Agent Skills in this project:

- ✅ **Capture expertise** - Project knowledge preserved
- ✅ **Auto-apply** - Claude uses when relevant
- ✅ **Team-shared** - Everyone benefits via git
- ✅ **Self-documenting** - Clear instructions included
- ✅ **Validated** - Verification steps built-in

**Result**: More consistent, higher quality code with less repetitive guidance! 🎉

