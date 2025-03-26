const { app, BrowserWindow, ipcMain, dialog, protocol } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (require("electron-squirrel-startup")) {
  app.quit();
}

let mainWindow;

/**
 * Simple static file server using built-in HTTP server
 */
function startServer() {
  return new Promise((resolve, reject) => {
    try {
      const http = require("node:http");
      const outDir = path.join(__dirname, "../next-app/out");

      if (!fs.existsSync(outDir)) {
        return reject(
          new Error(`Next.js output directory not found: ${outDir}`)
        );
      }

      // Create a simple HTTP server
      const server = http.createServer((req, res) => {
        let reqPath = req.url;

        console.log(`[Server] Request: ${req.method} ${reqPath}`);

        // Handle root path
        if (reqPath === "/") {
          reqPath = "/index.html";
        }

        // For routes like /settings, serve the HTML file
        if (reqPath.startsWith("/settings") && !reqPath.includes(".")) {
          reqPath = "/settings.html";
        }

        // Remove query parameters
        reqPath = reqPath.split("?")[0];

        // Resolve the file path
        const filePath = path.join(outDir, reqPath);

        // Special case for 404 page
        if (!fs.existsSync(filePath) && reqPath !== "/404.html") {
          // Try to serve the 404 page for client-side routing
          if (fs.existsSync(path.join(outDir, "/404.html"))) {
            const content = fs.readFileSync(path.join(outDir, "/404.html"));
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(content);
            return;
          }
        }

        // Check if the file exists
        if (fs.existsSync(filePath)) {
          // Determine content type
          const ext = path.extname(filePath).toLowerCase();
          const contentTypeMap = {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
            ".ttf": "font/ttf",
            ".eot": "application/vnd.ms-fontobject",
            ".otf": "font/otf",
            ".txt": "text/plain",
          };

          const contentType = contentTypeMap[ext] || "application/octet-stream";

          // Set appropriate CORS headers
          const headers = {
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Cache-Control": "public, max-age=31536000", // 1 year for assets
          };

          // Read and send the file
          try {
            const content = fs.readFileSync(filePath);
            res.writeHead(200, headers);
            console.log(`[Server] Serving: ${filePath} (${contentType})`);
            res.end(content);
          } catch (error) {
            console.error(`[Server] Error reading file: ${filePath}`, error);
            res.writeHead(500);
            res.end("Server Error");
          }
        } else {
          // For client-side routing, send index.html instead of 404
          if (reqPath.indexOf(".") === -1) {
            console.log(
              `[Server] Client-side route: ${reqPath} - serving index.html`
            );
            const indexPath = path.join(outDir, "index.html");
            if (fs.existsSync(indexPath)) {
              const content = fs.readFileSync(indexPath);
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(content);
              return;
            }
          }

          console.error(`[Server] File not found: ${filePath}`);
          res.writeHead(404);
          res.end("Not Found");
        }
      });

      // Use a random free port or fallback to 0 which assigns a random port
      server.listen(0, "127.0.0.1", () => {
        const serverAddress = server.address();
        const port = serverAddress.port;

        console.log(`Server started on port ${port}`);

        resolve({
          url: `http://localhost:${port}`,
          close: () => {
            server.close();
            console.log("Server closed");
          },
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

function createWindow() {
  try {
    startServer()
      .then((server) => {
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

        // Load the app from the server URL
        mainWindow.loadURL(server.url);

        // Open DevTools for debugging
        mainWindow.webContents.openDevTools();

        // Set up a global reference for cleanup
        app.server = server;
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
    if (app.server) {
      app.server.close();
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

// Clean up on quit
app.on("quit", () => {
  if (app.server) {
    app.server.close();
  }
});
