import { createLogger } from '@brainstrike/utils/logger';
import { createRuntimeId, deserializeRuntimeError } from '@brainstrike/worker-runtime';
import { type BrowserWindow, powerSaveBlocker } from 'electron';
import {
  createEmbeddingHostCommand,
  createEmbeddingHostQueryEmbeddingRequest,
  createStoppedEmbeddingHostStatus,
  EMBEDDING_HOST_COMMAND_EVENT,
  EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
  EMBEDDING_HOST_STATUS_ADAPTER,
  EMBEDDING_HOST_STATUS_EVENT,
  EMBEDDING_HOST_STOPPED_RUNTIME_ID,
  type EmbeddingHostQueryEmbeddingPayload,
  type EmbeddingHostQueryEmbeddingResponseReport,
  type EmbeddingHostStatus,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';
import {
  createRuntimeHostPlatformStatus,
  type RuntimeHostControlState,
  type RuntimeHostPlatformStatus,
} from './platform/runtime-host-state';
import { RendererHostLifecycle } from './renderer-host-lifecycle';

const logger = createLogger('EmbeddingHostManager');

const HOST_READY_TIMEOUT_MS = 30_000;
const QUERY_EMBEDDING_TIMEOUT_MS = 60_000;
const MAX_PENDING_QUERY_EMBEDDING_REQUESTS = 8;
const POWER_SAVE_BLOCKER_IDLE_GRACE_MS = 5000;
const EMBEDDING_HOST_STATUS_IDLE_GRACE_MS = 5000;

interface PendingQueryEmbeddingRequest {
  reject: (error: Error) => void;
  resolve: (embedding: number[]) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class EmbeddingHostManager {
  private disposed = false;
  private readonly lifecycle: RendererHostLifecycle<EmbeddingHostStatus>;
  private pendingInactiveStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingInactiveStatusReport: EmbeddingHostStatusReport | null = null;
  private powerSaveBlockerId: number | null = null;
  private pendingIdleStopTimer: ReturnType<typeof setTimeout> | null = null;
  private controlState: RuntimeHostControlState | null = null;
  private readonly pendingQueryEmbeddingRequests = new Map<string, PendingQueryEmbeddingRequest>();

  constructor() {
    this.lifecycle = new RendererHostLifecycle<EmbeddingHostStatus>({
      createStatus: EMBEDDING_HOST_STATUS_ADAPTER.createStatus,
      createStoppedStatus: createStoppedEmbeddingHostStatus,
      mode: 'embedding-host',
      onDidFailLoad: ({ errorCode, errorDescription, message, url }) => {
        this.clearPendingInactiveStatus();
        this.rejectPendingQueryEmbeddingRequests(message);
        logger.error(message, { errorCode, errorDescription, url, windowRole: 'embedding-host' });
        this.lifecycle.setStatus(
          EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
            state: 'error',
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
          })
        );
      },
      onRenderProcessGone: ({ exitCode, message, reason }) => {
        this.clearPendingInactiveStatus();
        this.rejectPendingQueryEmbeddingRequests(message);
        logger.error(message, {
          reason,
          exitCode,
          windowRole: 'embedding-host',
        });
        this.lifecycle.setStatus(
          EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
            state: 'error',
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
          })
        );
      },
      onStatusChanged: (status) => {
        this.syncPowerSaveBlocker(status);
      },
      onWindowClosed: () => {
        this.clearPendingInactiveStatus();
        this.rejectPendingQueryEmbeddingRequests(
          'Embedding host window closed while query embedding requests were in flight.'
        );
        this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      },
      role: 'embedding-host',
      statusEventName: EMBEDDING_HOST_STATUS_EVENT,
      timeoutMessage: 'Timed out waiting for embedding host state transition.',
    });
  }

  getStatus(): EmbeddingHostStatus {
    return this.lifecycle.getStatus();
  }

  getPlatformStatus(): RuntimeHostPlatformStatus<'embedding-host'> {
    return createRuntimeHostPlatformStatus(this.getStatus(), {
      ...(this.disposed
        ? { controlState: 'disposed' as const }
        : this.controlState
          ? { controlState: this.controlState }
          : {}),
      pendingRequestCount: this.pendingQueryEmbeddingRequests.size,
    });
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.lifecycle.isHostWindow(window);
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('ensureStarted');
    return this.lifecycle.ensureStarted(options);
  }

  async stop(): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('stop');
    this.rejectPendingQueryEmbeddingRequests(
      'Embedding host stopped while query embedding requests were in flight.'
    );
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      this.lifecycle.clearHostWindow();
      this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      return this.getStatus();
    }

    this.lifecycle.setStatus(
      EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
        state: 'stopping',
        active: false,
        lastError: null,
        runtimeId: this.getStatus().runtimeId,
      })
    );
    this.clearPendingInactiveStatus();
    const { runtimeId } = this.getStatus();

    window.webContents.send(
      EMBEDDING_HOST_COMMAND_EVENT,
      createEmbeddingHostCommand('stop', runtimeId)
    );

    try {
      const status = await this.lifecycle.waitForStatus(
        (nextStatus) => nextStatus.state === 'stopped' || nextStatus.state === 'error',
        10_000
      );
      if (status.state === 'error') {
        this.lifecycle.destroyHostWindow();
        this.lifecycle.clearHostWindow();
        this.lifecycle.setStatus(createStoppedEmbeddingHostStatus(runtimeId));
        return this.getStatus();
      }
      return status;
    } catch {
      this.lifecycle.destroyHostWindow();
      this.lifecycle.clearHostWindow();
      this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      return this.getStatus();
    }
  }

  async reset(): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('reset');
    this.rejectPendingQueryEmbeddingRequests(
      'Embedding host reset while query embedding requests were in flight.'
    );
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      return this.ensureStarted();
    }
    const currentRuntimeId = this.getStatus().runtimeId;
    const nextRuntimeId = createRuntimeId('embedding-host');
    this.controlState = 'resetting';

    this.lifecycle.setStatus(
      EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
        state: 'starting',
        active: false,
        lastError: null,
        runtimeId: nextRuntimeId,
      })
    );
    this.clearPendingInactiveStatus();

    window.webContents.send(
      EMBEDDING_HOST_COMMAND_EVENT,
      createEmbeddingHostCommand('reset', currentRuntimeId, nextRuntimeId)
    );
    try {
      return await this.lifecycle.waitForStatus(
        (status) =>
          status.runtimeId === nextRuntimeId &&
          (status.state === 'running' || status.state === 'error'),
        HOST_READY_TIMEOUT_MS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lifecycle.setStatus(
        EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
          state: 'error',
          active: false,
          lastError: message,
          runtimeId: nextRuntimeId,
        })
      );
      return this.getStatus();
    } finally {
      this.controlState = null;
    }
  }

  /**
   * Destroy the embedding host renderer process and restart it fresh.
   * This is the only reliable way to release WebGPU/Dawn GPU buffers,
   * which are tied to the Chromium renderer process lifetime — neither
   * tensor.dispose() nor session.release() releases them from the shared
   * GPU process. Used during large backfills to cap GPU memory growth.
   */
  async destroyAndRestart(): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('destroyAndRestart');
    this.rejectPendingQueryEmbeddingRequests(
      'Embedding host restarted while query embedding requests were in flight.'
    );
    this.controlState = 'restarting';
    this.clearPendingInactiveStatus();
    this.lifecycle.destroyHostWindow();
    this.lifecycle.clearHostWindow();
    this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
    try {
      return await this.ensureStarted({ waitForRunning: true });
    } finally {
      this.controlState = null;
    }
  }

  async queryEmbedding(payload: EmbeddingHostQueryEmbeddingPayload): Promise<number[]> {
    this.assertNotDisposed('queryEmbedding');
    const status = await this.ensureStarted({ waitForRunning: true });
    if (status.state !== 'running') {
      throw new Error(
        status.lastError ?? 'Embedding host is not running and cannot generate query embeddings.'
      );
    }
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      throw new Error('Embedding host window is unavailable.');
    }
    if (this.pendingQueryEmbeddingRequests.size >= MAX_PENDING_QUERY_EMBEDDING_REQUESTS) {
      throw new Error(
        `Embedding host has ${this.pendingQueryEmbeddingRequests.size} query embedding requests in flight; retry after one completes.`
      );
    }

    const request = createEmbeddingHostQueryEmbeddingRequest(status.runtimeId, payload);
    return await new Promise<number[]>((resolve, reject) => {
      if (this.pendingQueryEmbeddingRequests.has(request.requestId)) {
        reject(new Error(`Duplicate embedding host query requestId ${request.requestId}.`));
        return;
      }

      const timeoutId = setTimeout(() => {
        this.pendingQueryEmbeddingRequests.delete(request.requestId);
        reject(new Error(`Embedding host query request ${request.requestId} timed out.`));
      }, QUERY_EMBEDDING_TIMEOUT_MS);
      this.pendingQueryEmbeddingRequests.set(request.requestId, {
        resolve,
        reject,
        timeoutId,
      });

      try {
        window.webContents.send(EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT, request);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingQueryEmbeddingRequests.delete(request.requestId);
        const wrappedMessage = `Embedding host query request ${request.requestId} could not be sent`;
        reject(
          error instanceof Error
            ? new Error(`${wrappedMessage}: ${error.message}`, { cause: error })
            : new Error(wrappedMessage)
        );
      }
    });
  }

  async dispose(): Promise<void> {
    try {
      await this.stop();
    } finally {
      this.disposed = true;
      this.rejectPendingQueryEmbeddingRequests(
        'Embedding host disposed while query embedding requests were in flight.'
      );
      this.clearPendingInactiveStatus();
      this.lifecycle.destroyHostWindow();
      this.stopPowerSaveBlocker();
      this.lifecycle.dispose();
    }
  }

  acceptStatusReport(senderId: number, report: EmbeddingHostStatusReport): void {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.webContents.id !== senderId) {
      logger.warn('Rejected embedding host status report from unknown renderer', { senderId });
      return;
    }

    const currentStatus = this.lifecycle.getStatus();
    const nextStatus = EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
      state: report.state,
      active: report.active,
      lastError: report.lastError,
      runtimeId: report.runtimeId,
    });
    if (
      currentStatus.runtimeId !== EMBEDDING_HOST_STOPPED_RUNTIME_ID &&
      currentStatus.runtimeId !== nextStatus.runtimeId
    ) {
      logger.debug('Ignored stale embedding host status report from superseded runtime', {
        currentRuntimeId: currentStatus.runtimeId,
        reportRuntimeId: nextStatus.runtimeId,
        senderId,
        state: nextStatus.state,
      });
      return;
    }

    if (nextStatus.state !== 'running' || nextStatus.active) {
      this.clearPendingInactiveStatus();
      this.lifecycle.setStatus(nextStatus);
      return;
    }

    if (
      currentStatus.state === 'running' &&
      currentStatus.active &&
      currentStatus.runtimeId === nextStatus.runtimeId
    ) {
      this.scheduleInactiveStatus(nextStatus);
      return;
    }

    this.clearPendingInactiveStatus();
    this.lifecycle.setStatus(nextStatus);
  }

  acceptQueryEmbeddingResponseReport(
    senderId: number,
    report: EmbeddingHostQueryEmbeddingResponseReport
  ): void {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed() || window.webContents.id !== senderId) {
      return;
    }

    const pending = this.pendingQueryEmbeddingRequests.get(report.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingQueryEmbeddingRequests.delete(report.requestId);
    if (report.type === 'error') {
      pending.reject(deserializeRuntimeError(report.payload));
      return;
    }
    pending.resolve(report.payload.embedding);
  }

  private syncPowerSaveBlocker(status: EmbeddingHostStatus): void {
    const shouldBlock = status.state === 'running' && status.active;
    if (shouldBlock) {
      this.clearPendingIdleStop();
      if (this.powerSaveBlockerId === null) {
        this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        logger.info('powerSaveBlocker started for active embedding host work', {
          id: this.powerSaveBlockerId,
          runtimeId: status.runtimeId,
        });
      }
      return;
    }

    if (status.state === 'running') {
      this.scheduleIdleStop();
      return;
    }

    this.stopPowerSaveBlocker();
  }

  private scheduleIdleStop(): void {
    if (this.disposed || this.powerSaveBlockerId === null || this.pendingIdleStopTimer !== null) {
      return;
    }

    this.pendingIdleStopTimer = setTimeout(() => {
      this.pendingIdleStopTimer = null;
      // Re-check disposal here because dispose() can race after the timer is scheduled.
      if (this.disposed) {
        return;
      }
      this.stopPowerSaveBlocker();
    }, POWER_SAVE_BLOCKER_IDLE_GRACE_MS);
  }

  private clearPendingIdleStop(): void {
    if (this.pendingIdleStopTimer === null) {
      return;
    }
    clearTimeout(this.pendingIdleStopTimer);
    this.pendingIdleStopTimer = null;
  }

  private scheduleInactiveStatus(status: EmbeddingHostStatus): void {
    // This is intentionally last-write-wins on the pending status payload while the original
    // timer keeps running. Embedding micro-batch idle reports are semantically equivalent here,
    // so we preserve one grace window instead of extending it on every inactive edge.
    this.pendingInactiveStatusReport = status;
    if (this.pendingInactiveStatusTimer !== null) {
      return;
    }
    this.pendingInactiveStatusTimer = setTimeout(() => {
      this.pendingInactiveStatusTimer = null;
      const pendingStatus = this.pendingInactiveStatusReport;
      this.pendingInactiveStatusReport = null;
      if (!pendingStatus || this.disposed) {
        return;
      }
      this.lifecycle.setStatus(pendingStatus);
    }, EMBEDDING_HOST_STATUS_IDLE_GRACE_MS);
  }

  private clearPendingInactiveStatus(): void {
    if (this.pendingInactiveStatusTimer !== null) {
      clearTimeout(this.pendingInactiveStatusTimer);
      this.pendingInactiveStatusTimer = null;
    }
    this.pendingInactiveStatusReport = null;
  }

  private stopPowerSaveBlocker(): void {
    this.clearPendingIdleStop();
    if (this.powerSaveBlockerId === null) {
      return;
    }
    try {
      if (powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
        powerSaveBlocker.stop(this.powerSaveBlockerId);
        logger.info('powerSaveBlocker stopped for idle embedding host', {
          id: this.powerSaveBlockerId,
          runtimeId: this.getStatus().runtimeId,
        });
      }
    } catch (stopError) {
      // Loud-but-recoverable: surface the failure, but never leave the stale id
      // in place — that would permanently wedge syncPowerSaveBlocker so no
      // future blocker could ever start.
      logger.warn('powerSaveBlocker stop failed; clearing stale blocker id', {
        error: stopError,
        id: this.powerSaveBlockerId,
        runtimeId: this.getStatus().runtimeId,
      });
    } finally {
      this.powerSaveBlockerId = null;
    }
  }

  private assertNotDisposed(
    methodName: 'destroyAndRestart' | 'ensureStarted' | 'queryEmbedding' | 'reset' | 'stop'
  ): void {
    if (this.disposed) {
      throw new Error(`EmbeddingHostManager.${methodName} cannot be called after dispose().`);
    }
  }

  private rejectPendingQueryEmbeddingRequests(message: string): void {
    for (const [requestId, pending] of this.pendingQueryEmbeddingRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`${message} (request ${requestId})`));
      this.pendingQueryEmbeddingRequests.delete(requestId);
    }
  }
}
