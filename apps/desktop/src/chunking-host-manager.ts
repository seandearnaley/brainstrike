import { createLogger } from '@brainstrike/utils';
import { BrowserWindow } from 'electron';
import {
  CHUNKING_HOST_PROGRESS_EVENT,
  CHUNKING_HOST_REQUEST_EVENT,
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
import { RendererHostLifecycle, type RendererHostStatusShape } from './renderer-host-lifecycle';

const logger = createLogger('ChunkingHostManager');

function createChunkingHostStatus(status: RendererHostStatusShape): ChunkingHostStatus {
  return {
    runtimeKind: 'chunking-host',
    runtimeId: status.runtimeId,
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
  private readonly lifecycle: RendererHostLifecycle<ChunkingHostStatus>;
  private readonly pendingRequests = new Map<string, PendingChunkingRequest>();

  constructor() {
    this.lifecycle = new RendererHostLifecycle<ChunkingHostStatus>({
      createStatus: createChunkingHostStatus,
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
          createChunkingHostStatus({
            state: 'error',
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
          })
        );
      },
      onRenderProcessGone: ({ exitCode, message, reason }) => {
        logger.error(message, {
          reason,
          exitCode,
          windowRole: 'chunking-host',
        });
        this.rejectPendingRequests(message);
        this.lifecycle.setStatus(
          createChunkingHostStatus({
            state: 'error',
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
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
      createChunkingHostStatus({
        state: 'stopping',
        active: false,
        lastError: null,
        runtimeId: this.getStatus().runtimeId,
      })
    );

    const window = this.lifecycle.getHostWindow();
    if (window && !window.isDestroyed()) {
      this.lifecycle.destroyHostWindow();
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
      const message: ChunkingHostRequest = {
        type: 'request',
        channel: 'chunk',
        requestId: request.requestId,
        runtimeId: this.getStatus().runtimeId,
        payload: request,
      };
      this.lifecycle.getHostWindow()?.webContents.send(CHUNKING_HOST_REQUEST_EVENT, message);
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
      const message: ChunkingHostRequest = {
        type: 'request',
        channel: 'chunk',
        requestId: request.requestId,
        runtimeId: this.getStatus().runtimeId,
        payload: request,
      };
      this.lifecycle.getHostWindow()?.webContents.send(CHUNKING_HOST_REQUEST_EVENT, message);
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
      createChunkingHostStatus({
        state: report.state,
        active: report.active,
        lastError: report.lastError,
        runtimeId: report.runtimeId,
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
        senderId,
        requestId: report.requestId,
        type: report.type,
        channel: report.channel,
      });
      return;
    }

    const pending = this.pendingRequests.get(report.requestId);
    if (!pending) {
      logger.warn('Received chunking host response for unknown request', {
        requestId: report.requestId,
        type: report.type,
        channel: report.channel,
      });
      return;
    }

    if (report.type === 'progress') {
      this.forwardProgressEvent(pending.requesterWebContentsId, report);
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
            this.pendingRequests.delete(report.requestId);
            return;
          }
          this.pendingRequests.delete(report.requestId);
          pending.resolve(report.payload.result);
          return;

        case 'chunk-batch-complete':
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
          pending.resolve(Array.from(report.payload.results));
          return;
      }
    }

    this.pendingRequests.delete(report.requestId);
    pending.reject(createRequestFailure(report.payload.message));
  }

  private async assertReadyForRequests(): Promise<void> {
    const status = await this.ensureStarted({ waitForRunning: true });
    if (status.state === 'error') {
      throw new Error(status.lastError ?? 'Chunking host failed to start.');
    }
    if (status.state !== 'running') {
      throw new Error(`Chunking host is not ready for requests (state: ${status.state}).`);
    }
    const window = this.lifecycle.getHostWindow();
    if (!(window && !window.isDestroyed())) {
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
}
