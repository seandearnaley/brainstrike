# Test Suite Modernization (2025)

This document captures findings from an audit of the Brainstrike monorepo tests and proposes a modernization plan to improve speed, memory usage, reliability, and consistency across packages. It is designed to be actionable with a checklist and dependency ordering.

## Executive Summary

- The suite is comprehensive but incurs overhead from duplicated setup, heavy global mocks, ad‑hoc sleeps, and inconsistent runner configs. Several UI packages use process forks, which increases memory and startup costs. Some tests risk hanging due to unresolved promises in hoisted Electron mocks.
- Core improvements: unify test harness, standardize environments, remove arbitrary sleeps, tune parallelization, and consolidate coverage. Replace global console filtering with explicit assertions. Move IPC/DB mocks into shared factories.
- Expected outcomes: 30–60% runtime reduction for unit/integration tests in UI packages, reduced flakiness, and lower peak RSS (especially by dropping per-file process forks and uncontrolled timers/workers).

## Key Findings (with references)

### Configuration and Environments

- Multiple per‑package Vitest configs with divergent options lead to inconsistent behavior and resource usage.
  - `packages/file-explorer-ui/vitest.config.mts:5` uses `environment: 'jsdom'` plus `pool: 'forks'` and `isolate: true`. Forks create new Node processes per worker, increasing memory and startup time.
  - `packages/db/vitest.config.mts:23` uses `pool: 'threads'` with `singleThread: true` (likely correct for the DB mock/WASM constraints, but we should limit this isolation only where necessary).
  - Root `vitest.config.ts:8` aggregates `projects: ['packages/*', 'apps/*']`, while many packages define their own configs. This is OK, but we should make options consistent via a shared base.

- Mixed DOM environments: some packages use `jsdom` (slower but full-featured), while the repo depends on `happy-dom` at the root. We can standardize to `happy-dom` for most React tests and pin `jsdom` only where needed.

### Global Setup and Mocks

- `@brainstrike/test-utils` sets a heavy global setup that overrides console output and Worker behavior:
  - `packages/test-utils/src/vitest.setup.ts:1` imports `@testing-library/jest-dom` globally (good), but also:
  - Mocks `window.Worker` globally and tracks worker instances with a `MAX_WORKERS` cap. While this prevents leaks, it couples all tests to a mocked Worker, and the async `setTimeout` in the constructor can add microtasks across tests.
  - Overrides `console.error` with string filtering (risk: hides real issues and makes failures harder to detect), see `packages/test-utils/src/vitest.setup.ts:72` and later.
  - Provides `IntersectionObserver`, `ResizeObserver`, `matchMedia` mocks globally (useful), but they should be opt‑in when tests need them to minimize cross‑test coupling.

### Asynchrony, Timers, and Sleeps

- Ad‑hoc sleeps and timeouts degrade speed and add flakiness:
  - Examples include `await new Promise((resolve) => setTimeout(resolve, 100))` and 600ms sleeps in UI tests (e.g., `packages/file-explorer-ui/src/__tests__/hooks/use-tab-manager.test.ts:356`, `:388`).
  - Several tests depend on `waitFor` with long timeouts (2s) and occasional naked `setTimeout` calls instead of fake timers.
  - Multiple files use fake timers but do not consistently restore real timers after each test (e.g., sporadic `vi.useFakeTimers()` without a paired `vi.useRealTimers()` globally).

### IPC/Electron Mocking

- Hoisted mocks are used per‑file, often redefining Electron IPC patterns:
  - `apps/desktop/src/__tests__/main-ipc.test.ts:4` uses `vi.hoisted` with `app.whenReady` mocked to `new Promise<void>(() => {})` (never resolves). If the code under test awaits `whenReady()`, this can hang imports or tests.
  - Many tests manually stub `ipcMain.handle` and `ipcRenderer.invoke`. These can be centralized into a shared mock to reduce duplication and mistakes.

### Cleanup and Mock Restoration

- `vi.clearAllMocks()` is used frequently, but `vi.restoreAllMocks()` is not enforced after each test. Restoring is important to return built‑ins to their original behavior, especially when `spyOn` is used.
- Global cleanup for React Testing Library is implicitly handled by current versions, but explicit consistency via a shared setup keeps behavior predictable across environments.

