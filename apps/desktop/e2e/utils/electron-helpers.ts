import path from 'node:path';
import { getCILaunchArgs } from '@brainstrike/config/playwright-environment';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';

declare const process: NodeJS.Process;

export interface ElectronAppContext {
  app: ElectronApplication;
  window: Page;
}

/**
 * Launch the Electron app for testing
 */
export async function launchElectronApp(): Promise<ElectronAppContext> {
  const electronPath = require('electron');
  const mainPath = path.join(process.cwd(), 'dist', 'main.js');

  console.log('🚀 Launching Electron app...');
  console.log('Electron path:', electronPath);
  console.log('Main path:', mainPath);

  // Get CI-optimized launch arguments
  const ciArgs = getCILaunchArgs();
  const baseArgs = [mainPath, '--test-mode', '--disable-dialogs'];
  // Force software GL to avoid headless GPU stalls in CI
  const glArgs = ['--use-gl=swiftshader'];

  const launchOptions: Parameters<typeof electron.launch>[0] = {
    args: [...baseArgs, ...ciArgs, ...glArgs],
    executablePath: electronPath,
    // Keep a tight launch timeout to fail fast
    timeout: 20000,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'test',
    },
  };

  // Only record video when not in CI to prevent window popups
  if (!process.env.CI) {
    launchOptions.recordVideo = {
      dir: 'test-results/videos',
      size: { width: 1280, height: 720 },
    };
  }

  let app;
  try {
    app = await electron.launch(launchOptions);
  } catch (error) {
    console.error('❌ Failed to launch Electron app:', error);
    throw new Error(`Failed to launch Electron app: ${error}`);
  }

  // Add error logging for app crashes
  app.on('close', () => {
    console.log('⚠️ Electron app closed unexpectedly');
  });

  // Wait for the first window to be created with better error handling
  let window: Page | undefined;
  let retryCount = 0;
  const maxRetries = 3;

  while (retryCount < maxRetries) {
    try {
      // Wait progressively longer for subsequent retries, especially important for restart scenarios
      if (retryCount > 0) {
        const waitTime = Math.min(500 + retryCount * 500, 1500); // 0.5s, 1s, 1.5s
        console.log(
          `🔄 Retry ${retryCount}/${maxRetries} - waiting ${waitTime}ms for app to initialize...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      // Use longer timeout for window creation on retries (restart scenarios)
      const windowTimeout = retryCount > 0 ? 15000 : 10000;
      console.log(`⏱️ Waiting for first window (timeout: ${windowTimeout}ms)...`);

      // Prefer explicit window event; fallback to polling to avoid event race
      try {
        const evt = await app.waitForEvent('window', { timeout: windowTimeout });
        window = evt;
        console.log('✅ Got first window via waitForEvent("window")');
      } catch {
        // Poll windows() for up to the same timeout in 500ms steps
        const start = Date.now();
        while (!window && Date.now() - start < windowTimeout) {
          const wins = app.windows();
          if (wins.length > 0) {
            window = wins[0];
            console.log(`✅ Found window via polling (count=${wins.length})`);
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!window) throw new Error('No window after waitForEvent and polling');
      }
      break;
    } catch (error) {
      console.error(`❌ Failed to get first window (attempt ${retryCount + 1}):`, error);

      // If the error indicates the app crashed, we need to restart the app entirely
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAppCrashed =
        errorMessage.includes('Target page, context or browser has been closed') ||
        errorMessage.includes('Browser closed') ||
        errorMessage.includes('Connection closed');

      if (isAppCrashed && retryCount < maxRetries - 1) {
        console.log('🔄 App appears to have crashed, attempting full restart...');
        try {
          await app.close();
          console.log('✅ Closed crashed app');
        } catch (closeError) {
          console.error('❌ Failed to close crashed app:', closeError);
        }

        // Wait before relaunching
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Relaunch the app
        try {
          app = await electron.launch(launchOptions);
          console.log('✅ Relaunched app after crash');
          // Count this as another attempt instead of resetting, to avoid infinite loops
          retryCount++;
          continue;
        } catch (relaunchError) {
          console.error('❌ Failed to relaunch app:', relaunchError);
          retryCount++;
          continue;
        }
      }

      // Try to get any available windows for non-crash errors
      const windows = app.windows();
      console.log(`🔍 Available windows: ${windows.length}`);

      if (windows.length > 0) {
        const firstWindow = windows[0];
        if (firstWindow) {
          window = firstWindow;
          console.log('✅ Using first available window');
          break;
        }
      }

      retryCount++;
      if (retryCount >= maxRetries) {
        console.error('❌ Exhausted all retries, app may have crashed');
        // Try to close the app gracefully
        try {
          await app.close();
          console.log('✅ Closed failed app');
        } catch (closeError) {
          console.error('❌ Failed to close app:', closeError);
        }
        throw new Error(
          'No windows available after retries - app may have crashed during initialization'
        );
      }
    }
  }

  // Ensure window was assigned
  if (!window) {
    throw new Error('Window was not assigned after retry logic - this should not happen');
  }

  // Wait for the app to be ready
  await window.waitForLoadState('domcontentloaded');

  // Set up dialog mocking to prevent native dialogs from blocking tests
  await setupDialogMocking(app);

  console.log('✅ Electron app launched successfully');

  return { app, window };
}

/**
 * Close the Electron app
 */
export async function closeElectronApp(appContext: ElectronAppContext): Promise<void> {
  console.log('🔒 Closing Electron app...');
  try {
    // First, try to close all windows gracefully
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

    // Then close the app
    await appContext.app.close();
    console.log('✅ Electron app closed');

    // Add extended delay for cleanup, especially important for restart scenarios
    // This ensures all processes are fully terminated and resources are released
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error) {
    console.error('❌ Error closing Electron app:', error);
    // Still try to wait for any cleanup processes
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Wait for the app to be fully loaded and ready
 */
export async function waitForAppReady(window: Page): Promise<void> {
  try {
    // Wait for React to be ready
    await window.waitForFunction(
      () => {
        return document.readyState === 'complete';
      },
      { timeout: 30000 }
    );

    // Increase wait time for Codex environment and restart scenarios
    const isCodex = process.env['CODEX_ENV'] === 'true';
    const baseWaitTime = isCodex ? 3000 : 1000;

    // Add extra time for potential restart scenarios (detected by checking if this is a subsequent call)
    const extendedWaitTime = baseWaitTime + 2000; // Add 2 seconds for restart scenarios

    console.log(`⏱️ Waiting ${extendedWaitTime}ms for app to be fully ready...`);
    await window.waitForTimeout(extendedWaitTime);

    // Verify the window is still responsive
    await window.evaluate(() => {
      return document.readyState === 'complete' && (window as any).innerWidth > 0;
    });

    console.log('✅ App is ready and responsive');
  } catch (error) {
    console.error('❌ Error waiting for app to be ready:', error);
    throw new Error(`App failed to become ready: ${error}`);
  }
}

/**
 * Reset app state by clearing localStorage and sessionStorage
 */
export async function resetAppState(window: Page): Promise<void> {
  await window.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

/**
 * Get app version from the main process
 */
export async function getAppVersion(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async ({ app }) => {
    return app.getVersion();
  });
}

/**
 * Get app path from the main process
 */
export async function getAppPath(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async ({ app }) => {
    return app.getAppPath();
  });
}

/**
 * Simulate app menu action
 */
export async function triggerMenuAction(app: ElectronApplication, menuId: string): Promise<void> {
  await app.evaluate(async ({ Menu }, menuId) => {
    const menu = Menu.getApplicationMenu();
    if (menu) {
      const menuItem = menu.getMenuItemById(menuId);
      if (menuItem) {
        menuItem.click();
      }
    }
  }, menuId);
}

/**
 * Wait for a new window to be created (useful for modal dialogs)
 */
export async function waitForNewWindow(app: ElectronApplication): Promise<Page> {
  const windowPromise = app.waitForEvent('window');
  return await windowPromise;
}

/**
 * Check if the app is running in development mode
 */
export async function isDevMode(app: ElectronApplication): Promise<boolean> {
  return await app.evaluate(async ({ app }) => {
    return !app.isPackaged;
  });
}

/**
 * Setup dialog mocking to prevent native dialogs from blocking tests
 */
export async function setupDialogMocking(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ dialog }) => {
    // Store original methods in case they're needed
    // const originalShowOpenDialog = dialog.showOpenDialog;
    // const originalShowSaveDialog = dialog.showSaveDialog;
    // const originalShowMessageBox = dialog.showMessageBox;
    // const originalShowErrorBox = dialog.showErrorBox;

    // Mock showOpenDialog to return a predefined result
    dialog.showOpenDialog = async (options) => {
      console.log('🔸 Mocked showOpenDialog called with options:', options);

      // Return a mock directory path for testing
      return {
        canceled: false,
        filePaths: ['/mock/test/directory'],
      };
    };

    // Mock showSaveDialog
    dialog.showSaveDialog = async (options) => {
      console.log('🔸 Mocked showSaveDialog called with options:', options);

      return {
        canceled: false,
        filePath: '/mock/test/file.txt',
      };
    };

    // Mock showMessageBox
    dialog.showMessageBox = async (options) => {
      console.log('🔸 Mocked showMessageBox called with options:', options);

      return {
        response: 0, // First button (usually OK/Yes)
        checkboxChecked: false,
      };
    };

    // Mock showErrorBox (this is synchronous)
    dialog.showErrorBox = (title, content) => {
      console.log('🔸 Mocked showErrorBox called:', { title, content });
      // Just log the error, don't show a dialog
    };

    // Mock showCertificateTrustDialog if it exists
    if (dialog.showCertificateTrustDialog) {
      dialog.showCertificateTrustDialog = async (...args: any[]) => {
        console.log('🔸 Mocked showCertificateTrustDialog called with args:', args);
        // This method doesn't return anything according to Electron docs
      };
    }
  });
}

/**
 * Mock file system operations for testing
 */
export async function mockFileSystemOperations(window: Page): Promise<void> {
  await window.evaluate(() => {
    // Mock the electronAPI file system methods if they exist
    const electronAPI = (window as any).electronAPI;
    if (electronAPI?.fileSystem) {
      console.log('🔸 Setting up file system API mocks...');

      electronAPI.fileSystem.requestDirectoryAccess = async () => {
        console.log('🔸 Mocked requestDirectoryAccess called');
        return '/mock/test/directory';
      };

      electronAPI.fileSystem.exists = async (path: string) => {
        console.log('🔸 Mocked exists called with path:', path);
        // Return true for mock paths, false for others
        return path.includes('/mock/');
      };

      electronAPI.fileSystem.readDirectory = async (path: string) => {
        console.log('🔸 Mocked readDirectory called with path:', path);
        return ['mock-file1.txt', 'mock-file2.txt', 'mock-folder/'];
      };

      electronAPI.fileSystem.readFile = async (path: string) => {
        console.log('🔸 Mocked readFile called with path:', path);
        return 'Mock file content for testing';
      };

      electronAPI.fileSystem.writeFile = async (path: string, content: string) => {
        console.log(
          '🔸 Mocked writeFile called with path:',
          path,
          'content length:',
          content.length
        );
        return true;
      };

      electronAPI.fileSystem.watchDirectory = async (path: string) => {
        console.log('🔸 Mocked watchDirectory called with path:', path);
        return { unwatch: () => console.log('🔸 Mocked unwatch called') };
      };
    } else {
      console.log('🔸 No electronAPI.fileSystem found to mock');
    }

    // Also mock any global file picker functions if they exist
    if ((window as any).showDirectoryPicker) {
      (window as any).showDirectoryPicker = async () => {
        console.log('🔸 Mocked showDirectoryPicker called');
        return {
          name: 'mock-directory',
          kind: 'directory',
        };
      };
    }
  });
}
