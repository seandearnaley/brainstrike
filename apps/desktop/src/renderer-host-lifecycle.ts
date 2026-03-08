import { EventEmitter } from 'node:events';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { assignWindowRole, type DesktopWindowRole, getWindowRole } from './window-role';

const DEFAULT_HOST_READY_TIMEOUT_MS = 30_000;

export type RendererHostLifecycleState = 'error' | 'running' | 'starting' | 'stopped' | 'stopping';

export interface RendererHostStatusShape {
  readonly active: boolean;
  readonly lastError: string | null;
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

const DEV_RENDERER_URL =
  process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim() || 'http://localhost:8081';

function resolveDistRoot(): string {
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  return path.basename(appPath) === 'dist' ? appPath : path.join(appPath, 'dist');
}

export class RendererHostLifecycle<TStatus extends RendererHostStatusShape> {
  private readonly events = new EventEmitter();
  private hostWindow: BrowserWindow | null = null;
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

    if (existingWindow && !existingWindow.isDestroyed()) {
      if (!waitForRunning) {
        return this.getStatus();
      }
      if (this.status.state === 'running' || this.status.state === 'error') {
        return this.getStatus();
      }
      return this.waitForStatus(
        (status) => status.state === 'running' || status.state === 'error',
        DEFAULT_HOST_READY_TIMEOUT_MS
      );
    }

    this.setStatus(
      this.options.createStatus({
        state: 'starting',
        active: false,
        lastError: null,
      })
    );

    try {
      const window = await this.createWindow();
      this.hostWindow = window;
      this.attachWindow(window);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(
        this.options.createStatus({
          state: 'error',
          active: false,
          lastError: message,
        })
      );
      return this.getStatus();
    }

    if (!waitForRunning) {
      return this.getStatus();
    }

    try {
      return await this.waitForStatus(
        (status) => status.state === 'running' || status.state === 'error',
        DEFAULT_HOST_READY_TIMEOUT_MS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(
        this.options.createStatus({
          state: 'error',
          active: false,
          lastError: message,
        })
      );
      return this.getStatus();
    }
  }

  waitForStatus(predicate: (status: TStatus) => boolean, timeoutMs: number): Promise<TStatus> {
    if (predicate(this.status)) {
      return Promise.resolve(this.getStatus());
    }

    return new Promise<TStatus>((resolve, reject) => {
      const listener = (status: TStatus) => {
        if (!predicate(status)) {
          return;
        }
        clearTimeout(timeoutId);
        this.events.removeListener(this.options.statusEventName, listener);
        resolve(this.options.createStatus(status));
      };

      const timeoutId = setTimeout(() => {
        this.events.removeListener(this.options.statusEventName, listener);
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
    this.hostWindow = null;
    this.events.removeAllListeners();
    this.status = this.options.createStoppedStatus();
  }

  private async createWindow(): Promise<BrowserWindow> {
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
        query: { mode: this.options.mode },
      });
      return window;
    }

    await window.loadURL(`${DEV_RENDERER_URL}?mode=${this.options.mode}`);
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
      window.webContents.send(this.options.statusEventName, snapshot);
    }
  }
}
