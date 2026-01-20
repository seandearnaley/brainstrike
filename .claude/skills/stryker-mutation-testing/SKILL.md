---
name: stryker-mutation-testing
description: Guide for setting up and using Stryker mutation testing. Use when discussing mutation testing, mutants, mutation score, test quality assessment, or Stryker configuration. Covers installation, configuration, interpreting results, and improving mutation scores.
---

# Stryker Mutation Testing

## Purpose

Mutation testing evaluates test suite quality by introducing small changes (mutations) to source code and checking if tests detect them. Stryker is the leading mutation testing framework for JavaScript/TypeScript.

## When to Use

- Setting up mutation testing in a new or existing project
- Configuring Stryker for TypeScript with Vitest, Jest, or Mocha
- Interpreting mutation testing results
- Improving mutation scores
- Understanding mutant survival patterns
- CI/CD integration for mutation testing

---

## Quick Start

### Installation

```bash
# For pnpm monorepos with Vitest
pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner @stryker-mutator/typescript-checker

# For npm projects with Jest
npm install -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker
```

### Basic Configuration

Create `stryker.config.js` in your package root:

```javascript
// @ts-check
const config = {
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.mutation.config.ts', // Separate config for mutation runs
  },
  checkers: ['typescript'],
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**'
  ],
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text', 'progress'],
  timeoutMS: 60_000,
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: 50, // Fail if score drops below this
  },
  ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**', 'reports/**'],
  tsconfigFile: 'tsconfig.json',
};

module.exports = config;
```

### Running Stryker

```bash
# Run mutation testing
npx stryker run

# Initialize a new config (interactive)
npx stryker init
```

---

## Key Concepts

### Mutation Score

```
Mutation Score = (Killed Mutants / Total Mutants) × 100%
```

- **Killed**: Test failed when mutant was introduced (good)
- **Survived**: Tests still passed despite mutation (indicates weak test)
- **No Coverage**: Mutant wasn't covered by any test
- **Timeout**: Test took too long (usually counts as killed)
- **Runtime Error**: Mutant caused a crash (usually counts as killed)

### Mutation Operators

Stryker applies various mutation operators:

| Operator | Example | Mutation |
|----------|---------|----------|
| Arithmetic | `a + b` | `a - b` |
| Comparison | `a > b` | `a >= b`, `a < b` |
| Logical | `a && b` | `a \|\| b` |
| Boolean | `true` | `false` |
| String | `"hello"` | `""` |
| Array | `[1, 2]` | `[]` |
| Block | `if (x) { ... }` | `if (x) {}` |
| Conditional | `x ? a : b` | `x ? b : a` |

---

## Configuration Options

### Coverage Analysis Modes

```javascript
// Options: 'off', 'all', 'perTest'
coverageAnalysis: 'perTest', // Best for performance
```

- **off**: Run all tests for every mutant (slowest)
- **all**: Only run tests that cover mutated file
- **perTest**: Only run tests that cover the specific mutated code (fastest)

### Incremental Mode

Speed up subsequent runs by only testing changed code:

```javascript
incremental: true,
incrementalFile: '.stryker-incremental.json',
```

### Concurrency

```javascript
concurrency: 4, // Number of parallel test runners
```

### Targeted Mutation

Focus on specific files or patterns:

```javascript
mutate: [
  'src/core/**/*.ts',     // Only mutate core module
  '!src/**/*.d.ts',       // Exclude type definitions
],
```

---

## Vitest-Specific Configuration

Create a separate `vitest.mutation.config.ts` to exclude flaky or slow tests:

```typescript
import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [
        '**/node_modules/**',
        '**/integration/**',  // Exclude integration tests
        '**/*.e2e.test.ts',   // Exclude e2e tests
      ],
      coverage: {
        enabled: false, // Disable coverage during mutation testing
      },
    },
  })
);
```

---

## Interpreting Results

### HTML Report

The HTML report shows:
- Overall mutation score
- Per-file breakdown
- Survived mutants with exact code changes
- Source code with mutation indicators

### Common Survival Patterns

**1. Missing edge case tests**
```typescript
// Mutation: x > 0 → x >= 0
function isPositive(x: number): boolean {
  return x > 0;  // Need test for x === 0
}
```

**2. Untested branches**
```typescript
// Mutation: removes else block entirely
if (condition) {
  doA();
} else {
  doB();  // Survives if no test covers this branch
}
```

**3. Weak assertions**
```typescript
// Test only checks function runs, not output
expect(() => processData(input)).not.toThrow();
// Better: expect(processData(input)).toEqual(expected);
```

---

## Improving Mutation Score

### Strategy 1: Target Survivors

Focus on killing survived mutants rather than achieving arbitrary scores:

```bash
# Open HTML report to find survivors
open reports/mutation/index.html
```

### Strategy 2: Add Boundary Tests

```typescript
// For function with x > 0, add:
it('returns false for zero', () => {
  expect(isPositive(0)).toBe(false);
});
```

### Strategy 3: Strengthen Assertions

```typescript
// Weak
expect(result).toBeTruthy();

// Strong
expect(result).toEqual({ status: 'success', count: 5 });
```

### Strategy 4: Test Error Paths

```typescript
it('throws on invalid input', () => {
  expect(() => parse(null)).toThrow('Invalid input');
});
```

---

## CI/CD Integration

### GitHub Actions

```yaml
- name: Run Mutation Tests
  run: pnpm stryker run
  continue-on-error: true  # Don't fail build on mutation score

- name: Upload Mutation Report
  uses: actions/upload-artifact@v4
  with:
    name: mutation-report
    path: reports/mutation/
```

### Break on Low Score

```javascript
thresholds: {
  break: 50, // CI fails if score drops below 50%
},
```

---

## Performance Tips

1. **Use perTest coverage analysis** - Only runs relevant tests per mutant
2. **Enable incremental mode** - Caches results between runs
3. **Use TypeScript checker** - Skips invalid mutants that break types
4. **Exclude slow tests** - Use separate vitest.mutation.config.ts
5. **Run on CI only** - Full mutation testing is resource-intensive
6. **Target specific files** - Don't mutate the entire codebase at once

---

## Troubleshooting

### "No tests executed"

- Check that `vitest.mutation.config.ts` includes the right test files
- Verify `coverageAnalysis` is set correctly

### Slow Performance

- Reduce `concurrency` if running out of memory
- Use `mutate` patterns to focus on changed files
- Enable `incremental: true`

### TypeScript Errors

- Ensure `tsconfigFile` points to the correct config
- Add `@stryker-mutator/typescript-checker` plugin

### Flaky Results

- Exclude integration/e2e tests from mutation runs
- Increase `timeoutMS` for slow tests
- Use `disableBail: true` in vitest config

---

## Reference Links

- [Stryker Mutator Docs](https://stryker-mutator.io/docs/)
- [Vitest Runner Docs](https://stryker-mutator.io/docs/stryker-js/vitest-runner)
- [Mutation Testing Theory](https://stryker-mutator.io/docs/mutation-testing-elements/what-is-mutation-testing/)
