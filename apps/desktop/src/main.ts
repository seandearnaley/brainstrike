import fs from 'node:fs';
import path from 'node:path';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import { ElectronStorageAdapter } from '@brainstrike/storage';
import type { PanelPersistenceState } from '@brainstrike/ui';
import { isDevEnv } from '@brainstrike/utils';
import { BrowserWindow, app, ipcMain, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import ElectronStore from 'electron-store';

const fileSystem = new ElectronFileSystemAdapter();
const storage = new ElectronStorageAdapter();

interface StoreSchema {
  panelLayout: {
    v1: PanelPersistenceState;
  };
}

const store: ElectronStore<StoreSchema> = new ElectronStore<StoreSchema>();

// Type definitions for Electron's webRequest
interface WebRequestDetails {
  responseHeaders?: Record<string, string[]>;
}

type WebRequestCallback = (response: { responseHeaders: Record<string, string[]> }) => void;

// Simple CSP setup
function setupSecurity() {
  const isDev = !app.isPackaged;

  if (isDev) {
    // Development CSP - allow localhost and dev tools (unsafe-eval needed for WASM)
    const devCSP =
      "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*; style-src 'self' 'unsafe-inline' http://localhost:*; img-src 'self' data: blob: http://localhost:*; font-src 'self' data: http://localhost:*; connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* wss://localhost:*; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

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

    if (isDevEnv()) {
      console.log('🔒 Development CSP configured');
    }
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
  const hasBuiltRenderer = fs.existsSync(rendererPath);

  if (app.isPackaged || hasBuiltRenderer) {
    // Production: load built files
    if (isDevEnv()) {
      console.log('📦 Loading built renderer files');
    }
    win.loadFile(rendererPath);
  } else {
    // Development: connect to Vite dev server
    if (isDevEnv()) {
      console.log('🔧 Development mode - connecting to Vite dev server');
    }
    const devPorts = [8081, 8082, 8083]; // Port 8080 is reserved for the web app

    for (const port of devPorts) {
      try {
        await win.loadURL(`http://localhost:${port}`);
        if (isDevEnv()) {
          console.log(`✅ Connected to Vite dev server on port ${port}`);
        }
        break;
      } catch (error) {
        if (isDevEnv()) {
          console.log(`❌ Failed to connect to port ${port}`);
        }
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

// Layout persistence IPC handlers
ipcMain.handle('layout:save', async (_e: IpcMainInvokeEvent, state: PanelPersistenceState) => {
  // TypeScript has issues with electron-store method resolution during build
  // Using type assertion to access inherited Conf methods
  (store as ElectronStore<StoreSchema> & { set: (key: string, value: unknown) => void }).set(
    'panelLayout',
    { v1: state }
  );
});

ipcMain.handle('layout:load', async () => {
  // TypeScript has issues with electron-store method resolution during build
  // Using type assertion to access inherited Conf methods
  const layout = (store as ElectronStore<StoreSchema> & { get: (key: string) => unknown }).get(
    'panelLayout'
  ) as StoreSchema['panelLayout'] | undefined;
  return layout?.v1;
});
