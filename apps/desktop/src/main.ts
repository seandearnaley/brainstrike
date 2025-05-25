import path from 'node:path';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system';
import { ElectronStorageAdapter } from '@brainstrike/storage';
import { BrowserWindow, app, ipcMain } from 'electron';

const fileSystem = new ElectronFileSystemAdapter();
const storage = new ElectronStorageAdapter();

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '../index.html'));
  } else {
    win.loadURL('http://localhost:3000');
  }
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
