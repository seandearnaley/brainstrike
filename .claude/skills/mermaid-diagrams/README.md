# Mermaid Diagrams Skill

An Agent Skill that provides expert guidance for creating and maintaining error-free Mermaid diagrams in the BrainStrike project.

## What This Skill Does

This skill automatically activates when Claude Code works with Mermaid diagrams, providing:

- ✅ **Automatic validation** - Runs validation scripts after diagram changes
- ✅ **Error prevention** - Applies learned best practices from project experience
- ✅ **Quick fixes** - Common syntax error patterns and solutions
- ✅ **Tool integration** - Uses existing validation scripts seamlessly
- ✅ **Project-specific guidance** - Follows BrainStrike conventions

## When It Activates

Claude will automatically use this skill when you:

- Create new Mermaid diagrams
- Edit existing diagrams
- Work with architecture documentation
- Mention Mermaid, flowcharts, sequence diagrams, ER diagrams, etc.
- Ask about diagram syntax or validation

**You don't need to explicitly invoke it** - Claude decides when it's relevant based on your request.

## What's Included

### Main Skill Document

**`SKILL.md`** - Complete guide covering:
- Common syntax errors and fixes
- Validation workflow
- Node shapes and syntax
- Diagram type reference
- Best practices
- Troubleshooting guide

### Supporting Files

**`EXAMPLES.md`** - Real-world examples:
- 8 before/after examples from actual project diagrams
- Common error patterns and fixes
- Validation output examples

**`QUICK-REFERENCE.md`** - Fast lookup:
- Copy-paste ready fixes
- Common patterns
- Node shapes cheat sheet
- Arrow types reference
- Emergency fix checklist

### Integrated Tools

The skill includes these validation scripts:

- **`.claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs`** - Primary validation
- **`.claude/skills/mermaid-diagrams/scripts/test-one-diagram.mjs`** - Single diagram testing
- **`.claude/skills/mermaid-diagrams/scripts/README.md`** - Script documentation

See the scripts README for detailed usage and customization options.

### Project Integration Points

This skill is **self-contained** but integrates with project-specific paths:

**Validation Target** (configurable):
- Default: `docs/architecture/*.md` (BrainStrike project structure)
- Customizable: Edit glob pattern in `scripts/validate-mermaid.mjs` for other projects

**Reference Documentation** (project-specific):
- `docs/mermaid-guide.md` - Complete Mermaid guide for this project
- `docs/architecture/*.md` - Example diagrams in this project
- `AGENTS.md` - Repository guidelines including Mermaid section

These references are specific to the BrainStrike project. When sharing this skill with other projects, update the validation script's glob pattern to match their documentation structure.

## Skill Configuration

```yaml
name: mermaid-diagram-validation
description: Create, edit, and validate Mermaid diagrams in markdown files.
             Use when working with Mermaid diagrams, flowcharts, sequence
             diagrams, ER diagrams, state diagrams, architecture documentation,
             or any markdown containing Mermaid syntax. ALWAYS validate after
             creating or editing diagrams.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
```

**Allowed tools**:
- `Read`, `Write`, `Edit` - File operations for diagrams
- `Grep`, `Glob` - Search for existing diagrams
- `Bash` - Run validation scripts

## How It Works

### Workflow Example

1. **You**: "Create a flowchart showing the authentication process"

2. **Claude** (using this skill):
   - Checks existing diagrams for patterns
   - Creates diagram with proper syntax
   - Quotes all labels with special characters
   - Runs validation: `node .claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs`
   - Reports validation results
   - Explains any fixes applied

3. **Output**: Validated, properly formatted Mermaid diagram ready to commit

### Progressive Disclosure

The skill uses progressive disclosure to avoid overwhelming context:

1. **Quick Reference** loaded first for common patterns
2. **Main skill** provides comprehensive guidance
3. **Examples** loaded only when needed for complex cases
4. **Full guide** (`docs/mermaid-guide.md`) referenced for deep dives

## Key Features

### 1. Error Prevention

Applies learned lessons from past errors:
- Quotes labels with parentheses
- Removes invalid comments from ER diagrams
- Uses `<br/>` for line breaks
- Proper cylinder syntax for databases

### 2. Validation Integration

Automatically runs validation scripts:
```bash
node .claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs
```

Shows results and explains any fixes needed.

### 3. Project Conventions

Follows BrainStrike standards:
- Architecture diagram naming (01-, 02-, etc.)
- C4 model conventions
- Consistent label formatting
- Proper documentation structure

### 4. Context-Aware

