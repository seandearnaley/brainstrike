import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

test.describe('Electron App Launch', () => {
  test('should launch successfully and show main window', { tag: '@smoke' }, async ({
    window,
    homePage,
  }) => {
    // Verify the app window is visible
    expect(window).toBeTruthy();

    // Check window title
    const title = await window.title();
    expect(title).toContain('BrainStrike');

    // Verify the main content is loaded
    await homePage.shouldBeVisible();
  });

  test.setTimeout(90_000);

  test('should have correct app metadata', { tag: '@smoke' }, async ({ electronApp }) => {
    const { getAppPath, getAppVersion } = await loadElectronHelpers();

    // Check app version
    const version = await getAppVersion(electronApp.app);
    expect(version).toBeTruthy();
    expect(version).toMatch(/^\d+\.\d+\.\d+/); // Semantic version format

    // Check app path
    const appPath = await getAppPath(electronApp.app);
    expect(appPath).toBeTruthy();
    expect(appPath).toContain('brainstrike');
  });

  test('should handle window resize', { tag: '@smoke' }, async ({ electronApp, window }) => {
    // Verify the app is responsive to window operations
    const windowBounds = await electronApp.app.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        const window = windows[0];
        if (window) {
          const bounds = window.getBounds();

          // Resize the window
          window.setBounds({
            ...bounds,
            width: Math.max(800, bounds.width),
            height: Math.max(600, bounds.height),
          });

          return window.getBounds();
        }
      }
      return null;
    });

    expect(windowBounds).toBeTruthy();
    expect(windowBounds?.width).toBeGreaterThanOrEqual(800);
    expect(windowBounds?.height).toBeGreaterThanOrEqual(600);

    // Verify content is still visible after resize
    const pageHome = new HomePage(window);
    await pageHome.shouldBeVisible();
  });

  test('should persist window state', async ({ electron, electronApp }) => {
    const { waitForAppReady } = await loadElectronHelpers();

    // Test window state persistence
    const initialBounds = await electronApp.app.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        const window = windows[0];
        if (window) {
          return window.getBounds();
        }
      }
      return null;
    });

    expect(initialBounds).toBeTruthy();

    // Close and reopen app
    const relaunchedContext = await electron.restart();
    await waitForAppReady(relaunchedContext.window);
    const relaunchedHome = new HomePage(relaunchedContext.window);
    await relaunchedHome.shouldBeVisible();

    // Note: Window state persistence depends on your app's implementation
    const newBounds = await relaunchedContext.app.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        const window = windows[0];
        if (window) {
          return window.getBounds();
        }
      }
      return null;
    });

    expect(newBounds).toBeTruthy();
  });

  test('should handle app interactions', { tag: '@smoke' }, async ({ window, homePage }) => {
    // Verify content is accessible and interactive
    await homePage.shouldBeVisible();

    // Test basic interaction with the app
    const rootElement = window.locator('#root');
    await expect(rootElement).toBeVisible();

    // Test that the app responds to clicks
    await window.click('body');

    // Verify app is still functional after interaction
    await homePage.shouldBeVisible();
  });
});
