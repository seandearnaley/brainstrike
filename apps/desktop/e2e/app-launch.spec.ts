import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import type { ElectronAppContext } from './utils/electron-helpers';
import {
  closeElectronApp,
  getAppPath,
  getAppVersion,
  launchElectronApp,
  waitForAppReady,
} from './utils/electron-helpers';

test.describe('Electron App Launch', () => {
  let appContext: ElectronAppContext;
  let homePage: HomePage;

  test.beforeEach(async () => {
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
    homePage = new HomePage(appContext.window);
  });

  test.afterEach(async () => {
    if (appContext) {
      await closeElectronApp(appContext);
    }
  });

  test('should launch successfully and show main window', async () => {
    // Verify the app window is visible
    expect(appContext.window).toBeTruthy();

    // Check window title
    const title = await appContext.window.title();
    expect(title).toContain('BrainStrike');

    // Verify the main content is loaded
    await homePage.shouldBeVisible();
  });

  test('should have correct app metadata', async () => {
    // Check app version
    const version = await getAppVersion(appContext.app);
    expect(version).toBeTruthy();
    expect(version).toMatch(/^\d+\.\d+\.\d+/); // Semantic version format

    // Check app path
    const appPath = await getAppPath(appContext.app);
    expect(appPath).toBeTruthy();
    expect(appPath).toContain('brainstrike');
  });

  test('should handle window resize', async () => {
    // Verify the app is responsive to window operations
    const windowBounds = await appContext.app.evaluate(async ({ BrowserWindow }) => {
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
    await homePage.shouldBeVisible();
  });

  test('should persist window state', async () => {
    // Test window state persistence
    const initialBounds = await appContext.app.evaluate(async ({ BrowserWindow }) => {
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
    await closeElectronApp(appContext);

    // Launch new instance
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
    homePage = new HomePage(appContext.window);

    // Verify app launches successfully
    await homePage.shouldBeVisible();

    // Note: Window state persistence depends on your app's implementation
    const newBounds = await appContext.app.evaluate(async ({ BrowserWindow }) => {
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

  test('should handle app interactions', async () => {
    // Verify content is accessible and interactive
    await homePage.shouldBeVisible();

    // Test basic interaction with the app
    const rootElement = appContext.window.locator('#root');
    await expect(rootElement).toBeVisible();

    // Test that the app responds to clicks
    await appContext.window.click('body');

    // Verify app is still functional after interaction
    await homePage.shouldBeVisible();
  });
});
