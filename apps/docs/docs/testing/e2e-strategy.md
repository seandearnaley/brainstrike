---
title: E2E Strategy
sidebar_position: 3
---

# E2E Testing Strategy

**Objective:** Ensure the Brainstrike Desktop application is robust, reliable, and regression-free across all supported platforms.

## 1. Overview

We use **Playwright** for End-to-End (E2E) testing of the Electron application. Playwright allows us to automate user interactions with the application in a real environment, verifying both the renderer (UI) and main process behaviors.

## 2. Test Scope

### 2.1. Critical User Journeys (CUJs)
Tests should cover the following core functionalities:
*   **Application Launch & Startup:** Verifying the app starts, main window appears, and initial state is correct.
*   **File System Integration:**
    *   Opening directories.
    *   Reading file contents.
    *   File tree navigation (expanding/collapsing folders).
    *   Handling file system errors (e.g., permission denied).
*   **Database Operations:**
    *   Connecting to the local PGlite database.
    *   Performing queries (via UI or mocked IPC).
    *   Data persistence across app restarts.
*   **UI/UX Interactions:**
    *   Panel resizing and layout persistence.
    *   Theme switching (if applicable).
    *   Navigation between tabs/views.

### 2.2. IPC & Main Process
*   Verifying IPC handlers correctly bridge the renderer and main process.
*   Testing main process logic like window management, menu actions, and native dialogs.

## 3. Testing Architecture

### 3.1. Fixtures (`apps/desktop/e2e/fixtures/`)
We use Playwright's fixture system to manage the test environment:
*   **`electron` Fixture:** Handles the lifecycle of the Electron application. It starts the app before tests and closes it afterwards.
    *   **Sharding Support:** Automatically assigns unique remote debugging ports based on the shard index to allow parallel execution (e.g., in CI).
*   **`window` Fixture:** Provides access to the main application window (`Page` object) for UI interactions.

### 3.2. Utilities (`apps/desktop/e2e/utils/`)
Helper functions to simplify test code and ensure consistency:
*   **`electron-helpers.ts`:** Contains functions for launching/closing the app, mocking native dialogs, and interacting with the file system.
*   **Shared Mocks:** Common mock data (like directory structures) should be imported from `@brainstrike/test-utils` or `@brainstrike/file-system` to avoid duplication between unit and E2E tests.

### 3.3. Mocks & Stubs
To ensure tests are deterministic and fast, we mock certain external dependencies:
*   **Native Dialogs:** Electron's `dialog.showOpenDialog`, `dialog.showSaveDialog`, etc., are mocked to return predefined paths without blocking the test execution.
*   **File System:** For some tests, we inject mocks into the `electronAPI` exposed to the renderer to simulate file system operations without touching the disk.

## 4. CI/CD Integration

### 4.1. Parallel Execution (Sharding)
Tests are designed to run in parallel using Playwright sharding.
*   **Isolation:** Each shard runs a separate instance of the Electron app.
*   **Port Management:** Unique debugging ports are assigned to avoid collisions between shards running on the same host (crucial for `act` and some CI runners).

### 4.2. Local Debugging (`pnpm ci:local`)
A local CI simulation script (`scripts/local-ci.sh`) allows developers to run the E2E suite in an environment closely matching GitHub Actions (using `act` and Docker) before pushing changes.

### 4.3. PR Cloud Lane Routing

PRs no longer run every cloud E2E lane by default.

`pnpm ci:select --base origin/main --head HEAD` prints the same risk plan that
GitHub computes in the `plan` job. That plan owns:

- the selected risk lanes,
- the exact `requiredJobs` cloud gate,
- the web and desktop dynamic E2E matrices,
- and the optional local `localCommands` evidence list.

Developers do not add CI labels and do not commit generated proof artifacts.
Empty E2E matrices do not run; selected narrow lanes run only their tagged
commands.

The full matrix remains available on `main`, nightly schedule, and manual
workflow dispatch.

## 5. Best Practices

1.  **Deterministic Locators:** Use `data-testid` or accessible roles (`getByRole`) instead of fragile CSS selectors.
2.  **Isolation:** Tests should be independent. Use `beforeEach` / `afterEach` to reset state (e.g., clearing `electron-store` or database).
3.  **Error Handling:** Avoid silent `.catch()` blocks. Log errors or allow tests to fail explicitly so issues aren't hidden.
4.  **Timeouts:** Use appropriate timeouts for Electron startup, but avoid arbitrary `waitForTimeout`. Rely on `waitForSelector` or `waitForFunction` for state changes.
5.  **Type Safety:** Avoid `any`. Use proper types for IPC payloads and Playwright objects.

## 6. Troubleshooting

*   **"Waiting for debugger to disconnect":** Usually indicates a port collision. Check `electron-fixture.ts` port assignment logic.
*   **App fails to start:** Check `dist/main.js` exists (run `pnpm build`). Verify dependencies are installed.
*   **Selectors failing:** The UI might not be fully rendered. Ensure `waitForAppReady` helper is used.







