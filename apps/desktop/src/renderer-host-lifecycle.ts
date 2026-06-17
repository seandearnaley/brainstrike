import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';
import { createRuntimeId } from '@brainstrike/worker-runtime';
import { app, BrowserWindow } from 'electron';
import { DESKTOP_DEV_RENDERER_URL } from './desktop-renderer-url';
import { waitForWindowClosed } from './window-lifecycle-utils';
import {
  assignWindowRole,
  clearWindowRoleByWebContentsId,
  type DesktopWindowRole,
  getTrackedWindowsByRole,
} from './window-role';

const DEFAULT_HOST_READY_TIMEOUT_MS = 30_000;
const HOST_LOAD_RETRY_ATTEMPTS = 3;
const HOST_LOAD_RETRY_DELAY_MS = 300;
const logger = createLogger('RendererHostLifecycle');
const RENDERER_HOST_LIFECYCLE_DISPOSED_CODE = 'RENDERER_HOST_LIFECYCLE_DISPOSED';

export type RendererHostLifecycleState = 'error' | 'running' | 'starting' | 'stopped' | 'stopping';

export interface RendererHostStatusShape {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly state: RendererHostLifecycleState;
}

export interface RendererHostLoadFailureContext {
  readonly errorCode: number;
  readonly errorDescription: string;
  readonly message: string;
  readonly url: string;
  readonly window: BrowserWindow;
}

export interface RendererHostProcessGoneContext {
  readonly exitCode: number;
  readonly message: string;
  readonly reason: string;
  readonly window: BrowserWindow;
}

interface RendererHostLifecycleOptions<TStatus extends RendererHostStatusShape> {
  readonly createStatus: (status: RendererHostStatusShape) => TStatus;
  readonly createStoppedStatus: () => TStatus;
  readonly mode: Exclude<DesktopWindowRole, 'visible-ui'>;
  readonly onDidFailLoad?: (context: RendererHostLoadFailureContext) => void;
  readonly onRenderProcessGone?: (context: RendererHostProcessGoneContext) => void;
  readonly onStatusChanged?: (status: TStatus) => void;
  readonly onWindowClosed?: (window: BrowserWindow) => void;
  readonly role: Exclude<DesktopWindowRole, 'visible-ui'>;
  readonly statusEventName: string;
  readonly timeoutMessage: string;
}

function resolveDistRoot(): string {
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  return path.basename(appPath) === 'dist' ? appPath : path.join(appPath, 'dist');
}

function createLifecycleDisposedError(role: Exclude<DesktopWindowRole, 'visible-ui'>): Error {
  const error = new Error(`${role} lifecycle was disposed while waiting for status.`);
  (
    error as Error & {
      code?: string;
    }
  ).code = RENDERER_HOST_LIFECYCLE_DISPOSED_CODE;
  return error;
}

function isLifecycleDisposedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (
      error as Error & {
        code?: string;
      }
    ).code === RENDERER_HOST_LIFECYCLE_DISPOSED_CODE
  );
}

export class RendererHostLifecycle<TStatus extends RendererHostStatusShape> {
  private readonly events = new EventEmitter();
  private hostWindow: BrowserWindow | null = null;
  private readonly pendingWaiterRejectors = new Set<(error: Error) => void>();
  private disposed = false;
  private startupPromise: Promise<TStatus> | null = null;
  private status: TStatus;

  constructor(private readonly options: RendererHostLifecycleOptions<TStatus>) {
    this.status = options.createStoppedStatus();
  }

  getHostWindow(): BrowserWindow | null {
    return this.hostWindow;
  }

