# Desktop Electron E2E Tests

This directory contains comprehensive end-to-end tests for the Brainstrike desktop Electron application using Playwright. These tests are designed to catch desktop-specific regressions that web E2E tests cannot detect.

## 🚀 Quick Start

```bash
# Run tests in UI mode (recommended for development)
npm run test:e2e

# Run tests headlessly (for CI)
npm run test:e2e:headless

# Debug tests with inspector
npm run test:e2e:debug

# Type check E2E tests
npm run type-check:e2e

# Lint E2E tests
npm run lint
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
├── app-launch.spec.ts          # App launching and window management tests
├── file-system.spec.ts         # File system operations and permissions tests
└── ipc-communication.spec.ts   # Inter-Process Communication tests
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

### 1. App Launch Tests (`app-launch.spec.ts`)
Tests fundamental Electron app functionality:
- App launches successfully
- Window management (resize, minimize, maximize)
- App metadata retrieval
- Window state persistence
- Basic user interactions

### 2. File System Tests (`file-system.spec.ts`)
Tests file system operations specific to desktop:
- Directory access permissions
- File operations (read, write, delete)
- Large directory structure handling
- Error handling for invalid paths
- State persistence across app restarts

### 3. IPC Communication Tests (`ipc-communication.spec.ts`)
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
npx playwright show-report

# View specific trace file
npx playwright show-trace test-results/trace.zip
```

## 🔍 Debugging

### UI Mode (Recommended)
```bash
npm run test:e2e
```
- Visual test runner
- Step-by-step execution
- Live DOM inspection
- Time travel debugging

### Debug Mode
```bash
npm run test:e2e:debug
```
- Playwright Inspector
- Breakpoint support
- Element selector generation

### Headless with Artifacts
```bash
npm run test:e2e:headless
npx playwright show-report
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
  run: npm ci

- name: Install Playwright browsers
  run: npx playwright install --with-deps

- name: Build desktop app
  run: npm run build
  working-directory: apps/desktop

- name: Run E2E tests
  run: npm run test:e2e:headless
  working-directory: apps/desktop

- name: Upload test artifacts
  uses: actions/upload-artifact@v3
  if: failure()
  with:
    name: playwright-report
    path: apps/desktop/test-results/
```

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
- Verify the app is built: `npm run build`
- Check that `dist/main.js` exists
- Review global setup logs

**TypeScript errors:**
- Use `npm run type-check:e2e` to check E2E types specifically
- Ensure `tsconfig.e2e.json` includes the correct files

**Resource conflicts:**
- Reduce worker count in `playwright.config.ts`
- Ensure proper app cleanup in test teardown

**Permission errors:**
- Check file system mocking is active
- Verify sandbox settings in Electron launch options 