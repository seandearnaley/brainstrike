---
title: Performance Testing
sidebar_position: 9
---

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

- **Cleaner Directory Structure**: Performance tests are organized in a dedicated subdirectory
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

Performance tests are isolated from functional E2E tests to speed up development and CI workflows. By default, `pnpm check` and CI runs exclude performance tests.

### Quick Commands

```bash
# Run functional E2E tests only (default for pnpm check and CI)
pnpm test:e2e:functional

# Run performance tests on demand
pnpm test:e2e:perf

# Run all E2E tests (functional + performance)
pnpm test:e2e:full-browsers
```

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

# Run performance tests only (isolated from functional tests)
pnpm exec playwright test --project=performance

# Run functional tests only (default behavior)
pnpm exec playwright test --project=functional

# Run specific performance test files
pnpm exec playwright test performance/benchmarks.test.ts
pnpm exec playwright test performance/memory-usage.test.ts
pnpm exec playwright test performance/tree-rendering.test.ts
pnpm exec playwright test performance/real-world-performance.test.ts
pnpm exec playwright test performance/memory-profiling-test.test.ts

# Run with headed browser for debugging
pnpm exec playwright test performance/benchmarks.test.ts --headed

# Run with debug mode
pnpm exec playwright test performance/benchmarks.test.ts --debug

# Run performance tests with full browser coverage
PLAYWRIGHT_FULL_BROWSER_COVERAGE=true pnpm exec playwright test --project=performance
```

## CI Integration

### Functional vs Performance Test Separation

**Default CI Behavior (Fast):**
- Regular PR builds run only functional E2E tests (`--project=functional`)
- Performance tests are excluded to speed up CI and reduce resource usage
- E2E tests are sharded across 4 parallel jobs for faster execution

**Performance Test Execution:**
- **Scheduled**: Daily at 07:23 UTC via `.github/workflows/performance.yml`
- **On-Demand**: Manual workflow dispatch in GitHub Actions
- **PR Labels**: Add `run-perf` or `run-performance-tests` label to any PR to trigger performance tests

### GitHub Actions Workflows

**Main Test Workflow (`.github/workflows/test.yml`):**
- Runs functional E2E tests only by default
- Uses 4-way sharding for faster execution
- Excludes performance tests to maintain fast feedback loops

**Performance Workflow (`.github/workflows/performance.yml`):**
- **Triggers**: 
  - Daily scheduled runs (cron: '23 7 * * *')
  - Manual workflow dispatch with optional project/grep filters
  - Pull requests with `run-perf` or `run-performance-tests` labels
- **Features**:
  - Runs isolated performance test suite
  - Supports custom project selection (default: 'performance')
  - Optional test filtering via grep pattern
  - Saves performance artifacts for 7 days
### How to Run Performance Tests on PRs

1. **Add Label Method**: Add the `run-perf` or `run-performance-tests` label to your PR
2. **Manual Trigger**: Go to Actions → "Performance E2E" → "Run workflow" and select your branch
3. **Custom Filtering**: Use workflow dispatch with grep patterns to run specific tests

### Performance Test Organization

All performance tests are located in `apps/web/e2e/performance/`:
- `benchmarks.test.ts` - Main benchmark suite with thresholds
- `memory-usage.test.ts` - Memory leak and usage tests  
- `tree-rendering.test.ts` - Tree-specific performance tests
- `regression.test.ts` - Performance regression detection
- `validation.test.ts` - Simple validation tests
- `real-world-performance.test.ts` - Real-world performance validation
- `memory-profiling-test.test.ts` - Comprehensive memory profiling

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

## Performance Regression Detection

### Baseline Establishment
Performance baselines should be established after major changes and updated when intentional performance improvements are made:

```bash
# Establish new baseline after performance improvements
./scripts/run-performance-tests.sh run all
./scripts/run-performance-tests.sh baseline

# Compare current performance against baseline
./scripts/run-performance-tests.sh compare
```

### Automated Performance Alerts
The CI system includes automated performance monitoring:

- **Regression Detection**: Tests fail if performance degrades beyond established thresholds
- **Performance Trends**: Track performance metrics over time in CI artifacts
- **Bundle Size Monitoring**: Monitor JavaScript bundle size changes with size-limit integration
- **Memory Leak Detection**: Automated memory usage monitoring with configurable thresholds

### Bundle Size Monitoring
Monitor JavaScript bundle size impact across packages:

```bash
# Check bundle size impact for specific packages
pnpm --filter @brainstrike/app-shell exec size-limit
pnpm --filter @brainstrike/file-explorer-ui exec size-limit

# Compare bundle sizes before/after changes
pnpm exec size-limit --compare
```

### Performance Regression Workflow
1. **Detect Regression**: CI alerts when performance thresholds are exceeded
2. **Investigate**: Use browser DevTools and performance profiling to identify bottlenecks
3. **Fix Issues**: Address root causes rather than adjusting thresholds
4. **Update Baseline**: Re-establish baseline after legitimate performance improvements
5. **Document Changes**: Update performance documentation with new thresholds or patterns

## Best Practices

### Writing Performance Tests

1. **Use Realistic Data**: Create file trees similar to real-world usage
2. **Measure What Matters**: Focus on user-perceived performance
3. **Isolate Variables**: Test one performance aspect per test
4. **Clean State**: Reset between tests to avoid interference
5. **Reasonable Thresholds**: Set achievable but meaningful limits
6. **Regression Prevention**: Design tests to catch performance regressions early

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
└── performance.yml                       # CI automation
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
DEBUG=pw:test pnpm exec playwright test performance/benchmarks.test.ts

# Run single test with full output  
pnpm exec playwright test performance/benchmarks.test.ts -g "baseline performance"

# Generate trace files for analysis
pnpm exec playwright test performance/benchmarks.test.ts --trace on
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
- **File Loading**: Monitoring file content loading performance regressions.