  getStatus(): TStatus {
    return this.createStatusSnapshot(this.status);
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.hostWindow?.id === window.id;
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<TStatus> {
    if (this.disposed) {
      throw new Error(`${this.options.role} lifecycle has been disposed.`);
    }

    const waitForRunning = options?.waitForRunning ?? true;
    const existingWindow = this.hostWindow;

    if (this.startupPromise) {
      if (!waitForRunning) {
        return this.getStatus();
      }
      return this.startupPromise;
    }

    if (existingWindow && !existingWindow.isDestroyed()) {
      if (this.status.state === 'running') {
        return this.getStatus();
      }
      if (this.status.state === 'starting') {
        if (!waitForRunning) {
          return this.getStatus();
        }
        return this.waitForStatus(
          (status) => status.state === 'running' || status.state === 'error',
          DEFAULT_HOST_READY_TIMEOUT_MS
        );
      }

      // An existing hidden host window in stopped/stopping/error is not usable for new work.
      // Replace it inside the startup promise so concurrent callers share one restart path.
    }

    const runtimeId = createRuntimeId(this.options.role);
    this.setStatus(
      this.options.createStatus({
        state: 'starting',
        active: false,
        lastError: null,
        runtimeId,
      })
    );

    // startupPromise serializes replacement work, so this snapshot remains valid for the lifetime
    // of the in-flight startup attempt even if later callers arrive while it is pending.
    const shouldReplaceExistingWindow =
      !!existingWindow &&
      !existingWindow.isDestroyed() &&
      existingWindow.id === this.hostWindow?.id;

    this.startupPromise = Promise.resolve().then(async (): Promise<TStatus> => {
      if (shouldReplaceExistingWindow) {
        this.destroyHostWindow();
      }

      try {
        const window = await this.createWindow(runtimeId);
        if (this.disposed) {
          this.clearHostWindow(window);
          if (!window.isDestroyed()) {
            clearWindowRoleByWebContentsId(window.webContents.id);
            window.destroy();
          }
          return this.getStatus();
        }
        this.hostWindow = window;
        this.attachWindow(window);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus(
          this.options.createStatus({
            state: 'error',
            active: false,
            lastError: message,
            runtimeId,
          })
        );
        return this.getStatus();
      }

      try {
        return await this.waitForStatus(
          (status) => status.state === 'running' || status.state === 'error',
          DEFAULT_HOST_READY_TIMEOUT_MS
        );
      } catch (error) {
        if (isLifecycleDisposedError(error)) {
          return this.getStatus();
        }
        const message = error instanceof Error ? error.message : String(error);
        this.destroyHostWindow();
        this.setStatus(
          this.options.createStatus({
            state: 'error',
            active: false,
            lastError: message,
            runtimeId: this.status.runtimeId,
          })
        );
        return this.getStatus();
      }
    });
    const startupPromise = this.startupPromise;
    void startupPromise.finally(() => {
      if (this.startupPromise === startupPromise) {
        this.startupPromise = null;
      }
    });

    if (!waitForRunning) {
      return this.getStatus();
    }

    return startupPromise;
  }

  waitForStatus(predicate: (status: TStatus) => boolean, timeoutMs: number): Promise<TStatus> {
    try {
      if (predicate(this.status)) {
        return Promise.resolve(this.getStatus());
      }
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<TStatus>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const rejectPendingWaiter = (error: Error) => {
        if (settled) {
          return;
        }
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.pendingWaiterRejectors.delete(rejectPendingWaiter);
        this.events.removeListener(this.options.statusEventName, listener);
      };
      const listener = (status: TStatus) => {
        let matches = false;
        try {
          matches = predicate(status);
        } catch (error) {
          rejectPendingWaiter(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (!matches) {
          return;
        }
        cleanup();
        resolve(this.createStatusSnapshot(status));
      };

      timeoutId = setTimeout(() => {
        rejectPendingWaiter(new Error(this.options.timeoutMessage));
      }, timeoutMs);

      this.pendingWaiterRejectors.add(rejectPendingWaiter);
      this.events.on(this.options.statusEventName, listener);
    });
  }

  setStatus(status: TStatus): void {
    const nextStatus = this.createStatusSnapshot(status);
    if (this.areStatusesEqual(this.status, nextStatus)) {
      return;
    }
    this.status = nextStatus;
    const snapshot = this.getStatus();
    this.options.onStatusChanged?.(snapshot);
    this.broadcastStatus(snapshot);
    this.events.emit(this.options.statusEventName, snapshot);
  }

  clearHostWindow(window?: BrowserWindow): void {
    if (window && this.hostWindow?.id !== window.id) {
      return;
    }
    this.hostWindow = null;
  }

  destroyHostWindow(): void {
    const window = this.hostWindow;
    this.hostWindow = null;
    if (window && !window.isDestroyed()) {
      clearWindowRoleByWebContentsId(window.webContents.id);
      window.destroy();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.destroyHostWindow();
    // Any caller already awaiting the previously captured startup promise still needs a concrete
    // disposal signal here; otherwise it would sit until the status wait timeout fires.
    this.startupPromise = null;
    const disposalError = createLifecycleDisposedError(this.options.role);
    for (const rejectPendingWaiter of [...this.pendingWaiterRejectors]) {
      rejectPendingWaiter(disposalError);
    }
    this.pendingWaiterRejectors.clear();
    this.events.removeAllListeners();
    this.status = this.options.createStoppedStatus();
  }

  private createStatusSnapshot(status: TStatus): TStatus {
    return {
      ...status,
      ...this.options.createStatus(status),
    };
  }

  private buildWindow(): BrowserWindow {
    const isTestMode = process.argv.includes('--test-mode') && !app.isPackaged;
    const enableSandbox = !isTestMode;
    const preloadPath = path.join(resolveDistRoot(), 'preload.js');
    const window = new BrowserWindow({
      width: 320,
      height: 240,
      show: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: enableSandbox,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        backgroundThrottling: false,
      },
    });

    // Security: Prevent unauthorized window creation by background renderer hosts
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    return window;
  }

  private async loadWindow(window: BrowserWindow, runtimeId: string): Promise<void> {
    const isTestMode = process.argv.includes('--test-mode') && !app.isPackaged;
    if (app.isPackaged || isTestMode) {
      await window.loadFile(path.join(resolveDistRoot(), 'renderer/index.html'), {
        query: {
          mode: this.options.mode,
          runtimeId,
        },
      });
      return;
    }
    await window.loadURL(
      `${DESKTOP_DEV_RENDERER_URL}?mode=${encodeURIComponent(this.options.mode)}&runtimeId=${encodeURIComponent(runtimeId)}`
    );
  }

  private async createWindow(runtimeId: string): Promise<BrowserWindow> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < HOST_LOAD_RETRY_ATTEMPTS; attempt++) {
      if (this.disposed) {
        throw new Error(`${this.options.role} lifecycle was disposed during load retry.`);
      }
      const window = this.buildWindow();
      assignWindowRole(window, this.options.role);
      // Expose the in-flight window to status-report acceptance BEFORE the
      // page-load await: the host app can mount and send its one-shot
      // 'running' status while loadURL/loadFile is still pending. If the
      // manager's acceptStatusReport can't see this window yet, that report
      // is dropped and ensureStarted waits out the full ready timeout (then
      // destroys a perfectly healthy host).
      this.hostWindow = window;
      try {
        await this.loadWindow(window, runtimeId);
        return window;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          `${this.options.role} failed to load (attempt ${attempt + 1}/${HOST_LOAD_RETRY_ATTEMPTS})`,
          {
            attempt: attempt + 1,
            errorMessage: lastError.message,
          }
        );
        this.clearHostWindow(window);
        clearWindowRoleByWebContentsId(window.webContents.id);
        if (attempt < HOST_LOAD_RETRY_ATTEMPTS - 1) {
          // Register the closed listener BEFORE destroy() — Electron's destroy()
          // synchronously sets isDestroyed()=true, so waitForWindowClosed must
          // capture the 'closed' event while the window is still alive. The 300ms
          // timeout acts as a maximum wait; if 'closed' fires sooner, we retry
          // immediately (the goal is resource release, not a guaranteed backoff).
          const closedPromise = waitForWindowClosed(window, HOST_LOAD_RETRY_DELAY_MS);
          window.destroy();
          await closedPromise;
        } else {
          window.destroy();
        }
      }
    }
    throw new Error(
      `${this.options.role} failed to load after ${HOST_LOAD_RETRY_ATTEMPTS} attempts`,
      { cause: lastError }
    );
  }

  private attachWindow(window: BrowserWindow): void {
    window.on('closed', () => {
      if (this.hostWindow?.id !== window.id) {
        return;
      }
      this.hostWindow = null;
      this.options.onWindowClosed?.(window);
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      if (this.hostWindow?.id !== window.id) {
        return;
      }
      this.options.onRenderProcessGone?.({
        message: `${this.options.role} renderer exited (${details.reason}, code ${details.exitCode})`,
        reason: details.reason,
        exitCode: details.exitCode,
        window,
      });
    });

    window.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, url, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (this.hostWindow?.id !== window.id) {
          return;
        }
        this.options.onDidFailLoad?.({
          message: `${this.options.role} failed to load (${errorCode}): ${errorDescription}`,
          errorCode,
          errorDescription,
          url,
          window,
        });
      }
    );
  }

  private broadcastStatus(snapshot: TStatus): void {
    for (const window of getTrackedWindowsByRole('visible-ui')) {
      try {
        window.webContents.send(this.options.statusEventName, snapshot);
      } catch (error) {
        // Visible renderers can still disappear between registry lookup and send during shutdown.
        logger.debug('Host status broadcast skipped for unavailable window', {
          error,
          targetWindowId: window.id,
          windowRole: 'visible-ui',
        });
      }
    }
  }

  private areStatusesEqual(left: TStatus, right: TStatus): boolean {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every(
      (key) =>
        JSON.stringify((left as Record<string, unknown>)[key]) ===
        JSON.stringify((right as Record<string, unknown>)[key])
    );
  }
}
