import {
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingTelemetrySnapshot,
} from '@brainstrike/embedding-worker';
import type { EmbeddingRequestProgress } from '@brainstrike/embeddings';
import { isHostedProvider, parseProviderModelKey } from '@brainstrike/embeddings/provider-core';
import { createLogger } from '@brainstrike/logging';
import { type BrowserWindow, powerSaveBlocker } from 'electron';
import { EmbeddingHostStartup } from './embedding-host-background-startup';
import { awaitHostDevice, requestHostDeviceResolution } from './embedding-host-device';
import { documentBatchTimeout, queryEmbeddingTimeout } from './embedding-host-document-timeout';
import {
  documentResponseFailure,
  joinDocumentEmbeddingInterruption,
  joinQueryEmbeddingInterruption,
  queryResponseFailure,
} from './embedding-host-inference-settlement';
import { stopEmbeddingHostPowerSaveBlocker } from './embedding-host-power-save-blocker';
import { EmbeddingHostSettingsReads } from './embedding-host-settings-reads';
import {
  createEmbeddingHostDocumentEmbeddingsCancel,
  createEmbeddingHostDocumentEmbeddingsRequest,
  createEmbeddingHostQueryEmbeddingCancel,
  createEmbeddingHostQueryEmbeddingRequest,
  createStoppedEmbeddingHostStatus,
  EMBEDDING_HOST_COMMAND_EVENT,
  EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_CANCEL_EVENT,
  EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_REQUEST_EVENT,
  EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT,
  EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
  EMBEDDING_HOST_STATUS_ADAPTER,
  EMBEDDING_HOST_STATUS_EVENT,
  EMBEDDING_HOST_STOPPED_RUNTIME_ID,
  type EmbeddingHostDocumentEmbeddingsPayload,
  type EmbeddingHostDocumentEmbeddingsRequest,
  type EmbeddingHostDocumentEmbeddingsResponseReport,
  type EmbeddingHostQueryEmbeddingPayload,
  type EmbeddingHostQueryEmbeddingRequest,
  type EmbeddingHostQueryEmbeddingResponseReport,
  type EmbeddingHostStatus,
  type EmbeddingHostStatusReport,
  reportedHostFields,
} from './embedding-host-shared';
import { createEmbeddingHostStallSeam } from './embedding-host-stall-seam';
import { waitForHostStartup } from './embedding-host-startup';
import { HostedEmbeddingRequests } from './hosted-embedding-requests';
import { createHostRequestChannel, type HostRequestChannel } from './platform/host-request-channel';
import {
  createRuntimeHostPlatformStatus,
  type RuntimeHostControlState,
  type RuntimeHostPlatformStatus,
} from './platform/runtime-host-state';
import { RendererHostLifecycle } from './renderer-host-lifecycle';

const logger = createLogger('EmbeddingHostManager');

/** R5(a): one inference request's bound, refused alone and typed with its cancel sent; never a host stop. */
const QUERY_EMBEDDING_TIMEOUT_MS = 60_000;
const MAX_PENDING_QUERY_EMBEDDING_REQUESTS = 8;
/** Not a lifecycle timeout: how long an idle host keeps the power-save blocker, a UI grace. */
const POWER_SAVE_BLOCKER_IDLE_GRACE_MS = 5000;
/** Not a lifecycle timeout: how long an inactive report waits before it is shown, a UI grace. */
const EMBEDDING_HOST_STATUS_IDLE_GRACE_MS = 5000;
const STOPPED_WITH_INFERENCE = 'Embedding host stopped while inference requests were in flight.';

export interface EmbeddingHostManagerOptions {
  readonly platform?: NodeJS.Platform;
  readonly storage?:
    | import('@brainstrike/storage/electron').ElectronStorageAdapter
    | Pick<import('@brainstrike/storage/electron').ElectronStorageAdapter, 'getItem'>;
}

