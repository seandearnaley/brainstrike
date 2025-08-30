import path from 'node:path';
import { getCILaunchArgs } from '@brainstrike/config/playwright-environment';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';

declare const process: NodeJS.Process;

export interface ElectronAppContext {
  app: ElectronApplication;
  window: Page;
}

export async function launchElectronApp(): Promise<ElectronAppContext> {
  const electronPath = require('electron');
  const mainPath = path.join(process.cwd(), 'dist', 'main.js');

  console.log('🚀 Launching Electron app...');
  console.log('Electron path:', electronPath);
  console.log('Main path:', mainPath);

  const launchOptions = createLaunchOptions(electronPath, mainPath);
  const app = await startElectron(launchOptions);
  const { app: stableApp, window } = await getFirstWindowWithRecovery(app, launchOptions);
  await window.waitForLoadState('domcontentloaded');
  await setupDialogMocking(stableApp);
  console.log('✅ Electron app launched successfully');
  return { app: stableApp, window };
}

function createLaunchOptions(
  _electronPath: string,
  mainPath: string
): Parameters<typeof electron.launch>[0] {
  const ciArgs = getCILaunchArgs();
  const baseArgs = [
    mainPath,
    '--test-mode',
    '--disable-dialogs',
    // Ensure a concrete remote debugging port to satisfy some Electron builds
    '--remote-debugging-port=9222',
  ];
  const options: Parameters<typeof electron.launch>[0] = {
    args: [...baseArgs, ...ciArgs],
    // Let Playwright use its managed Electron binary unless explicitly needed
    timeout: 90000,
  };
  if (!process.env.CI) {
    options.recordVideo = {
      dir: 'test-results/videos',
      size: { width: 1280, height: 720 },
    };
  }
  return options;
}

async function startElectron(launchOptions: Parameters<typeof electron.launch>[0]) {
  try {
    const app = await electron.launch(launchOptions);
    app.on('close', () => {
      console.log('⚠️ Electron app closed unexpectedly');
    });
    return app;
  } catch (error) {
    console.error('❌ Failed to launch Electron app:', error);
    throw new Error(`Failed to launch Electron app: ${error}`);
  }
}

function isCrashError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Target page, context or browser has been closed') ||
    message.includes('Browser closed') ||
    message.includes('Connection closed')
  );
}

async function relaunchApp(
  current: ElectronApplication,
  launchOptions: Parameters<typeof electron.launch>[0]
) {
  try {
    await current.close();
    console.log('✅ Closed crashed app');
  } catch (closeError) {
    console.error('❌ Failed to close crashed app:', closeError);
  }
  await new Promise((r) => setTimeout(r, 3000));
  const relaunched = await startElectron(launchOptions);
  console.log('✅ Relaunched app after crash');
  return relaunched;
}

async function getFirstWindowWithRecovery(
  initialApp: ElectronApplication,
  launchOptions: Parameters<typeof electron.launch>[0]
): Promise<{ app: ElectronApplication; window: Page }> {
  let app = initialApp;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await delayForAttempt(attempt, maxRetries);
      const window = await app.firstWindow();
      console.log('✅ Successfully got first window');
      return { app, window };
    } catch (error) {
      console.error(`❌ Failed to get first window (attempt ${attempt + 1}):`, error);
      const relaunched = await relaunchIfCrash(app, error, attempt, maxRetries, launchOptions);
      if (relaunched) {
        app = relaunched;
        continue;
      }
      const fallback = pickAvailableWindow(app);
      if (fallback) return { app, window: fallback };
      if (attempt === maxRetries - 1)
        throw new Error('Failed to get first window after multiple attempts');
    }
  }
  throw new Error('No window found after launching Electron app');
}

function pickAvailableWindow(app: ElectronApplication): Page | undefined {
  const windows = app.windows();
  console.log(`🔍 Available windows: ${windows.length}`);
  return windows[0];
}

async function delayForAttempt(attempt: number, maxRetries: number): Promise<void> {
  if (attempt === 0) return;
  const waitMs = Math.min(2000 + attempt * 2000, 8000);
  console.log(`🔄 Retry ${attempt}/${maxRetries} - waiting ${waitMs}ms for app init...`);
  await new Promise((r) => setTimeout(r, waitMs));
}

async function relaunchIfCrash(
  app: ElectronApplication,
  error: unknown,
  attempt: number,
  maxRetries: number,
  launchOptions: Parameters<typeof electron.launch>[0]
): Promise<ElectronApplication | null> {
  if (!isCrashError(error) || attempt >= maxRetries - 1) return null;
  return await relaunchApp(app, launchOptions);
}

