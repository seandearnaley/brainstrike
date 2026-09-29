# Desktop Electron E2E Tests

This directory contains comprehensive end-to-end tests for the Brainstrike desktop Electron application using Playwright. These tests are designed to catch desktop-specific regressions that web E2E tests cannot detect.

## 🚀 Quick Start

```bash
# Run the full desktop E2E suite
pnpm test:e2e

# Run the non-persistence desktop regression suite
pnpm test:e2e:main

# Run the persistence-only desktop regression suite
pnpm test:e2e:persistence

# Run the real-backgrounding crash-repro regression path
pnpm test:e2e:backgrounding

# Debug tests with inspector
pnpm test:e2e:debug

# Type check E2E tests
pnpm type-check:e2e

# Lint E2E tests
pnpm lint
```

## 📁 Project Structure

```
e2e/
├── README.md                    # This file
├── global-setup.ts             # Global test setup (builds app, verifies files)
├── utils/
│   └── electron-helpers.ts     # Electron-specific test utilities
├── page-objects/
│   └── home-page.ts            # Page object model for main app interface
├── app-launch.test.ts          # App launching and window management tests
├── file-system.test.ts         # File system operations and permissions tests
└── ipc-communication.test.ts   # Inter-Process Communication tests
```

## 🔧 Configuration

### TypeScript Configuration

The E2E tests use a separate TypeScript configuration (`tsconfig.e2e.json`) to:
- Include only E2E test files and Playwright config
- Use appropriate types (`@playwright/test`, `node`)
- Avoid conflicts with main app types

### Playwright Configuration

Key configuration features:
- **Timeout**: 60 seconds (Electron apps are slower to start)
- **Workers**: Limited to 1 on CI, 2 locally for resource management
- **Tracing**: `retain-on-failure` locally, `on-first-retry` on CI
- **Video**: `retain-on-failure` for debugging
- **Screenshots**: `only-on-failure`

## 🧪 Test Categories

### Embedding Host Renderer Lanes

The former monolithic `embedding-worker-renderer.test.ts` is split by lane so
normal feedback loops can select a focused file instead of the full diagnostic
surface:

- `embedding-worker-renderer.smoke.desktop.test.ts` - lifecycle and bounded
  queue smoke coverage.
- `embedding-worker-renderer.backfill-search.desktop.test.ts` - import,
  backfill, and search regressions.
- `embedding-worker-renderer.memory.desktop.test.ts` - visible renderer and
  collection memory regressions.
- `embedding-worker-renderer.diagnostics.desktop.test.ts` - mixed-state and
  desktop-dev diagnostics.
- `embedding-worker-renderer.crash-a.desktop.test.ts` and
  `embedding-worker-renderer.crash-b.desktop.test.ts` - crash-reproduction and
  reclaim diagnostics.

`embedding-worker-renderer.shared.ts` is an explicitly documented test fixture
file. It is intentionally larger than the normal source-file budget because it
keeps the shared desktop setup, DB fixtures, host diagnostics, and memory
samplers in one import surface while all executable `*.test.ts` files stay below
2,000 LOC.

### File Explorer Selection Lanes

The former monolithic `file-explorer-selection.desktop.test.ts` is split by
purpose:

- `file-explorer-selection.desktop.test.ts` - interactive selection, select-all,
  limit, expansion, explicit selection, and mixed file/folder behavior.
- `file-explorer-selection-restore.desktop.test.ts` - restored explicit,
  partial, query, snapshot-backed, and live replay selection behavior after
  desktop restart.

`file-explorer-selection.shared.ts` is an explicitly documented test fixture
exception. It owns the desktop file-system fixture, persisted selection-state
seeders, checkbox helpers, and renderer-settle helpers while both executable
`*.test.ts` files stay below 2,000 LOC.

