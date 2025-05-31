const path = require('node:path');
const { ElectronFileSystemAdapter } = require('@brainstrike/file-system');
const { ElectronStorageAdapter } = require('@brainstrike/storage');
const { BrowserWindow, app, ipcMain, session } = require('electron');
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { IpcMainInvokeEvent } from 'electron';

const fileSystem = new ElectronFileSystemAdapter();
const storage = new ElectronStorageAdapter();

// Type definitions for Electron's webRequest
interface WebRequestDetails {
  responseHeaders?: Record<string, string[]>;
}

type WebRequestCallback = (response: { responseHeaders: Record<string, string[]> }) => void;

// Simple CSP setup
function setupSecurity() {
  const isDev = !app.isPackaged;

  if (isDev) {
    // Development CSP - allow localhost and dev tools (removed unsafe-eval for security)
    const devCSP =
      "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' 'unsafe-inline' http://localhost:*; style-src 'self' 'unsafe-inline' http://localhost:*; img-src 'self' data: blob: http://localhost:*; font-src 'self' data: http://localhost:*; connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* wss://localhost:*; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    session.defaultSession.webRequest.onHeadersReceived(
      (details: WebRequestDetails, callback: WebRequestCallback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [devCSP],
          },
        });
      }
    );

    console.log('🔒 Development CSP configured');
  } else {
    // Production CSP - more restrictive
    const prodCSP =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    session.defaultSession.webRequest.onHeadersReceived(
      (details: WebRequestDetails, callback: WebRequestCallback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [prodCSP],
          },
        });
      }
    );
  }
}

async function createWindow() {
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

  // Check if built renderer files exist
  const rendererPath = path.join(__dirname, 'renderer/index.html');
  const fs = require('node:fs');
  const hasBuiltRenderer = fs.existsSync(rendererPath);

  if (app.isPackaged || hasBuiltRenderer) {
    // Production: load built files
    console.log('📦 Loading built renderer files');
    win.loadFile(rendererPath);
  } else {
    // Development: connect to Vite dev server
    console.log('🔧 Development mode - connecting to Vite dev server');
    const devPorts = [3001, 3002, 3003]; // Port 3000 is reserved for the web app

    for (const port of devPorts) {
      try {
        await win.loadURL(`http://localhost:${port}`);
        console.log(`✅ Connected to Vite dev server on port ${port}`);
        break;
      } catch (error) {
        console.log(`❌ Failed to connect to port ${port}`);
        if (port === devPorts[devPorts.length - 1]) {
          console.error('❌ Could not connect to any Vite dev server port');
          throw error;
        }
      }
    }

    // Open DevTools in development
    win.webContents.openDevTools();
  }

  return win;
}

app.whenReady().then(async () => {
  // Setup security before creating windows
  setupSecurity();

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers
ipcMain.handle('storage:getItem', async (_e: IpcMainInvokeEvent, key: string) =>
  storage.getItem(key)
);
ipcMain.handle('storage:setItem', async (_e: IpcMainInvokeEvent, key: string, value: string) =>
  storage.setItem(key, value)
);
ipcMain.handle('storage:removeItem', async (_e: IpcMainInvokeEvent, key: string) =>
  storage.removeItem(key)
);
ipcMain.handle('storage:clear', async () => storage.clear());
ipcMain.handle('storage:getAllKeys', async () => storage.getAllKeys());

ipcMain.handle('fs:requestDirectoryAccess', async () => fileSystem.requestDirectoryAccess());
ipcMain.handle('fs:readDirectory', async (_e: IpcMainInvokeEvent, handle: DirectoryHandle) =>
  fileSystem.readDirectory(handle)
);
ipcMain.handle('fs:readFile', async (_e: IpcMainInvokeEvent, handle: FileHandle) =>
  fileSystem.readFile(handle)
);
ipcMain.handle('fs:exists', async (_e: IpcMainInvokeEvent, p: string) => fileSystem.exists(p));
