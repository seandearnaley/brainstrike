import { once } from 'node:events';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { setupAssistantMock } from './utils/assistant-mock';
import { resolveDesktopE2eTarget } from './utils/desktop-e2e-target';
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

  // A launch through a shell left Playwright holding cmd.exe, so its Windows force close was a
  // `taskkill /T` from that pid, which also walks into processes whose dead parent's pid it reused.
  test('the launched process is the app itself', async ({ electronApp }) => {
    const mainPid = await electronApp.app.evaluate(() => process.pid);
    expect(electronApp.app.process().pid).toBe(mainPid);
  });

  test('does not start persisted stores without storage', async ({ electronApp, window }) => {
    await setupAssistantMock(window);

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
    expect(version).toMatch(/^\d+\.\d+\.\d+/u); // Semantic version format

    // The app path is the bundle Electron loaded: the dev entry's folder, or
    // the packaged app.asar. It names no checkout folder.
    const appPath = await getAppPath(electronApp.app);
    if (resolveDesktopE2eTarget().kind === 'packaged') {
      expect(path.basename(appPath)).toBe('app.asar');
    } else {
      expect(appPath).toBe(path.resolve(import.meta.dirname, '..', 'dist'));
    }
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

  test('@desktop-runtime-hosts runs only its visible window, with background throttling on', async ({
    electronApp,
  }) => {
    const windows = await electronApp.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((candidate) => ({
        backgroundThrottling: candidate.webContents.getBackgroundThrottling(),
        hostMode: new URL(candidate.webContents.getURL()).searchParams.get('mode'),
      }))
    );

    expect(windows).toEqual([{ backgroundThrottling: true, hostMode: null }]);
  });
});

// Drive the public preload ports continuously, as background indexing does. Quit joins only
// the document's durable writers (ADR-0026 R1), never these producers: they run until their
// window closes, which quit does before it retires any host they call. Observed: every read
// they issue after quit starts still succeeds, so none is refused and none fails.
test('renderer IPC producers are not joined at quit: they run until their window closes and the app exits 0 with no error record @smoke', async ({
  electron,
}, testInfo) => {
  const page = await electron.ensureWindow();
  const ownedProcess = (await electron.ensureContext()).app.process();
  const output: string[] = [];
  const producerErrors: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('Renderer shutdown producer failed')) {
      producerErrors.push(message.text());
    }
  });
  const capture = (chunk: Buffer) => output.push(chunk.toString());
  ownedProcess.stderr?.on('data', capture);
  ownedProcess.stdout?.on('data', capture);
  await page.evaluate(async () => {
    const catalog = window.modelCatalog;
    if (!catalog) {
      throw new Error('Desktop producer capabilities unavailable');
    }
    const ready = Promise.withResolvers<void>();
    const produce = async () => {
      let completed = 0;
      while (true) {
        await catalog.read().then((result) => {
          if (!result.ok) {
            throw new Error(
              `${result.error.category}/${result.error.code}: ${result.error.message}`
            );
          }
          return result.value;
        });
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
  try {
    // 'close' follows the exit once the process's output streams have ended.
    await Promise.all([once(ownedProcess, 'close'), electron.dispose()]);
  } finally {
    // Preserve the original failure's output even when close rejects.
    await testInfo.attach('renderer-shutdown-process-log', {
      body: output.join(''),
      contentType: 'text/plain',
    });
  }
  const log = output.join('');
  expect(ownedProcess.exitCode).toBe(0);
  expect(ownedProcess.signalCode).toBeNull();
  expect(producerErrors).toEqual([]);
  const errorRecords = log
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { level?: number; msg?: string })
    .filter((record) => (record.level ?? 0) >= 50);
  expect(errorRecords).toEqual([]);
  expect(log).not.toContain('DB host manager is closing');
  expect(log).not.toContain("Error occurred in handler for 'db:query'");
});