export class EmbeddingHostManager {
  private readonly hostedRequests: HostedEmbeddingRequests;
  private readonly startup = new EmbeddingHostStartup();
  /** Settings' reads of the running host: WebGPU detection and its model cache. */
  readonly settingsReads = new EmbeddingHostSettingsReads({
    ensureRunning: async () => {
      const status = await this.ensureHostStarted({ waitForRunning: true }, false);
      if (status.state !== 'running') {
        throw new Error(status.lastError ?? 'The embedding host is not running.');
      }
      return status.runtimeId;
    },
    hostSenderId: () => {
      const window = this.lifecycle.getHostWindow();
      return window && !window.isDestroyed() ? window.webContents.id : undefined;
    },
    send: (event, request) => this.requireHostWindow().webContents.send(event, request),
    timeoutMs: QUERY_EMBEDDING_TIMEOUT_MS,
  });
  private disposed = false;
  private disposing = false;
  /** A Stop retiring hosted queries before it destroys the host window; every caller joins it. */
  private stopping: Promise<EmbeddingHostStatus> | null = null;
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
  private readonly documentRequests: HostRequestChannel<
    EmbeddingHostDocumentEmbeddingsRequest,
    EmbeddingHostDocumentEmbeddingsResponseReport
  >;
  /** The progress that last re-armed each document batch's window: its stage when it went silent. */
  private readonly documentProgress = new WeakMap<
    EmbeddingHostDocumentEmbeddingsRequest,
    EmbeddingRequestProgress
  >();
  private readonly stallDocumentBatch = createEmbeddingHostStallSeam();

