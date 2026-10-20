import fs from 'node:fs';
import path from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { runAtPromiseBoundary, runWithTimeout } from '@brainstrike/effect-kit';
import { createLogger } from '@brainstrike/logging';
import { Effect, Schedule } from 'effect';
import { app, BrowserWindow } from 'electron';
import { resolveAgentDevtoolsWindowTitle } from './agent-devtools-config';
import {
  recordRendererCrashDeferred,
  recordRendererCrashLoopSuppressed,
  recordRendererRecoveryReloadAttempt,
} from './desktop-crash-recovery';
import {
  type DesktopRendererTarget,
  rendererDocumentUrl,
  resolveDesktopRendererTarget,
} from './desktop-renderer-target';
import { resolveDistRoot } from './dist-root';
import { shouldDenyMcpAppFrameNavigation } from './mcp/apps-frame-navigation';
import {
  createDesktopIpcSenderFrameAllowlist,
  isAllowedDesktopIpcSenderFrameUrl,
} from './platform/desktop-ipc-sender-frame';
import { prepareDesktopRendererClose } from './prepare-desktop-renderer-close';
import type { DesktopWindowState } from './store-schema';
import { publishWindowFocus } from './window-focus-ipc';
import { assignWindowRole, getWindowRole } from './window-role';
import { ensureWindowBoundsVisible, resolveInitialWindowState } from './window-state';

const startupLogger = createLogger('CreateWindow');

function isAllowedRendererNavigation(targetUrl: string): boolean {
  return isAllowedDesktopIpcSenderFrameUrl(
    createDesktopIpcSenderFrameAllowlist(resolveDesktopRendererTarget()),
    targetUrl
  );
}

/**
 * Configure security settings for the browser window.
 */
function configureSecurity(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (isAllowedRendererNavigation(url)) {
      return { action: 'allow' };
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event: Electron.Event, navigationUrl: string) => {
    if (isAllowedRendererNavigation(navigationUrl)) {
      return;
    }
    event.preventDefault();
  });

  // `will-navigate` is main-frame only. The MCP App sandbox shell and its
  // srcdoc app frame are fenced here (BST-1572): see apps-frame-navigation.ts.
  win.webContents.on(
    'will-frame-navigate',
    (details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
      // `frame` is null only for a frame Electron already disposed; such a
      // navigation cannot belong to a live sandbox shell or app frame.
      const frameUrl = details.frame?.url ?? '';
      if (
        shouldDenyMcpAppFrameNavigation({
          frameUrl,
          isMainFrame: details.isMainFrame,
          parentUrl: details.frame?.parent?.url,
          targetUrl: details.url,
        })
      ) {
        startupLogger.warn(
          { frameUrl, targetUrl: details.url },
          'Denied MCP App sandbox frame navigation'
        );
        details.preventDefault();
      }
    }
  );

  // CSP handled elsewhere
}

/**
 * Load built renderer files in production.
 */
