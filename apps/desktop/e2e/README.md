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

### Real Backgrounding Regression Coverage
`pnpm test:e2e:backgrounding` is the explicit production-path regression run for
the crash-repro tests that require Chromium to throttle a backgrounded renderer.
It sets `BRAINSTRIKE_E2E_ALLOW_BACKGROUNDING=1`, which removes the default
Electron launch flags that otherwise disable renderer backgrounding in test mode.
This regression is intentionally kept off the default PR workflow because it is
materially slower than the desktop smoke suite. Run it locally when debugging or
via a manual dispatch of the GitHub Actions `Test` workflow when you want Linux
CI coverage on demand. On manual dispatch, the workflow runs only the desktop
backgrounding regression lane instead of the normal PR matrix.

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
