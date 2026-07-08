import { createLogger } from '@brainstrike/utils/logger';
import { BrowserWindow } from 'electron';
import {
  CHUNKING_HOST_PROGRESS_EVENT,
  CHUNKING_HOST_REQUEST_EVENT,
  CHUNKING_HOST_STATUS_ADAPTER,
  CHUNKING_HOST_STATUS_EVENT,
  type ChunkingHostChunkBatchRequest,
  type ChunkingHostChunkFileByIdRequest,
  type ChunkingHostChunkFileRequest,
  type ChunkingHostProgressEvent,
  type ChunkingHostRequest,
  type ChunkingHostResponseReport,
  type ChunkingHostStatus,
  type ChunkingHostStatusReport,
  createStoppedChunkingHostStatus,
} from './chunking-host-shared';
import { RendererHostLifecycle } from './renderer-host-lifecycle';
import { waitForWindowClosed } from './window-lifecycle-utils';

const logger = createLogger('ChunkingHostManager');
const CHUNKING_HOST_REQUEST_TIMEOUT_MS = 30_000;
const CHUNKING_HOST_STOP_DESTROY_TIMEOUT_MS = 500;

type PendingChunkingRequest =
  | {
      readonly kind: 'batch';
      readonly requesterWindow: BrowserWindow | null;
      readonly requesterWebContentsId: number;
      readonly reject: (error: Error) => void;
      readonly resolve: (results: unknown[]) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  | {
      readonly kind: 'file';
      readonly requesterWindow: BrowserWindow | null;
      readonly requesterWebContentsId: number;
      readonly reject: (error: Error) => void;
      readonly resolve: (result: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    };

function createRequestFailure(message: string): Error {
  return new Error(message);
}

export class ChunkingHostManager {
  private readonly lifecycle: RendererHostLifecycle<ChunkingHostStatus>;
  private readonly pendingRequests = new Map<string, PendingChunkingRequest>();

  constructor() {
    this.lifecycle = new RendererHostLifecycle<ChunkingHostStatus>({
      createStatus: CHUNKING_HOST_STATUS_ADAPTER.createStatus,
      createStoppedStatus: createStoppedChunkingHostStatus,
      mode: 'chunking-host',
      onDidFailLoad: ({ errorCode, errorDescription, message, url }) => {
        logger.error(message, {
          errorCode,
          errorDescription,
          url,
          windowRole: 'chunking-host',
        });
        this.rejectPendingRequests(message);
        this.lifecycle.setStatus(
          CHUNKING_HOST_STATUS_ADAPTER.createStatus({
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
            state: 'error',
          })
        );
      },
      onRenderProcessGone: ({ exitCode, message, reason }) => {
        logger.error(message, {
          exitCode,
          reason,
          windowRole: 'chunking-host',
        });
        this.rejectPendingRequests(message);
        this.lifecycle.setStatus(
          CHUNKING_HOST_STATUS_ADAPTER.createStatus({
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
            state: 'error',
          })
        );
      },
      onWindowClosed: () => {
        this.rejectPendingRequests('Chunking host window closed while requests were in flight.');
        this.lifecycle.setStatus(createStoppedChunkingHostStatus());
      },
      role: 'chunking-host',
      statusEventName: CHUNKING_HOST_STATUS_EVENT,
      timeoutMessage: 'Timed out waiting for chunking host state transition.',
    });
  }

  getStatus(): ChunkingHostStatus {
    return this.lifecycle.getStatus();
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.lifecycle.isHostWindow(window);
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<ChunkingHostStatus> {
    return this.lifecycle.ensureStarted(options);
  }

  async stop(): Promise<ChunkingHostStatus> {
    this.rejectPendingRequests('Chunking host stopped while requests were in flight.');
    this.lifecycle.setStatus(
      CHUNKING_HOST_STATUS_ADAPTER.createStatus({
        active: false,
        lastError: null,
        runtimeId: this.getStatus().runtimeId,
        state: 'stopping',
      })
    );

    const window = this.lifecycle.getHostWindow();
    if (window && !window.isDestroyed()) {
      // Register the closed listener BEFORE destroy() — Electron's destroy()
      // synchronously sets isDestroyed()=true, so waitForWindowClosed must be
      // called while the window is still alive to capture the 'closed' event.
      const closedPromise = waitForWindowClosed(window, CHUNKING_HOST_STOP_DESTROY_TIMEOUT_MS);
      this.lifecycle.destroyHostWindow();
      await closedPromise;
    }

    this.lifecycle.clearHostWindow();
    this.lifecycle.setStatus(createStoppedChunkingHostStatus());
    return this.getStatus();
  }

  async reset(): Promise<ChunkingHostStatus> {
    await this.stop();
    return this.ensureStarted({ waitForRunning: true });
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.lifecycle.dispose();
  }

  async chunkFile(
    requesterWebContentsId: number,
    request: ChunkingHostChunkFileByIdRequest | ChunkingHostChunkFileRequest
  ): Promise<unknown> {
    return this.sendRequest('file', requesterWebContentsId, request);
  }

  async chunkBatch(
    requesterWebContentsId: number,
    request: ChunkingHostChunkBatchRequest
  ): Promise<unknown[]> {
    return this.sendRequest('batch', requesterWebContentsId, request);
  }

  private async sendRequest<TResponse>(
    kind: PendingChunkingRequest['kind'],
    requesterWebContentsId: number,
    request:
      | ChunkingHostChunkBatchRequest
      | ChunkingHostChunkFileByIdRequest
      | ChunkingHostChunkFileRequest
  ): Promise<TResponse> {
    const hostWindow = await this.assertReadyForRequests();
    return new Promise<TResponse>((resolve, reject) => {
      if (this.pendingRequests.has(request.requestId)) {
        reject(
          createRequestFailure(`Chunking host request ${request.requestId} is already in flight.`)
        );
        return;
      }

      const timeoutId = this.createRequestTimeout(request.requestId);
      const pendingRequest: PendingChunkingRequest =
        kind === 'batch'
          ? {
              kind: 'batch',
              reject,
              requesterWebContentsId,
              requesterWindow: this.resolveRequesterWindow(requesterWebContentsId),
              resolve: resolve as (results: unknown[]) => void,
              timeoutId,
            }
          : {
              kind: 'file',
              reject,
              requesterWebContentsId,
              requesterWindow: this.resolveRequesterWindow(requesterWebContentsId),
              resolve: resolve as (result: unknown) => void,
              timeoutId,
            };
      this.pendingRequests.set(request.requestId, pendingRequest);
      const message: ChunkingHostRequest = {
        channel: 'chunk',
        payload: request,
        requestId: request.requestId,
        runtimeId: this.getStatus().runtimeId,
        type: 'request',
      };
      try {
        hostWindow.webContents.send(CHUNKING_HOST_REQUEST_EVENT, message);
      } catch (error) {
        this.clearPendingRequest(request.requestId);
        reject(
          createRequestFailure(
            error instanceof Error
              ? `Chunking host request ${request.requestId} could not be sent: ${error.message}`
              : `Chunking host request ${request.requestId} could not be sent.`
          )
        );
      }
    });
  }

  acceptStatusReport(senderId: number, report: ChunkingHostStatusReport): void {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.webContents.id !== senderId) {
      logger.warn('Rejected chunking host status report from unknown renderer', { senderId });
      return;
    }
    this.lifecycle.setStatus(
      CHUNKING_HOST_STATUS_ADAPTER.createStatus({
        active: report.active,
        lastError: report.lastError,
        runtimeId: report.runtimeId,
        state: report.state,
      })
    );
  }

  acceptResponseReport(senderId: number, report: ChunkingHostResponseReport): void {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.webContents.id !== senderId) {
      logger.warn('Rejected chunking host response report from unknown renderer', {
        channel: report.channel,
        requestId: report.requestId,
        senderId,
        type: report.type,
      });
      return;
    }

    const pending = this.pendingRequests.get(report.requestId);
    if (!pending) {
      logger.warn('Received chunking host response for unknown request', {
        channel: report.channel,
        requestId: report.requestId,
        type: report.type,
      });
      return;
    }

    if (report.type === 'progress') {
      this.refreshRequestTimeout(report.requestId);
      this.forwardProgressEvent(pending, report);
      return;
    }

    if (report.type === 'result') {
      switch (report.channel) {
        case 'chunk-result':
          if (pending.kind !== 'file') {
            pending.reject(
              createRequestFailure(
                `Chunking host returned a single-file result for batch request ${report.requestId}.`
              )
            );
            this.clearPendingRequest(report.requestId);
            return;
          }
          this.clearPendingRequest(report.requestId);
          pending.resolve(report.payload.result);
          return;

        case 'chunk-batch-complete':
          if (pending.kind !== 'batch') {
            pending.reject(
              createRequestFailure(
                `Chunking host returned a batch result for single-file request ${report.requestId}.`
              )
            );
            this.clearPendingRequest(report.requestId);
            return;
          }
          this.clearPendingRequest(report.requestId);
          pending.resolve(Array.from(report.payload.results));
          return;
      }
    }

    this.clearPendingRequest(report.requestId);
    pending.reject(createRequestFailure(this.describeUnexpectedResponse(report)));
  }

  private async assertReadyForRequests(): Promise<BrowserWindow> {
    const status = await this.ensureStarted({ waitForRunning: true });
    if (status.state === 'error') {
      throw new Error(status.lastError ?? 'Chunking host failed to start.');
    }
    if (status.state !== 'running') {
      throw new Error(`Chunking host is not ready for requests (state: ${status.state}).`);
    }
    const window = this.lifecycle.getHostWindow();
    if (!(window && !window.isDestroyed())) {
      throw new Error('Chunking host window became unavailable after startup completed.');
    }
    return window;
  }

  private forwardProgressEvent(
    pending: PendingChunkingRequest,
    progress: ChunkingHostProgressEvent
  ): void {
    const targetWindow =
      pending.requesterWindow && !pending.requesterWindow.isDestroyed()
        ? pending.requesterWindow
        : this.resolveRequesterWindow(pending.requesterWebContentsId);
    if (!targetWindow) {
      logger.trace('Dropped chunking progress for missing requester window', {
        channel: progress.channel,
        requesterWebContentsId: pending.requesterWebContentsId,
        requestId: progress.requestId,
      });
      return;
    }
    try {
      targetWindow.webContents.send(CHUNKING_HOST_PROGRESS_EVENT, progress);
    } catch (error) {
      logger.trace('Dropped chunking progress for unavailable requester window', {
        channel: progress.channel,
        error,
        requesterWebContentsId: pending.requesterWebContentsId,
        requestId: progress.requestId,
      });
    }
  }

  private resolveRequesterWindow(requesterWebContentsId: number): BrowserWindow | null {
    return (
      BrowserWindow.getAllWindows().find(
        (window) => window.webContents.id === requesterWebContentsId && !window.isDestroyed()
      ) ?? null
    );
  }

  private rejectPendingRequests(message: string): void {
    if (this.pendingRequests.size === 0) {
      return;
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(createRequestFailure(message));
    }
    this.pendingRequests.clear();
  }

  private clearPendingRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);
  }

  private createRequestTimeout(requestId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      this.clearPendingRequest(requestId);
      pending.reject(
        createRequestFailure(
          `Chunking host request ${requestId} timed out after ${CHUNKING_HOST_REQUEST_TIMEOUT_MS}ms.`
        )
      );
    }, CHUNKING_HOST_REQUEST_TIMEOUT_MS);
  }

  private refreshRequestTimeout(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    pending.timeoutId = this.createRequestTimeout(requestId);
  }

  private describeUnexpectedResponse(report: ChunkingHostResponseReport): string {
    if (report.type === 'error') {
      return (
        report.payload.errorMessage ?? report.payload.message ?? 'Unknown chunking host error.'
      );
    }
    return `Unexpected chunking host response (type=${report.type}, channel=${report.channel}).`;
  }
}
