import fs from 'node:fs';
import path from 'node:path';
import { isDevEnv } from '@brainstrike/utils';
import { app, BrowserWindow } from 'electron';

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

  // Security: CSP is handled in setup-security.ts
  // No CSP configuration here to avoid conflicts
}

/**
 * Load built renderer files in production.
 */
function loadProductionRenderer(win: BrowserWindow, rendererPath: string) {
  if (isDevEnv()) {
  }
  const search = buildUrlSearchParams();
  // Use loadFile with search param to pass feature flag overrides to the renderer
  if (search) {
    win.loadFile(rendererPath, { search });
  } else {
    win.loadFile(rendererPath);
  }
}

/**
 * Connect to Vite dev server in development.
 */
async function connectToDevServer(win: BrowserWindow) {
  if (isDevEnv()) {
  }

  const devPorts = [8081, 8082, 8083]; // Port 8080 is reserved for the web app

  for (const port of devPorts) {
    try {
      const search = buildUrlSearchParams();
      const base = `http://localhost:${port}`;
      await win.loadURL(`${base}${search ?? ''}`);
      if (isDevEnv()) {
      }
      return;
    } catch (error) {
      if (isDevEnv()) {
      }
      if (port === devPorts[devPorts.length - 1]) {
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

  if (app.isPackaged || hasBuiltRenderer) {
    loadProductionRenderer(win, rendererPath);
  } else {
    await connectToDevServer(win);
    // Open DevTools in development
    win.webContents.openDevTools();
  }
}

/**
 * Create the main application window and load the appropriate renderer.
 */
export async function createWindow() {
  // Check if running in headless mode (for tests) - prefer CI env var over command line flags
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
  const isHeadless = process.env['CI'] || process.argv.includes('--test-mode');

  const win = new BrowserWindow({
    width: 1536,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
    titleBarStyle: 'default',
    show: false,
  });

  // Show window when ready (unless in headless mode)
  if (!isHeadless) {
    win.once('ready-to-show', () => {
      win.show();
    });
  }

  configureSecurity(win);
  await loadRenderer(win);

  return win;
}

/**
 * Compose a URL search string from CLI/env overrides with precedence:
 * CLI switch --ff_explorer_v2 => BRAINSTRIKE_URL_PARAMS => none
 * Returns a value beginning with '?' or null when no overrides are present.
 */
export function __testOnlyBuildUrlSearchParams(): string | null {
  try {
    // Highest precedence: explicit CLI switch value
    const hasSwitch = app.commandLine.hasSwitch('ff_explorer_v2');
    const cliValue = app.commandLine.getSwitchValue('ff_explorer_v2');
    if (hasSwitch) {
      return `?ff_explorer_v2=${encodeURIComponent(cliValue || '1')}`;
    }
  } catch {
    // ignore
  }

  // Next precedence: raw query string from env var for convenience
  const brainstrikeUrlParams = 'BRAINSTRIKE_URL_PARAMS';
  const raw = process.env[brainstrikeUrlParams];
  if (raw && raw.trim().length > 0) {
    const prefix = raw.startsWith('?') ? '' : '?';
    return `${prefix}${raw}`;
  }

  return null;
}

// Keep the original name for runtime usage in this module
const buildUrlSearchParams = __testOnlyBuildUrlSearchParams;
