import { ElectronFileSystemAdapter } from '@brainstrike/file-system';
import { ElectronStorageAdapter } from '@brainstrike/storage';
import type { PanelPersistenceState } from '@brainstrike/ui';
import { BrowserWindow, app } from 'electron';
import ElectronStore from 'electron-store';
import { createWindow } from './create-window';
import { registerIpcHandlers } from './ipc-handlers';
import { setupSecurity } from './setup-security';

const fileSystem = new ElectronFileSystemAdapter();
const storage = new ElectronStorageAdapter();

interface StoreSchema {
  panelLayout: {
    v1: PanelPersistenceState;
  };
}

const store: ElectronStore<StoreSchema> = new ElectronStore<StoreSchema>();

registerIpcHandlers(fileSystem, storage, store);

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

export { createWindow, setupSecurity, registerIpcHandlers };