### 1. App Launch Tests (`app-launch.test.ts`)
Tests fundamental Electron app functionality:
- App launches successfully
- Window management (resize, minimize, maximize)
- App metadata retrieval
- Window state persistence
- Basic user interactions

### 2. File System Tests (`file-system.test.ts`)
Tests file system operations specific to desktop:
- Directory access permissions
- File operations (read, write, delete)
- Large directory structure handling
- Error handling for invalid paths
- State persistence across app restarts

### 3. IPC Communication Tests (`ipc-communication.test.ts`)
Tests Inter-Process Communication between main and renderer:
- Electron API availability
- Storage operations via IPC
- File system operations via IPC
- Error handling in IPC calls
- Heavy operation handling
- Concurrent IPC calls
- Communication reliability

### 4. Composer Workspace Bar (`workspace-bar.desktop.test.ts`)
Drives the composer workspace bar against REAL on-disk folders — nothing about
the bar is mocked (see `docs/agents/workspace-context.md`, MAIN vs FOCUSED):
- Folder chip visible at a SINGLE root, labelled with the primary root's name.
- Branch chip (read-only `window.git.status`) shows `main` + `data-dirty` for a
  real `git init`'d repo, and is ABSENT for a non-git folder.
- Recents: a path seeded into main's `recentRootsList` ledger re-mounts through
  the picker-less `fs:addRootByPath` and is recorded as a thread secondary
  (`+1`).
- "Add folder…" (OS picker bypassed by `BRAINSTRIKE_E2E_REAL_ROOT_PATH`) mounts
  globally AND attaches to the thread as a secondary.

Only the first test is `@smoke`; the rest run in the `regression` project. Temp
folder fixtures come from `utils/git-fixtures.ts` and the ledger seed from
`utils/seed-root.ts` — both shared with `git-panel.desktop.test.ts`, so the two
specs cannot drift apart. The web counterpart is `apps/web/e2e/workspace-bar.test.ts`
(one test, tagged `@web-smoke` so it runs on every PR).
Web's smaller capability surface (no git bridge, no recents ledger) is pinned
separately by `apps/web/e2e/workspace-bar.test.ts`.

### 5. Threads Panel Folder Grouping (`threads-panel-folders.desktop.test.ts`)
Drives the Threads panel's `Group by → Folder` view against a REAL `git init`'d
folder (see `docs/agents/assistant-persistence.md`, THREAD GROUPS):
- Folder sections keyed by each thread's primary root, with a live count and a
  trailing **No folder** section that carries no "New thread here" action.
- The `⎇ branch` badge on bound rows (real `window.changes` git inventory) and
  no badge at all on an unbound row.
- "New thread here" creating a thread born BOUND to that folder (the section's
  count moves 2 → 3 while "No folder" does not).
- `Show only → Running` with no runs emptying the list into
  `threads-filtered-empty-card`, and clearing it restoring every row.

Only the first test is `@smoke`; the second runs in the `regression` project.
Threads are SEEDED as `mastra_threads` rows via `utils/seed-threads.ts` (the
shared `electronAPI.db` bridge) because a thread's folder binding is written at
its FIRST REQUEST — so no product gesture mints a bound thread before one
exists. That helper also reads the DURABLE `roots.id` back from the database
(never the adapter root id) and probes `to_regclass('mastra_threads')` rather
than retrying a failing INSERT. The spec `realpath`s its temp repo on purpose:
the branch join tries exact path equality FIRST (no symlink resolution) and
only then the containment-id fallback, so resolving the macOS
`/var` → `/private/var` tmpdir keeps this spec grading the path join rather
than the fallback. Root and
repo fixtures are the shared `utils/git-fixtures.ts` + `utils/seed-root.ts`.
The web counterpart is `apps/web/e2e/threads-panel-folders.test.ts`
(one test, `@web-smoke`), which pins the option, the "No folder" catch-all, and
the absence of both the branch badge and the `window.changes` bridge.

