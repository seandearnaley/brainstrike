import fs from 'node:fs';
import path from 'node:path';
import { isDevEnv } from '@brainstrike/utils';
import { BrowserWindow, app } from 'electron';

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
}

/**
 * Load built renderer files in production.
 */
function loadProductionRenderer(win: BrowserWindow, rendererPath: string) {
  if (isDevEnv()) {
    console.info('📦 Loading built renderer files');
  }
  win.loadFile(rendererPath);
}

/**
 * Connect to Vite dev server in development.
 */
async function connectToDevServer(win: BrowserWindow) {
  if (isDevEnv()) {
    console.info('🔧 Development mode - connecting to Vite dev server');
  }

  const devPorts = [8081, 8082, 8083]; // Port 8080 is reserved for the web app

  for (const port of devPorts) {
    try {
      await win.loadURL(`http://localhost:${port}`);
      if (isDevEnv()) {
        console.info(`✅ Connected to Vite dev server on port ${port}`);
      }
      return;
    } catch (error) {
      if (isDevEnv()) {
        console.info(`❌ Failed to connect to port ${port}`);
      }
      if (port === devPorts[devPorts.length - 1]) {
        console.error('❌ Could not connect to any Vite dev server port');
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

  // Show window when ready
  win.once('ready-to-show', () => {
    win.show();
  });

  configureSecurity(win);
  await loadRenderer(win);

  return win;
}