### Parallelization and Resource Use

- Using `pool: 'forks'` in `packages/file-explorer-ui/vitest.config.mts:11` increases memory and reduces the benefits of V8 shared state across tests. Vitest threads are generally faster and lighter for DOM tests in 2025.
- DB tests are pinned to single thread (likely necessary for the mock/WASM constraints). That’s fine but should be scoped to that package only.

### Coverage and Reporting

- Coverage is defined per‑package and at the root. Consolidating to a single `@vitest/coverage-v8` pass with consistent `include/exclude` improves performance and simplifies reporting.

## Recommendations (2025 Best Practices)

1) Establish a shared base Vitest config and setup

- Create `@brainstrike/test-utils/vitest.base.ts` exporting a partial `defineConfig({ test: { ... } })` with:
  - Defaults: `globals: true`, `mockReset: true`, `restoreMocks: true`, `clearMocks: true` (Vitest options) to auto‑restore/clear between tests.
  - Default `testTimeout: 10000`, `hookTimeout: 15000` (tighten from 30s/20s where safe).
  - Default `pool: 'threads'` for UI packages; remove `forks` unless a test demonstrably needs process isolation.
  - `environment: 'happy-dom'` for React unit/integration tests unless `jsdom` is required by a specific dependency.
  - A single `setupFiles` entry pointing to a leaner `@brainstrike/test-utils/vitest.setup` (see below).

2) Slim and harden the global test setup

- Replace global `console.error` filtering with explicit assertions in tests that expect no errors. For unexpected errors, fail fast. Remove the filter from `packages/test-utils/src/vitest.setup.ts`.
- Make `Worker` mocking opt‑in per test file (export a `withMockWorkers()` helper from `@brainstrike/test-utils`), instead of global override. This reduces cross‑test coupling and event‑loop churn.
- Keep `matchMedia`, `IntersectionObserver`, `ResizeObserver` polyfills, but export them as helpers for tests that need them; avoid always‑on globals.
- Add a global afterEach safety net:
  - `vi.useRealTimers()`
  - `vi.restoreAllMocks()` (if not using Vitest `restoreMocks: true`)
  - Ensure any pending microtasks are flushed via a shared `flushMicrotasks()` helper when relevant.

3) Remove sleeps; prefer fake timers and RTL utilities

- Replace `new Promise((r) => setTimeout(r, X))` with `vi.useFakeTimers()` and `vi.advanceTimersByTime(X)` or `await vi.runAllTimersAsync()`.
- Use Testing Library `findBy*` queries and `waitFor` with short timeouts (100–500ms) and proper expectations. Add custom utilities for common async states (e.g., “wait for file tree idle”).
- For debounce/throttle logic, prefer deterministic timer-based tests instead of arbitrary waits.

4) Standardize DOM environment to `happy-dom` where possible

- For packages that don’t rely on `jsdom`-specific features, switch to `environment: 'happy-dom'` to reduce memory and increase speed.
- Keep `jsdom` for components/libraries that require it; annotate such tests with `@vitest-environment jsdom` at file top.

5) Centralize Electron IPC mocks

- Add `@brainstrike/test-utils/electron` with factories:
  - `createIpcMainMock()`, `createIpcRendererMock()`, `createAppMock({ whenReadyResolved })` with safe defaults (e.g., `whenReady` resolves immediately unless a test wants to control it).
  - Provide `installElectronModuleMocks()` to apply `vi.mock('electron', () => ...)` consistently.
- Refactor tests like `apps/desktop/src/__tests__/main-ipc.test.ts` to import these helpers. Avoid unresolved `whenReady` promises.

6) Tune parallelization and isolation

- UI packages: switch from `forks` to `threads` with a capped worker count (e.g., `maxWorkers: Math.min(4, os.cpus()-1)`).
- DB package: keep `singleThread: true` where necessary, and document why.
- Avoid `isolate: true` unless there’s a demonstrated cross‑test pollution. With `restoreMocks: true` and deterministic timers, most suites can run without full isolation.

7) Consolidate coverage

- Use root `vitest` with `@vitest/coverage-v8` to collect coverage across projects. Remove package‑level coverage scripts. Align `include/exclude` to skip generated files and Electron main where appropriate.
- Add coverage thresholds with fail‑fast behavior; never disable to pass builds.

