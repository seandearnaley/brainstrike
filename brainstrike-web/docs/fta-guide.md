# Fast TypeScript Analyzer (FTA) Guide

## Overview

The Fast TypeScript Analyzer (FTA) is a high-performance static analysis tool written in Rust, designed specifically for TypeScript projects. Using the SWC (Speedy Web Compiler) parser, FTA can analyze up to 1,600 files per second on typical hardware, making it one of the fastest static analysis tools available for TypeScript.

## Core Features

- Super-fast analysis using Rust and SWC
- Comprehensive complexity metrics
- Support for both TypeScript and JavaScript
- Multiple integration options (CLI, programmatic, WASM)
- Configurable scoring and thresholds

## FTA Score Components

The FTA score is calculated using several key metrics that together provide a comprehensive view of code quality:

### 1. Halstead Metrics

These metrics evaluate code complexity by analyzing operators and operands:

```json
{
  "halstead": {
    "uniq_operators": 28,      // Number of distinct operators
    "uniq_operands": 67,       // Number of distinct operands
    "total_operators": 271,    // Total operator occurrences
    "total_operands": 239,     // Total operand occurrences
    "program_length": 95,      // Length of implementation
    "vocabulary_size": 510,    // Size of vocabulary
    "volume": 854.46,          // Program volume
    "difficulty": 37.84,       // Difficulty level
    "effort": 32337.33,        // Estimated effort
    "time": 1796.51,          // Estimated time to program
    "bugs": 0.28              // Estimated number of bugs
  }
}
```

### 2. Cyclomatic Complexity
Measures the number of linearly independent paths through the code, indicating decision-making complexity.

### 3. Line Count
Total number of lines in the file, providing a basic size metric.

## Score Interpretation

FTA scores fall into three categories:

- **> 60**: Needs Improvement - Code is difficult to maintain
- **50-60**: Could Be Better - Code is reasonably maintainable but could benefit from simplification
- **< 50**: OK - Code is considered maintainable

## Installation & Usage

### CLI Usage

```bash
# Install globally
npm install -g fta-cli

# Or use npx
npx fta-cli path/to/project

# Add to your project
yarn add -D fta-cli
```

### Package.json Integration

```json
{
  "scripts": {
    "fta": "fta src"
  }
}
```

### Programmatic Usage

```typescript
import { runFta } from "fta-cli";

// Standard ASCII table output
const standardOutput = runFta("path/to/project");

// JSON output for programmatic use
const output = runFta("path/to/project", { json: true });
```

### WebAssembly Support

FTA also provides a WebAssembly package (`fta-wasm`) for browser-based analysis, which powers the official [FTA Playground](https://ftaproject.dev/playground).

## Command Line Options

- `-c, --config-path <PATH>`: Path to config file
- `-f, --format <FORMAT>`: Output format (table, csv, json) [default: table]
- `--json`: Output as JSON
- `-o, --output-limit <N>`: Maximum files in table output [default: 5000]
- `-s, --score-cap <N>`: Maximum FTA score threshold [default: 1000]
- `-i, --include-comments <BOOL>`: Include code comments in analysis [default: false]
- `-e, --exclude-under <N>`: Minimum LOC for inclusion [default: 6]

## Best Practices for Improving FTA Scores

1. **Component Architecture**
   - Break down large components into smaller, focused ones
   - Use composition over inheritance
   - Implement clear component boundaries

2. **Logic Optimization**
   - Reduce nested conditionals
   - Implement early returns and guard clauses
   - Use appropriate data structures
   - Consider functional programming patterns

3. **State Management**
   - Centralize state management
   - Use appropriate state management tools
   - Implement state immutability patterns

4. **Code Organization**
   - Follow Single Responsibility Principle
   - Implement clear module boundaries
   - Use meaningful naming conventions
   - Maintain consistent file structure

## CI/CD Integration

Add FTA to your continuous integration pipeline:

```yaml
# Example GitHub Action
name: Code Quality
on: [push, pull_request]
jobs:
  fta-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - run: npm install -g fta-cli
      - run: fta-cli . --score-cap 60
```

## Configuration

Create an `fta.json` in your project root for custom configuration:

```json
{
  "threshold": 60,
  "excludePatterns": ["**/*.test.ts", "**/*.spec.ts"],
  "includePaths": ["src/"],
  "excludePaths": ["dist/", "node_modules/"]
}
```

## Resources

- [Official Documentation](https://ftaproject.dev/)
- [GitHub Repository](https://github.com/sgb-io/fta)
- [Online Playground](https://ftaproject.dev/playground)
- [Changelog](https://github.com/sgb-io/fta/blob/main/CHANGELOG.md)

## License

FTA is available under the MIT License.
