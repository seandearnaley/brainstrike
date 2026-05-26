---
title: Mutation Testing
sidebar_position: 8
---

# Mutation Testing with Stryker

This document outlines how to set up and use mutation testing in the brainstrike monorepo using [Stryker](https://stryker-mutator.io/), a powerful mutation testing framework for TypeScript and JavaScript.

## What is Mutation Testing?

Mutation testing evaluates the quality of your test suite by introducing small changes (mutations) to your code and checking if your tests can detect them. This helps identify:

- **Weak tests** that don't properly validate your code
- **Untested edge cases** in your business logic
- **Redundant tests** that don't add value
- **Dead code** that can be safely removed

## How It Works

1. **Stryker creates mutants** by modifying your source code (e.g., changing `+` to `-`, `&&` to `||`)
2. **Runs your test suite** against each mutant
3. **"Kills" mutants** when tests fail (good!)
4. **Reports "survivors"** when tests still pass (indicates weak testing)
5. **Generates a mutation score** showing the percentage of killed mutants

## Setup in Monorepo

### 1. Turborepo Configuration

The `mutation` task is already configured in `turbo.jsonc`:

```json
{
  "mutation": {
    "dependsOn": ["build"],
    "outputs": ["reports/mutation/**"],
    "cache": false,
    "outputLogs": "full"
  }
}
```

### 2. Package Configuration

To add mutation testing to a package, follow these steps:

#### Install Dependencies

Add these dev dependencies to your package:

```json
{
  "devDependencies": {
    "@stryker-mutator/core": "^9.0.1",
    "@stryker-mutator/vitest-runner": "^9.0.1",
    "@stryker-mutator/typescript-checker": "^9.0.1"
  }
}
```

#### Add Script

Add the mutation script to your `package.json`:

```json
{
  "scripts": {
    "mutation": "stryker run"
  }
}
```

#### Create Stryker Config

Create a `stryker.config.ts` file in your package root:

```typescript
// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    // Root config aggregates all projects
    configFile: 'vitest.config.mts'
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
  timeoutMS: 60000,
  htmlReporter: {
    baseDir: 'reports/mutation/PACKAGE_NAME'
  },
  thresholds: {
    high: 80,
    low: 60,
    break: 50
  },
  ignorePatterns: [
    'dist/**',
    'node_modules/**',
    'coverage/**',
    'reports/**'
  ],
  tsconfigFile: 'tsconfig.json'
};

export default config;
```

**Note:** Replace `PACKAGE_NAME` with your actual package name (e.g., `utils`, `hooks`, etc.).

## Usage

### Running Mutation Tests

#### Single Package
```bash
# Run mutation testing for a specific package
cd packages/utils
pnpm run mutation

# Or using Turborepo filter
pnpm turbo run mutation --filter=@brainstrike/utils
```

#### All Packages
```bash
# Run mutation testing for all packages that have it configured
pnpm turbo run mutation
```

#### With Parallel Execution
```bash
# Run with specific concurrency
pnpm turbo run mutation --concurrency=4
```

### Interpreting Results

After running mutation tests, you'll get:

1. **Terminal output** with a summary
2. **HTML report** in `reports/mutation/PACKAGE_NAME/`
3. **Mutation score** (percentage of killed mutants)

#### Mutation Score Guidelines

- **90-100%**: Excellent test coverage
- **80-89%**: Good test coverage  
- **60-79%**: Acceptable but could be improved
- **Below 60%**: Poor test coverage, needs attention

#### Reading the HTML Report

The HTML report shows:

- **File-by-file breakdown** of mutation scores
- **Specific mutants** and whether they were killed
- **Code diff** showing what was changed
- **Test results** for each mutant

## Best Practices

### 1. Start Small
Begin with a single package that has good unit tests:
```bash
npx turbo run mutation --filter=@brainstrike/utils
```

### 2. Set Realistic Thresholds
Don't aim for 100% immediately. Start with achievable goals:

```typescript
thresholds: {
  high: 70,    // Start lower
  low: 50,     // Gradually increase
  break: 40    // Don't break CI initially
}
```

### 3. Focus on Critical Code
Use the `mutate` pattern to focus on business logic:

```typescript
mutate: [
  'src/core/**/*.ts',           // Focus on core business logic
  'src/utils/**/*.ts',          // Include utilities
  '!src/utils/constants.ts',    // Exclude constants
  '!src/**/*.test.ts'           // Always exclude tests
]
```

### 4. Exclude Appropriate Files
Don't mutate:
- Test files
- Mock files  
- Configuration files
- Generated code
- Pure type definitions

### 5. Use TypeScript Checker
The TypeScript checker skips mutants that would cause compile errors:

```typescript
checkers: ['typescript']
```

### 6. Handle Slow Tests
For packages with slow tests, increase timeout:

```typescript
timeoutMS: 120000  // 2 minutes
```

### 7. Disable Specific Mutations
If certain mutations aren't valuable, disable them:

```typescript
// In your source code
function criticalFunction() {
  // Stryker disable next-line StringLiteral
  return "CRITICAL_CONSTANT";
}
```

## CI Integration

### Don't Run in Standard CI
Mutation testing is computationally expensive. Don't include it in your regular CI pipeline.

### Optional CI Jobs
Create separate CI jobs for mutation testing:

```yaml
# .github/workflows/mutation-testing.yml
name: Mutation Testing
on:
  workflow_dispatch:  # Manual trigger only
  schedule:
    - cron: '0 2 * * 0'  # Weekly at 2 AM Sunday

jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Install dependencies
        run: pnpm install
      - name: Run mutation tests
        run: npx turbo run mutation
```

## Troubleshooting

### Common Issues

#### 1. "Cannot find module" Errors
Ensure your Vitest config includes proper path resolution:

```typescript
// vitest.config.mts
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
```

#### 2. Memory Issues
For large codebases, you might need to:

```typescript
// Reduce concurrency
maxConcurrentTestRunners: 2,

// Or increase Node.js memory
// In package.json script:
"mutation": "node --max-old-space-size=4096 node_modules/.bin/stryker run"
```

#### 3. TypeScript Compilation Errors
If using complex TypeScript features:

```typescript
tsconfigFile: 'tsconfig.json',
typescriptChecker: {
  prioritizePerformanceOverAccuracy: false
}
```

### Performance Tips

1. **Use `perTest` coverage analysis** (already configured)
2. **Limit mutated files** to critical business logic
3. **Run on powerful machines** or CI with more resources
4. **Consider incremental mode** for large codebases

## Example Output

```
✅ Mutation testing complete!

📊 Mutation score: 85.2% (92/108 mutants killed)
🎯 Thresholds: high: 80% | low: 60% | break: 50%

📁 Results: reports/mutation/utils/index.html
```

## Integration with Development Workflow

### Pre-commit Hook (Optional)
For critical packages, consider a pre-commit hook:

```json
{
  "husky": {
    "hooks": {
      "pre-push": "npx turbo run mutation --filter=@brainstrike/core"
    }
  }
}
```

### Code Review Process
1. **Regular tests** should pass before mutation testing
2. **Mutation testing** helps identify gaps during code review
3. **Mutation reports** can guide discussion about test quality

## Further Reading

- [Stryker Documentation](https://stryker-mutator.io/docs/)
- [Mutation Testing Handbook](https://github.com/stryker-mutator/stryker-handbook)
- [Vitest Runner Documentation](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)
- [TypeScript Checker Documentation](https://stryker-mutator.io/docs/stryker-js/typescript-checker/) 
