# Performance Testing with Playwright

This document outlines the comprehensive performance testing strategy for BrainStrike, designed to measure improvements and catch regressions in the file explorer and tree rendering components.

## Overview

The performance testing suite includes:

- **Tree Rendering Performance**: Measures load times, expansion speed, and scroll performance
- **Memory Usage Monitoring**: Tracks memory consumption and leak detection
- **Benchmark Tests**: Establishes baselines and regression detection
- **CI Integration**: Automated performance monitoring in GitHub Actions

## Test Files

### Core Test Suites

Located in `apps/web/e2e/performance/`:

1. **`benchmarks.test.ts`** - Main benchmark suite with thresholds
2. **`memory-usage.test.ts`** - Memory leak and usage tests  
3. **`tree-rendering.test.ts`** - Tree-specific performance tests
4. **`regression.test.ts`** - Performance regression detection
5. **`validation.test.ts`** - Simple validation tests

### Test Organization Benefits

- **Cleaner Directory Structure**: Performance tests are organized in dedicated subdirectory
- **Project Separation**: Playwright projects allow running performance tests independently
- **Optimized Timeouts**: Performance tests have longer timeouts (2 minutes vs 1 minute)
- **Fewer Retries**: Performance tests retry less to avoid skewing measurements
- **Shared Utilities**: Common performance testing code is extracted to reusable helpers

### Utilities

- **`utils/performance-helpers.ts`** - General performance utilities for all tests
- **`utils/performance-test-helpers.ts`** - Performance-specific test utilities
- **`scripts/run-performance-tests.sh`** - CLI tool for running tests

## Performance Thresholds

Current performance thresholds (adjust based on your baseline):

```typescript
const PERFORMANCE_THRESHOLDS = {
  TREE_LOAD_MAX_MS: 3000,        // Tree initial load
  TREE_EXPANSION_MAX_MS: 1500,   // Expanding folders  
  FILE_SELECTION_MAX_MS: 800,    // Selecting files
  SCROLL_PERFORMANCE_MAX_MS: 500, // Scrolling large trees
  MEMORY_INCREASE_MAX_MB: 15,     // Memory usage limit
  RENDER_TIME_MAX_MS: 100,        // Component render time
};
```

## Running Performance Tests

### Local Development

```bash
# Run all performance tests
./scripts/run-performance-tests.sh run all

# Run specific test types
./scripts/run-performance-tests.sh run baseline
./scripts/run-performance-tests.sh run memory
./scripts/run-performance-tests.sh run tree

# Establish baseline (run this after fixing performance issues)
./scripts/run-performance-tests.sh baseline

# Compare with baseline
./scripts/run-performance-tests.sh compare

# View latest results
./scripts/run-performance-tests.sh results
```

### Manual Playwright Commands

```bash
cd apps/web

# Run all performance tests (organized in performance/ directory)
pnpm exec playwright test --project=performance

# Run all functional tests (excluding performance tests)
pnpm exec playwright test --project=functional

# Run specific performance test files
pnpm exec playwright test performance/benchmarks.test.ts
pnpm exec playwright test performance/memory-usage.test.ts
pnpm exec playwright test performance/tree-rendering.test.ts

# Run with headed browser for debugging
pnpm exec playwright test performance/benchmarks.test.ts --headed

# Run with debug mode
pnpm exec playwright test performance/benchmarks.test.ts --debug

# Run performance tests with full browser coverage
PLAYWRIGHT_FULL_BROWSER_COVERAGE=true pnpm exec playwright test --project=performance
```

## CI Integration

### GitHub Actions Workflow

The `.github/workflows/performance-monitoring.yml` workflow:

- **Triggers**: Push to main, PRs, daily scheduled runs
- **Baseline Management**: Maintains baseline metrics on main branch
- **PR Comments**: Automatically comments performance results on PRs
- **Artifact Storage**: Saves metrics for historical tracking
- **Threshold Enforcement**: Fails builds if thresholds are exceeded

### Workflow Features

1. **Baseline Comparison**: Compares PR performance against main branch
2. **Regression Detection**: Identifies performance regressions automatically  
3. **Historical Tracking**: Stores metrics as artifacts
4. **PR Feedback**: Provides detailed performance reports in PR comments

