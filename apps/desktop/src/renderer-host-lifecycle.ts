import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { createRuntimeId } from '@brainstrike/worker-runtime';
import { app, BrowserWindow } from 'electron';
import { DESKTOP_DEV_RENDERER_URL } from './desktop-renderer-url';
import { assignWindowRole, type DesktopWindowRole, getWindowRole } from './window-role';

const DEFAULT_HOST_READY_TIMEOUT_MS = 30_000;
const logger = createLogger('RendererHostLifecycle');

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

export class RendererHostLifecycle<TStatus extends RendererHostStatusShape> {
  private readonly events = new EventEmitter();
  private hostWindow: BrowserWindow | null = null;
  private startupPromise: Promise<TStatus> | null = null;
  private status: TStatus;

  constructor(private readonly options: RendererHostLifecycleOptions<TStatus>) {
    this.status = options.createStoppedStatus();
  }

  getHostWindow(): BrowserWindow | null {
    return this.hostWindow;
  }

  getStatus(): TStatus {
    return this.options.createStatus(this.status);
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.hostWindow?.id === window.id;
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<TStatus> {
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
      // Destroy it and create a fresh runtime instead of waiting on a state transition that
      // will never happen on its own.
      this.destroyHostWindow();
      this.setStatus(this.options.createStoppedStatus());
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

    const startupPromise = (async (): Promise<TStatus> => {
      try {
        const window = await this.createWindow(runtimeId);
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
    })();

    this.startupPromise = startupPromise;
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
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.events.removeListener(this.options.statusEventName, listener);
      };
      const listener = (status: TStatus) => {
        let matches = false;
        try {
          matches = predicate(status);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (!matches) {
          return;
        }
        cleanup();
        resolve(this.options.createStatus(status));
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(this.options.timeoutMessage));
      }, timeoutMs);

      this.events.on(this.options.statusEventName, listener);
    });
  }

  setStatus(status: TStatus): void {
    this.status = this.options.createStatus(status);
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
      window.destroy();
    }
  }

  dispose(): void {
    this.destroyHostWindow();
    this.startupPromise = null;
    this.events.removeAllListeners();
    this.status = this.options.createStoppedStatus();
  }

  private async createWindow(runtimeId: string): Promise<BrowserWindow> {
    const isTestMode = process.env['CI'] === 'true' || process.argv.includes('--test-mode');
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

    assignWindowRole(window, this.options.role);

    if (app.isPackaged || isTestMode) {
      await window.loadFile(path.join(resolveDistRoot(), 'renderer/index.html'), {
        query: { mode: this.options.mode, runtimeId },
      });
      return window;
    }

    await window.loadURL(
      `${DESKTOP_DEV_RENDERER_URL}?mode=${encodeURIComponent(this.options.mode)}&runtimeId=${encodeURIComponent(runtimeId)}`
    );
    return window;
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
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        this.hostWindow?.id === window.id ||
        window.isDestroyed() ||
        getWindowRole(window) === this.options.role
      ) {
        continue;
      }
      try {
        window.webContents.send(this.options.statusEventName, snapshot);
      } catch (error) {
        // A window can disappear between enumeration and send during shutdown churn.
        logger.debug('Host status broadcast skipped for unavailable window', {
          error,
          targetWindowId: window.id,
          windowRole: getWindowRole(window),
        });
      }
    }
  }
}
