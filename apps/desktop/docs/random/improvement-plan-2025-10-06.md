## Desktop E2E High-Impact Improvements (2025-10-06)

### Current Pain Points
- `apps/desktop/e2e/app-launch.test.ts:16` launches and tears down Electron in every test, adding ~6s per spec and increasing flake surface when cleanup fails.
- `apps/desktop/e2e/database-persistence.test.ts:64` performs costly end-to-end DB initialization before each spec even though only a subset requires a full restart.
- Individual suites re-implement identical setup/teardown boilerplate (for example `apps/desktop/e2e/file-system.test.ts:18` and `apps/desktop/e2e/ipc-communication.test.ts:14`), slowing reviews and discouraging new coverage.
- Mock wiring such as assistant fetch overrides repeats per test suite, and there is no unified path to reset renderer state without discarding the entire Electron process.

### Fixture-Driven Reuse
- Added `apps/desktop/e2e/fixtures/electron-fixture.ts:1` exporting a worker-scoped Electron harness that keeps a single Electron process alive per worker and resets renderer state between tests.
- The harness exposes `electron.ensureContext()` and `electron.ensureWindow()` with optional `@preserve-electron-state` annotation support so tests that verify persistence can opt out of automatic reloads.
- Converted the lean `apps/desktop/e2e/agent-ipc.test.ts:1` suite to the new fixture as a reference implementation; it now bootstraps in ~1s instead of ~7s locally.

### Migration Plan
1. **Simple Suites First** – migrate `app-launch`, `file-system`, and `ipc-communication` to `fixtures/electron-fixture`. These already rely on a shared `HomePage` helper so the conversion is limited to import changes and parameter injection.
2. **Persistence Cases** – adopt the fixture in `database-persistence.test.ts` using `test.info().annotations.push({ type: 'preserve-electron-state' })` for specs that must reuse browser storage across steps, and replace manual relaunches with `electron.restart()`.
3. **Assistant Suites** – centralize assistant mock wiring in a helper invoked from the fixture’s `window` setup to avoid repeating init scripts in `assistant-panel.desktop.test.ts` and `mcp-filesystem.desktop.test.ts`.
4. **Delete Redundant Hooks** – once migrated, drop bespoke `beforeEach`/`afterEach` blocks and rely on fixture cleanup, reducing the chance of missing `closeElectronApp` calls that currently leak orphaned processes during failures.

### Recent Progress
- Worker fixture is now live for launch, file system, IPC, secrets, assistant, and agent suites; `apps/desktop/e2e/agent-ipc.test.ts` and friends import from `fixtures/electron-fixture.ts`.
- `apps/desktop/e2e/database-persistence.test.ts` migrated to the shared fixture with state-aware teardown and harness-driven restarts, trimming >100 lines of bespoke lifecycle management.
- Introduced `apps/desktop/e2e/utils/assistant-mock.ts` to seed secrets, persist provider preferences, and stub streaming responses (simple vs detailed variants) for desktop assistant tests; helper now waits for `waitForAppReady` after reload to reduce race conditions observed post-mock injection.

### Additional Opportunities
- Extend `ElectronHarness` with `electron.withMock<T>(callback)` helpers so network overrides, file-system mocks, and database seeding run once per worker instead of per spec.
- Move build verification from `apps/desktop/e2e/global-setup.ts:15` into a cached Turbo task (e.g. `pnpm turbo run build --filter @brainstrike/desktop --cache-dir`) and skip rebuilds when `dist/main.js` timestamp is newer than the sources.
- Introduce focused smoke suites using Playwright test projects (headed vs. headless) now that boot cost is amortized, enabling better coverage without multiplying runtime.
- Capture canonical assistant mock usage inside `fixtures/electron-fixture.ts` (e.g., optional pre-test hook) so individual tests only supply variant overrides when needed.
- Provide a fixture-level option to skip renderer reload for multi-step flows instead of relying on annotations per spec.
- Investigate using Playwright's project matrix to parallelise web/desktop smoke runs while keeping desktop worker count at one; combine with `xvfb-maybe` availability checks to avoid ENOENT failures on macOS dev machines.