## Metrics Collected

### Tree Rendering Metrics

- **Tree Load Time**: Time to initially load and render file tree
- **Tree Expansion Time**: Time to expand multiple folders
- **File Selection Time**: Time to select multiple files
- **Scroll Performance**: Scrolling responsiveness with large trees

### Memory Metrics

- **Memory Usage**: JavaScript heap size during operations
- **Memory Growth**: Memory increase during file loading
- **Memory Cleanup**: Memory reduction after deselecting files
- **Memory Stability**: Consistency across rapid operations

### Render Metrics

- **Render Count**: Number of component re-renders
- **Average Render Time**: Mean time per render
- **Max Render Time**: Worst-case render performance

## Best Practices

### Writing Performance Tests

1. **Use Realistic Data**: Create file trees similar to real-world usage
2. **Measure What Matters**: Focus on user-perceived performance
3. **Isolate Variables**: Test one performance aspect per test
4. **Clean State**: Reset between tests to avoid interference
5. **Reasonable Thresholds**: Set achievable but meaningful limits

### Debugging Performance Issues

1. **Use Browser DevTools**: Enable `--headed` mode for manual inspection
2. **Check Memory Tab**: Monitor heap usage during tests
3. **Profile Renders**: Use React DevTools Profiler
4. **Analyze Metrics**: Look for patterns in saved metrics files

### Updating Baselines

Update baselines when:

- You've made intentional performance improvements
- Infrastructure changes affect measurement consistency  
- Test changes require new baseline metrics

```bash
# After fixing performance issues
./scripts/run-performance-tests.sh run all
./scripts/run-performance-tests.sh baseline
```

## File Locations

```
apps/web/
├── e2e/
│   ├── performance/                        # Performance tests directory
│   │   ├── benchmarks.test.ts             # Main benchmark tests
│   │   ├── memory-usage.test.ts           # Memory monitoring
│   │   ├── tree-rendering.test.ts         # Tree performance
│   │   ├── regression.test.ts             # Regression detection
│   │   └── validation.test.ts             # Simple validation tests
│   └── utils/
│       ├── performance-helpers.ts          # Shared utilities
│       └── performance-test-helpers.ts     # Performance-specific utilities
├── performance-metrics/                    # Generated metrics
│   ├── baseline.json                      # Baseline measurements
│   ├── consolidated-metrics.json          # Latest results
│   └── metrics-*.json                     # Individual test runs
└── playwright.config.ts                   # Playwright configuration

scripts/
└── run-performance-tests.sh               # CLI testing tool

.github/workflows/
└── performance-monitoring.yml             # CI automation
```

## Troubleshooting

### Common Issues

1. **Tests Timeout**: Increase timeouts in `playwright.config.ts`
2. **Memory Tests Fail**: May need to adjust thresholds for CI environment
3. **Flaky Results**: Add stabilization waits or increase overscan values
4. **Missing Metrics**: Check console output for collection errors

### Environment Differences

- **CI vs Local**: CI may have different performance characteristics
- **Browser Versions**: Performance can vary between Playwright browser versions
- **System Resources**: Adjust thresholds based on available memory/CPU

### Debug Commands

```bash
# View detailed test output
DEBUG=pw:test pnpm exec playwright test performance-benchmarks.test.ts

# Run single test with full output  
pnpm exec playwright test performance-benchmarks.test.ts -g "baseline performance"

# Generate trace files for analysis
pnpm exec playwright test performance-benchmarks.test.ts --trace on
```

## Contributing

When adding new performance tests:

1. Follow existing patterns in `performance-helpers.ts`
2. Use meaningful metric names and appropriate thresholds
3. Include both positive and negative test scenarios
4. Update this documentation with new metrics
5. Test locally before submitting PRs

## Related Issues

The performance testing suite is designed to track improvements for the identified performance issues:

- **Memory Leaks**: File contents accumulating without cleanup
- **Excessive Re-renders**: Missing shallow comparisons in Zustand
- **Tree Rendering**: Optimization of virtualized tree components
- **File Loading**: Monitoring file content loading performance