import {
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingTelemetrySnapshot,
} from '@brainstrike/embedding-worker';
import { createLogger } from '@brainstrike/logging';
import { createRuntimeId, deserializeRuntimeError } from '@brainstrike/worker-runtime';
import { type BrowserWindow, powerSaveBlocker } from 'electron';
import {
  createEmbeddingHostCommand,
  createEmbeddingHostQueryEmbeddingCancel,
  createEmbeddingHostQueryEmbeddingRequest,
  createStoppedEmbeddingHostStatus,
  EMBEDDING_HOST_COMMAND_EVENT,
  EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT,
  EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
  EMBEDDING_HOST_STATUS_ADAPTER,
  EMBEDDING_HOST_STATUS_EVENT,
  EMBEDDING_HOST_STOPPED_RUNTIME_ID,
  type EmbeddingHostQueryEmbeddingPayload,
  type EmbeddingHostQueryEmbeddingRequest,
  type EmbeddingHostQueryEmbeddingResponseReport,
  type EmbeddingHostStatus,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';
import { createHostRequestChannel, type HostRequestChannel } from './platform/host-request-channel';
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

// Leave time for the remaining owners inside main's five-second shutdown budget.
const EMBEDDING_HOST_SHUTDOWN_TIMEOUT_MS = 3000;
const EMBEDDING_HOST_STOP_TIMEOUT_MS = 10_000;

function waitForHostStartup(
  startup: Promise<EmbeddingHostStatus>,
  signal?: AbortSignal
): Promise<EmbeddingHostStatus> {
  if (!signal) {
    return startup;
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    void startup.then(
      (status) => {
        signal.removeEventListener('abort', onAbort);
        resolve(status);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

export interface EmbeddingHostManagerOptions {
  readonly platform?: NodeJS.Platform;
}

export class EmbeddingHostManager {
  private disposed = false;
  private disposing = false;
  private reportedRuntimeId: string | null = null;
  private pendingReset: { requestId: string; runtimeId: string } | null = null;
  private readonly lifecycle: RendererHostLifecycle<EmbeddingHostStatus>;
  private readonly powerSaveBlockerEnabled: boolean;
  private pendingInactiveStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingInactiveStatusReport: EmbeddingHostStatusReport | null = null;
  private powerSaveBlockerId: number | null = null;
  private pendingIdleStopTimer: ReturnType<typeof setTimeout> | null = null;
  private controlState: RuntimeHostControlState | null = null;
  private readonly queryRequests: HostRequestChannel<
    EmbeddingHostQueryEmbeddingRequest,
    EmbeddingHostQueryEmbeddingResponseReport
  >;

  constructor(options: EmbeddingHostManagerOptions = {}) {
    this.powerSaveBlockerEnabled = (options.platform ?? process.platform) === 'darwin';
    this.queryRequests = createHostRequestChannel<
      EmbeddingHostQueryEmbeddingRequest,
      EmbeddingHostQueryEmbeddingResponseReport
    >({
      onAbort: (request, { reason, requestId }) => {
        this.cancelQueryEmbeddingRequest(request);
        return reason instanceof Error
          ? reason
          : new Error(`Embedding host request ${requestId} was aborted.`);
      },
      onTimeout: (request, context) => {
        logger.warn('Embedding host query timed out', {
          elapsedMs: Math.max(0, context.timedOutAt - context.startedAt),
          pendingCount: context.pendingCount,
          provider: 'local',
          stage: 'host-response',
          timeoutMs: context.timeoutMs,
        });
        this.cancelQueryEmbeddingRequest(request);
        return {
          error: new Error(
            `Embedding host request ${context.requestId} timed out after ${context.timeoutMs}ms.`
          ),
          policy: 'abandon',
        };
      },
      requestId: (request) => request.requestId,
      responseId: (report) => report.requestId,
      role: 'Embedding host',
      send: (request) => {
        this.requireHostWindow().webContents.send(
          EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
          request
        );
      },
      timeoutMs: () => QUERY_EMBEDDING_TIMEOUT_MS,
    });
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
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
            state: 'error',
          })
        );
      },
      onRenderProcessGone: ({ exitCode, message, reason }) => {
        this.clearPendingInactiveStatus();
        this.rejectPendingQueryEmbeddingRequests(message);
        logger.error(message, {
          exitCode,
          reason,
          windowRole: 'embedding-host',
        });
        this.lifecycle.setStatus(
          EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
            state: 'error',
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
      pendingRequestCount: this.queryRequests.size(),
    });
  }

  getTelemetrySnapshot(): EmbeddingTelemetrySnapshot {
    return this.getStatus().embeddingRuntime?.telemetry ?? createEmptyEmbeddingTelemetrySnapshot();
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
    return this.stopHost();
  }

  private async stopHost(timeoutMs = EMBEDDING_HOST_STOP_TIMEOUT_MS): Promise<EmbeddingHostStatus> {
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
        active: false,
        lastError: null,
        runtimeId: this.getStatus().runtimeId,
        state: 'stopping',
      })
    );
    this.clearPendingInactiveStatus();
    const { runtimeId } = this.getStatus();

    const command = createEmbeddingHostCommand('stop', runtimeId);
    window.webContents.send(EMBEDDING_HOST_COMMAND_EVENT, command);

    try {
      const status = await this.lifecycle.waitForStatus(
        (nextStatus) =>
          nextStatus.commandId === command.requestId &&
          (nextStatus.state === 'stopped' || nextStatus.state === 'error'),
        timeoutMs
      );
      if (status.state === 'error') {
        throw new Error(status.lastError ?? 'Embedding renderer reported a failed stop.');
      }
      return status;
    } catch (error) {
      this.lifecycle.destroyHostWindow();
      this.lifecycle.clearHostWindow();
      this.lifecycle.setStatus(createStoppedEmbeddingHostStatus(runtimeId));
      throw error;
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
    const command = createEmbeddingHostCommand('reset', currentRuntimeId, nextRuntimeId);
    this.pendingReset = command;

    this.lifecycle.setStatus(
      EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
        active: false,
        lastError: null,
        runtimeId: nextRuntimeId,
        state: 'starting',
      })
    );
    this.clearPendingInactiveStatus();

    window.webContents.send(EMBEDDING_HOST_COMMAND_EVENT, command);
    try {
      const status = await this.lifecycle.waitForStatus(
        (nextStatus) =>
          (nextStatus.runtimeId === nextRuntimeId &&
            (nextStatus.state === 'running' || nextStatus.state === 'error')) ||
          (nextStatus.runtimeId === currentRuntimeId &&
            nextStatus.commandId === command.requestId &&
            nextStatus.state === 'error'),
        HOST_READY_TIMEOUT_MS
      );
      if (status.state === 'error') {
        // A failed drain or replacement startup retires this renderer before any new start.
        this.lifecycle.destroyHostWindow();
        this.lifecycle.setStatus(status);
      }
      return status;
    } catch (error) {
      this.lifecycle.destroyHostWindow();
      const message = error instanceof Error ? error.message : String(error);
      this.lifecycle.setStatus(
        EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
          active: false,
          lastError: message,
          runtimeId: nextRuntimeId,
          state: 'error',
        })
      );
      return this.getStatus();
    } finally {
      if (this.pendingReset === command) {
        this.pendingReset = null;
      }
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
    try {
      return await this.ensureStarted({ waitForRunning: true });
    } finally {
      this.controlState = null;
    }
  }

  async queryEmbedding(
    payload: EmbeddingHostQueryEmbeddingPayload,
    options?: { signal?: AbortSignal }
  ): Promise<number[]> {
    options?.signal?.throwIfAborted();
    this.assertNotDisposed('queryEmbedding');
    const status = await waitForHostStartup(
      this.ensureStarted({ waitForRunning: true }),
      options?.signal
    );
    options?.signal?.throwIfAborted();
    if (status.state !== 'running') {
      throw new Error(
        status.lastError ?? 'Embedding host is not running and cannot generate query embeddings.'
      );
    }
    this.requireHostWindow();
    const pendingCount = this.queryRequests.size();
    if (pendingCount >= MAX_PENDING_QUERY_EMBEDDING_REQUESTS) {
      throw new Error(
        `Embedding host has ${pendingCount} query embedding requests in flight; retry after one completes.`
      );
    }

    const request = createEmbeddingHostQueryEmbeddingRequest(status.runtimeId, payload);
    const report = await this.queryRequests.request(request, options);
    if (report.type === 'error') {
      throw deserializeRuntimeError(report.payload);
    }
    return report.payload.embedding;
  }

  private cancelQueryEmbeddingRequest(request: EmbeddingHostQueryEmbeddingRequest): void {
    try {
      this.requireHostWindow().webContents.send(
        EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT,
        createEmbeddingHostQueryEmbeddingCancel(request)
      );
    } catch (error) {
      throw new Error('Embedding host query cancellation could not be sent.', { cause: error });
    }
  }

  private requireHostWindow(): BrowserWindow {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      throw new Error('Embedding host window is unavailable.');
    }
    return window;
  }

  async dispose(): Promise<void> {
    // Refuse new starts BEFORE the cooperative stop below awaits the renderer:
    // a backfill arriving mid-teardown would otherwise replace the very window
    // stop() is waiting on, orphaning that wait for its whole timeout.
    this.disposing = true;
    try {
      // A trusted renderer status is emitted only after its control listener is
      // registered; a still-loading page cannot acknowledge Stop yet.
      const status = this.lifecycle.getStatus();
      if (status.state !== 'starting' || this.reportedRuntimeId === status.runtimeId) {
        await this.stopHost(EMBEDDING_HOST_SHUTDOWN_TIMEOUT_MS);
      }
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
    const baseStatus = EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
      active: report.active,
      lastError: report.lastError,
      runtimeId: report.runtimeId,
      state: report.state,
    });
    const nextStatus: EmbeddingHostStatus = {
      ...baseStatus,
      ...(report.commandId ? { commandId: report.commandId } : {}),
      ...(report.embeddingRuntime ? { embeddingRuntime: report.embeddingRuntime } : {}),
    };
    // Keep this exact identity test aligned with reset()'s old-runtime waiter clause.
    const isPendingResetFailure =
      nextStatus.state === 'error' &&
      this.pendingReset?.requestId === nextStatus.commandId &&
      this.pendingReset?.runtimeId === nextStatus.runtimeId;
    if (
      currentStatus.runtimeId !== EMBEDDING_HOST_STOPPED_RUNTIME_ID &&
      currentStatus.runtimeId !== nextStatus.runtimeId &&
      !isPendingResetFailure
    ) {
      logger.debug('Ignored stale embedding host status report from superseded runtime', {
        currentRuntimeId: currentStatus.runtimeId,
        reportRuntimeId: nextStatus.runtimeId,
        senderId,
        state: nextStatus.state,
      });
      return;
    }

    this.reportedRuntimeId = report.runtimeId;

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
    this.queryRequests.accept(report);
  }

  private syncPowerSaveBlocker(status: EmbeddingHostStatus): void {
    if (!this.powerSaveBlockerEnabled) {
      return;
    }

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
    const blockerId = this.powerSaveBlockerId;
    if (blockerId === null) {
      return;
    }
    try {
      if (powerSaveBlocker.isStarted(blockerId)) {
        powerSaveBlocker.stop(blockerId);
        logger.info('powerSaveBlocker stopped for idle embedding host', {
          id: blockerId,
          runtimeId: this.getStatus().runtimeId,
        });
      }
      this.powerSaveBlockerId = null;
    } catch (stopError) {
      // stop() throwing has two distinct failure directions:
      // - The id is stale (already stopped/invalid — the common case): keeping
      //   it would permanently wedge syncPowerSaveBlocker, so clear it.
      // - The OS block is verifiably STILL ACTIVE: clearing would discard the
      //   only handle to an unstoppable blocker (machine never sleeps). Keep
      //   the id so the next stop cycle retries; the start path guards on a
      //   non-null id, so no duplicate blocker can start meanwhile.
      if (this.isPowerSaveBlockerStillActive(blockerId)) {
        logger.warn('powerSaveBlocker stop failed; blocker still active, keeping id to retry', {
          error: stopError,
          id: blockerId,
          runtimeId: this.getStatus().runtimeId,
        });
        return;
      }
      logger.warn('powerSaveBlocker stop failed; clearing stale blocker id', {
        error: stopError,
        id: blockerId,
        runtimeId: this.getStatus().runtimeId,
      });
      this.powerSaveBlockerId = null;
    }
  }

  private isPowerSaveBlockerStillActive(blockerId: number): boolean {
    try {
      return powerSaveBlocker.isStarted(blockerId);
    } catch {
      // The recheck itself failing means the id is unusable either way;
      // treat it as stale so the manager cannot wedge.
      return false;
    }
  }

  private assertNotDisposed(
    methodName: 'destroyAndRestart' | 'ensureStarted' | 'queryEmbedding' | 'reset' | 'stop'
  ): void {
    if (this.disposed || this.disposing) {
      throw new Error(`EmbeddingHostManager.${methodName} cannot be called after dispose().`);
    }
  }

  private rejectPendingQueryEmbeddingRequests(message: string): void {
    this.queryRequests.rejectAll((requestId) => new Error(`${message} (request ${requestId})`));
  }
}
