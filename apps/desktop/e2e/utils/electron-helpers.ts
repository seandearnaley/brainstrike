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

export async function launchElectronApp(
  debugPort?: number,
  userDataDir?: string
): Promise<ElectronAppContext> {
  const electronPath = require('electron');
  const mainPath = path.join(process.cwd(), 'dist', 'main.js');

  console.log('🚀 Launching Electron app...');

  // #region agent log - Hypothesis A: V8 Inspector check
  console.log('[DEBUG][HYP-A] NODE_OPTIONS:', process.env['NODE_OPTIONS'] ?? '<not set>');
  console.log('[DEBUG][HYP-A] NODE_DEBUG:', process.env['NODE_DEBUG'] ?? '<not set>');
  console.log(
    '[DEBUG][HYP-A] ELECTRON_ENABLE_STACK_DUMPING:',
    process.env['ELECTRON_ENABLE_STACK_DUMPING'] ?? '<not set>'
  );
  // #endregion

  // #region agent log - Hypothesis C: DISPLAY check
  console.log('[DEBUG][HYP-C] DISPLAY:', process.env['DISPLAY'] ?? '<not set>');
  console.log('[DEBUG][HYP-C] WAYLAND_DISPLAY:', process.env['WAYLAND_DISPLAY'] ?? '<not set>');
  console.log('[DEBUG][HYP-C] XDG_SESSION_TYPE:', process.env['XDG_SESSION_TYPE'] ?? '<not set>');
  // #endregion

  if (debugPort) {
    console.log(`🔌 Requesting manual debug port: ${debugPort}`);
    // #region agent log - Hypothesis B: Port availability check
    try {
      const net = require('node:net');
      await new Promise<void>((resolve, reject) => {
        const testServer = net.createServer();
        testServer.once('error', (err: NodeJS.ErrnoException) => {
          console.log(`[DEBUG][HYP-B] Port ${debugPort} check FAILED: ${err.code}`);
          reject(err);
        });
        testServer.once('listening', () => {
          testServer.close(() => {
            console.log(`[DEBUG][HYP-B] Port ${debugPort} is AVAILABLE`);
            resolve();
          });
        });
        testServer.listen(debugPort, '127.0.0.1');
      });
    } catch (_portError) {
      console.error(
        `[DEBUG][HYP-B] Port ${debugPort} is IN USE or blocked - this may cause launch failure`
      );
    }
    // #endregion
  }
  if (userDataDir) {
    console.log(`📂 Using custom user data dir: ${userDataDir}`);
  }
  console.log('Electron path:', electronPath);
  console.log('Main path:', mainPath);

  // Kill any lingering processes to free up ports
  // Only perform global cleanup if we are NOT running with a specific debug port (sharded)
  // otherwise we might kill the electron instances of concurrent shards on the same host.
  if (!debugPort) {
    await killLingeringElectronProcesses();
  } else {
    console.log(`ℹ️ Cleaning up any processes bound to port ${debugPort}...`);
    await killSpecificElectronProcess(debugPort);
  }

  const launchOptions = createLaunchOptions(electronPath, mainPath, debugPort, userDataDir);
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

async function killSpecificElectronProcess(debugPort: number): Promise<void> {
  try {
    const pattern = `remote-debugging-port=${debugPort}`;
    if (process.platform === 'darwin' || process.platform === 'linux') {
      execSync(`pkill -9 -f '${pattern}' || true`, { stdio: 'ignore' });
    }
    // Give OS time to release resources
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(`✅ Cleaned up processes on port ${debugPort}`);
  } catch (_error) {
    console.log(`⚠️ No processes found on port ${debugPort} to clean up`);
  }
}

function createLaunchOptions(
  _electronPath: string,
  mainPath: string,
  debugPort?: number,
  userDataDir?: string
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
    // Explicitly set user data dir to avoid collisions in shared environments
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    // Disable GPU to prevent crashes in CI
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ];

  // #region agent log - Hypothesis C: DISPLAY resolution logic
  const currentDisplay = process.env['DISPLAY'];
  const isLinuxCI = process.platform === 'linux' && process.env['CI'];
  const needsDisplayFallback = isLinuxCI && !currentDisplay;
  console.log('[DEBUG][HYP-C] DISPLAY resolution:', {
    platform: process.platform,
    isCI: Boolean(process.env['CI']),
    currentDisplay: currentDisplay ?? '<not set>',
    needsDisplayFallback,
    willUseFallback: needsDisplayFallback ? ':99' : 'N/A',
  });
  // #endregion

  const options: Parameters<typeof electron.launch>[0] = {
    args: [...baseArgs, ...ciArgs],
    env: {
      ...process.env,
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      ELECTRON_DISABLE_SANDBOX: '1',
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      ELECTRON_ENABLE_LOGGING: 'true',
      // Force console logging and disable file logging to avoid contention/permissions issues
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      BRAINSTRIKE_OPENAI_API_KEY: 'test-api-key-for-e2e-tests',
      // #region agent log - Hypothesis A: Explicitly clear NODE_OPTIONS to prevent V8 inspector issues
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      NODE_OPTIONS: '', // Clear any inherited NODE_OPTIONS that might enable --inspect
      // #endregion
      // Ensure DISPLAY in Linux CI if not provided by runner; xvfb-maybe usually sets this
      ...(needsDisplayFallback
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

// #region agent log - Hypothesis F: Pre-flight Electron binary check
function runPreflightElectronCheck(displayEnv: string | undefined): void {
  if (process.platform !== 'linux' || !process.env['CI']) {
    return;
  }

  const electronBinaryPath = require('electron');
  const fs = require('node:fs');
  const { execSync } = require('node:child_process');

  console.log('[DEBUG][HYP-F] Checking Electron binary...');
  console.log('[DEBUG][HYP-F] Binary path:', electronBinaryPath);

  try {
    const stats = fs.statSync(electronBinaryPath);
    console.log('[DEBUG][HYP-F] Binary exists, size:', stats.size);
    console.log('[DEBUG][HYP-F] Binary mode:', stats.mode.toString(8));
  } catch (statErr) {
    console.error('[DEBUG][HYP-F] Cannot stat binary:', statErr);
  }

  // Check for missing libraries using ldd
  try {
    const lddOutput = execSync(`ldd "${electronBinaryPath}" 2>&1 | grep -i "not found"`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (lddOutput.trim()) {
      console.error('[DEBUG][HYP-F] MISSING LIBRARIES DETECTED:');
      console.error(lddOutput);
    }
  } catch (lddErr) {
    // grep returns exit code 1 when no matches - that's good (no missing libs)
    if ((lddErr as { status?: number }).status === 1) {
      console.log('[DEBUG][HYP-F] No missing libraries detected');
    } else {
      console.log('[DEBUG][HYP-F] ldd check inconclusive:', (lddErr as Error).message);
    }
  }

  // Try to run electron --version to verify it can execute
  try {
    const versionOutput = execSync(`"${electronBinaryPath}" --version 2>&1`, {
      encoding: 'utf8',
      timeout: 10000,
      // biome-ignore lint/style/useNamingConvention: Environment variable names must be uppercase
      env: { ...process.env, DISPLAY: displayEnv ?? process.env['DISPLAY'] },
    });
    console.log('[DEBUG][HYP-F] Electron version check:', versionOutput.trim());
  } catch (versionErr) {
    console.error('[DEBUG][HYP-F] Electron version check FAILED:', (versionErr as Error).message);
  }
}
// #endregion

async function startElectron(launchOptions: Parameters<typeof electron.launch>[0]) {
  // #region agent log - Hypothesis D: Pre-launch diagnostics
  console.log('[DEBUG][HYP-D] Pre-launch diagnostics:');
  console.log('[DEBUG][HYP-D] Platform:', process.platform);
  console.log('[DEBUG][HYP-D] Arch:', process.arch);
  console.log('[DEBUG][HYP-D] CI:', process.env['CI'] ?? '<not set>');
  console.log('[DEBUG][HYP-D] GITHUB_ACTIONS:', process.env['GITHUB_ACTIONS'] ?? '<not set>');
  console.log('[DEBUG][HYP-D] Launch args:', JSON.stringify(launchOptions?.args ?? []));
  console.log('[DEBUG][HYP-D] Launch env keys:', Object.keys(launchOptions?.env ?? {}).join(', '));
  // #endregion

  // Run pre-flight check for Linux CI environments
  runPreflightElectronCheck(launchOptions?.env?.['DISPLAY']);

  const launchStartTime = Date.now();
  try {
    console.log('[DEBUG] Calling electron.launch() at', new Date().toISOString());
    const app = await electron.launch(launchOptions);
    console.log('[DEBUG] electron.launch() returned after', Date.now() - launchStartTime, 'ms');

    // Pipe stdout and stderr for debugging CI crashes
    const electronProcess = app.process();
    const pid = electronProcess.pid;
    console.log(`🔧 Attaching process listeners for stdout/stderr (PID: ${pid})`);

    // #region agent log - Hypothesis G: Verify stdio pipe status
    console.log(
      '[DEBUG][HYP-G] stdout pipe:',
      electronProcess.stdout ? 'available' : 'NOT AVAILABLE'
    );
    console.log(
      '[DEBUG][HYP-G] stderr pipe:',
      electronProcess.stderr ? 'available' : 'NOT AVAILABLE'
    );
    console.log(
      '[DEBUG][HYP-G] stdin pipe:',
      electronProcess.stdin ? 'available' : 'NOT AVAILABLE'
    );
    // #endregion

    let stdoutReceived = false;
    let stderrReceived = false;

    // #region agent log - Hypothesis A: Check for V8 inspector messages
    electronProcess.stdout?.on('data', (data) => {
      if (!stdoutReceived) {
        console.log(
          '[DEBUG][HYP-G] First stdout data received at',
          Date.now() - launchStartTime,
          'ms'
        );
        stdoutReceived = true;
      }
      const str = data.toString();
      console.log(`[Electron Stdout]: ${str}`);
      if (str.includes('debugger') || str.includes('inspector') || str.includes('Debugger')) {
        console.log('[DEBUG][HYP-A] V8 Inspector activity detected in stdout');
      }
    });
    electronProcess.stderr?.on('data', (data) => {
      if (!stderrReceived) {
        console.log(
          '[DEBUG][HYP-G] First stderr data received at',
          Date.now() - launchStartTime,
          'ms'
        );
        stderrReceived = true;
      }
      const str = data.toString();
      console.error(`[Electron Stderr]: ${str}`);
      if (str.includes('debugger') || str.includes('inspector') || str.includes('Debugger')) {
        console.log('[DEBUG][HYP-A] V8 Inspector activity detected in stderr');
      }
    });
    // #endregion

    // #region agent log - Hypothesis H: Heartbeat to track if we're waiting
    const heartbeatInterval = setInterval(() => {
      const elapsed = Date.now() - launchStartTime;
      console.log(
        `[DEBUG][HYP-H] Heartbeat: ${elapsed}ms elapsed, stdout=${stdoutReceived}, stderr=${stderrReceived}`
      );
    }, 5000);
    // Clear heartbeat on process exit
    electronProcess.on('exit', () => clearInterval(heartbeatInterval));
    // #endregion

    electronProcess.on('exit', (code, signal) => {
      const elapsed = Date.now() - launchStartTime;
      console.log(
        `[Electron Process Exit] Code: ${code}, Signal: ${signal}, Elapsed: ${elapsed}ms`
      );
      // #region agent log - Hypothesis E: Analyze exit timing
      if (elapsed < 2000) {
        console.log(
          '[DEBUG][HYP-E] RAPID EXIT: Process exited within 2 seconds - likely startup failure'
        );
      }
      // #endregion
    });

    app.on('close', () => {
      console.log('⚠️ Electron app closed unexpectedly');
    });
    return app;
  } catch (error) {
    console.error('❌ Failed to launch Electron app:', error);
    // #region agent log - Additional error context
    console.error('[DEBUG] Launch error details:', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      elapsed: Date.now() - launchStartTime,
    });
    // #endregion
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