export async function closeElectronApp(appContext: ElectronAppContext): Promise<void> {
  console.log('🔒 Closing Electron app...');
  try {
    const windows = appContext.app.windows();
    console.log(`📋 Closing ${windows.length} window(s)...`);
    for (const window of windows) {
      try {
        await window.close();
        console.log('✅ Window closed successfully');
      } catch (windowError) {
        console.warn('⚠️ Failed to close window gracefully:', windowError);
      }
    }
    await appContext.app.close();
    console.log('✅ Electron app closed');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error) {
    console.error('❌ Error closing Electron app:', error);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export async function waitForAppReady(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 });
    const isCodex = process.env['CODEX_ENV'] === 'true';
    const baseWaitTime = isCodex ? 3000 : 1000;
    const extendedWaitTime = baseWaitTime + 2000;
    console.log(`⏱️ Waiting ${extendedWaitTime}ms for app to be fully ready...`);
    await page.waitForTimeout(extendedWaitTime);
    await page.evaluate(() => {
      return document.readyState === 'complete' && window.innerWidth > 0;
    });
    console.log('✅ App is ready and responsive');
  } catch (error) {
    console.error('❌ Error waiting for app to be ready:', error);
    throw new Error(`App failed to become ready: ${error}`);
  }
}

export async function resetAppState(window: Page): Promise<void> {
  await window.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

export async function getAppVersion(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async ({ app }) => {
    return app.getVersion();
  });
}

export async function getAppPath(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async ({ app }) => {
    return app.getAppPath();
  });
}

export async function triggerMenuAction(app: ElectronApplication, menuId: string): Promise<void> {
  await app.evaluate(async ({ Menu }, id) => {
    const menu = Menu.getApplicationMenu();
    if (menu) {
      const menuItem = menu.getMenuItemById(id);
      if (menuItem) menuItem.click();
    }
  }, menuId);
}

export async function waitForNewWindow(app: ElectronApplication): Promise<Page> {
  const windowPromise = app.waitForEvent('window');
  return await windowPromise;
}

export async function isDevMode(app: ElectronApplication): Promise<boolean> {
  return await app.evaluate(async ({ app }) => {
    return !app.isPackaged;
  });
}

export async function setupDialogMocking(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ dialog }) => {
    dialog.showOpenDialog = async (options) => {
      console.log('🔸 Mocked showOpenDialog called with options:', options);
      return { canceled: false, filePaths: ['/mock/test/directory'] };
    };
    dialog.showSaveDialog = async (options) => {
      console.log('🔸 Mocked showSaveDialog called with options:', options);
      return { canceled: false, filePath: '/mock/test/file.txt' };
    };
    dialog.showMessageBox = async (options) => {
      console.log('🔸 Mocked showMessageBox called with options:', options);
      return { response: 0, checkboxChecked: false };
    };
    dialog.showErrorBox = (title, content) => {
      console.log('🔸 Mocked showErrorBox called:', { title, content });
    };
    if (dialog.showCertificateTrustDialog) {
      dialog.showCertificateTrustDialog = async (...args: unknown[]) => {
        console.log('🔸 Mocked showCertificateTrustDialog called with args:', args);
      };
    }
  });
}

export async function mockFileSystemOperations(window: Page): Promise<void> {
  await window.evaluate(() => {
    const electronAPI = (
      window as unknown as {
        electronAPI?: { fileSystem?: Record<string, unknown> };
      }
    ).electronAPI;

    if (electronAPI?.fileSystem) {
      console.log('🔸 Setting up file system API mocks...');
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.requestDirectoryAccess = async () => {
        console.log('🔸 Mocked requestDirectoryAccess called');
        return '/mock/test/directory';
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.exists = async (p: string) => {
        console.log('🔸 Mocked exists called with path:', p);
        return p.includes('/mock/');
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.readDirectory = async (_p: string) => {
        console.log('🔸 Mocked readDirectory called with path:', _p);
        return ['mock-file1.txt', 'mock-file2.txt', 'mock-folder/'];
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.readFile = async (_p: string) => {
        console.log('🔸 Mocked readFile called with path:', _p);
        return 'Mock file content for testing';
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.writeFile = async (p: string, content: string) => {
        console.log('🔸 Mocked writeFile called with path:', p, 'content length:', content.length);
        return true;
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.watchDirectory = async (p: string) => {
        console.log('🔸 Mocked watchDirectory called with path:', p);
        return { unwatch: () => console.log('🔸 Mocked unwatch called') };
      };
    } else {
      console.log('🔸 No electronAPI.fileSystem found to mock');
    }

    const w = window as unknown as { showDirectoryPicker?: () => Promise<unknown> };
    if (w.showDirectoryPicker) {
      w.showDirectoryPicker = async () => {
        console.log('🔸 Mocked showDirectoryPicker called');
        return { name: 'mock-directory', kind: 'directory' };
      };
    }
  });
}