async function loadProductionRenderer(win: BrowserWindow, documentUrl: string): Promise<void> {
  await win.loadURL(documentUrl);
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

async function connectToDevServer(win: BrowserWindow, devRendererUrl: string): Promise<void> {
  let attempt = 0;
  const load = Effect.tryPromise({
    catch: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      startupLogger.warn(
        { attempt, message, url: devRendererUrl },
        'Desktop renderer connection attempt failed'
      );
      return error;
    },
    try: async () => {
      attempt++;
      const attemptStart = Date.now();
      // CRITICAL: Keep dev renderer URL deterministic.
      // Probing multiple ports caused hidden startup slowdowns and non-deterministic
      // behavior when another local dev server occupied the expected renderer port.
      startupLogger.info(
        { attempt, url: devRendererUrl },
        'Attempting to connect desktop renderer'
      );
      await win.loadURL(devRendererUrl);
      startupLogger.info(
        { attempt, elapsedMs: Date.now() - attemptStart, url: devRendererUrl },
        'Desktop renderer connection established'
      );
    },
  });
  const retryPolicy = Schedule.spaced(DEV_SERVER_RETRY_DELAY_MS).pipe(
    Schedule.upTo({ times: DEV_SERVER_RETRY_ATTEMPTS - 1 })
  );
  try {
    await runAtPromiseBoundary(Effect.retry(load, retryPolicy));
  } catch (error) {
    throw new Error(
      `Unable to connect to dev renderer at ${devRendererUrl} after ${DEV_SERVER_RETRY_ATTEMPTS} attempts`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

export function noteNextWindowReload(win: BrowserWindow, metadata: WindowReloadMetadata): void {
  pendingWindowReloadMetadata.set(win, metadata);
}

interface DesktopWindowReloadOptions {
  readonly beforeReload?: () => Promise<void>;
  readonly deadlineMs: number;
  readonly ignoreCache?: boolean;
  readonly reportFailure: (
    window: BrowserWindow | undefined,
    phase: 'admission' | 'preparation' | 'replacement'
  ) => Promise<void>;
  readonly shouldReload: () => boolean;
}

const pendingWindowReloads = new WeakMap<
  BrowserWindow,
  {
    readonly operation: Promise<void>;
    readonly isCurrent: () => boolean;
  }
>();

/** Retire only the captured documents; their profile and host keep their existing owners. */
export function reloadDesktopWindows(
  requestedWindows: readonly BrowserWindow[],
  metadata: WindowReloadMetadata,
  options: DesktopWindowReloadOptions
): Promise<void> {
  const windows = [...new Set(requestedWindows)];
  const pending = windows
    .map((window) => pendingWindowReloads.get(window))
    .find((entry) => entry?.isCurrent())?.operation;
  if (pending) {
    if (!options.beforeReload) {
      return pending;
    }
    return options.reportFailure(windows[0], 'admission').then(() => {
      throw refusalError(
        'availability',
        'desktop.reload-in-progress',
        'A document reload is already in progress.'
      );
    });
  }
  for (const window of windows) {
    if (window.isDestroyed() || getWindowRole(window) !== 'visible-ui') {
      return Promise.reject(new Error('Renderer replacement requires a live visible window.'));
    }
  }
  const documents = windows.map((window) => {
    const contents = window.webContents;
    let releaseAbort = (): void => undefined;
    let current = true;
    let committing = false;
    const navigation = Promise.withResolvers<void>();
    void navigation.promise.catch(() => undefined);
    const changed = (): void => {
      current = false;
      if (committing) {
        navigation.resolve();
      } else {
        navigation.reject(
          new Error('The document was replaced before reload preparation settled.')
        );
      }
    };
    const closed = (): void => {
      current = false;
      navigation.reject(new Error('The reload window closed.'));
    };
    const failed = (
      _event: Electron.Event,
      _code: number,
      _description: string,
      _url: string,
      main: boolean
    ): void => {
      if (main && committing) {
        navigation.reject(new Error('The replacement document failed to load.'));
      }
    };
    const crashed = (): void => navigation.reject(new Error('The renderer exited during reload.'));
    const allowOwnedUnload = (event: Electron.Event): void => {
      if (committing && current) {
        event.preventDefault();
      }
    };
    contents.on('did-navigate', changed);
    contents.on('did-fail-load', failed);
    contents.on('render-process-gone', crashed);
    contents.on('will-prevent-unload', allowOwnedUnload);
    window.once('closed', closed);
    const isCurrent = (): boolean => current && !window.isDestroyed();
    return {
      cleanup: () => {
        contents.removeListener('did-navigate', changed);
        contents.removeListener('did-fail-load', failed);
        contents.removeListener('render-process-gone', crashed);
        contents.removeListener('will-prevent-unload', allowOwnedUnload);
        window.removeListener('closed', closed);
        releaseAbort();
      },
      commit: (signal: AbortSignal): Promise<void> => {
        if (!isCurrent()) {
          return Promise.reject(new Error('A replacement document superseded this reload.'));
        }
        const aborted = (): void => navigation.reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        releaseAbort = () => signal.removeEventListener('abort', aborted);
        committing = true;
        noteNextWindowReload(window, metadata);
        if (options.ignoreCache) {
          contents.reloadIgnoringCache();
        } else {
          contents.reload();
        }
        return navigation.promise.finally(releaseAbort);
      },
      isCurrent,
      window,
    };
  });
  let phase: 'preparation' | 'replacement' = 'preparation';
  const operation = Promise.resolve()
    .then(async () => {
      const started = performance.now();
      await runWithTimeout(
        async (signal) => {
          const results = await Promise.allSettled(
            documents.map(({ window }) => prepareDesktopRendererClose(window, signal))
          );
          const failures = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          );
          if (failures.length) {
            throw new AggregateError(failures, 'Renderer reload preparation failed.');
          }
        },
        {
          onTimeout: () => new Error('Renderer reload preparation reached its deadline.'),
          timeoutMs: options.deadlineMs,
        }
      );
      if (documents.some((document) => !document.isCurrent())) {
        throw new Error('The reload document was superseded.');
      }
      const remainingMs = options.deadlineMs - (performance.now() - started);
      phase = 'replacement';
      // Destructive work remains under the existing reset owner and its own lifetime.
      await options.beforeReload?.();
      if (!options.shouldReload()) {
        startupLogger.info('Skipped document replacement because the application is shutting down');
        return;
      }
      await runWithTimeout(
        async (signal) => {
          await Promise.all(documents.map((document) => document.commit(signal)));
        },
        {
          onTimeout: () => new Error('Renderer reload reached its deadline.'),
          timeoutMs: remainingMs,
        }
      );
    })
    .catch(async (cause: unknown) => {
      const current = documents.filter((document) => document.isCurrent());
      if (current.length === 0 && documents.length > 0) {
        throw refusalError(
          'availability',
          'desktop.reload-superseded',
          'The reload target document is no longer current.'
        );
      }
      startupLogger.error('Desktop document replacement failed', { cause, phase });
      try {
        await options.reportFailure(current[0]?.window, phase);
      } finally {
        for (const document of current) {
          if (document.isCurrent()) {
            document.window.destroy();
          }
        }
      }
      throw cause;
    })
    .finally(() => {
      for (const document of documents) {
        document.cleanup();
        if (pendingWindowReloads.get(document.window)?.operation === operation) {
          pendingWindowReloads.delete(document.window);
        }
      }
    });
  for (const document of documents) {
    pendingWindowReloads.set(document.window, { isCurrent: document.isCurrent, operation });
  }
  return operation;
}

/**
 * Load the renderer content (either built files or dev server).
 */
/**
 * Loads the document named by the process-wide renderer target (BST-1641):
 * the same object `main.ts` configured, the hidden hosts load from, and the
 * IPC sender-frame allowlist is derived from. Resolving it here — before any
 * `loadURL` — makes an unconfigured target a named load-time
 * failure instead of every authorized IPC channel rejecting at first invoke.
 */
async function loadRenderer(win: BrowserWindow, target: DesktopRendererTarget) {
  startupLogger.debug(
    { distRoot: resolveDistRoot(), isPackaged: app.isPackaged, target },
    'Loading renderer'
  );

  if (target.kind === 'built-renderer') {
    if (!fs.existsSync(target.rendererPath)) {
      throw new Error(
        `Built renderer is required in packaged/test mode but was not found at ${target.rendererPath}`
      );
    }

    startupLogger.debug('Loading built renderer document');
    await loadProductionRenderer(win, rendererDocumentUrl(target));
    return;
  }

  try {
    // In local development, always prefer Vite dev server.
    // Using file:// renderer in dev can break module workers (opaque origin).
    startupLogger.debug('Attempting dev server renderer first');
    await connectToDevServer(win, target.url);
    // Keep DevTools opt-in so local startup remains deterministic and we don't
    // force-open a debug window on every launch.
    if (shouldAutoOpenDevTools()) {
      win.webContents.openDevTools();
    }
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
  /** Install window listeners synchronously before renderer navigation starts. */
  onBeforeLoad?: (window: BrowserWindow) => void;
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
  // Resolved before the BrowserWindow exists so a missing target fails here,
  // by name, rather than after a window was shown.
  const rendererTarget = resolveDesktopRendererTarget();
  const resolvedWindowState = ensureWindowBoundsVisible(
    resolveInitialWindowState(options.windowState)
  );
  const { bounds, isFullScreen, isMaximized } = resolvedWindowState;
  const agentDevtoolsWindowTitle = resolveAgentDevtoolsWindowTitle(process.env, process.argv);

  // Sandbox must be disabled in CI/test environments because:
  // 1. Playwright's Electron support does not work with sandbox enabled in CI
  //    (see: https://github.com/microsoft/playwright/issues/16814)
  // 2. CI environments (containers) lack the seccomp profiles needed for Chrome sandbox
  // In production/local dev, sandbox remains enabled for security.
  const enableSandbox = !isTestMode;

  const win = new BrowserWindow({
    ...(agentDevtoolsWindowTitle
      ? {
          accessibleTitle: agentDevtoolsWindowTitle,
          title: agentDevtoolsWindowTitle,
        }
      : {}),
    height: bounds.height,
    width: bounds.width,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    backgroundColor: '#0b1020',
    fullscreen: isFullScreen,
    minHeight: 600,
    minWidth: 800,
    show: false,
    titleBarStyle: 'default',
    webPreferences: {
      allowRunningInsecureContent: false,
      // Keep Chromium's normal background throttling on the visible UI.
      // Long-running embedding work belongs in the hidden renderer host.
      backgroundThrottling: true,
      contextIsolation: true,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      nodeIntegration: false,
      preload: path.join(resolveDistRoot(), 'preload.js'),
      safeDialogs: true,
      sandbox: enableSandbox,
      webSecurity: true,
    },
    ...(isTestMode
      ? {
          focusable: false,
          skipTaskbar: true,
        }
      : {}),
  });
  assignWindowRole(win, 'visible-ui');
  // The renderer's app-active signal follows THIS window's native focus, not its
  // own `document.hasFocus()` (false while the browser pane or DevTools holds
  // keyboard focus). Attached before `show()` and before the renderer loads: the
  // renderer subscribes and asks `isFocused()` during the load, and `show()`
  // itself hands the window key status, so a listener attached after either would
  // miss a transition the renderer's initial read predates. A push before the
  // renderer has subscribed is dropped, which is fine: its own `isFocused()`
  // answers the state at call time. Per window, so a dock-reopened replacement
  // publishes too.
  publishWindowFocus(win);
  if (agentDevtoolsWindowTitle) {
    win.on('page-title-updated', (event: Electron.Event) => {
      event.preventDefault();
      win.setTitle(agentDevtoolsWindowTitle);
    });
  }

  logStartupPhase('browser-window-created', {
    isPackaged: app.isPackaged,
    isTestMode,
  });

  win.webContents.on(
    'did-start-navigation',
    (_event: Electron.Event, navigationUrl: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame) {
        return;
      }
      pendingMainFrameNavigation = {
        isInPlace,
        url: navigationUrl,
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
          url: pendingMainFrameNavigation.url,
          windowRole: getWindowRole(win) ?? 'visible-ui',
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
      recordRendererRecoveryReloadAttempt({ windowRole: getWindowRole(win) ?? 'visible-ui' });
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

  // A hung renderer leaves no trace in the durable log on its own: the main
  // process keeps serving while the window is frozen (2026-09-14, four child
  // streams into the root thread). Electron reports the hang; record it and
  // its recovery with timing so a debug pack can prove WHEN the UI locked.
  let unresponsiveSince: number | undefined;
  win.webContents.on('unresponsive', () => {
    unresponsiveSince = Date.now();
    startupLogger.error(
      { code: 'renderer_unresponsive', windowRole: getWindowRole(win) ?? 'visible-ui' },
      'Renderer became unresponsive'
    );
  });
  win.webContents.on('responsive', () => {
    startupLogger.warn(
      {
        code: 'renderer_responsive_again',
        unresponsiveMs:
          unresponsiveSince === undefined ? undefined : Date.now() - unresponsiveSince,
        windowRole: getWindowRole(win) ?? 'visible-ui',
      },
      'Renderer responsive again'
    );
    unresponsiveSince = undefined;
  });

  win.webContents.on(
    'render-process-gone',
    (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      startupLogger.error(
        {
          elapsedMs: Date.now() - startupStartedAt,
          exitCode: details.exitCode,
          reason: details.reason,
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
          recordRendererCrashLoopSuppressed({
            crashCountInWindow,
            exitCode: details.exitCode,
            reason: details.reason,
            windowRole: getWindowRole(win) ?? 'visible-ui',
          });
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
            crashCountInWindow,
            exitCode: details.exitCode,
            reason: details.reason,
            windowRole: getWindowRole(win) ?? 'visible-ui',
          },
          'Renderer crashed; deferring recovery (immediate reload causes main-thread freeze)'
        );
        pendingRendererRecovery = true;
        recordRendererCrashDeferred({
          crashCountInWindow,
          exitCode: details.exitCode,
          reason: details.reason,
          windowRole: getWindowRole(win) ?? 'visible-ui',
        });

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

  // Reveal the window BEFORE loading the renderer (Electron's documented
  // `backgroundColor` strategy for apps with heavy startup work:
  // https://www.electronjs.org/docs/latest/api/browser-window#showing-the-window-gracefully).
  // The frame appears instantly painted with the dark backgroundColor, then the
  // inline startup splash in index.html takes over as soon as the document
  // parses. ready-to-show intentionally stays log-only (see above): it fires for
  // the initial about:blank document, so gating reveal on it produced long blank
  // windows.
  if (!(isTestMode || win.isDestroyed())) {
    win.show();
    logStartupPhase('window-shown');
  } else if (
    isTestMode &&
    process.env['BRAINSTRIKE_E2E_SHOW_INACTIVE'] === '1' &&
    !win.isDestroyed()
  ) {
    // E2E keeps windows hidden so runs never pop up on a developer's desktop. On
    // Linux, Chromium renders a window X11 never mapped at one frame per second,
    // so the harness opts in to an unfocused show for Linux CI under Xvfb (BST-2040).
    win.showInactive();
  }

  logStartupPhase('loading-renderer');
  try {
    options.onBeforeLoad?.(win);
    await loadRenderer(win, rendererTarget);
  } catch (error) {
    // Don't leave a dead splash window on screen when the renderer never loads;
    // destroy it and let the caller surface the failure.
    if (!win.isDestroyed()) {
      win.destroy();
    }
    throw error;
  }
  logStartupPhase('renderer-loaded');

  return win;
}