### 6. Composer Worktree Mode (`worktree-mode.desktop.test.ts`)
Drives the composer's Mode and branch chips against REAL on-disk Git worktrees
and the real PGlite-backed managed-worktree ledger — `window.worktrees`, Git,
picker-less mounting, and thread checkout persistence are not mocked:
- A plain Git checkout shows the enabled `Local` mode chip.
- The create sheet runs a real `git worktree add`, then moves the thread's
  primary folder and branch chips into the created checkout.
- A real worktree below `.codex/worktrees` appears in the existing-worktree
  picker as a disabled `Codex` row with its reason and **Grant access…** action.
- Archiving a clean managed worktree removes the real checkout, records its
  archive ref, and hands the thread back to `Local`.
- The selected worktree, folder, and branch survive a renderer reload.
- The branch chip switches the real local checkout to another branch.

Only the Local-chip test is `@smoke`; the other five run in the `regression`
project. Repository and external-worktree fixtures come from the shared
`utils/git-fixtures.ts`, while root/PGlite setup uses `utils/seed-root.ts`, the
same production-chain helpers as `git-panel.desktop.test.ts` and
`workspace-bar.desktop.test.ts`. The managed directory is redirected to a
tracked temp directory through the E2E-only `BRAINSTRIKE_E2E_WORKTREE_DIR` hook.

### Packaged MCP Tasks restart (`mcp-task-restart.packaged.desktop.test.ts`)

This focused verifier requires an `electron-builder --dir` artifact. It launches
that executable twice against one isolated user-data directory and asserts
`app.isPackaged === true` on both processes. A test-only lazy renderer mode
composes migration-114 PGlite persistence, the Tasks lifecycle and interaction
authorities, the bounded presentation controller, and the accessible task card.
The test covers durable restart recovery, principal/generation fencing,
remote-observed cancellation, focus restoration, and explicit quiescent close.
The mode is unavailable outside Desktop test mode and never enables production
Tasks registration.

## 🛠 Key Features

### Dialog Mocking
Native Electron dialogs (file/directory selection) are automatically mocked to prevent tests from hanging:
- `showOpenDialog` returns mock directory paths
- `showSaveDialog` returns mock file paths
- `showMessageBox` returns default responses

### File System Mocking
File system operations are mocked to prevent real filesystem access:
- `requestDirectoryAccess` returns mock paths
- `exists` checks for mock path patterns
- Safe for CI environments

### Error Handling
Comprehensive error handling for:
- App launch failures
- IPC communication errors
- File system permission errors
- Network timeouts

## 🎯 What These Tests Catch

Desktop-specific issues that web tests cannot detect:
- **Electron API Integration**: Main/renderer process communication
- **File System Access**: Native file operations and permissions
- **Window Management**: Desktop window behaviors
- **App Lifecycle**: Launch, close, state persistence
- **Native Dialogs**: File/directory selection dialogs
- **Performance**: Heavy operations in Electron context
- **Security**: Sandbox restrictions and permissions

## 📊 Test Artifacts

When tests fail, the following artifacts are captured:
- **Screenshots**: Automatic on failure
- **Videos**: Recorded on failure (retained for debugging)
- **Traces**: Full execution trace with DOM snapshots
- **Console Logs**: Both main and renderer process logs

Access artifacts:
```bash
# View HTML report with artifacts
pnpm exec playwright show-report

# View specific trace file
pnpm exec playwright show-trace test-results/trace.zip
```

## 🔍 Debugging

### UI Mode (Recommended)
```bash
pnpm test:e2e
```
- Visual test runner
- Step-by-step execution
- Live DOM inspection
- Time travel debugging

### Debug Mode
```bash
pnpm test:e2e:debug
```
- Playwright Inspector
- Breakpoint support
- Element selector generation

### Headless with Artifacts
```bash
pnpm test:e2e:main
pnpm exec playwright show-report
```

## 🚀 CI/CD Integration

