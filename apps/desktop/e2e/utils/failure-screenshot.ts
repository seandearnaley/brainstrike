import type { Page, TestInfo } from '@playwright/test';

/** Playwright's own screenshot timeout for its automatic captures. */
const SCREENSHOT_TIMEOUT_MS = 5000;

type FailureScreenshotTestInfo = Pick<
  TestInfo,
  'attach' | 'expectedStatus' | 'outputPath' | 'status'
>;

/**
 * BST-2239: the desktop E2E harness takes the failure screenshot itself, of the main
 * window, BEFORE it closes the app. Playwright's `screenshot` option ("Whether to
 * automatically capture a screenshot after each test", https://playwright.dev/docs/api/class-testoptions#test-options-screenshot)
 * is `'off'` for these Electron projects: with `'only-on-failure'` Playwright screenshots
 * every page of the closing app before it asks Main to quit, inside the harness's 10 s
 * close deadline, and on hosted windows-2025 a hidden window took 2.2-5 s to capture
 * (runs 39336738388 and 39345112384). An Electron trace records no visuals, so this keeps
 * the failure visual: written to the test's output and attached with `testInfo.attach`
 * (https://playwright.dev/docs/api/class-testinfo#test-info-attach). A capture that cannot
 * be taken is attached as its error, never skipped silently.
 */
export async function attachFailureScreenshot(
  window: Page | undefined,
  testInfo: FailureScreenshotTestInfo
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) {
    return;
  }
  if (!window || window.isClosed()) {
    await testInfo.attach('screenshot-unavailable', {
      body: 'The main window was already closed when the test failed.',
      contentType: 'text/plain',
    });
    return;
  }
  const path = testInfo.outputPath('test-failed-1.png');
  try {
    await window.screenshot({ path, timeout: SCREENSHOT_TIMEOUT_MS });
  } catch (error) {
    await testInfo.attach('screenshot-failed', {
      body: error instanceof Error ? (error.stack ?? error.message) : String(error),
      contentType: 'text/plain',
    });
    return;
  }
  await testInfo.attach('screenshot', { contentType: 'image/png', path });
}
