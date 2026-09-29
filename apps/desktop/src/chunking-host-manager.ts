import { createLogger } from '@brainstrike/logging';
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
import { createHostRequestChannel, type HostRequestChannel } from './platform/host-request-channel';
import { RendererHostLifecycle } from './renderer-host-lifecycle';
import { waitForWindowClosed } from './window-lifecycle-utils';

const logger = createLogger('ChunkingHostManager');
const CHUNKING_HOST_REQUEST_TIMEOUT_MS = 30_000;
const CHUNKING_HOST_STOP_DESTROY_TIMEOUT_MS = 500;

type ChunkingRequestKind = 'batch' | 'file';

interface ChunkingRequester {
  readonly requesterWebContentsId: number;
  readonly requesterWindow: BrowserWindow | null;
}

function createRequestFailure(message: string): Error {
  return new Error(message);
}

function isProgressReport(report: ChunkingHostResponseReport): report is ChunkingHostProgressEvent {
  return report.type === 'progress';
}

export class ChunkingHostManager {
  private readonly lifecycle: RendererHostLifecycle<ChunkingHostStatus>;
  private readonly requests: HostRequestChannel<ChunkingHostRequest, ChunkingHostResponseReport>;

  constructor() {
    this.requests = createHostRequestChannel<ChunkingHostRequest, ChunkingHostResponseReport>({
      isProgress: isProgressReport,
      // `channel` and `type` are what identify WHICH late report arrived
      // (chunk-result vs chunk-batch-complete vs progress); the channel's
      // default late-response log carries only the request id.
      onLateResponse: (requestId, report) => {
        logger.warn('Received chunking host response for unknown request', {
          channel: report.channel,
          requestId,
          type: report.type,
        });
      },
      requestId: (request) => request.requestId,
      responseId: (report) => report.requestId,
      role: 'Chunking host',
      send: (request) => {
        this.requireHostWindow().webContents.send(CHUNKING_HOST_REQUEST_EVENT, request);
      },
      timeoutMs: () => CHUNKING_HOST_REQUEST_TIMEOUT_MS,
    });
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
    // Like the embedding and LLM managers: a failed stop still retires the
    // lifecycle, and the failure still reaches the shutdown step.
    try {
      await this.stop();
    } finally {
      this.lifecycle.dispose();
    }
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
    kind: ChunkingRequestKind,
    requesterWebContentsId: number,
    request:
      | ChunkingHostChunkBatchRequest
      | ChunkingHostChunkFileByIdRequest
      | ChunkingHostChunkFileRequest
  ): Promise<TResponse> {
    await this.assertReadyForRequests();
    // Captured once at dispatch so progress keeps flowing to the window that
    // asked even if BrowserWindow.getAllWindows() ordering changes mid-request.
    const requester: ChunkingRequester = {
      requesterWebContentsId,
      requesterWindow: this.resolveRequesterWindow(requesterWebContentsId),
    };
    const message: ChunkingHostRequest = {
      channel: 'chunk',
      payload: request,
      requestId: request.requestId,
      runtimeId: this.getStatus().runtimeId,
      type: 'request',
    };
    const report = await this.requests.request(message, {
      onProgress: (progress) => {
        if (isProgressReport(progress)) {
          this.forwardProgressEvent(requester, progress);
        }
      },
    });
    return this.interpretResponse(kind, report) as TResponse;
  }

  private interpretResponse(
    kind: ChunkingRequestKind,
    report: ChunkingHostResponseReport
  ): unknown {
    if (report.type === 'result') {
      switch (report.channel) {
        case 'chunk-result':
          if (kind !== 'file') {
            throw createRequestFailure(
              `Chunking host returned a single-file result for batch request ${report.requestId}.`
            );
          }
          return report.payload.result;

        case 'chunk-batch-complete':
          if (kind !== 'batch') {
            throw createRequestFailure(
              `Chunking host returned a batch result for single-file request ${report.requestId}.`
            );
          }
          return Array.from(report.payload.results);
      }
    }
    throw createRequestFailure(this.describeUnexpectedResponse(report));
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
    this.requests.accept(report);
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
      throw new Error('Chunking host window became unavailable after startup completed.');
    }
  }

  private requireHostWindow(): BrowserWindow {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      throw new Error('Chunking host window is unavailable.');
    }
    return window;
  }

  private forwardProgressEvent(
    requester: ChunkingRequester,
    progress: ChunkingHostProgressEvent
  ): void {
    const targetWindow =
      requester.requesterWindow && !requester.requesterWindow.isDestroyed()
        ? requester.requesterWindow
        : this.resolveRequesterWindow(requester.requesterWebContentsId);
    if (!targetWindow) {
      logger.trace('Dropped chunking progress for missing requester window', {
        channel: progress.channel,
        requesterWebContentsId: requester.requesterWebContentsId,
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
        requesterWebContentsId: requester.requesterWebContentsId,
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
    this.requests.rejectAll(() => createRequestFailure(message));
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
