import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { DesktopWindowState } from './store-schema';
import { ensureWindowBoundsVisible, resolveInitialWindowState } from './window-state';

const resolveDistRoot = (): string => {
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  return path.basename(appPath) === 'dist' ? appPath : path.join(appPath, 'dist');
};

/**
 * Configure security settings for the browser window.
 */
function configureSecurity(win: BrowserWindow) {
  // Security: Prevent new window creation
  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (url.startsWith('http://localhost:') || url.startsWith('file://')) {
      return { action: 'allow' };
    }
    return { action: 'deny' };
  });

  // Security: Prevent navigation to external URLs
  win.webContents.on('will-navigate', (event: Electron.Event, navigationUrl: string) => {
    const parsedUrl = new URL(navigationUrl);
    if (parsedUrl.hostname === 'localhost' || parsedUrl.protocol === 'file:') {
      return;
    }
    event.preventDefault();
  });

  // CSP handled elsewhere
}

/**
 * Load built renderer files in production.
 */
function loadProductionRenderer(win: BrowserWindow, rendererPath: string) {
  win.loadFile(rendererPath);
}

/**
 * Connect to Vite dev server in development.
 */
const isTestRuntime = process.env['VITEST'] === 'true';
const DEV_SERVER_RETRY_ATTEMPTS = isTestRuntime ? 1 : 30;
const DEV_SERVER_RETRY_DELAY_MS = isTestRuntime ? 0 : 200;
const DEV_RENDERER_URL =
  process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim() || 'http://localhost:8081';

function shouldAutoOpenDevTools(): boolean {
  return process.env['BRAINSTRIKE_DESKTOP_OPEN_DEVTOOLS'] === '1';
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectToDevServer(win: BrowserWindow) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DEV_SERVER_RETRY_ATTEMPTS; attempt++) {
    try {
      // CRITICAL: Keep dev renderer URL deterministic.
      // Probing multiple ports caused hidden startup slowdowns and non-deterministic
      // behavior when another process occupied 8081 and Vite auto-shifted ports.
      await win.loadURL(DEV_RENDERER_URL);
      return;
    } catch (error) {
      lastError = error;
    }

    if (attempt < DEV_SERVER_RETRY_ATTEMPTS) {
      await wait(DEV_SERVER_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Unable to connect to dev renderer at ${DEV_RENDERER_URL} after ${DEV_SERVER_RETRY_ATTEMPTS} attempts`,
    {
      cause: lastError instanceof Error ? lastError : undefined,
    }
  );
}

/**
 * Load the renderer content (either built files or dev server).
 */
async function loadRenderer(win: BrowserWindow) {
  const distRoot = resolveDistRoot();
  const rendererPath = path.join(distRoot, 'renderer/index.html');
  const hasBuiltRenderer = fs.existsSync(rendererPath);

  // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
  console.log(
    '[createWindow] Loading renderer...\n' +
      `[createWindow] distRoot: ${distRoot}\n` +
      `[createWindow] Expected renderer path: ${rendererPath}\n` +
      `[createWindow] Has built renderer: ${hasBuiltRenderer}\n` +
      `[createWindow] Is packaged: ${app.isPackaged}`
  );

  if (app.isPackaged) {
    // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
    console.log('[createWindow] Loading production renderer file');
    loadProductionRenderer(win, rendererPath);
    return;
  }

  try {
    // In local development, always prefer Vite dev server.
    // Using file:// renderer in dev can break module workers (opaque origin).
    // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
    console.log('[createWindow] Attempting dev server renderer first');
    await connectToDevServer(win);
    // Keep DevTools opt-in so local startup remains deterministic and we don't
    // force-open a debug window on every launch.
    if (shouldAutoOpenDevTools()) {
      win.webContents.openDevTools();
    }
    return;
  } catch (error) {
    // CRITICAL: Never fall back to file:// in non-packaged mode.
    // Loading production renderer during local dev repeatedly breaks module workers.
    throw new Error(
      'Dev renderer unavailable in non-packaged mode; refusing production fallback to avoid worker regressions.',
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

/**
 * Create the main application window and load the appropriate renderer.
 */
interface CreateWindowOptions {
  windowState?: DesktopWindowState | null;
}

export async function createWindow(options: CreateWindowOptions = {}) {
  const isTestMode = process.env['CI'] === 'true' || process.argv.includes('--test-mode');
  const resolvedWindowState = ensureWindowBoundsVisible(
    resolveInitialWindowState(options.windowState)
  );
  const { bounds, isFullScreen, isMaximized } = resolvedWindowState;

  // Sandbox must be disabled in CI/test environments because:
  // 1. Playwright's Electron support does not work with sandbox enabled in CI
  //    (see: https://github.com/microsoft/playwright/issues/16814)
  // 2. CI environments (containers) lack the seccomp profiles needed for Chrome sandbox
  // In production/local dev, sandbox remains enabled for security.
  const enableSandbox = !isTestMode;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 800,
    minHeight: 600,
    fullscreen: isFullScreen,
    webPreferences: {
      preload: path.join(resolveDistRoot(), 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: enableSandbox,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
    titleBarStyle: 'default',
    show: false,
  });

  if (isMaximized) {
    win.maximize();
  }

  // In test mode, keep window hidden; otherwise show when ready
  if (!isTestMode) {
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show();
      }
    });
  }

  configureSecurity(win);
  await loadRenderer(win);

  return win;
}