The tests are configured for CI environments:
- Single worker to avoid resource conflicts
- Blob reporter for CI artifact collection
- Proper timeout handling
- Headless execution

Example GitHub Actions integration:
```yaml
- name: Install dependencies
  run: pnpm install

- name: Install Playwright browsers
  run: pnpm exec playwright install --with-deps

- name: Build desktop app
  run: pnpm build
  working-directory: apps/desktop

- name: Run E2E tests
  run: pnpm test:e2e:main
  working-directory: apps/desktop

- name: Upload test artifacts
  uses: actions/upload-artifact@v3
  if: failure()
  with:
    name: playwright-report
    path: apps/desktop/test-results/
```

### Window focus in the harness (BST-1864)
The harness window is `focusable: false` and never shown (test mode), so it never
takes OS focus, and Playwright forces `document.hasFocus()` true on every page.
The `windowFocus` preload bridge reports the NATIVE window (always unfocused
here), so `createLaunchOptions` disables it by default through
`BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES=windowFocus` and every spec keeps the
focused app it has always run with. A spec that tests the bridge sets that
variable to `''` before launch (an explicit value wins), as
`window-focus-seen.desktop.test.ts` does; it synthesizes the OS `focus` event
with `BrowserWindow.emit`. Keyboard focus in a child `WebContentsView` cannot be
reproduced under Playwright's forced focus; that is covered by unit tests.

### Real Backgrounding Regression Coverage
`pnpm test:e2e:backgrounding` is the explicit production-path regression run for
the crash-repro tests that require Chromium to throttle a backgrounded renderer.
It sets `BRAINSTRIKE_E2E_ALLOW_BACKGROUNDING=1`, which removes the default
Electron launch flags that otherwise disable renderer backgrounding in test mode.
This regression is intentionally kept off the default PR workflow because it is
materially slower than the desktop smoke suite. Run it locally when debugging or
when explicitly validating the production background-throttling path.

Note on file naming (2025): We standardize on `.test.ts` across unit, integration, and E2E to keep naming runner-agnostic and consistent. Playwright recognizes both `.spec` and `.test`, but `.test` aligns with our Vitest conventions and simplifies TypeScript include/exclude globs.

## 🔧 Maintenance

### Adding New Tests
1. Follow existing patterns in test files
2. Use page objects for reusable UI interactions
3. Include proper error handling
4. Add descriptive test names and comments

### Updating Dependencies
When updating Playwright:
1. Check the [release notes](https://playwright.dev/docs/release-notes)
2. Update configuration if needed
3. Test all scenarios locally
4. Update this README if new features are used

### Performance Optimization
- Keep tests focused and atomic
- Use mocking to avoid real file system operations
- Limit concurrent workers on resource-constrained systems
- Clean up test artifacts regularly

## 📚 Resources

- [Playwright Electron Documentation](https://playwright.dev/docs/api/class-electron)
- [Playwright Test Configuration](https://playwright.dev/docs/test-configuration)
- [Electron Testing Best Practices](https://www.electronjs.org/docs/latest/tutorial/automated-testing)
- [Brainstrike Web E2E Tests](../../../apps/web/e2e/) for comparison

## 🐛 Troubleshooting

### Common Issues

**Tests hang on directory selection:**
- Ensure dialog mocking is properly set up in `electron-helpers.ts`
- Check that `setupDialogMocking` is called in test setup

**App fails to launch:**
- Verify the app is built: `pnpm build`
- Check that `dist/main.js` exists
- Review global setup logs

**TypeScript errors:**
- Use `pnpm type-check:e2e` to check E2E types specifically
- Ensure `tsconfig.e2e.json` includes the correct files

**Resource conflicts:**
- Reduce worker count in `playwright.config.ts`
- Ensure proper app cleanup in test teardown

**Permission errors:**
- Check file system mocking is active
- Verify sandbox settings in Electron launch options 
