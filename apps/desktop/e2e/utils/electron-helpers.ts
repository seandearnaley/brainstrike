import { execSync } from 'node:child_process';
import path from 'node:path';
import { getCILaunchArgs } from '@brainstrike/config/playwright-environment';
import { getTestDirectoryStructure } from '@brainstrike/file-system';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';

declare const process: NodeJS.Process;

export interface ElectronAppContext {
  app: ElectronApplication;
  window: Page;
}

export async function launchElectronApp(debugPort?: number): Promise<ElectronAppContext> {
  const electronPath = require('electron');
  const mainPath = path.join(process.cwd(), 'dist', 'main.js');

  console.log('🚀 Launching Electron app...');
  if (debugPort) {
    console.log(`🔌 Using manual debug port: ${debugPort}`);
  }
  console.log('Electron path:', electronPath);
  console.log('Main path:', mainPath);

  // Kill any lingering processes to free up ports
  // Only perform global cleanup if we are NOT running with a specific debug port (sharded)
  // otherwise we might kill the electron instances of concurrent shards on the same host.
  if (!debugPort) {
    await killLingeringElectronProcesses();
  } else {
    console.log('ℹ️ Skipping global process cleanup (sharded execution detected)');
  }

  const launchOptions = createLaunchOptions(electronPath, mainPath, debugPort);
  const app = await startElectron(launchOptions);

  console.log('⏳ Waiting for first window...');
  const window = await app.firstWindow({ timeout: 30000 });
  await window.waitForLoadState('domcontentloaded');
  await setupDialogMocking(app);
  console.log('✅ Electron app launched successfully');
  return { app, window };
}

// a Helper to kill lingering Electron processes that might be holding ports
async function killLingeringElectronProcesses(): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      // macOS: Kill Electron processes that might be lingering
      execSync("pkill -9 -f 'Electron.*--test-mode' || true", { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      // Linux: Similar approach
      execSync("pkill -9 -f 'electron.*--test-mode' || true", { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      // Windows: Use taskkill
      execSync('taskkill /F /IM electron.exe /T 2>nul || exit 0', { stdio: 'ignore' });
    }
    // Give OS time to release resources
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log('✅ Cleaned up lingering processes');
  } catch (_error) {
    // Ignore errors - processes might not exist
    console.log('⚠️ No lingering processes to clean up');
  }
}

function createLaunchOptions(
  _electronPath: string,
  mainPath: string,
  debugPort?: number
): Parameters<typeof electron.launch>[0] {
  const ciArgs = getCILaunchArgs();
  const baseArgs = [
    mainPath,
    '--test-mode',
    '--disable-dialogs',
    // Note: Playwright automatically adds --remote-debugging-port=0 (dynamic port)
    // However, in sharded CI environments, this can cause collisions if isolation fails.
    // If a debugPort is provided, we explicitly set it to avoid collisions.
    ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : []),
    // Disable GPU to prevent crashes in CI
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ];
  const options: Parameters<typeof electron.launch>[0] = {
    args: [...baseArgs, ...ciArgs],
    env: {
      ...process.env,
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      ELECTRON_DISABLE_SANDBOX: '1',
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      ELECTRON_ENABLE_LOGGING: 'true',
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      BRAINSTRIKE_OPENAI_API_KEY: 'test-api-key-for-e2e-tests',
      // Ensure DISPLAY in Linux CI if not provided by runner; xvfb-maybe usually sets this
      ...(process.platform === 'linux' && process.env['CI'] && !process.env['DISPLAY']
        ? // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
          { DISPLAY: ':99' }
        : {}),
    },
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

    // Pipe stdout and stderr for debugging CI crashes
    const process = app.process();
    console.log('🔧 Attaching process listeners for stdout/stderr');

    process.stdout?.on('data', (data) => {
      console.log(`[Electron Stdout]: ${data.toString()}`);
    });
    process.stderr?.on('data', (data) => {
      console.error(`[Electron Stderr]: ${data.toString()}`);
    });

    process.on('exit', (code, signal) => {
      console.log(`[Electron Process Exit] Code: ${code}, Signal: ${signal}`);
    });

    app.on('close', () => {
      console.log('⚠️ Electron app closed unexpectedly');
    });
    return app;
  } catch (error) {
    console.error('❌ Failed to launch Electron app:', error);
    throw new Error(`Failed to launch Electron app: ${error}`);
  }
}

