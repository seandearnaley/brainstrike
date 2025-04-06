# Electron Integration Guide

This document outlines how to use the static build of our Vite application with Electron.

## Static Build Configuration

The application is built into a static website using Vite. Running `npm run build` generates the static assets in the `/dist` directory.

## Using the Static Build with Electron

### 1. Testing the Static Build Locally

Before integrating with Electron, test the static build locally:

```bash
# Build the static site
npm run build

# Serve the static site locally
npm run serve-static
```

The application should now be running at http://localhost:3000 (or another port if 3000 is in use).

### 2. Setting Up Electron

To create an Electron app that wraps the static Vite build:

1. Create a new Electron project or add Electron to an existing project:

```bash
# If creating a new project
mkdir brainstrike-electron
cd brainstrike-electron
npm init -y
npm install electron --save-dev

# Create basic Electron main file
touch main.js
```

2. Configure the Electron main process to load the static build:

```javascript
// main.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const url = require('url');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js') // If you need a preload script
    }
  });

  // Load the static Vite build
  const startUrl = url.format({
    pathname: path.join(__dirname, 'dist/index.html'),
    protocol: 'file:',
    slashes: true
  });
  
  mainWindow.loadURL(startUrl);

  // Optionally open DevTools
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function() {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function() {
  if (mainWindow === null) {
    createWindow();
  }
});
```

3. Create a preload script for any Node.js integration if needed:

```javascript
// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Expose specific functions to the renderer process
contextBridge.exposeInMainWorld('electron', {
  // Example: providing file system access through a safe API
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  writeFile: (path, content) => ipcRenderer.invoke('write-file', path, content),
  // Add other functionality as needed
});
```

4. Set up handlers in the main process:

```javascript
// In main.js, add these handlers
const fs = require('fs').promises;
const { ipcMain } = require('electron');

ipcMain.handle('read-file', async (event, path) => {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    return null;
  }
});

ipcMain.handle('write-file', async (event, path, content) => {
  try {
    await fs.writeFile(path, content, 'utf8');
    return true;
  } catch (error) {
    return false;
  }
});
```

### 3. Building the Electron App

To package your Electron app for distribution:

1. Install electron-builder:

```bash
npm install electron-builder --save-dev
```

2. Add scripts to package.json:

```json
"scripts": {
  "start": "electron .",
  "pack": "electron-builder --dir",
  "dist": "electron-builder"
},
"build": {
  "appId": "com.brainstrike.app",
  "productName": "BrainStrike",
  "files": [
    "main.js",
    "preload.js",
    "dist/**/*"
  ],
  "directories": {
    "output": "dist"
  },
  "mac": {
    "category": "public.app-category.developer-tools"
  },
  "win": {
    "target": "nsis"
  },
  "linux": {
    "target": "AppImage"
  }
}
```

3. Build the application:

```bash
# First build your Vite static site
npm run build

# Then build the Electron app
npm run dist
```

## Considerations for Electron Integration

1. **Backend Logic**: Since this is a static build, any backend logic previously handled by Next.js API routes needs to be reimplemented using Electron's IPC mechanism or moved to a separate backend service if required.

2. **Browser APIs**: Some browser APIs may behave differently in Electron. Make sure to test functionality that relies on:
   - File system access
   - Browser storage
   - Network requests

3. **Security**: Use contextIsolation and a preload script to safely expose Node.js functionality to the renderer process.

4. **Relative Paths**: If assets aren't loading correctly, check that relative paths are configured properly for a `file://` protocol context.

5. **Updates**: Consider implementing an auto-update mechanism using `electron-updater`.

## Resources

- [Electron Documentation](https://www.electronjs.org/docs)
- [Vite Documentation](https://vitejs.dev/)
- [electron-builder Documentation](https://www.electron.build/)