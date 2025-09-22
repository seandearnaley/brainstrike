import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, nativeImage } from 'electron';

function logDebug(message: string, meta?: unknown) {
  if (process.env['DEBUG_DESKTOP_ICONS'] === '1') {
    // eslint-disable-next-line no-console
    console.log(`[DesktopIcons] ${message}`, meta ?? '');
  }
}

/**
 * Configure security settings for the browser window.
 */
function configureSecurity(win: BrowserWindow) {
  // Security: Prevent new window creation
  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (url.startsWith('http://localhost:') || url.startsWith('file://')) {
      return { action: 'allow' };
    }
    return { action: 'deny' };
  });

  // Security: Prevent navigation to external URLs
  win.webContents.on('will-navigate', (event: Electron.Event, navigationUrl: string) => {
    const parsedUrl = new URL(navigationUrl);
    if (parsedUrl.hostname === 'localhost' || parsedUrl.protocol === 'file:') {
      return;
    }
    event.preventDefault();
  });

  // Security: CSP is handled in setup-security.ts
}

function firstExistingPath(candidates: string[]): string | null {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveBuildPath(relative: string): string | null {
  const appPath =
    typeof (app as unknown as { getAppPath?: unknown }).getAppPath === 'function'
      ? app.getAppPath()
      : process.cwd();
  const candidates = [
    path.join(appPath, 'build', relative),
    path.join(__dirname, '../build', relative),
    path.join(process.cwd(), 'apps/desktop/build', relative),
  ];
  const resolved = firstExistingPath(candidates);
  logDebug(`resolveBuildPath(${relative})`, { candidates, resolved });
  return resolved;
}

async function loadProductionRenderer(win: BrowserWindow, rendererPath: string) {
  const forcedUrl = getForcedDevUrl();
  if (forcedUrl) {
    await win.loadURL(forcedUrl);
    return;
  }
  win.loadFile(rendererPath);
}

function getForcedDevUrl(): string | null {
  const envUrl = process.env['DESKTOP_DEV_SERVER_URL'];
  if (envUrl && /^https?:\/\//.test(envUrl)) return envUrl;
  const arg = process.argv.find((a) => a.startsWith('--dev-url='));
  if (arg) {
    const url = arg.slice('--dev-url='.length);
    if (/^https?:\/\//.test(url)) return url;
  }
  return null;
}

async function connectToDevServer(win: BrowserWindow) {
  const forcedUrl = getForcedDevUrl();
  if (forcedUrl) {
    await win.loadURL(forcedUrl);
    return;
  }

  const devPorts = [8081, 8082, 8083];
  for (const port of devPorts) {
    try {
      await win.loadURL(`http://localhost:${port}`);
      return;
    } catch (error) {
      if (port === devPorts[devPorts.length - 1]) {
        throw error;
      }
    }
  }
}

async function loadRenderer(win: BrowserWindow) {
  const rendererPath = path.join(__dirname, 'renderer/index.html');
  const hasBuiltRenderer = fs.existsSync(rendererPath);

  if (app.isPackaged || hasBuiltRenderer) {
    await loadProductionRenderer(win, rendererPath);
  } else {
    await connectToDevServer(win);
    win.webContents.openDevTools();
  }
}

export async function createWindow() {
  const isHeadless = process.env['CI'] === 'true' || process.argv.includes('--test-mode');

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1536,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
    titleBarStyle: 'default',
    show: false,
  };

  const win = new BrowserWindow(windowOptions);

  if (process.platform === 'darwin') {
    const dockIcns = resolveBuildPath('icon.icns');
    if (dockIcns) {
      const nimg = nativeImage.createFromPath(dockIcns);
      if (!nimg.isEmpty()) {
        app.dock?.setIcon(nimg);
        win.once('ready-to-show', () => {
          const nimg2 = nativeImage.createFromPath(dockIcns);
          if (!nimg2.isEmpty()) app.dock?.setIcon(nimg2);
        });
      }
    }
  }

  if (!isHeadless) {
    win.once('ready-to-show', () => {
      win.show();
    });
  }

  configureSecurity(win);
  await loadRenderer(win);

  return win;
}
