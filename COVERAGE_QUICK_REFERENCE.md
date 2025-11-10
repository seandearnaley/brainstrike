# Quick Reference: Test Coverage Gaps

## Priority 1: CRITICAL (Fix First)
Package improvements will have the highest impact on system reliability.

| Package | Coverage | Dependents | Issue | Files to Fix |
|---------|----------|-----------|-------|--------------|
| **queue** | 28.6% | 6 | No tests for core adapters | `browser-pqueue.ts`, `browser-workerpool.ts`, `remote-telemetry-sink.ts` |
| **file-system** | 50.0% | 7 | Incomplete electron support | `electron-adapter.ts`, `electron-watchers.ts` |
| **storage** | 50.0% | 6 | Missing persistence tests | `electron-storage-adapter.ts` |
| **types** | 25.0% | 14 | Minimal validation | `embedding-constants.ts`, `errors.ts` |

## Priority 2: HIGH IMPACT (Fix Next)
Will improve UI/UX reliability and developer confidence.

| Package | Coverage | Dependents | Issue | 
|---------|----------|-----------|-------|
| **vector-management** | 52.9% | 2 | Missing component tests | 8 components, 2 hooks |
| **ui** | 61.5% | 7 | Low component coverage | 64 source files |
| **db-explorer** | 46.0% | 1 | Incomplete UI/service tests | 49 source files |

## Priority 3: INFRASTRUCTURE (Nice to Have)
Lower impact but should eventually reach 70%+.

| Package | Coverage | Issue |
|---------|----------|-------|
| queue-telemetry-collector | 33.3% | No tests |
| build-utils | 33.3% | 1 test only |
| server-config | 50.0% | Incomplete |

## Positive Examples (70%+ Coverage)
These packages demonstrate good testing patterns:
- **db**: 102.4% (43 tests) - Use as model for service testing
- **embeddings**: 100.0% (20 tests) - Good integration test patterns
- **file-explorer**: 100.0% (20 tests) - Zustand store testing reference
- **utils**: 92.9% (26 tests) - Pure function testing examples

## Metrics Summary
- Total Packages: 28
- Packages <50% coverage: 9
- Packages 50-70% coverage: 5
- Packages >70% coverage: 14
- Average coverage: 65.7%
- Target: 70% minimum per package

