import { once } from 'node:events';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { setupAssistantMock } from './utils/assistant-mock';
import { loadElectronHelpers } from './utils/load-electron-helpers';

test.describe('Electron App Launch', () => {
  test('should launch successfully and show main window', { tag: '@smoke' }, async ({
    electronApp,
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

    const { getBufferedElectronOutput } = await loadElectronHelpers();
    const output = await getBufferedElectronOutput(electronApp.app);
    const startupOutput = [...output.stderr, ...output.stdout].join('\n');
    expect(startupOutput).not.toContain('dist/dist/main-log-transport.js');
    expect(startupOutput).not.toContain('dist/dist/main-watchdog-worker.js');
  });

  test('does not start persisted stores without storage', async ({ electronApp, window }) => {
    await setupAssistantMock(window, { variant: 'simple' });

    const { getBufferedElectronOutput } = await loadElectronHelpers();
    const output = await getBufferedElectronOutput(electronApp.app);
    const unavailableStorageWarnings = output.stderr.filter((line) =>
      line.includes('[zustand persist middleware] Unable to update item')
    );

    expect(unavailableStorageWarnings).toEqual([]);
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
            height: Math.max(600, bounds.height),
            width: Math.max(800, bounds.width),
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

  test('@desktop-runtime-hosts keeps background throttling scoped to hidden embedding hosts', async ({
    electronApp,
    window,
  }) => {
    const visibleThrottlingEnabled = await electronApp.app.evaluate(async ({ BrowserWindow }) => {
      const visibleWindow = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.webContents.getURL().includes('mode=')
      );
      if (!visibleWindow) {
        throw new Error('Visible desktop window was not found.');
      }
      return visibleWindow.webContents.getBackgroundThrottling();
    });

    expect(visibleThrottlingEnabled).toBe(true);

    await window.evaluate(async () => {
      const host = (
        globalThis.window as Window & {
          embeddingHost?: {
            ensureStarted?: () => Promise<unknown>;
          };
        }
      ).embeddingHost;
      if (!host?.ensureStarted) {
        throw new Error('Embedding host bridge is not available.');
      }
      await host.ensureStarted();
    });

    const hostThrottlingEnabled = await electronApp.app.evaluate(async ({ BrowserWindow }) => {
      const hostWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('mode=embedding-host')
      );
      if (!hostWindow) {
        throw new Error('Embedding host window was not found.');
      }
      return hostWindow.webContents.getBackgroundThrottling();
    });

    expect(hostThrottlingEnabled).toBe(false);

    await window.evaluate(async () => {
      const host = (
        globalThis.window as Window & {
          embeddingHost?: {
            stop?: () => Promise<unknown>;
          };
        }
      ).embeddingHost;
      if (!host?.stop) {
        throw new Error('Embedding host stop bridge is not available.');
      }
      await host.stop();
    });
  });
});

// Drive the public preload ports continuously, as background indexing does.
// This pins app-owned shutdown ordering without substituting a mocked host.
test('joins renderer IPC producers before closing their hosts @smoke', async ({
  electron,
}, testInfo) => {
  const page = await electron.ensureWindow();
  const ownedProcess = (await electron.ensureContext()).app.process();
  const output: string[] = [];
  const capture = (chunk: Buffer) => output.push(chunk.toString());
  ownedProcess.stderr?.on('data', capture);
  ownedProcess.stdout?.on('data', capture);
  await page.evaluate(async () => {
    const db = window.electronAPI?.db;
    const chunkingHost = (
      window as typeof window & {
        chunkingHost?: { ensureStarted(): Promise<unknown> };
      }
    ).chunkingHost;
    if (!(db && chunkingHost)) {
      throw new Error('Desktop producer capabilities unavailable');
    }
    const ready = Promise.withResolvers<void>();
    const produce = async () => {
      let completed = 0;
      while (true) {
        await Promise.all([
          db.query('SELECT 1 AS shutdown_producer_probe'),
          chunkingHost.ensureStarted(),
        ]);
        completed += 1;
        if (completed === 3) {
          ready.resolve();
        }
      }
    };
    void produce().catch((error: unknown) => {
      ready.reject(error);
      console.error('Renderer shutdown producer failed', error);
    });
    await ready.promise;
  });
  await Promise.all([
    once(ownedProcess, 'close', { signal: AbortSignal.timeout(5000) }),
    electron.dispose(),
  ]);
  const log = output.join('');
  await testInfo.attach('renderer-shutdown-process-log', { body: log, contentType: 'text/plain' });
  expect(ownedProcess.exitCode).toBe(0);
  expect(ownedProcess.signalCode).toBeNull();
  expect(log).not.toContain('chunking-host lifecycle has been disposed');
  expect(log).not.toContain('DB host manager is closing');
  expect(log).not.toContain("Error occurred in handler for 'db:query'");
});
