# Code Analysis with Nocuous

## Overview

Nocuous is a static code analysis tool for JavaScript and TypeScript that helps identify code complexity and potential maintainability issues. This document explains how to use nocuous with our codebase and interpret its results.

## Installation

1. First, ensure you have Deno installed. If not, follow the [Deno installation guide](https://docs.deno.com/runtime/getting_started/installation/).

2. Install nocuous using Deno:
```bash
deno install --name nocuous --allow-read --allow-net -f jsr:@higher-order-testing/nocuous/cli --global
```

3. Add Deno's bin directory to your PATH if prompted:
```bash
export PATH="$HOME/.deno/bin:$PATH"
```

## Usage

### Basic Analysis

To analyze a single file:
```bash
NO_COLOR=1 nocuous stat src/path/to/file.tsx | grep -v "Analyzing\.\.\." | grep -v "⠋\|⠙\|⠹\|⠸\|✔"
```

To analyze an entire directory:
```bash
NO_COLOR=1 nocuous stat src | grep -v "Analyzing\.\.\." | grep -v "⠋\|⠙\|⠹\|⠸\|✔"
```

Note: We use `NO_COLOR=1` and grep filters to produce clean, uncolored output without progress indicators.

### Command Line Options

- `stat <source>`: Analyze source outputting code toxicity stats
- `-h, --help`: Show help information

## Understanding the Metrics

Nocuous provides several metrics based on Erik Dörnenburg's article ["How toxic is your code?"](https://erik.doernenburg.com/2008/11/how-toxic-is-your-code/). Here's what each metric means:

### Score Metrics

| Metric | Name | Description | Good Range |
|--------|------|-------------|------------|
| Score | Overall Toxicity | Combined score of all metrics | < 5.0 |
| AIL | Average Indentation Level | Measures code nesting depth | < 3.0 |
| BEC | Binary Expression Complexity | Measures complexity of boolean expressions | < 2.0 |
| CDAC | Class Data Abstraction Coupling | Measures coupling between classes | < 3.0 |
| CC | Cyclomatic Complexity | Measures number of code paths | < 2.0 |
| L | Lines | Number of lines in the analyzed scope | Context dependent |
| FL | File Length | Total file length | < 500 lines |
| MSD | Method State Dependency | Measures state dependencies in methods | < 4.0 |
| P | Parameters | Number of parameters | < 4 |

### Interpreting Results

The output shows three rows:
1. Score row: Shows the calculated values for each metric
2. Counts row: Shows the number of occurrences for each metric
3. Total row: Shows the total/average values

Example output:
```
┌────────┬───────┬──────┬──────┬──────┬──────┬───┬────┬─────┬───┐
│ Path   │ Score │ AIL  │ BEC  │ CDAC │ CC   │ L │ FL │ MSD │ P │
└────────┴───────┴──────┴──────┴──────┴──────┴───┴────┴─────┴───┘
           8.16    5.86   1.00          1.30                     
  Counts           1      5             8      1              1  
  Total            5.86   1.00          1.30                     
```

### Guidelines for Our Codebase

When working on our codebase:

1. **New Code**
   - Aim for a total score < 5.0 for new components
   - Keep AIL < 3.0 by extracting nested logic into separate functions
   - Break down complex boolean expressions (high BEC) into named variables

2. **Refactoring Targets**
   - Files with Score > 8.0 should be candidates for refactoring
   - High AIL (> 4.0) suggests need for logic extraction
   - High BEC (> 3.0) suggests need for boolean logic simplification

3. **Best Practices**
   - Extract complex conditions into well-named functions
   - Use custom hooks to separate concerns
   - Keep components focused and single-purpose
   - Consider splitting files when FL approaches 500 lines

## Examples

Here are some real examples from our codebase:

### Good Example (useFileLoadingManager.ts)
```
Score: 1.03
AIL: 1.03
CC: (present but low)
```
This hook shows good separation of concerns and clean structure.

### Needs Improvement (FileTreeNode.tsx)
```
Score: 11.84
AIL: 5.74
BEC: 5.00
CC: 1.10
```
This component could benefit from:
- Extracting nested logic to reduce AIL
- Simplifying boolean expressions to reduce BEC
- Breaking down into smaller subcomponents

## Integration with Development Workflow

1. **Before Committing**
   - Run nocuous analysis on changed files
   - Address any metrics that exceed guidelines
   - Document any necessary exceptions

2. **Code Review**
   - Include nocuous scores in PR descriptions
   - Flag significant increases in toxicity scores
   - Suggest refactoring strategies based on metrics

3. **Continuous Improvement**
   - Regularly analyze the entire codebase
   - Track toxicity trends over time
   - Prioritize refactoring based on highest scores
