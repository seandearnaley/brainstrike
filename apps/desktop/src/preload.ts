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
    restoreLastFolder: () => ipcRenderer.invoke('fs:restoreLastFolder'),
    saveLastFolder: (folderPath: string) => ipcRenderer.invoke('fs:saveLastFolder', folderPath),
  },
  // Panel layout persistence
  saveLayout: (state: PanelPersistenceState) => ipcRenderer.invoke('layout:save', state),
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  // Database operations
  db: {
    ping: () => ipcRenderer.invoke('db:ping'),
    query: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:query', sql, params),
    exec: (sql: string) => ipcRenderer.invoke('db:exec', sql),
    test: () => ipcRenderer.invoke('db:test'),
    clearAll: (confirmationToken?: string) => ipcRenderer.invoke('db:clearAll', confirmationToken),
  },
  // Database path (legacy - kept for compatibility)
  getUserDataPath: () => ipcRenderer.invoke('db:getUserDataPath'),
});

// Secure Secrets API
contextBridge.exposeInMainWorld('secrets', {
  saveKey: (provider: string, value: string) => ipcRenderer.invoke('secrets:save', provider, value),
  getKey: (provider: string) => ipcRenderer.invoke('secrets:get', provider),
  deleteKey: (provider: string) => ipcRenderer.invoke('secrets:delete', provider),
  list: () => ipcRenderer.invoke('secrets:list'),
});

// Local Agent API (non-streaming aggregate; renderer can pseudo-stream chunks)
contextBridge.exposeInMainWorld('agent', {
  chat: (messages: unknown[], runtime?: unknown) =>
    ipcRenderer.invoke('agent:chat', messages, runtime),
});

// MCP Config API (desktop-only)
contextBridge.exposeInMainWorld('mcp', {
  getConfig: () => ipcRenderer.invoke('mcp:config:get'),
  watch: () => ipcRenderer.invoke('mcp:config:watch'),
  unwatch: () => ipcRenderer.invoke('mcp:config:unwatch'),
});
