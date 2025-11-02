# Vitest 4 Browser Mode Research & Investigation

**Date:** November 2, 2025  
**Status:** Research Spike  
**Related Issue:** BrainStrike Testing Infrastructure

## Executive Summary

Vitest 4.0 introduces a stable **Browser Mode** that enables tests to run in real browser environments rather than simulated environments (jsdom/Happy DOM). This research document explores how Browser Mode addresses current testing limitations in BrainStrike, particularly around WebAssembly (WASM) and IndexedDB support, which are critical for PGlite database testing.

## Current Testing Limitations

### JSDOM and Happy DOM Constraints

The current testing setup in BrainStrike uses jsdom/Happy DOM environments, which have fundamental limitations:

1. **WASM Support:** Incomplete or missing WebAssembly support, affecting libraries that rely on WASM binaries (e.g., PGlite, certain embedding models)
2. **IndexedDB:** Limited or no support for IndexedDB operations, requiring workarounds or mocking
3. **Performance:** Simulated DOM operations are inherently slower than real browser implementations
4. **API Gaps:** Many modern Web APIs are not available or incompletely implemented in simulated environments
5. **Current Workarounds:** BrainStrike currently disables/mocks tests that require full WASM or IndexedDB support, reducing test coverage

### Impact on BrainStrike

- **PGlite Testing:** Cannot properly test SQLite-in-browser functionality due to WASM limitations
- **Embedding Queue:** Cannot fully test queue persistence and retrieval operations that depend on IndexedDB
- **Test Coverage:** Must exclude or heavily mock critical functionality, creating technical debt
- **Confidence:** Tests don't reflect actual runtime behavior in real browsers

## Vitest 4 Browser Mode: Solution Overview

### What is Browser Mode?

Vitest 4 Browser Mode allows tests to execute in actual browser environments (Chromium, Firefox, WebKit) using browser automation providers like Playwright or WebdriverIO. This provides:

- **Real Browser APIs:** Full access to native `window`, `document`, `localStorage`, `IndexedDB`, `Web Workers`, `WASM`, etc.
- **Accurate Testing:** Tests execute in the exact environment where the application runs
- **Feature Parity:** No feature gaps or API limitations compared to production
- **Debugging:** Full browser DevTools integration for inspection and troubleshooting

### Key Features of Vitest 4 Browser Mode

#### 1. **Multiple Browser Provider Options**

- **Playwright Provider:** Supports Chromium, Firefox, WebKit
  - Best-in-class for parallel test execution
  - Integrated with Chrome DevTools Protocol
  - Excellent trace and debugging support
  
- **WebdriverIO Provider:** Supports Chrome, Firefox, Edge, Safari
  - Cross-browser coverage including Safari
  - WebDriver protocol support
  
- **Preview Provider:** Uses Vite's built-in dev server
  - No external dependencies required
  - Lightweight option for development

#### 2. **Headless and Headed Modes**

- **Headless Mode (CI):** Tests run without UI; optimized for continuous integration
- **Headed Mode (Local):** Visual browser window for interactive debugging
- **Automatic Selection:** Headless by default in CI, headed for local development

#### 3. **Visual Regression Testing**

- **Screenshot Comparison:** Capture and compare UI screenshots across test runs
- **Diffing:** Automated visual diffing to detect unintended UI changes
- **Baseline Management:** Maintain golden images for consistent UI testing

#### 4. **Advanced Debugging**

- **Playwright Traces:** Generate detailed trace files viewable in Playwright Trace Viewer
- **Browser DevTools:** Full access to DevTools for inspection during tests
- **Video Recording:** Optional test video recording for CI analysis

## Installation & Setup

### Package Installation

For the BrainStrike monorepo, the recommended approach is to use Playwright as the provider:

```bash
pnpm install -D @vitest/browser @vitest/browser-playwright
```

**Alternative:** For WebdriverIO provider:
```bash
pnpm install -D @vitest/browser @vitest/browser-webdriver
```

### Configuration

Create or update `vitest.config.ts` in affected packages:

```typescript
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true, // CI defaults to true
      instances: [
        {
          name: 'chromium',
          browser: 'chromium',
          headless: true,
        },
      ],
      // Optional: Configure for specific environments
      // slowHint: 75000,
      // screenshotFailures: true,
      // uploadScreenshots: true, // For CI services
    },
  },
});
```

### Running Browser Tests

```bash
# Run all tests in browser mode
pnpm vitest --browser

# Run specific test file
pnpm vitest --browser path/to/test.spec.ts

# Run with specific browser
pnpm vitest --browser --browser.instances=firefox

# Run in headed mode (with visible browser)
pnpm vitest --browser --browser.headless=false
```

## Migration Strategy for BrainStrike

### Phase 1: Infrastructure Setup
- Install `@vitest/browser` and `@vitest/browser-playwright` packages
- Create browser-specific Vitest configuration
- Set up CI/CD integration for headless testing
- Document setup and troubleshooting guide

