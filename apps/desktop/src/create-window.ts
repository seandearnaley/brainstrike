import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { app, BrowserWindow } from 'electron';
import type { DesktopWindowState } from './store-schema';
import { ensureWindowBoundsVisible, resolveInitialWindowState } from './window-state';

const startupLogger = createLogger('CreateWindow');

const resolveDistRoot = (): string => {
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  return path.basename(appPath) === 'dist' ? appPath : path.join(appPath, 'dist');
};

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

  // CSP handled elsewhere
}

/**
 * Load built renderer files in production.
 */
function loadProductionRenderer(win: BrowserWindow, rendererPath: string) {
  win.loadFile(rendererPath);
}

/**
 * Connect to Vite dev server in development.
 */
const isTestRuntime = process.env['VITEST'] === 'true';
const DEV_SERVER_RETRY_ATTEMPTS = isTestRuntime ? 1 : 30;
const DEV_SERVER_RETRY_DELAY_MS = isTestRuntime ? 0 : 200;
const DEV_RENDERER_URL =
  process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim() || 'http://localhost:8081';

function shouldAutoOpenDevTools(): boolean {
  return process.env['BRAINSTRIKE_DESKTOP_OPEN_DEVTOOLS'] === '1';
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectToDevServer(win: BrowserWindow) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DEV_SERVER_RETRY_ATTEMPTS; attempt++) {
    try {
      const attemptStart = Date.now();
      // CRITICAL: Keep dev renderer URL deterministic.
      // Probing multiple ports caused hidden startup slowdowns and non-deterministic
      // behavior when another process occupied 8081 and Vite auto-shifted ports.
      startupLogger.info('Attempting to connect desktop renderer', {
        attempt,
        url: DEV_RENDERER_URL,
      });
      await win.loadURL(DEV_RENDERER_URL);
      startupLogger.info('Desktop renderer connection established', {
        attempt,
        url: DEV_RENDERER_URL,
        elapsedMs: Date.now() - attemptStart,
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startupLogger.warn('Desktop renderer connection attempt failed', {
        attempt,
        url: DEV_RENDERER_URL,
        message,
      });
      lastError = error;
    }

    if (attempt < DEV_SERVER_RETRY_ATTEMPTS) {
      await wait(DEV_SERVER_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Unable to connect to dev renderer at ${DEV_RENDERER_URL} after ${DEV_SERVER_RETRY_ATTEMPTS} attempts`,
    {
      cause: lastError instanceof Error ? lastError : undefined,
    }
  );
}

/**
 * Load the renderer content (either built files or dev server).
 */
interface LoadRendererOptions {
  isTestMode: boolean;
}

async function loadRenderer(win: BrowserWindow, options: LoadRendererOptions) {
  const distRoot = resolveDistRoot();
  const rendererPath = path.join(distRoot, 'renderer/index.html');
  const hasBuiltRenderer = fs.existsSync(rendererPath);

  // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
  console.log(
    '[createWindow] Loading renderer...\n' +
      `[createWindow] distRoot: ${distRoot}\n` +
      `[createWindow] Expected renderer path: ${rendererPath}\n` +
      `[createWindow] Has built renderer: ${hasBuiltRenderer}\n` +
      `[createWindow] Is packaged: ${app.isPackaged}`
  );

  if (app.isPackaged || options.isTestMode) {
    if (!hasBuiltRenderer) {
      throw new Error(
        `Built renderer is required in packaged/test mode but was not found at ${rendererPath}`
      );
    }

    // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
    console.log('[createWindow] Loading built renderer file');
    loadProductionRenderer(win, rendererPath);
    return;
  }

  try {
    // In local development, always prefer Vite dev server.
    // Using file:// renderer in dev can break module workers (opaque origin).
    // biome-ignore lint/suspicious/noConsole: Debugging CI flakiness
    console.log('[createWindow] Attempting dev server renderer first');
    await connectToDevServer(win);
    // Keep DevTools opt-in so local startup remains deterministic and we don't
    // force-open a debug window on every launch.
    if (shouldAutoOpenDevTools()) {
      win.webContents.openDevTools();
    }
    return;
  } catch (error) {
    // CRITICAL: Never fall back to file:// in non-packaged mode.
    // Loading production renderer during local dev repeatedly breaks module workers.
    throw new Error(
      'Dev renderer unavailable in non-packaged mode; refusing production fallback to avoid worker regressions.',
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

/**
 * Create the main application window and load the appropriate renderer.
 */
interface CreateWindowOptions {
  windowState?: DesktopWindowState | null;
}

export async function createWindow(options: CreateWindowOptions = {}) {
  const startupStartedAt = Date.now();
  const logStartupPhase = (phase: string, extra: Record<string, unknown> = {}) => {
    startupLogger.info(`Window startup: ${phase}`, {
      elapsedMs: Date.now() - startupStartedAt,
      ...extra,
    });
  };
  const isTestMode = process.env['CI'] === 'true' || process.argv.includes('--test-mode');
  const resolvedWindowState = ensureWindowBoundsVisible(
    resolveInitialWindowState(options.windowState)
  );
  const { bounds, isFullScreen, isMaximized } = resolvedWindowState;

  // Sandbox must be disabled in CI/test environments because:
  // 1. Playwright's Electron support does not work with sandbox enabled in CI
  //    (see: https://github.com/microsoft/playwright/issues/16814)
  // 2. CI environments (containers) lack the seccomp profiles needed for Chrome sandbox
  // In production/local dev, sandbox remains enabled for security.
  const enableSandbox = !isTestMode;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 800,
    minHeight: 600,
    fullscreen: isFullScreen,
    webPreferences: {
      preload: path.join(resolveDistRoot(), 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: enableSandbox,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // CRITICAL: Prevents Chromium from freezing the renderer process after ~5
      // minutes of inactivity. Without this, the embedding worker's WebGPU
      // keep-alive timer stops firing, the GPU device idles out, and ONNX
      // Runtime hits a V8 CHECK() on the stale handle → SIGTRAP → crash.
      // See: docs/debug-handoff-renderer-crash.md
      backgroundThrottling: false,
    },
    titleBarStyle: 'default',
    backgroundColor: '#0b1020',
    show: false,
  });

  logStartupPhase('browser-window-created', {
    isTestMode,
    isPackaged: app.isPackaged,
  });

  win.webContents.on('did-start-loading', () => {
    logStartupPhase('did-start-loading');
  });
  win.webContents.on('dom-ready', () => {
    logStartupPhase('dom-ready');
  });
  win.webContents.on('did-finish-load', () => {
    logStartupPhase('did-finish-load');
  });
  win.webContents.on(
    'did-fail-load',
    (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ) => {
      if (!isMainFrame) {
        return;
      }
      startupLogger.error('Window startup: did-fail-load', {
        elapsedMs: Date.now() - startupStartedAt,
        errorCode,
        errorDescription,
        validatedURL,
      });
    }
  );

  // Safety net for renderer crashes (e.g. SIGTRAP from stale WebGPU handles).
  // Logs crash details and reloads the renderer for automatic recovery.
  // See: docs/debug-handoff-renderer-crash.md (Layer 3: crash recovery)
  win.webContents.on(
    'render-process-gone',
    (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      startupLogger.error('Renderer process gone', {
        reason: details.reason,
        exitCode: details.exitCode,
        elapsedMs: Date.now() - startupStartedAt,
      });

      // Only attempt recovery for crashes — 'killed' and 'clean-exit' are intentional.
      if (details.reason === 'crashed' || details.reason === 'abnormal-exit') {
        startupLogger.info('Attempting renderer recovery via reload');
        try {
          win.webContents.reload();
        } catch (reloadError) {
          startupLogger.error('Renderer reload failed after crash', { reloadError });
        }
      }
    }
  );

  if (isMaximized) {
    win.maximize();
  }

  // Log the lifecycle event for startup diagnostics, but do not show the window here.
  // IMPORTANT: ready-to-show can fire for the initial about:blank document before we
  // load the real renderer URL, which produced long plain-white windows during startup.
  if (!isTestMode) {
    win.once('ready-to-show', () => {
      logStartupPhase('ready-to-show');
    });
  }

  configureSecurity(win);
  logStartupPhase('loading-renderer');
  await loadRenderer(win, { isTestMode });
  logStartupPhase('renderer-load-invocation-returned');

  // Show only after the target renderer has loaded.
  // This keeps startup deterministic and avoids exposing transient blank frames.
  const windowDestroyed = typeof win.isDestroyed === 'function' ? win.isDestroyed() : false;
  if (!(isTestMode || windowDestroyed)) {
    win.show();
    logStartupPhase('window-shown');
  }

  return win;
}
