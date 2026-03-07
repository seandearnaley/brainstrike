import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import {
  createStoppedEmbeddingHostStatus,
  EMBEDDING_HOST_COMMAND_EVENT,
  EMBEDDING_HOST_STATUS_EVENT,
  type EmbeddingHostStatus,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';

const logger = createLogger('EmbeddingHostManager');

const DEV_RENDERER_URL =
  process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim() || 'http://localhost:8081';
const HOST_READY_TIMEOUT_MS = 30_000;

function resolveDistRoot(): string {
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  return path.basename(appPath) === 'dist' ? appPath : path.join(appPath, 'dist');
}

function createErrorStatus(message: string): EmbeddingHostStatus {
  return {
    state: 'error',
    active: false,
    lastError: message,
  };
}

function copyStatus(status: EmbeddingHostStatus): EmbeddingHostStatus {
  return {
    state: status.state,
    active: status.active,
    lastError: status.lastError,
  };
}

export class EmbeddingHostManager {
  private readonly events = new EventEmitter();
  private hostWindow: BrowserWindow | null = null;
  private powerSaveBlockerId: number | null = null;
  private status: EmbeddingHostStatus = createStoppedEmbeddingHostStatus();

  getStatus(): EmbeddingHostStatus {
    return copyStatus(this.status);
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.hostWindow?.id === window.id;
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<EmbeddingHostStatus> {
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
        HOST_READY_TIMEOUT_MS
      );
    }

    this.setStatus({
      state: 'starting',
      active: false,
      lastError: null,
    });

    try {
      const window = await this.createWindow();
      this.hostWindow = window;
      this.attachWindow(window);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(createErrorStatus(message));
      return this.getStatus();
    }

    if (!waitForRunning) {
      return this.getStatus();
    }

    try {
      return await this.waitForStatus(
        (status) => status.state === 'running' || status.state === 'error',
        HOST_READY_TIMEOUT_MS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(createErrorStatus(message));
      return this.getStatus();
    }
  }

  async stop(): Promise<EmbeddingHostStatus> {
    const window = this.hostWindow;
    if (!window || window.isDestroyed()) {
      this.hostWindow = null;
      this.setStatus(createStoppedEmbeddingHostStatus());
      return this.getStatus();
    }

    this.setStatus({
      state: 'stopping',
      active: false,
      lastError: null,
    });

    window.webContents.send(EMBEDDING_HOST_COMMAND_EVENT, { type: 'stop' });

    try {
      return await this.waitForStatus((status) => status.state === 'stopped', 10_000);
    } catch {
      window.destroy();
      this.hostWindow = null;
      this.setStatus(createStoppedEmbeddingHostStatus());
      return this.getStatus();
    }
  }

  async reset(): Promise<EmbeddingHostStatus> {
    const window = this.hostWindow;
    if (!window || window.isDestroyed()) {
      return this.ensureStarted();
    }

    this.setStatus({
      state: 'starting',
      active: false,
      lastError: null,
    });

    window.webContents.send(EMBEDDING_HOST_COMMAND_EVENT, { type: 'reset' });
    try {
      return await this.waitForStatus(
        (status) => status.state === 'running' || status.state === 'error',
        HOST_READY_TIMEOUT_MS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(createErrorStatus(message));
      return this.getStatus();
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.stop();
    } finally {
      const window = this.hostWindow;
      if (window && !window.isDestroyed()) {
        window.destroy();
      }
      this.hostWindow = null;
      this.stopPowerSaveBlocker();
      this.events.removeAllListeners();
      this.status = createStoppedEmbeddingHostStatus();
    }
  }

  acceptStatusReport(senderId: number, report: EmbeddingHostStatusReport): void {
    const window = this.hostWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.webContents.id !== senderId) {
      logger.warn('Rejected embedding host status report from unknown renderer', { senderId });
      return;
    }
    this.setStatus({
      state: report.state,
      active: report.active,
      lastError: report.lastError,
    });
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

    if (app.isPackaged || isTestMode) {
      await window.loadFile(path.join(resolveDistRoot(), 'renderer/index.html'), {
        query: { mode: 'embedding-host' },
      });
      return window;
    }

    await window.loadURL(`${DEV_RENDERER_URL}?mode=embedding-host`);
    return window;
  }

  private attachWindow(window: BrowserWindow): void {
    window.on('closed', () => {
      if (this.hostWindow?.id !== window.id) {
        return;
      }
      this.hostWindow = null;
      this.setStatus(createStoppedEmbeddingHostStatus());
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      if (this.hostWindow?.id !== window.id) {
        return;
      }
      const message = `Embedding host renderer exited (${details.reason}, code ${details.exitCode})`;
      logger.error(message, {
        reason: details.reason,
        exitCode: details.exitCode,
      });
      this.setStatus(createErrorStatus(message));
    });

    window.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, url, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        const message = `Embedding host failed to load (${errorCode}): ${errorDescription}`;
        logger.error(message, { url });
        this.setStatus(createErrorStatus(message));
      }
    );
  }

  private waitForStatus(
    predicate: (status: EmbeddingHostStatus) => boolean,
    timeoutMs: number
  ): Promise<EmbeddingHostStatus> {
    if (predicate(this.status)) {
      return Promise.resolve(this.getStatus());
    }

    return new Promise<EmbeddingHostStatus>((resolve, reject) => {
      const listener = (status: EmbeddingHostStatus) => {
        if (!predicate(status)) {
          return;
        }
        clearTimeout(timeoutId);
        this.events.removeListener(EMBEDDING_HOST_STATUS_EVENT, listener);
        resolve(copyStatus(status));
      };

      const timeoutId = setTimeout(() => {
        this.events.removeListener(EMBEDDING_HOST_STATUS_EVENT, listener);
        reject(new Error('Timed out waiting for embedding host state transition.'));
      }, timeoutMs);

      this.events.on(EMBEDDING_HOST_STATUS_EVENT, listener);
    });
  }

  private setStatus(status: EmbeddingHostStatus): void {
    this.status = copyStatus(status);
    this.syncPowerSaveBlocker();
    this.broadcastStatus();
    this.events.emit(EMBEDDING_HOST_STATUS_EVENT, this.getStatus());
  }

  private broadcastStatus(): void {
    const snapshot = this.getStatus();
    for (const window of BrowserWindow.getAllWindows()) {
      if (this.hostWindow?.id === window.id || window.isDestroyed()) {
        continue;
      }
      window.webContents.send(EMBEDDING_HOST_STATUS_EVENT, snapshot);
    }
  }

  private syncPowerSaveBlocker(): void {
    const shouldBlock = this.status.state === 'running' && this.status.active;
    if (shouldBlock) {
      if (this.powerSaveBlockerId === null) {
        this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        logger.info('powerSaveBlocker started for active embedding host work', {
          id: this.powerSaveBlockerId,
        });
      }
      return;
    }
    this.stopPowerSaveBlocker();
  }

  private stopPowerSaveBlocker(): void {
    if (this.powerSaveBlockerId === null) {
      return;
    }
    if (powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
      powerSaveBlocker.stop(this.powerSaveBlockerId);
      logger.info('powerSaveBlocker stopped for idle embedding host', {
        id: this.powerSaveBlockerId,
      });
    }
    this.powerSaveBlockerId = null;
  }
}
