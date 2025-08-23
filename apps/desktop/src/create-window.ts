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
  win.loadFile(rendererPath);
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
      await win.loadURL(`http://localhost:${port}`);
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
  const isHeadless = process.env['CI'] === 'true' || process.argv.includes('--test-mode');
  console.info('🔧 createWindow: isHeadless=', isHeadless);

  const preloadPath = path.join(__dirname, 'preload.js');
  console.info('🔧 createWindow: preloadPath=', preloadPath, 'exists=', fs.existsSync(preloadPath));

  const win = new BrowserWindow({
    width: 1536,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // In CI/headless, disable renderer sandbox to avoid Chromium headless stalls
      sandbox: !isHeadless,
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
  // Add diagnostics to surface renderer load outcome
  win.webContents.on('did-finish-load', () => {
    console.info('✅ Renderer did-finish-load');
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error('❌ Renderer did-fail-load', { errorCode, errorDescription, validatedURL });
  });

  try {
    const rendererPath = path.join(__dirname, 'renderer/index.html');
    console.info(
      '🔧 createWindow: rendererPath=',
      rendererPath,
      'exists=',
      fs.existsSync(rendererPath)
    );
    await loadRenderer(win);
  } catch (err) {
    console.error('❌ loadRenderer threw:', err);
    throw err;
  }

  return win;
}
