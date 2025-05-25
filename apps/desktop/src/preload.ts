import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  storage: {
    getItem: (key: string) => ipcRenderer.invoke('storage:getItem', key),
    setItem: (key: string, value: string) => ipcRenderer.invoke('storage:setItem', key, value),
    removeItem: (key: string) => ipcRenderer.invoke('storage:removeItem', key),
    clear: () => ipcRenderer.invoke('storage:clear'),
    getAllKeys: () => ipcRenderer.invoke('storage:getAllKeys'),
  },
  fs: {
    requestDirectoryAccess: () => ipcRenderer.invoke('fs:requestDirectoryAccess'),
    readDirectory: (handle: unknown) => ipcRenderer.invoke('fs:readDirectory', handle),
    readFile: (handle: unknown) => ipcRenderer.invoke('fs:readFile', handle),
    exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
  },
});