8) Consistent patterns and ergonomics

- Use `test.each`/`describe.each` for matrixed tests to DRY repetitive cases.
- Prefer `userEvent` for interactions over low‑level DOM event dispatch.
- Add a tiny `renderWithProviders` in `@brainstrike/test-utils` with common providers (theme/router) used across UI packages.

## Illustrative Refactors

### Example: Replace ad‑hoc IPC mocks

Before (`apps/desktop/src/__tests__/main-ipc.test.ts:4`):

```ts
const { mockIpcMain, mockIpcRenderer, mockApp } = vi.hoisted(() => {
  // ... app.whenReady: new Promise(() => {})
});
```

After (shared factory):

```ts
import { installElectronModuleMocks, createAppMock } from '@brainstrike/test-utils/electron';

const app = createAppMock({ whenReadyResolved: true });
installElectronModuleMocks({ app });
```

### Example: Remove sleeps

Before:

```ts
await new Promise((resolve) => setTimeout(resolve, 600));
```

After:

```ts
vi.useFakeTimers();
// trigger action ...
vi.advanceTimersByTime(600);
await vi.runAllTimersAsync();
vi.useRealTimers();
```

## Rollout Plan (Checklist with Dependencies)

- [x] 1. Create shared Vitest base config in `@brainstrike/test-utils` (exports `test` defaults) [No deps]
- [x] 2. Slim `packages/test-utils/src/vitest.setup.ts` (remove console filtering and global Worker override; keep minimal polyfills) [No deps]
- [x] 3. Add `afterEach` safety in shared setup or via Vitest `restoreMocks/clearMocks/mockReset` options [Depends on 1]
- [x] 4. Switch UI packages to `pool: 'threads'` and set `environment: 'happy-dom'` by default [Depends on 1]
  - Initial adoption: `packages/file-explorer-ui` switched from forks→threads; retained `jsdom` temporarily pending audit.
- [x] 5. Keep `packages/db` `singleThread: true`; document rationale in its config [Parallel]
- [ ] 6. Introduce `@brainstrike/test-utils/electron` factories and migrate desktop IPC tests [Parallel]
- [ ] 7. Migrate tests off ad‑hoc sleeps to fake timers + `waitFor` patterns [Depends on 3]
- [x] 8. Remove global console.error filter; replace with per‑test assertions for error/no‑error [Depends on 2]
- [ ] 9. Consolidate coverage at root; remove per‑package coverage scripts; add thresholds [Depends on 1]
- [ ] 10. Add `renderWithProviders` and adopt in UI tests where providers are repeated [Parallel]
- [ ] 11. Audit for hanging promises (e.g., `app.whenReady`) and fix with resolving mocks [Parallel]
- [x] 12. Cap workers (`maxWorkers`) per CI agent; document local override via env [Parallel]

## Measurement and Guardrails

- Baseline: capture total test runtime, max RSS, and flaky test count before changes.
- Use `vitest --reporter=junit` or JSON to track durations per package and file.
- After each milestone, compare runtime and memory (
  e.g., `node --expose-gc` and sampling `process.memoryUsage().rss` in a custom reporter if needed).
- Add a CI job that fails on unexpected `console.error`/`console.warn` output to prevent regressions (post removal of the global filter).

## File References

- Root Vitest projects: `vitest.config.ts:8`
- UI config using forks: `packages/file-explorer-ui/vitest.config.mts:5`
- DB Vitest config: `packages/db/vitest.config.mts:23`
- Heavy global setup and console filtering: `packages/test-utils/src/vitest.setup.ts:1`
- Hoisted unresolved `whenReady`: `apps/desktop/src/__tests__/main-ipc.test.ts:4`

## Notes

- Never downgrade or disable tests to “make green”. Prefer fail‑fast and fix root causes.
- Prefer minimal, explicit mocks. Global overrides should be rare and well‑documented.
- Prefer shared helpers over copy‑paste blocks to reduce maintenance and memory footprint.

## PR Checklist (Copy Into Description)

Use this list to structure the PR and ensure nothing is missed. Keep items checked only when verifiably complete.

