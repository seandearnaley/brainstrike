import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';
import { app, BrowserWindow } from 'electron';
import {
  type DesktopRendererLaunchMode,
  resolveDesktopRendererLaunchMode,
} from './desktop-launch-mode';
import { DESKTOP_DEV_RENDERER_URL } from './desktop-renderer-url';
import type { DesktopWindowState } from './store-schema';
import { assignWindowRole, getWindowRole } from './window-role';
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
const MAX_RENDERER_CRASHES_IN_WINDOW = 3;
const RENDERER_CRASH_WINDOW_MS = 30_000;
const pendingWindowReloadMetadata = new WeakMap<BrowserWindow, WindowReloadMetadata>();

interface WindowReloadMetadata {
  readonly reason: string;
  readonly source: 'main' | 'renderer';
}

function getCurrentWindowUrl(win: BrowserWindow): string | null {
  try {
    const currentUrl = win.webContents.getURL();
    return currentUrl.trim().length > 0 ? currentUrl : null;
  } catch {
    return null;
  }
}

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
      // behavior when another local dev server occupied the expected renderer port.
      startupLogger.info(
        { attempt, url: DESKTOP_DEV_RENDERER_URL },
        'Attempting to connect desktop renderer'
      );
      await win.loadURL(DESKTOP_DEV_RENDERER_URL);
      startupLogger.info(
        { attempt, url: DESKTOP_DEV_RENDERER_URL, elapsedMs: Date.now() - attemptStart },
        'Desktop renderer connection established'
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startupLogger.warn(
        { attempt, url: DESKTOP_DEV_RENDERER_URL, message },
        'Desktop renderer connection attempt failed'
      );
      lastError = error;
    }

    if (attempt < DEV_SERVER_RETRY_ATTEMPTS) {
      await wait(DEV_SERVER_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Unable to connect to dev renderer at ${DESKTOP_DEV_RENDERER_URL} after ${DEV_SERVER_RETRY_ATTEMPTS} attempts`,
    {
      cause: lastError instanceof Error ? lastError : undefined,
    }
  );
}

export function noteNextWindowReload(win: BrowserWindow, metadata: WindowReloadMetadata): void {
  pendingWindowReloadMetadata.set(win, metadata);
}

/**
 * Load the renderer content (either built files or dev server).
 */
interface LoadRendererOptions {
  isTestMode: boolean;
  launchMode?: DesktopRendererLaunchMode;
}

async function loadRenderer(win: BrowserWindow, options: LoadRendererOptions) {
  const distRoot = resolveDistRoot();
  const rendererPath = path.join(distRoot, 'renderer/index.html');
  const hasBuiltRenderer = fs.existsSync(rendererPath);
  const launchMode = options.launchMode ?? 'built';

  startupLogger.debug(
    {
      distRoot,
      rendererPath,
      hasBuiltRenderer,
      isPackaged: app.isPackaged,
    },
    'Loading renderer'
  );

  if (launchMode === 'built' || launchMode === 'test-built') {
    if (!hasBuiltRenderer) {
      throw new Error(
        `Built renderer is required in packaged/test mode but was not found at ${rendererPath}`
      );
    }

    startupLogger.debug('Loading built renderer file');
    loadProductionRenderer(win, rendererPath);
    return;
  }

  if (launchMode !== 'dev-server') {
    throw new Error(`Unsupported renderer launch mode "${launchMode}".`);
  }

  try {
    // In local development, always prefer Vite dev server.
    // Using file:// renderer in dev can break module workers (opaque origin).
    startupLogger.debug('Attempting dev server renderer first');
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
  let crashCountInWindow = 0;
  let lastCrashAt = 0;
  let hasFinishedInitialLoad = false;
  let pendingMainFrameNavigation: { readonly isInPlace: boolean; readonly url: string } | null =
    null;
  const logStartupPhase = (phase: string, extra: Record<string, unknown> = {}) => {
    startupLogger.info(
      { elapsedMs: Date.now() - startupStartedAt, ...extra },
      `Window startup: ${phase}`
    );
  };
  const isTestMode = process.env['CI'] === 'true' || process.argv.includes('--test-mode');
  const launchMode = resolveDesktopRendererLaunchMode({
    argv: process.argv,
    isPackaged: app.isPackaged,
    isTestMode,
  });
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
      safeDialogs: true,
      navigateOnDragDrop: false,
      // Keep Chromium's normal background throttling on the visible UI.
      // Long-running embedding work belongs in the hidden renderer host.
      backgroundThrottling: true,
    },
    titleBarStyle: 'default',
    backgroundColor: '#0b1020',
    show: false,
    ...(isTestMode
      ? {
          focusable: false,
          skipTaskbar: true,
        }
      : {}),
  });
  assignWindowRole(win, 'visible-ui');

  logStartupPhase('browser-window-created', {
    isTestMode,
    isPackaged: app.isPackaged,
  });

  win.webContents.on(
    'did-start-navigation',
    (_event: Electron.Event, navigationUrl: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame) {
        return;
      }
      pendingMainFrameNavigation = {
        url: navigationUrl,
        isInPlace,
      };
    }
  );
  win.webContents.on('did-navigate', () => {
    pendingMainFrameNavigation = null;
  });
  win.webContents.on('did-navigate-in-page', () => {
    pendingMainFrameNavigation = null;
  });
  win.webContents.on('did-start-loading', () => {
    const reloadMetadata = pendingWindowReloadMetadata.get(win);
    if (reloadMetadata) {
      pendingWindowReloadMetadata.delete(win);
      logStartupPhase('did-start-loading', {
        reloadReason: reloadMetadata.reason,
        reloadSource: reloadMetadata.source,
        windowRole: getWindowRole(win) ?? 'visible-ui',
      });
      return;
    }
    if (hasFinishedInitialLoad) {
      if (pendingMainFrameNavigation && !pendingMainFrameNavigation.isInPlace) {
        logStartupPhase('did-start-loading', {
          reloadReason: 'top-level-navigation',
          reloadSource: 'unknown',
          windowRole: getWindowRole(win) ?? 'visible-ui',
          url: pendingMainFrameNavigation.url,
        });
      } else {
        startupLogger.trace(
          {
            isInPlaceNavigation: pendingMainFrameNavigation?.isInPlace ?? false,
            url: pendingMainFrameNavigation?.url ?? getCurrentWindowUrl(win),
            windowRole: getWindowRole(win) ?? 'visible-ui',
          },
          'Ignored did-start-loading without explicit reload intent'
        );
      }
      return;
    }
    logStartupPhase('did-start-loading', {
      reloadReason: 'initial-load',
      reloadSource: 'main',
      windowRole: getWindowRole(win) ?? 'visible-ui',
    });
  });
  win.webContents.on('dom-ready', () => {
    logStartupPhase('dom-ready');
  });
  win.webContents.on('did-finish-load', () => {
    hasFinishedInitialLoad = true;
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
      startupLogger.error(
        { elapsedMs: Date.now() - startupStartedAt, errorCode, errorDescription, validatedURL },
        'Window startup: did-fail-load'
      );
    }
  );

  // Safety net for renderer crashes (e.g. SIGTRAP from stale WebGPU handles).
  // CRITICAL: Reloading a dead renderer while the window is backgrounded causes
  // a permanent main-thread freeze (100% CPU in kernel signal handlers). To avoid
  // this, we defer recovery until the window regains focus.
  // See: docs/debug-handoff-renderer-crash.md (Layer 3: crash recovery)
  let pendingRendererRecovery = false;

  const attemptRendererReload = () => {
    if (win.isDestroyed() || !pendingRendererRecovery) {
      return;
    }
    pendingRendererRecovery = false;
    startupLogger.info('Executing deferred renderer reload');
    try {
      noteNextWindowReload(win, {
        reason: 'renderer-crash-recovery',
        source: 'main',
      });
      win.webContents.reload();
    } catch (reloadError) {
      startupLogger.error({ reloadError }, 'Renderer reload failed after crash');
    }
  };

  // Recovery triggers: reload when the user actually interacts with the window.
  win.on('focus', () => {
    if (pendingRendererRecovery) {
      attemptRendererReload();
    }
  });
  // macOS dock icon click / Cmd-Tab back to app
  const activateHandler = () => {
    if (pendingRendererRecovery) {
      attemptRendererReload();
    }
  };
  app.on('activate', activateHandler);
  win.on('closed', () => {
    app.removeListener('activate', activateHandler);
  });

  win.webContents.on(
    'render-process-gone',
    (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      startupLogger.error(
        {
          reason: details.reason,
          exitCode: details.exitCode,
          elapsedMs: Date.now() - startupStartedAt,
          windowRole: getWindowRole(win) ?? 'visible-ui',
        },
        'Renderer process gone'
      );

      // Only attempt recovery for crashes — 'killed' and 'clean-exit' are intentional.
      if (details.reason === 'crashed' || details.reason === 'abnormal-exit') {
        const now = Date.now();
        if (now - lastCrashAt > RENDERER_CRASH_WINDOW_MS) {
          crashCountInWindow = 0;
        }
        crashCountInWindow += 1;
        lastCrashAt = now;

        if (crashCountInWindow > MAX_RENDERER_CRASHES_IN_WINDOW) {
          startupLogger.error(
            {
              crashCountInWindow,
              maxRendererCrashesInWindow: MAX_RENDERER_CRASHES_IN_WINDOW,
              rendererCrashWindowMs: RENDERER_CRASH_WINDOW_MS,
            },
            'Renderer crash loop detected; skipping automatic reload'
          );
          return;
        }

        // CRITICAL: NEVER reload synchronously in the render-process-gone handler.
        // Calling webContents.reload() here triggers a POSIX signal storm
        // (_sigtramp → uv_signal_stop) that permanently freezes the main thread
        // at 100% CPU. This happens regardless of window focus state.
        //
        // Instead, always defer recovery. The reload fires when the user brings
        // the app back via: window focus, macOS activate (dock click / Cmd-Tab),
        // or a 3-second fallback timer for when the window already has focus.
        startupLogger.info(
          {
            reason: details.reason,
            exitCode: details.exitCode,
            crashCountInWindow,
            windowRole: getWindowRole(win) ?? 'visible-ui',
          },
          'Renderer crashed; deferring recovery (immediate reload causes main-thread freeze)'
        );
        pendingRendererRecovery = true;

        // Fallback: if the window already has focus (user is looking at it),
        // the focus/activate events won't re-fire. Use a delayed reload
        // to recover after the signal handler context has unwound.
        setTimeout(() => {
          if (pendingRendererRecovery && !win.isDestroyed()) {
            startupLogger.info('Fallback timer triggering deferred renderer reload');
            attemptRendererReload();
          }
        }, 3000);
      }
    }
  );

  if (isMaximized) {
    if (isTestMode) {
      startupLogger.info(
        'Skipping maximize in desktop E2E mode because Electron shows hidden windows when maximizing'
      );
    } else {
      win.maximize();
    }
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
  await loadRenderer(win, { isTestMode, launchMode });
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