### Phase 2: Test Conversion (High Priority)
Begin with tests that are currently disabled/mocked:

1. **PGlite Database Tests** (`packages/db/**/*.test.ts`)
   - Enable PGlite initialization and query tests
   - Remove WASM-related mocks
   - Test actual SQLite operations in IndexedDB

2. **Embedding Queue Tests** (`packages/queue/**/*.test.ts`)
   - Enable IndexedDB persistence tests
   - Test job queueing and retrieval
   - Verify concurrent job processing

3. **Storage Tests** (`packages/storage/**/*.test.ts`)
   - Test localStorage and sessionStorage operations
   - Verify cache operations
   - Test browser storage quota scenarios

### Phase 3: Test Suite Expansion
- Add visual regression tests for critical UI components
- Implement E2E integration tests for workflows
- Add WebWorker tests (especially for embedding workers)
- Test offline functionality with Service Worker integration

### Phase 4: Performance & Optimization
- Benchmark test execution speed (browser mode vs jsdom)
- Optimize parallel execution settings
- Configure test timeouts appropriately
- Set up performance tracking

## Technical Considerations

### 1. **Monorepo Setup Considerations**

For BrainStrike's Turborepo structure:

- **Per-Package Configuration:** Each package can have its own `vitest.config.ts`
- **Shared Configuration:** Consider shared base config in `packages/config`
- **Turbo Integration:** Ensure `pnpm turbo run test --browser` works correctly
- **Cache Management:** Browser mode may interact with Turborepo caching differently

**Recommended Approach:**
```
packages/
├── db/
│   └── vitest.config.ts          # Browser mode for WASM/IndexedDB tests
├── queue/
│   └── vitest.config.ts          # Browser mode for IndexedDB tests
├── storage/
│   └── vitest.config.ts          # Browser mode for storage tests
├── ui/
│   └── vitest.config.ts          # Browser mode for visual regression
└── hooks/
    └── vitest.config.ts          # jsdom for hook logic (no browser APIs needed)
```

### 2. **Mixed Test Environments**

Not all tests need browser mode. Recommended strategy:

- **Browser Mode:** Tests requiring real browser APIs (IndexedDB, WASM, localStorage, Web Workers)
- **jsdom Mode:** Pure logic tests, hooks without browser dependencies, utility functions
- **Explicit Choice:** Use configuration per package or per test file

Example per-file configuration:
```typescript
// test.spec.ts
/// <reference types="vitest" />
import { describe, it, expect, beforeAll } from 'vitest';

// This test runs in browser mode (if enabled in config)
describe('IndexedDB operations', () => {
  // tests
});
```

### 3. **CI/CD Integration**

**GitHub Actions Considerations:**
- Browser binaries must be available (Playwright provides pre-built binaries)
- Headless mode is the default and preferred setting
- Increase CI timeout for browser tests (typically 2-3x slower than jsdom)
- Screenshot/video artifacts for failed tests

**Example CI Configuration:**
```yaml
- name: Install browsers
  run: npx playwright install --with-deps

- name: Run browser tests
  run: pnpm turbo run test --filter ./packages/db --browser
```

### 4. **Performance Implications**

**Comparison: jsdom vs Browser Mode**

| Metric | jsdom | Browser Mode |
|--------|-------|--------------|
| Startup Time | ~500ms | ~2-3s (first run) |
| Per-Test Overhead | ~10-50ms | ~50-200ms |
| Parallel Execution | Good | Excellent (with instances) |
| WASM Support | No | Full |
| IndexedDB Support | No/Mock | Full |
| Real API Access | No | Full |
| Debugging | Limited | Excellent |

**Optimization Strategies:**
- Use browser instance pooling for parallel tests
- Keep browser tests separate from unit tests for faster CI feedback
- Consider test splitting: fast unit tests (jsdom) + comprehensive browser tests

### 5. **Development Workflow Impact**

**Local Development:**
- Headed mode useful for debugging interactive components
- Faster feedback loop with HMR still available
- Can inspect real browser state during tests
- Screenshots available for failed assertions

**Recommendations:**
```bash
# Local development - headed mode for debugging
pnpm dev

# In another terminal - browser tests in headed mode
pnpm vitest --browser --browser.headless=false

# Or for headless mode (faster)
pnpm vitest --browser
```

## Known Limitations & Considerations

### 1. **Platform Support**
- Windows: Full support for all providers
- macOS: Full support for all providers (Intel and Apple Silicon)
- Linux: Requires Xvfb or headless configuration

### 2. **Resource Requirements**
- Browser processes consume more memory than jsdom (~100-200MB per instance)
- Consider resource constraints on CI runners
- May need to adjust parallel instance count for large test suites

### 3. **Test Isolation**
- IndexedDB and localStorage persist between tests (need proper cleanup)
- Service Workers and caches need manual clearing
- Browser state isolation requires careful setup