- [ ] Title uses Conventional Commits: `<type>(test): ...` or appropriate scoped type
- [ ] Affected workspaces listed (apps/packages) and rationale provided
- [ ] No downgrades, no disabled tests, no “temporary” hacks

Implementation (map to plan)
- [x] Created shared base config: `packages/test-utils/src/vitest.base.ts`
  - [x] `globals`, `restoreMocks`, `clearMocks`, `mockReset` enabled
  - [x] `testTimeout` (~10s) and `hookTimeout` (~15s) standardized
  - [x] Default `pool: 'threads'`; remove `forks` for UI packages
  - [x] Default `environment: 'happy-dom'` (unless file/package requires `jsdom`)
- [ ] Slimmed global setup: `packages/test-utils/src/vitest.setup.ts`
  - [x] Removed global `console.error` filtering
  - [x] Removed always-on `Worker` mock; exported opt-in helper (`installMockWorkers`)
  - [x] Kept polyfills (`matchMedia`, `IntersectionObserver`, `ResizeObserver`) minimal
  - [x] Added global afterEach safety (or rely on Vitest options): `vi.useRealTimers()`
- [x] Electron mock utilities added: `packages/test-utils/src/electron.ts`
  - [x] `createIpcMainMock`, `createIpcRendererMock`, `createAppMock`
  - [x] `installElectronModuleMocks()`
  - [x] Documented safe defaults (e.g., `app.whenReady()` resolves)
- [x] UI package configs updated to use base config
  - [x] `packages/file-explorer-ui/vitest.config.mts` switched to threads; removed `forks`
  - [ ] Annotated any files that truly need `jsdom` with `@vitest-environment jsdom`
- [x] DB package kept `singleThread: true`, documented rationale in `packages/db/vitest.config.mts`
- [ ] Replaced ad-hoc `setTimeout` sleeps with fake timers or RTL `waitFor`
  - [x] List of files updated
    - `packages/file-explorer-ui/src/__tests__/hooks/use-tab-manager.test.ts`
    - `packages/file-explorer-ui/src/__tests__/file-explorer-provider.integration.test.tsx`
    - `packages/file-explorer-ui/src/__tests__/use-file-tree-context.test.ts` (partial: fake timers used, long waits avoided)
- [ ] Removed long `waitFor` timeouts (>1000ms) or justified necessity
- [ ] Refactored desktop IPC tests to shared Electron mocks
  - [x] Fixed unresolved `app.whenReady` usage in:
    - `apps/desktop/src/__tests__/main-ipc.test.ts`
    - `apps/desktop/src/__tests__/main/ipc-handlers-db.test.ts`
- [ ] Coverage consolidated at root with `@vitest/coverage-v8`
  - [ ] Aligned `include/exclude`; excluded Electron main where appropriate
  - [ ] Removed per-package coverage scripts
  - [ ] Added thresholds and documented target numbers

Validation
- [ ] `pnpm install` (root)
- [ ] `pnpm lint-all` (no errors; formatter applied)
- [ ] `pnpm build` (all workspaces succeed)
- [ ] `pnpm type-check` (0 errors)
- [ ] `pnpm test` (unit/integration) all green
- [ ] `pnpm test:e2e` green (desktop/web where applicable)
- [ ] Coverage meets thresholds; report attached (path + numbers)
- [ ] Performance: before/after total runtime and peak RSS captured and attached
  - [ ] Unit/integration runtime δ and memory δ summarized

Risk & Rollout
- [ ] Breaking change notes (if any) called out
- [ ] Migration notes for contributors (new helpers, config knobs)
- [ ] CI updated (coverage merge/reporters, worker caps) and passes
- [ ] Backout plan: revert list and config toggles documented

Package Checkboxes (tick those touched)
- [x] apps/desktop
- [ ] apps/web
- [x] packages/test-utils
- [x] packages/file-explorer-ui
- [ ] packages/file-explorer-hooks
- [ ] packages/file-explorer
- [ ] packages/ui
- [ ] packages/db
- [x] packages/db
- [ ] packages/utils
- [ ] packages/types
- [ ] packages/file-system
- [ ] packages/config / tailwind-config

Appendices (optional but recommended)
- [ ] Links to flaky tests fixed (if applicable)
- [ ] Screenshots/logs of failing-to-passing cases after changes
- [ ] Notes on tests left intentionally unchanged with justification