export async function closeElectronApp(appContext: ElectronAppContext): Promise<void> {
  console.log('🔒 Closing Electron app...');
  try {
    const windows = appContext.app.windows();
    console.log(`📋 Closing ${windows.length} window(s)...`);
    const windowClosePromises: Promise<void>[] = [];
    for (const window of windows) {
      if (window.isClosed()) {
        console.log('ℹ️ Window already closed');
        continue;
      }

      const closePromise = window.waitForEvent('close').then(
        () => {
          return;
        },
        (windowError) => {
          console.warn('⚠️ Window did not close gracefully:', windowError);
        }
      );
      windowClosePromises.push(closePromise);
      try {
        await window.close();
        console.log('✅ Requested window close');
      } catch (windowError) {
        console.warn('⚠️ Failed to close window gracefully:', windowError);
      }
    }

    const appClosed = appContext.app.waitForEvent('close');
    await Promise.all(windowClosePromises);
    await appContext.app.close();
    await appClosed;
    console.log('✅ Electron app closed');
  } catch (error) {
    console.error('❌ Error closing Electron app:', error);
    throw error;
  }
}

export async function waitForAppReady(page: Page): Promise<void> {
  try {
    // First check if the page is still open
    if (page.isClosed()) {
      throw new Error('Page was closed before app could become ready');
    }

    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 });

    const readinessCheck = () => {
      const readyFlag = Boolean(
        Reflect.get(window as unknown as Record<string, unknown>, '__BRAINSTRIKE_READY__')
      );
      if (!readyFlag) {
        return false;
      }

      const root = document.querySelector<HTMLElement>('#root');
      if (!root) {
        return false;
      }

      const { width, height } = root.getBoundingClientRect();
      if (width <= 0 || height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(root);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };

    const isCodex = process.env['CODEX_ENV'] === 'true';

    if (isCodex) {
      const pollInterval = 100;
      const maxAttempts = Math.ceil(30000 / pollInterval);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (page.isClosed()) {
          throw new Error('Page was closed while waiting for app to become ready');
        }

        const isReady = await page.evaluate(readinessCheck);
        if (isReady) {
          console.log('✅ App is ready and responsive (Codex environment)');
          return;
        }

        await page.waitForTimeout(pollInterval);
      }

      throw new Error('Timed out waiting for app readiness in Codex environment');
    }

    await page.waitForFunction(readinessCheck, { timeout: 30000, polling: 100 });
    console.log('✅ App is ready and responsive');
  } catch (error) {
    console.error('❌ Error waiting for app to be ready:', error);

    // Provide more context about the error
    if (
      error instanceof Error &&
      error.message.includes('Target page, context or browser has been closed')
    ) {
      throw new Error('App window was closed unexpectedly during initialization');
    }

    throw new Error(`App failed to become ready: ${error}`);
  }
}

export async function resetAppState(window: Page): Promise<void> {
  await window.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();

    // Clear persistent backend storage (electron-store/adapter)
    // This ensures no "last folder" state persists between tests
    const electronAPI = (
      window as unknown as {
        electronAPI?: { storage?: { clear?: () => Promise<void> } };
      }
    ).electronAPI;

    if (electronAPI?.storage?.clear) {
      try {
        await electronAPI.storage.clear();
        console.log('🔸 Backend storage cleared');
      } catch (error) {
        console.warn('🔸 Failed to clear backend storage:', error);
      }
    }
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
        return {
          id: 'mock-directory-handle',
          name: 'mock-test-directory',
          path: '/mock/test/directory',
          type: 'directory',
          kind: 'directory',
          platform: 'electron',
        };
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.exists = async (p: string) => {
        console.log('🔸 Mocked exists called with path:', p);
        return p.includes('/mock/');
      };
      // @ts-expect-error - runtime mock only
      electronAPI.fileSystem.readDirectory = async (_p: string) => {
        const rootPath = '/mock/test/directory';
        console.log('🔸 Mocked readDirectory called with path:', _p);
        return getTestDirectoryStructure(rootPath);
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