### 4. **Test Debugging**
- Slower to run (but more accurate)
- Local debugging easier (headed mode)
- CI debugging requires trace files or video artifacts

## Recommended Action Items

### Spike Tasks

1. **Environment Setup** (1-2 days)
   - [ ] Install dependencies
   - [ ] Create test configuration
   - [ ] Verify basic browser test execution
   - [ ] Document setup process

2. **PGlite Test Conversion** (2-3 days)
   - [ ] Convert existing PGlite tests to browser mode
   - [ ] Remove WASM mocks and workarounds
   - [ ] Verify database operations work correctly
   - [ ] Measure performance impact

3. **IndexedDB Tests** (1-2 days)
   - [ ] Convert embedding queue tests
   - [ ] Convert storage tests
   - [ ] Test concurrent operations
   - [ ] Verify data persistence

4. **CI/CD Integration** (1-2 days)
   - [ ] Update GitHub Actions workflow
   - [ ] Install browser binaries in CI
   - [ ] Configure timeout and resource settings
   - [ ] Set up artifact collection for failed tests

5. **Documentation & Decision** (1 day)
   - [ ] Document best practices for browser tests
   - [ ] Create migration guide for team
   - [ ] Make go/no-go decision for full adoption
   - [ ] Plan phased rollout if proceeding

**Estimated Spike Duration:** 1-2 weeks (including risk mitigation)

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Increased CI time | Medium | Parallel execution, selective test runs |
| Resource usage | Medium | Instance pooling, timeout tuning |
| Cross-platform issues | Low | Test on multiple OSes in spike |
| Test reliability | Medium | Proper test isolation, retry logic |
| Knowledge gap | Medium | Team documentation, training |

## Decision Points

### Before Full Adoption, Spike Should Answer:

1. **Feasibility:** Can we successfully run WASM and IndexedDB tests in browser mode?
2. **Performance:** Are CI times acceptable with browser tests?
3. **Effort:** What's the effort to migrate existing test suites?
4. **ROI:** Is the improvement in test coverage/confidence worth the overhead?
5. **Integration:** How well does it integrate with current Turborepo/CI setup?

### Success Criteria:

- [ ] PGlite tests pass without mocking WASM
- [ ] IndexedDB tests pass without storage mocking
- [ ] CI execution time < 2x current time (or < 30% of total CI)
- [ ] No regressions in existing test suites
- [ ] Documentation complete and team trained

## References

### Official Documentation
- [Vitest Browser Mode Guide](https://vitest.dev/guide/browser/)
- [Vitest Browser Configuration](https://vitest.dev/guide/browser/config)
- [Vitest 4.0 Release Notes](https://vitest.dev/blog/vitest-4)
- [Playwright Documentation](https://playwright.dev/)

### Related Technologies
- [PGlite Documentation](https://pglite.io/)
- [IndexedDB MDN Reference](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [WebAssembly (WASM) MDN Guide](https://developer.mozilla.org/en-US/docs/WebAssembly)

### Community Resources
- Vitest GitHub: https://github.com/vitest-dev/vitest
- Playwright GitHub: https://github.com/microsoft/playwright
- Vitest Browser Mode Video: "Vitest - Browser mode with instant feedback like HMR"

## Appendix: Example Test Conversion

### Before (jsdom with mocks)
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('PGlite Database', () => {
  beforeEach(() => {
    // Mock WASM initialization
    vi.mock('pg', () => ({
      __esModule: true,
      default: { initDb: vi.fn() }
    }));
  });

  it('should execute query', async () => {
    // Can't really test - WASM not available
    const result = vi.fn().mockResolvedValue([{ id: 1 }]);
    expect(result).toHaveBeenCalled();
  });
});
```

### After (browser mode - real)
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { PostgresLiteSyncClient } from '@brainstrike/db';

describe('PGlite Database', () => {
  let db: PostgresLiteSyncClient;

  beforeEach(async () => {
    // Real database instance - WASM works!
    db = new PostgresLiteSyncClient();
    await db.ready;
  });

  it('should execute query', async () => {
    const result = await db.query('SELECT 1 as id');
    expect(result.rows).toEqual([{ id: 1 }]);
  });

  it('should persist data', async () => {
    await db.query('INSERT INTO test (id) VALUES (1)');
    const result = await db.query('SELECT * FROM test');
    expect(result.rows).toHaveLength(1);
  });
});
```

## Conclusion

Vitest 4 Browser Mode presents a significant opportunity to improve test quality and coverage for BrainStrike, particularly for WASM-dependent features like PGlite and IndexedDB operations. A structured spike investigation is recommended to validate feasibility, assess performance implications, and develop a rollout plan.

The move from simulated (jsdom/Happy DOM) to real browser environments aligns with best practices for modern web application testing and would eliminate current workarounds and test disabling, increasing overall confidence in the test suite.
