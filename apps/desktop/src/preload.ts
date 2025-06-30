// Electron preload script - must use CommonJS syntax
const { contextBridge, ipcRenderer } = require('electron');

import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { PanelPersistenceState } from '@brainstrike/ui';

// Expose storage APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  storage: {
    getItem: (key: string) => ipcRenderer.invoke('storage:getItem', key),
    setItem: (key: string, value: string) => ipcRenderer.invoke('storage:setItem', key, value),
    removeItem: (key: string) => ipcRenderer.invoke('storage:removeItem', key),
    clear: () => ipcRenderer.invoke('storage:clear'),
    getAllKeys: () => ipcRenderer.invoke('storage:getAllKeys'),
  },
  fileSystem: {
    requestDirectoryAccess: () => ipcRenderer.invoke('fs:requestDirectoryAccess'),
    readDirectory: (handle: DirectoryHandle) => ipcRenderer.invoke('fs:readDirectory', handle),
    readFile: (handle: FileHandle) => ipcRenderer.invoke('fs:readFile', handle),
    exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
  },
  // Panel layout persistence
  saveLayout: (state: PanelPersistenceState) => ipcRenderer.invoke('layout:save', state),
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  // Database operations
  db: {
    query: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:query', sql, params),
    exec: (sql: string) => ipcRenderer.invoke('db:exec', sql),
    test: () => ipcRenderer.invoke('db:test'),
  },
  // Database path (legacy - kept for compatibility)
  getUserDataPath: () => ipcRenderer.invoke('db:getUserDataPath'),
});
