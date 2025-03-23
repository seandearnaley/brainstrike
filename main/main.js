const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (require("electron-squirrel-startup")) {
  app.quit();
}

let mainWindow;
let serverProcess;

// Start a static file server for the Next.js output
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const nextAppDir = path.join(__dirname, "../next-app");
    const outDir = path.join(nextAppDir, "out");

    // If the output directory doesn't exist, reject
    if (!fs.existsSync(outDir)) {
      return reject(new Error(`Next.js build directory not found: ${outDir}`));
    }

    console.log("Starting static file server...");

    // Use the serve package that's already installed in the next-app folder
    serverProcess = spawn("npx", ["serve", "-s", outDir, "-p", "3000"], {
      cwd: nextAppDir,
      shell: true,
    });

    let serverStarted = false;

    serverProcess.stdout.on("data", (data) => {
      console.log(`Server output: ${data}`);

      // When server is ready, resolve
      if (data.includes("Accepting connections") && !serverStarted) {
        serverStarted = true;
        resolve("http://localhost:3000");
      }
    });

    serverProcess.stderr.on("data", (data) => {
      console.error(`Server error: ${data}`);
    });

    serverProcess.on("error", (err) => {
      console.error("Failed to start server:", err);
      reject(err);
    });

    // Timeout if server doesn't start in 5 seconds
    setTimeout(() => {
      if (!serverStarted) {
        reject(new Error("Server startup timed out"));
      }
    }, 5000);
  });
}

function createWindow() {
  try {
    // Start the static file server
    startStaticServer()
      .then((serverUrl) => {
        console.log(`Server started at ${serverUrl}`);

        // Create the browser window
        mainWindow = new BrowserWindow({
          width: 1200,
          height: 800,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false, // Allow Node.js modules in preload
            preload: path.join(__dirname, "preload.js"),
            webSecurity: true,
            allowRunningInsecureContent: false,
          },
          backgroundColor: "#ffffff",
        });

        // Set Content Security Policy
        mainWindow.webContents.session.webRequest.onHeadersReceived(
          (details, callback) => {
            callback({
              responseHeaders: {
                ...details.responseHeaders,
                "Content-Security-Policy": [
                  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' localhost:*;",
                ],
              },
            });
          }
        );

        // Wait a moment for the server to initialize
        setTimeout(() => {
          // Load the app from the server
          mainWindow.loadURL(serverUrl);

          // Open DevTools for debugging
          mainWindow.webContents.openDevTools();
        }, 500);
      })
      .catch((error) => {
        console.error("Error starting server:", error);
        app.quit();
      });
  } catch (error) {
    console.error("Error creating window:", error);
    app.quit();
  }
}

// Track if a dialog is currently open to prevent multiple dialogs
let isDialogOpen = false;

// Set up IPC handlers for file system access
function setupIpcHandlers() {
  ipcMain.handle("show-directory-picker", async () => {
    if (!mainWindow) return { canceled: true };

    // Prevent multiple dialogs from opening
    if (isDialogOpen) {
      console.log("Dialog already open, ignoring request");
      return { canceled: true, alreadyOpen: true };
    }

    try {
      isDialogOpen = true;
      console.log("Opening directory picker dialog");

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
        title: "Select Project Folder",
        buttonLabel: "Select Folder",
      });

      console.log("Directory picker result:", result);
      return result;
    } finally {
      isDialogOpen = false;
    }
  });

  // Add support for file listing
  ipcMain.handle("read-directory", async (event, dirPath) => {
    if (!dirPath) return { error: "No directory path provided" };

    try {
      const { promises: fs } = require("node:fs");
      const path = require("node:path");

      // Get all files in directory
      const files = await fs.readdir(dirPath, { withFileTypes: true });

      // Convert to structured data
      const result = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(dirPath, file.name);
          const stats = await fs.stat(filePath);

          return {
            name: file.name,
            path: filePath,
            type: file.isDirectory() ? "directory" : "file",
            size: stats.size,
            lastModified: stats.mtimeMs,
          };
        })
      );

      return { success: true, files: result };
    } catch (error) {
      console.error("Error reading directory:", error);
      return { error: error.message };
    }
  });

  // Add support for reading file content
  ipcMain.handle("read-file", async (event, filePath) => {
    if (!filePath) return { error: "No file path provided" };

    try {
      const { promises: fs } = require("node:fs");
      const data = await fs.readFile(filePath, "utf8");
      return { data };
    } catch (error) {
      console.error("Error reading file:", error);
      return { error: error.message };
    }
  });
}

// Initialize app
app.whenReady().then(() => {
  setupIpcHandlers();
  createWindow();
});

// Quit when all windows are closed, except on macOS
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Kill the server process if it exists
    if (serverProcess) {
      serverProcess.kill();
    }
    app.quit();
  }
});

app.on("activate", () => {
  // On macOS it's common to re-create a window when the dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Cleanup when app is quitting
app.on("quit", () => {
  // Make sure to kill the server process when the app is quitting
  if (serverProcess) {
    serverProcess.kill();
    console.log("Server process terminated");
  }
});
