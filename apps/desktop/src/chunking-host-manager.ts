import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { app, BrowserWindow } from 'electron';
import {
  CHUNKING_HOST_PROGRESS_EVENT,
  CHUNKING_HOST_REQUEST_EVENT,
  CHUNKING_HOST_STATUS_EVENT,
  type ChunkingHostChunkBatchRequest,
  type ChunkingHostChunkFileRequest,
  type ChunkingHostProgressEvent,
  type ChunkingHostResponseReport,
  type ChunkingHostStatus,
  type ChunkingHostStatusReport,
  createStoppedChunkingHostStatus,
} from './chunking-host-shared';

const logger = createLogger('ChunkingHostManager');

const DEV_RENDERER_URL =
  process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']?.trim() || 'http://localhost:8081';
const HOST_READY_TIMEOUT_MS = 30_000;

function resolveDistRoot(): string {
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  return path.basename(appPath) === 'dist' ? appPath : path.join(appPath, 'dist');
}

function createErrorStatus(message: string): ChunkingHostStatus {
  return {
    state: 'error',
    active: false,
    lastError: message,
  };
}

function copyStatus(status: ChunkingHostStatus): ChunkingHostStatus {
  return {
    state: status.state,
    active: status.active,
    lastError: status.lastError,
  };
}

type PendingChunkingRequest =
  | {
      readonly kind: 'batch';
      readonly requesterWebContentsId: number;
      readonly reject: (error: Error) => void;
      readonly resolve: (results: unknown[]) => void;
    }
  | {
      readonly kind: 'file';
      readonly requesterWebContentsId: number;
      readonly reject: (error: Error) => void;
      readonly resolve: (result: unknown) => void;
    };

function createRequestFailure(message: string): Error {
  return new Error(message);
}

export class ChunkingHostManager {
  private readonly events = new EventEmitter();
  private hostWindow: BrowserWindow | null = null;
  private readonly pendingRequests = new Map<string, PendingChunkingRequest>();
  private status: ChunkingHostStatus = createStoppedChunkingHostStatus();

  getStatus(): ChunkingHostStatus {
    return copyStatus(this.status);
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.hostWindow?.id === window.id;
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<ChunkingHostStatus> {
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

  async stop(): Promise<ChunkingHostStatus> {
    const window = this.hostWindow;
    this.rejectPendingRequests('Chunking host stopped while requests were in flight.');
    this.setStatus({
      state: 'stopping',
      active: false,
      lastError: null,
    });

    if (window && !window.isDestroyed()) {
      window.destroy();
    }

    this.hostWindow = null;
    this.setStatus(createStoppedChunkingHostStatus());
    return this.getStatus();
  }

  async reset(): Promise<ChunkingHostStatus> {
    await this.stop();
    return this.ensureStarted({ waitForRunning: true });
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.events.removeAllListeners();
    this.status = createStoppedChunkingHostStatus();
  }

  async chunkFile(
    requesterWebContentsId: number,
    request: ChunkingHostChunkFileRequest
  ): Promise<unknown> {
    await this.assertReadyForRequests();
    return new Promise<unknown>((resolve, reject) => {
      if (this.pendingRequests.has(request.requestId)) {
        reject(
          createRequestFailure(`Chunking host request ${request.requestId} is already in flight.`)
        );
        return;
      }

      this.pendingRequests.set(request.requestId, {
        kind: 'file',
        requesterWebContentsId,
        resolve,
        reject,
      });
      this.hostWindow?.webContents.send(CHUNKING_HOST_REQUEST_EVENT, request);
    });
  }

  async chunkBatch(
    requesterWebContentsId: number,
    request: ChunkingHostChunkBatchRequest
  ): Promise<unknown[]> {
    await this.assertReadyForRequests();
    return new Promise<unknown[]>((resolve, reject) => {
      if (this.pendingRequests.has(request.requestId)) {
        reject(
          createRequestFailure(`Chunking host request ${request.requestId} is already in flight.`)
        );
        return;
      }

      this.pendingRequests.set(request.requestId, {
        kind: 'batch',
        requesterWebContentsId,
        resolve,
        reject,
      });
      this.hostWindow?.webContents.send(CHUNKING_HOST_REQUEST_EVENT, request);
    });
  }

  acceptStatusReport(senderId: number, report: ChunkingHostStatusReport): void {
    const window = this.hostWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.webContents.id !== senderId) {
      logger.warn('Rejected chunking host status report from unknown renderer', { senderId });
      return;
    }
    this.setStatus({
      state: report.state,
      active: report.active,
      lastError: report.lastError,
    });
  }

  acceptResponseReport(senderId: number, report: ChunkingHostResponseReport): void {
    const window = this.hostWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.webContents.id !== senderId) {
      logger.warn('Rejected chunking host response report from unknown renderer', {
        senderId,
        requestId: report.requestId,
        type: report.type,
      });
      return;
    }

    const pending = this.pendingRequests.get(report.requestId);
    if (!pending) {
      logger.warn('Received chunking host response for unknown request', {
        requestId: report.requestId,
        type: report.type,
      });
      return;
    }

    switch (report.type) {
      case 'progress':
      case 'file-complete':
      case 'file-error':
        this.forwardProgressEvent(pending.requesterWebContentsId, report);
        return;

      case 'result':
        if (pending.kind !== 'file') {
          pending.reject(
            createRequestFailure(
              `Chunking host returned a single-file result for batch request ${report.requestId}.`
            )
          );
          this.pendingRequests.delete(report.requestId);
          return;
        }
        this.pendingRequests.delete(report.requestId);
        pending.resolve(report.result);
        return;

      case 'batch-complete':
        if (pending.kind !== 'batch') {
          pending.reject(
            createRequestFailure(
              `Chunking host returned a batch result for single-file request ${report.requestId}.`
            )
          );
          this.pendingRequests.delete(report.requestId);
          return;
        }
        this.pendingRequests.delete(report.requestId);
        pending.resolve(Array.from(report.results));
        return;

      case 'error':
        this.pendingRequests.delete(report.requestId);
        pending.reject(createRequestFailure(report.error));
        return;
    }
  }