Checks existing diagrams before creating new ones:
- Uses `Grep` to find similar patterns
- Reads architecture docs for examples
- Maintains consistency across project

## Benefits

### For Developers

- ⚡ **Faster diagram creation** - No need to remember syntax rules
- 🐛 **Fewer errors** - Validation catches issues immediately
- 📚 **Built-in knowledge** - Best practices applied automatically
- 🔄 **Consistent style** - All diagrams follow same patterns

### For Code Reviewers

- ✅ **Pre-validated diagrams** - All diagrams pass validation
- 📖 **Clear syntax** - Readable, maintainable diagrams
- 🎯 **Standards compliance** - Project conventions followed
- 🚀 **Fewer review cycles** - Errors caught before PR

### For the Team

- 📈 **Quality improvement** - Higher diagram quality across project
- 🧠 **Knowledge capture** - Hard-won lessons preserved
- 🔧 **Easy onboarding** - New team members get expert guidance
- 🎓 **Learning tool** - See best practices in action

## Testing the Skill

### Verify It's Loaded

Ask Claude:
```
What Skills are available?
```

You should see `mermaid-diagram-validation` in the list.

### Test With a Query

```
Can you create a sequence diagram showing how the user logs in?
```

Claude should:
1. Create a valid sequence diagram
2. Quote all labels properly
3. Run validation
4. Report success

### Check Validation

The skill should run validation automatically and show output like:
```
✅ All Mermaid diagrams pass syntax validation
```

## Troubleshooting

### Skill Not Activating

**Check**: Are you mentioning Mermaid or diagrams in your request?

**Try**: Be more explicit: "Create a Mermaid flowchart showing..."

### Validation Not Running

**Check**: Is the validation script accessible?
```bash
ls .claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs
```

**Fix**: Ensure you're in the project root directory.

### Syntax Errors Despite Skill

**Check**: Did validation run? Look for output:
```
node .claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs
```

**Fix**: Share the error message with Claude and ask for help fixing it.

## Updating the Skill

### When to Update

- New Mermaid syntax patterns discovered
- Additional validation rules needed
- New diagram types added to project
- Team identifies common issues

### How to Update

1. Edit `SKILL.md` with new guidance
2. Add examples to `EXAMPLES.md` if needed
3. Update `QUICK-REFERENCE.md` for new patterns
4. Test with Claude to verify changes
5. Commit and push (team members get updates automatically)

### Version History

- **v1.0.0** (2025-01-27): Initial skill created
  - Comprehensive validation guidance
  - 8 real-world examples
  - Quick reference guide
  - Integration with existing validation scripts

## Resources

### Within This Skill

- `SKILL.md` - Main skill document (comprehensive guide)
- `EXAMPLES.md` - Before/after examples with explanations
- `QUICK-REFERENCE.md` - Fast lookup for common patterns

### Project Documentation

- `docs/mermaid-guide.md` - Complete Mermaid guide
- `docs/architecture/*.md` - Example diagrams
- `.claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs` - Validation script
- `AGENTS.md` - Repository guidelines (includes Mermaid section)

### External Resources

- Mermaid Documentation: https://mermaid.js.org/
- Live Editor: https://mermaid.live/
- Syntax Reference: https://mermaid.js.org/syntax/

## FAQ

**Q: Do I need to explicitly invoke this skill?**

A: No! It activates automatically when working with Mermaid diagrams.

**Q: Will it slow down Claude's responses?**

A: No. The skill uses progressive disclosure - only loads what's needed.

**Q: Can I use this skill for other diagram types?**

A: This skill is Mermaid-specific. For other diagram types (PlantUML, Graphviz), create separate skills.

**Q: What if I want to skip validation?**

A: Not recommended, but you can tell Claude: "Create diagram without validation". However, the skill encourages validation for quality.

**Q: Can I customize the validation rules?**

A: Yes! Edit `.claude/skills/mermaid-diagrams/scripts/validate-mermaid.mjs` to add/modify rules.

## Contributing

Found a common error pattern? Want to add examples?

1. Document the issue in `EXAMPLES.md`
2. Add fix to `SKILL.md` if needed
3. Update `QUICK-REFERENCE.md` with pattern
4. Submit PR with clear description

## Summary

This skill captures the collective knowledge about Mermaid diagrams in the BrainStrike project, ensuring every diagram:

- ✅ Follows proper syntax
- ✅ Passes validation
- ✅ Meets project standards
- ✅ Is maintainable and clear

**Result**: Higher quality architecture documentation with fewer errors and faster reviews! 🎉

