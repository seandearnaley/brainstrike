// Electron preload script - must use CommonJS syntax
const { contextBridge, ipcRenderer } = require('electron');
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';

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
});