  private async assertReadyForRequests(): Promise<void> {
    const status = await this.ensureStarted({ waitForRunning: true });
    if (status.state === 'error') {
      throw new Error(status.lastError ?? 'Chunking host failed to start.');
    }
    if (status.state !== 'running') {
      throw new Error(`Chunking host is not ready for requests (state: ${status.state}).`);
    }
    if (!(this.hostWindow && !this.hostWindow.isDestroyed())) {
      throw new Error('Chunking host window is not available.');
    }
  }

  private forwardProgressEvent(
    requesterWebContentsId: number,
    progress: ChunkingHostProgressEvent
  ): void {
    const targetWindow = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === requesterWebContentsId && !window.isDestroyed()
    );
    if (!targetWindow) {
      return;
    }
    targetWindow.webContents.send(CHUNKING_HOST_PROGRESS_EVENT, progress);
  }

  private rejectPendingRequests(message: string): void {
    if (this.pendingRequests.size === 0) {
      return;
    }
    const failure = createRequestFailure(message);
    for (const [requestId, pending] of this.pendingRequests) {
      pending.reject(failure);
      this.pendingRequests.delete(requestId);
    }
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
        query: { mode: 'chunking-host' },
      });
      return window;
    }

    await window.loadURL(`${DEV_RENDERER_URL}?mode=chunking-host`);
    return window;
  }

  private attachWindow(window: BrowserWindow): void {
    window.on('closed', () => {
      if (this.hostWindow?.id !== window.id) {
        return;
      }
      this.hostWindow = null;
      this.rejectPendingRequests('Chunking host window closed while requests were in flight.');
      this.setStatus(createStoppedChunkingHostStatus());
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      if (this.hostWindow?.id !== window.id) {
        return;
      }
      const message = `Chunking host renderer exited (${details.reason}, code ${details.exitCode})`;
      logger.error(message, {
        reason: details.reason,
        exitCode: details.exitCode,
      });
      this.rejectPendingRequests(message);
      this.setStatus(createErrorStatus(message));
    });

    window.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, url, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        const message = `Chunking host failed to load (${errorCode}): ${errorDescription}`;
        logger.error(message, { url });
        this.rejectPendingRequests(message);
        this.setStatus(createErrorStatus(message));
      }
    );
  }

  private waitForStatus(
    predicate: (status: ChunkingHostStatus) => boolean,
    timeoutMs: number
  ): Promise<ChunkingHostStatus> {
    if (predicate(this.status)) {
      return Promise.resolve(this.getStatus());
    }

    return new Promise<ChunkingHostStatus>((resolve, reject) => {
      const listener = (status: ChunkingHostStatus) => {
        if (!predicate(status)) {
          return;
        }
        clearTimeout(timeoutId);
        this.events.removeListener(CHUNKING_HOST_STATUS_EVENT, listener);
        resolve(copyStatus(status));
      };

      const timeoutId = setTimeout(() => {
        this.events.removeListener(CHUNKING_HOST_STATUS_EVENT, listener);
        reject(new Error('Timed out waiting for chunking host state transition.'));
      }, timeoutMs);

      this.events.on(CHUNKING_HOST_STATUS_EVENT, listener);
    });
  }

  private setStatus(status: ChunkingHostStatus): void {
    this.status = copyStatus(status);
    this.broadcastStatus();
    this.events.emit(CHUNKING_HOST_STATUS_EVENT, this.getStatus());
  }

  private broadcastStatus(): void {
    const snapshot = this.getStatus();
    for (const window of BrowserWindow.getAllWindows()) {
      if (this.hostWindow?.id === window.id || window.isDestroyed()) {
        continue;
      }
      window.webContents.send(CHUNKING_HOST_STATUS_EVENT, snapshot);
    }
  }
}
