// preload.js - minimal version
const { contextBridge, ipcRenderer } = require('electron');

// Expose Electron API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => process.versions.electron,
  platform: process.platform,
  isElectron: true,
  
  // Basic file system operations
  pickDirectory: async () => {
    try {
      const result = await ipcRenderer.invoke('show-directory-picker');
      return result.canceled ? null : result.filePaths[0];
    } catch (error) {
      console.error('Error picking directory:', error);
      return null;
    }
  },
  
  listDirectory: async (dirPath) => {
    try {
      return await ipcRenderer.invoke('read-directory', dirPath);
    } catch (error) {
      console.error('Error listing directory:', error);
      return { error: error.message };
    }
  },
  
  readFile: async (filePath) => {
    try {
      return await ipcRenderer.invoke('read-file', filePath);
    } catch (error) {
      console.error('Error reading file:', error);
      return { error: error.message };
    }
  }
});

console.log('Preload script executed successfully');