  constructor(options: EmbeddingHostManagerOptions = {}) {
    this.hostedRequests = new HostedEmbeddingRequests(options.storage);
    this.powerSaveBlockerEnabled = (options.platform ?? process.platform) === 'darwin';
    this.queryRequests = createHostRequestChannel<
      EmbeddingHostQueryEmbeddingRequest,
      EmbeddingHostQueryEmbeddingResponseReport
    >({
      // A query past its bound is refused alone (R5(a)): its cancel is sent, the host keeps running.
      joinOnInterrupt: (request, context) =>
        context.source === 'timeout'
          ? Promise.resolve(context.error)
          : joinQueryEmbeddingInterruption(request, context, () => this.stopHost()),
      onAbort: (request, { reason }) => {
        try {
          this.cancelQueryEmbeddingRequest(request);
          return reason;
        } catch (error) {
          return new AggregateError(
            [reason, error],
            'Query embedding cancellation delivery failed.'
          );
        }
      },
      onTimeout: (request, context) =>
        queryEmbeddingTimeout(context, () => this.cancelQueryEmbeddingRequest(request)),
      requestId: (request) => `${request.runtimeId}:${request.requestId}`,
      responseId: (report) => `${report.runtimeId}:${report.requestId}`,
      role: 'Embedding host',
      send: (request) => {
        this.requireHostWindow().webContents.send(
          EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT,
          request
        );
      },
      timeoutMs: () => QUERY_EMBEDDING_TIMEOUT_MS,
    });
    this.documentRequests = createHostRequestChannel<
      EmbeddingHostDocumentEmbeddingsRequest,
      EmbeddingHostDocumentEmbeddingsResponseReport
    >({
      // Each completed slice re-arms the window: a long batch on slow hardware is alive.
      isProgress: (report) => report.type === 'progress',
      // A silent batch is refused alone (R5(a), BST-2104): its cancel is sent and indexing waits
      // for Retry, which restarts the host. The window itself never stops the host.
      joinOnInterrupt: (request, context) =>
        context.source === 'timeout'
          ? Promise.resolve(context.error)
          : joinDocumentEmbeddingInterruption(request, context, () => this.stopHost()),
      onAbort: (request, { reason }) => {
        try {
          this.cancelDocumentEmbeddingsRequest(request);
          return reason;
        } catch (error) {
          return new AggregateError(
            [reason, error],
            'Document embedding cancellation delivery failed.'
          );
        }
      },
      onTimeout: (request, context) =>
        documentBatchTimeout(request, context, this.documentProgress.get(request), () =>
          this.cancelDocumentEmbeddingsRequest(request)
        ),
      requestId: (request) => `${request.runtimeId}:${request.requestId}`,
      responseId: (report) => `${report.runtimeId}:${report.requestId}`,
      role: 'Embedding host',
      send: (request) => {
        const window = this.requireHostWindow();
        if (!this.stallDocumentBatch(request.requestId)) {
          window.webContents.send(EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_REQUEST_EVENT, request);
        }
      },
      timeoutMs: () => QUERY_EMBEDDING_TIMEOUT_MS,
    });
    this.lifecycle = new RendererHostLifecycle<EmbeddingHostStatus>({
      createStatus: EMBEDDING_HOST_STATUS_ADAPTER.createStatus,
      createStoppedStatus: createStoppedEmbeddingHostStatus,
      mode: 'embedding-host',
      onDidFailLoad: ({ errorCode, errorDescription, message, url }) => {
        this.clearPendingInactiveStatus();
        logger.error(message, { errorCode, errorDescription, url, windowRole: 'embedding-host' });
        this.lifecycle.setStatus(
          EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
            state: 'error',
          })
        );
        if (this.documentRequests.size() + this.queryRequests.size() > 0) {
          try {
            this.retireInferenceHost(message);
          } catch (error) {
            logger.error('Embedding host load failure retirement failed', { error });
          }
        }
      },
      onRenderProcessGone: ({ exitCode, message, reason }) => {
        this.clearPendingInactiveStatus();
        this.rejectSettledInferenceRequests(message, true);
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
        this.rejectSettledInferenceRequests(
          'Embedding host window closed while inference requests were in flight.',
          true
        );
        this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      },
      role: 'embedding-host',
      startupQuery: () => this.startup.query(),
      statusEventName: EMBEDDING_HOST_STATUS_EVENT,
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
      pendingRequestCount: this.queryRequests.size() + this.documentRequests.size(),
    });
  }

  getTelemetrySnapshot(): EmbeddingTelemetrySnapshot {
    return this.getStatus().embeddingRuntime?.telemetry ?? createEmptyEmbeddingTelemetrySnapshot();
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.lifecycle.isHostWindow(window);
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<EmbeddingHostStatus> {
    return this.ensureHostStarted(options, true);
  }

  /** Settings' WebGPU detection: an on-demand start, like a native request, loads no model. */
  private async ensureHostStarted(
    options: { waitForRunning?: boolean } | undefined,
    backgroundWorker: boolean
  ): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('ensureStarted');
    if (this.stopping !== null) {
      await this.stopping;
    }
    this.assertNotDisposed('ensureStarted');
    const status = this.lifecycle.getStatus();
    if (status.state === 'error' && this.queryRequests.size() + this.documentRequests.size() > 0) {
      this.retireInferenceHost(
        status.lastError ?? 'Embedding host failed with inference in flight.'
      );
    }
    return this.startup.ensure({
      assertCurrent: () => this.assertNotDisposed('ensureStarted'),
      backgroundWorker,
      lifecycle: this.lifecycle,
      options,
      send: (command) =>
        this.requireHostWindow().webContents.send(EMBEDDING_HOST_COMMAND_EVENT, command),
    });
  }

  async stop(): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('stop');
    return this.stopHost();
  }

  /** The running host's status carrying memory recall's device (BST-2193). */
  async ensureDeviceResolved(): Promise<EmbeddingHostStatus> {
    const started = await this.ensureStarted({ waitForRunning: true });
    return await awaitHostDevice(started, this.lifecycle, () => this.resolveDevice());
  }

  /** A preference change re-resolves a running host's unpinned device (`requestHostDeviceResolution`). */
  resolveDevice(): void {
    requestHostDeviceResolution(this.lifecycle, !(this.disposed || this.disposing));
  }

  /**
   * ADR-0031: stopping the hidden host is destroying its window. Its in-flight inference is
   * rejected then; no Stop is asked of the renderer and nothing joins the window's `closed`.
   * Pending hosted queries are retired first; a Stop already underway is the one every caller joins.
   */
  private async stopHost(): Promise<EmbeddingHostStatus> {
    if (this.stopping !== null) {
      return this.stopping;
    }
    const stop = (
      this.hostedRequests.hasPending ? this.hostedRequests.retire() : Promise.resolve()
    ).then(() => this.destroyHost(STOPPED_WITH_INFERENCE));
    this.stopping = stop;
    try {
      return await stop;
    } finally {
      if (this.stopping === stop) {
        this.stopping = null;
      }
    }
  }

  /**
   * Destroys the host window and rejects its in-flight inference with `reason`, or with
   * `failures` and a failed `destroy()` (thrown) as the host's own retirement failure. A
   * `replacing` caller starts the next host at once, so no `stopped` is reported between them.
   */
  private destroyHost(
    reason: string,
    failures: readonly unknown[] = [],
    replacing = false
  ): EmbeddingHostStatus {
    this.clearPendingInactiveStatus();
    const { runtimeId } = this.getStatus();
    const errors = [...failures];
    try {
      this.lifecycle.destroyHostWindow();
    } catch (error) {
      // The lifecycle keeps owning a window that survived destroy(): the next stop retries it.
      errors.push(error);
    }
    if (errors.length === 0) {
      if (!replacing) {
        this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      }
      this.rejectSettledInferenceRequests(reason);
      return this.getStatus();
    }
    const failure =
      errors.length === 1
        ? errors[0]
        : new AggregateError(errors, 'Embedding host retirement failed.');
    const error = failure instanceof Error ? failure : new Error(String(failure));
    this.lifecycle.setStatus(
      EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
        active: false,
        lastError: error.message,
        runtimeId,
        state: this.lifecycle.getHostWindow() ? 'error' : 'stopped',
      })
    );
    this.rejectSettledInferenceRequests(error, true);
    throw failure;
  }

  /**
   * A fresh host runtime: the window is destroyed and a new one started, answering with the new
   * host's own readiness report. In-flight inference is rejected as the old window is destroyed.
   */
  async reset(): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('reset');
    if (this.stopping !== null) {
      await this.stopping;
    }
    if (this.hostedRequests.hasPending) {
      await this.hostedRequests.retire();
    }
    this.assertNotDisposed('reset');
    this.controlState = 'resetting';
    try {
      this.destroyHost('Embedding host reset while inference requests were in flight.', [], true);
      return await this.ensureStarted({ waitForRunning: true });
    } finally {
      this.controlState = null;
    }
  }

  /** Restart to release process-owned WebGPU/Dawn memory that tensor/session disposal cannot free. */
  async destroyAndRestart(): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('destroyAndRestart');
    this.controlState = 'restarting';
    try {
      this.destroyHost(
        'Embedding host restarted while inference requests were in flight.',
        [],
        true
      );
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
    const selected = parseProviderModelKey(payload.modelKey);
    if (selected && isHostedProvider(selected.provider)) {
      if (selected.modelId !== payload.modelId || payload.inferencePlan) {
        throw new Error('Hosted query identity conflicts with the selected provider/model.');
      }
      if (this.stopping !== null) {
        await this.stopping;
      }
      if (this.hostedRequests.retirement !== null) {
        await this.hostedRequests.retirement;
      }
      this.assertNotDisposed('queryEmbedding');
      options?.signal?.throwIfAborted();
      return this.hostedRequests.query(selected.provider, payload, options?.signal);
    }

    const status = await waitForHostStartup(
      this.ensureHostStarted({ waitForRunning: true }, !payload.inferencePlan),
      options?.signal
    );
    options?.signal?.throwIfAborted();
    if (status.state !== 'running') {
      throw new Error(
        status.lastError ?? 'Embedding host is not running and cannot generate query embeddings.'
      );
    }
    this.requireHostWindow();
    const pendingCount = this.queryRequests.size() + this.documentRequests.size();
    if (pendingCount >= MAX_PENDING_QUERY_EMBEDDING_REQUESTS) {
      throw new Error(
        `Embedding host has ${pendingCount} query embedding requests in flight; retry after one completes.`
      );
    }

    const request = createEmbeddingHostQueryEmbeddingRequest(status.runtimeId, payload);
    const report = await this.queryRequests.request(request, options);
    const failure = queryResponseFailure(request, report);
    if (failure) {
      throw failure;
    }
    if (report.type !== 'result') {
      throw new Error('Query embedding response is not a result.');
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

  async documentEmbeddings(
    payload: EmbeddingHostDocumentEmbeddingsPayload,
    options?: { signal?: AbortSignal }
  ): Promise<number[][]> {
    options?.signal?.throwIfAborted();
    this.assertNotDisposed('documentEmbeddings');
    const status = await waitForHostStartup(
      this.ensureHostStarted({ waitForRunning: true }, false),
      options?.signal
    );
    options?.signal?.throwIfAborted();
    if (status.state !== 'running') {
      throw new Error(
        status.lastError ?? 'Embedding host is not running and cannot generate document embeddings.'
      );
    }
    this.requireHostWindow();
    const pendingCount = this.documentRequests.size() + this.queryRequests.size();
    if (pendingCount >= MAX_PENDING_QUERY_EMBEDDING_REQUESTS) {
      throw new Error(
        `Embedding host has ${pendingCount} inference requests in flight; retry after one completes.`
      );
    }

    const request = createEmbeddingHostDocumentEmbeddingsRequest(status.runtimeId, payload);
    const report = await this.documentRequests.request(request, {
      onProgress: (progress) => {
        if (progress.type === 'progress') {
          this.documentProgress.set(request, progress.payload);
        }
      },
      signal: options?.signal,
    });
    const failure = documentResponseFailure(payload, report);
    if (failure) {
      throw failure;
    }
    if (report.type !== 'result') {
      throw new Error('Document embedding response is not a result.');
    }
    return report.payload.embeddings;
  }

  private cancelDocumentEmbeddingsRequest(request: EmbeddingHostDocumentEmbeddingsRequest): void {
    try {
      this.requireHostWindow().webContents.send(
        EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_CANCEL_EVENT,
        createEmbeddingHostDocumentEmbeddingsCancel(request)
      );
    } catch (error) {
      throw new Error('Embedding host document cancellation could not be sent.', { cause: error });
    }
  }

  /** A host that failed with inference in flight: destroyed, its inference rejected with `message`. */
  private retireInferenceHost(message: string): void {
    this.destroyHost(message, [new Error(message)]);
  }

  private requireHostWindow(): BrowserWindow {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      throw new Error('Embedding host window is unavailable.');
    }
    return window;
  }

  async dispose(): Promise<void> {
    // Refuse new starts before hosted queries retire: a backfill arriving mid-teardown would
    // otherwise start a host this teardown then has to destroy.
    this.disposing = true;
    try {
      if (this.stopping !== null) {
        await this.stopping.catch(() => undefined);
      }
      if (this.hostedRequests.hasPending) {
        await this.hostedRequests.retire();
      }
    } finally {
      this.disposed = true;
      try {
        this.destroyHost('Embedding host disposed while inference requests were in flight.');
      } finally {
        this.stopPowerSaveBlocker();
        this.lifecycle.dispose();
      }
    }
  }

  acceptStatusReport(senderId: number, report: EmbeddingHostStatusReport): void {
    this.applyStatusReport(senderId, report);
  }

  private applyStatusReport(senderId: number, report: EmbeddingHostStatusReport): void {
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
    const nextStatus: EmbeddingHostStatus = { ...baseStatus, ...reportedHostFields(report) };
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
    this.queryRequests.accept(report);
  }

  acceptDocumentEmbeddingsResponseReport(
    senderId: number,
    report: EmbeddingHostDocumentEmbeddingsResponseReport
  ): void {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed() || window.webContents.id !== senderId) {
      return;
    }
    this.documentRequests.accept(report);
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
    if (this.powerSaveBlockerId !== null) {
      this.powerSaveBlockerId = stopEmbeddingHostPowerSaveBlocker(
        this.powerSaveBlockerId,
        this.getStatus().runtimeId
      );
    }
  }

  private assertNotDisposed(
    methodName:
      | 'destroyAndRestart'
      | 'ensureStarted'
      | 'queryEmbedding'
      | 'documentEmbeddings'
      | 'reset'
      | 'stop'
  ): void {
    if (this.disposed || this.disposing) {
      throw new Error(`EmbeddingHostManager.${methodName} cannot be called after dispose().`);
    }
  }

  private rejectSettledInferenceRequests(
    reason: string | Error,
    interruptionFailure = false
  ): void {
    const failure = (requestId: string): Error =>
      typeof reason === 'string' ? new Error(`${reason} (request ${requestId})`) : reason;
    this.queryRequests.rejectAll(failure, { interruptionFailure });
    this.documentRequests.rejectAll(failure, { interruptionFailure });
    this.settingsReads.rejectAll(failure);
  }
}
