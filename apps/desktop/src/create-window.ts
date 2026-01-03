import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { DesktopWindowState } from './store-schema';
import { ensureWindowBoundsVisible, resolveInitialWindowState } from './window-state';

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
async function connectToDevServer(win: BrowserWindow) {
  const devPorts = [8081, 8082, 8083];
  for (const port of devPorts) {
    try {
      await win.loadURL(`http://localhost:${port}`);
      return;
    } catch (error) {
      if (port === devPorts.at(-1)) {
        throw error;
      }
    }
  }
}

/**
 * Load the renderer content (either built files or dev server).
 */
async function loadRenderer(win: BrowserWindow) {
  const rendererPath = path.join(__dirname, 'renderer/index.html');
  const hasBuiltRenderer = fs.existsSync(rendererPath);

  // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
  console.log(
    '[createWindow] Loading renderer...\n' +
      `[createWindow] __dirname: ${__dirname}\n` +
      `[createWindow] Expected renderer path: ${rendererPath}\n` +
      `[createWindow] Has built renderer: ${hasBuiltRenderer}\n` +
      `[createWindow] Is packaged: ${app.isPackaged}`
  );

  if (app.isPackaged || hasBuiltRenderer) {
    // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
    console.log('[createWindow] Loading production renderer file');
    loadProductionRenderer(win, rendererPath);
  } else {
    // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
    console.log('[createWindow] Falling back to dev server');
    await connectToDevServer(win);
    win.webContents.openDevTools();
  }
}

/**
 * Create the main application window and load the appropriate renderer.
 */
type CreateWindowOptions = {
  windowState?: DesktopWindowState | null;
};

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
      preload: path.join(__dirname, 'preload.js'),
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
      win.show();
    });
  }

  configureSecurity(win);
  await loadRenderer(win);

  return win;
}
