import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system';
import { ElectronStorageAdapter } from '@brainstrike/storage';
import { BrowserWindow, app, ipcMain } from 'electron';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fileSystem = new ElectronFileSystemAdapter();
const storage = new ElectronStorageAdapter();

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'default',
    show: false, // Don't show until ready
  });

  // Show window when ready to prevent visual flash
  win.once('ready-to-show', () => {
    win.show();
  });

  if (app.isPackaged) {
    // In production, load the built renderer
    win.loadFile(path.join(__dirname, 'renderer/index.html'));
  } else {
    // In development, load from Vite dev server
    win.loadURL('http://localhost:3001');

    // Open DevTools in development
    win.webContents.openDevTools();
  }

  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('storage:getItem', async (_e, key: string) => storage.getItem(key));
ipcMain.handle('storage:setItem', async (_e, key: string, value: string) =>
  storage.setItem(key, value)
);
ipcMain.handle('storage:removeItem', async (_e, key: string) => storage.removeItem(key));
ipcMain.handle('storage:clear', async () => storage.clear());
ipcMain.handle('storage:getAllKeys', async () => storage.getAllKeys());

ipcMain.handle('fs:requestDirectoryAccess', async () => fileSystem.requestDirectoryAccess());
ipcMain.handle('fs:readDirectory', async (_e, handle) => fileSystem.readDirectory(handle));
ipcMain.handle('fs:readFile', async (_e, handle) => fileSystem.readFile(handle));
ipcMain.handle('fs:exists', async (_e, p: string) => fileSystem.exists(p));
