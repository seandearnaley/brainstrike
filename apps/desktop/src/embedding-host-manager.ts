import {
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingTelemetrySnapshot,
} from '@brainstrike/embedding-worker';
import { isHostedProvider, parseProviderModelKey } from '@brainstrike/embeddings/provider-core';
import type { WebGpuAdapterAvailability } from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { createRuntimeId } from '@brainstrike/worker-runtime';
import { type BrowserWindow, powerSaveBlocker } from 'electron';
import { EmbeddingHostStartup } from './embedding-host-background-startup';
import {
  documentResponseFailure,
  joinDocumentEmbeddingInterruption,
  joinQueryEmbeddingInterruption,
  queryResponseFailure,
} from './embedding-host-inference-settlement';
import { stopEmbeddingHostPowerSaveBlocker } from './embedding-host-power-save-blocker';
import {
  createEmbeddingHostCommand,
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
  EMBEDDING_HOST_WEBGPU_ADAPTER_REQUEST_EVENT,
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
import { waitForHostStartup } from './embedding-host-startup';
import {
  EmbeddingHostWebGpuAdapterRequests,
  type EmbeddingHostWebGpuAdapterResponseReport,
} from './embedding-host-webgpu-adapter';
import { HostedEmbeddingRequests } from './hosted-embedding-requests';
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

export interface EmbeddingHostManagerOptions {
  readonly platform?: NodeJS.Platform;
  readonly storage?:
    | import('@brainstrike/storage/electron').ElectronStorageAdapter
    | Pick<import('@brainstrike/storage/electron').ElectronStorageAdapter, 'getItem'>;
}

export class EmbeddingHostManager {
  private readonly hostedRequests: HostedEmbeddingRequests;
  private readonly startup = new EmbeddingHostStartup();
  private readonly webgpuAdapterRequests = new EmbeddingHostWebGpuAdapterRequests();
  private disposed = false;
  private disposing = false;
  private reportedRuntimeId: string | null = null;
  private pendingReset: { requestId: string; runtimeId: string } | null = null;
  private stopping: Promise<EmbeddingHostStatus> | null = null;
  private retirement: { readonly failures: unknown[]; readonly promise: Promise<void> } | null =
    null;
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

  constructor(options: EmbeddingHostManagerOptions = {}) {
    this.hostedRequests = new HostedEmbeddingRequests(options.storage);
    this.powerSaveBlockerEnabled = (options.platform ?? process.platform) === 'darwin';
    this.queryRequests = createHostRequestChannel<
      EmbeddingHostQueryEmbeddingRequest,
      EmbeddingHostQueryEmbeddingResponseReport
    >({
      joinOnInterrupt: (request, context) =>
        joinQueryEmbeddingInterruption(
          request,
          context,
          () => this.stopHost(),
          EMBEDDING_HOST_STOP_TIMEOUT_MS
        ),
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
      onTimeout: (request, context) => {
        logger.warn('Embedding host query timed out', {
          elapsedMs: Math.max(0, context.timedOutAt - context.startedAt),
          pendingCount: context.pendingCount,
          provider: 'local',
          stage: 'host-response',
          timeoutMs: context.timeoutMs,
        });
        let error: Error = new Error(
          `Embedding host request ${context.requestId} timed out after ${context.timeoutMs}ms.`
        );
        try {
          this.cancelQueryEmbeddingRequest(request);
        } catch (deliveryError) {
          error = new AggregateError(
            [error, deliveryError],
            'Query embedding timeout cancellation failed.'
          );
        }
        return { error, policy: 'abandon' };
      },
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
      joinOnInterrupt: (request, context) =>
        joinDocumentEmbeddingInterruption(
          request,
          context,
          () => this.stopHost(),
          EMBEDDING_HOST_STOP_TIMEOUT_MS
        ),
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
      onTimeout: (request, context) => {
        logger.warn('Embedding host document batch timed out', {
          elapsedMs: Math.max(0, context.timedOutAt - context.startedAt),
          pendingCount: context.pendingCount,
          provider: 'local',
          stage: 'host-response',
          timeoutMs: context.timeoutMs,
        });
        let error: Error = new Error(
          `Embedding host request ${context.requestId} timed out after ${context.timeoutMs}ms.`
        );
        try {
          this.cancelDocumentEmbeddingsRequest(request);
        } catch (deliveryError) {
          error = new AggregateError(
            [error, deliveryError],
            'Document embedding timeout cancellation failed.'
          );
        }
        return {
          error,
          policy: 'abandon',
        };
      },
      requestId: (request) => `${request.runtimeId}:${request.requestId}`,
      responseId: (report) => `${report.runtimeId}:${report.requestId}`,
      role: 'Embedding host',
      send: (request) => {
        this.requireHostWindow().webContents.send(
          EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_REQUEST_EVENT,
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
          void this.retireInferenceHost(message).catch((error: unknown) => {
            logger.error('Embedding host load failure retirement failed', { error });
          });
        }
      },
      onRenderProcessGone: ({ exitCode, message, reason }) => {
        this.clearPendingInactiveStatus();
        if (this.retirement) {
          this.retirement.failures.push(new Error(message));
        } else {
          this.rejectSettledInferenceRequests(message, true);
        }
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
        if (!this.retirement) {
          this.rejectSettledInferenceRequests(
            'Embedding host window closed while inference requests were in flight.',
            true
          );
        }
        this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      },
      role: 'embedding-host',
      startupQuery: () => this.startup.query(),
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
  async webgpuAdapter(): Promise<WebGpuAdapterAvailability> {
    return await this.webgpuAdapterRequests.detect(
      () => this.ensureHostStarted({ waitForRunning: true }, false),
      (request) =>
        this.requireHostWindow().webContents.send(
          EMBEDDING_HOST_WEBGPU_ADAPTER_REQUEST_EVENT,
          request
        ),
      HOST_READY_TIMEOUT_MS
    );
  }

  acceptWebGpuAdapterResponseReport(
    senderId: number,
    report: EmbeddingHostWebGpuAdapterResponseReport
  ): void {
    if (this.lifecycle.getHostWindow()?.webContents.id === senderId) {
      this.webgpuAdapterRequests.accept(report);
    }
  }

  private async ensureHostStarted(
    options: { waitForRunning?: boolean } | undefined,
    backgroundWorker: boolean
  ): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('ensureStarted');
    if (this.stopping) {
      await this.stopping;
    }
    if (this.retirement) {
      await this.retirement.promise;
    }
    this.assertNotDisposed('ensureStarted');
    const status = this.lifecycle.getStatus();
    if (status.state === 'error' && this.queryRequests.size() + this.documentRequests.size() > 0) {
      await this.retireInferenceHost(
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
      stopping: () => this.stopping,
      timeoutMs: HOST_READY_TIMEOUT_MS,
    });
  }

  async stop(): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('stop');
    return this.stopHost();
  }

  /** Re-resolve a running host's unpinned device; its background worker keeps its device until restart. */
  resolveDevice(): void {
    const window = this.lifecycle.getHostWindow();
    const status = this.getStatus();
    if (this.disposed || this.disposing || !window || window.isDestroyed()) {
      return;
    }
    if (status.state !== 'running') {
      return;
    }
    window.webContents.send(
      EMBEDDING_HOST_COMMAND_EVENT,
      createEmbeddingHostCommand('resolve-device', status.runtimeId)
    );
  }

  private async stopHost(timeoutMs = EMBEDDING_HOST_STOP_TIMEOUT_MS): Promise<EmbeddingHostStatus> {
    if (this.stopping) {
      if (timeoutMs === EMBEDDING_HOST_STOP_TIMEOUT_MS) {
        return this.stopping;
      }
      // Shutdown's shorter budget still owns the deadline when an ordinary Stop is underway.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.stopping,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Timed out waiting for embedding host state transition.')),
              timeoutMs
            );
          }),
        ]);
      } catch (error) {
        await this.destroyInferenceHostWindow([error]);
        this.rejectSettledInferenceRequests(
          error instanceof Error ? error : new Error(String(error)),
          true
        );
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    const stop = this.hostedRequests.hasPending
      ? this.hostedRequests.retire().then(() => this.stopHostOnce(timeoutMs))
      : this.stopHostOnce(timeoutMs);
    this.stopping = stop;
    try {
      return await stop;
    } finally {
      if (this.stopping === stop) {
        this.stopping = null;
      }
    }
  }

  private async stopHostOnce(timeoutMs: number): Promise<EmbeddingHostStatus> {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      if (window) {
        await this.destroyInferenceHostWindow();
      }
      this.lifecycle.clearHostWindow();
      this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      this.rejectSettledInferenceRequests(
        'Embedding host stopped while inference requests were in flight.'
      );
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
    try {
      window.webContents.send(EMBEDDING_HOST_COMMAND_EVENT, command);
      const status = await this.lifecycle.waitForStatus(
        (nextStatus) =>
          nextStatus.commandId === command.requestId &&
          (nextStatus.state === 'stopped' || nextStatus.state === 'error'),
        timeoutMs
      );
      if (status.state === 'error') {
        throw new Error(status.lastError ?? 'Embedding renderer reported a failed stop.');
      }
      this.rejectSettledInferenceRequests(
        'Embedding host stopped while inference requests were in flight.'
      );
      return status;
    } catch (error) {
      let failure = error;
      try {
        await this.destroyInferenceHostWindow([error]);
      } catch (retirementError) {
        failure = retirementError;
      }
      this.lifecycle.clearHostWindow();
      this.lifecycle.setStatus(createStoppedEmbeddingHostStatus(runtimeId));
      this.rejectSettledInferenceRequests(
        failure instanceof Error ? failure : new Error(String(failure)),
        true
      );
      throw failure;
    }
  }

  async reset(): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('reset');
    if (this.hostedRequests.hasPending) {
      await this.hostedRequests.retire();
    }
    if (this.stopping) {
      await this.stopping;
    }
    if (this.retirement) {
      await this.retirement.promise;
    }
    this.assertNotDisposed('reset');
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

    try {
      window.webContents.send(EMBEDDING_HOST_COMMAND_EVENT, command);
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
        await this.destroyInferenceHostWindow([
          new Error(status.lastError ?? 'Embedding host reset failed.'),
        ]);
        this.lifecycle.setStatus(status);
      }
      this.rejectSettledInferenceRequests(
        status.state === 'error'
          ? new Error(status.lastError ?? 'Embedding host reset failed.')
          : 'Embedding host reset while inference requests were in flight.',
        status.state === 'error'
      );
      return status;
    } catch (error) {
      await this.destroyInferenceHostWindow([error]);
      this.rejectSettledInferenceRequests(
        error instanceof Error ? error : new Error(String(error)),
        true
      );
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

  /** Restart to release process-owned WebGPU/Dawn memory that tensor/session disposal cannot free. */
  async destroyAndRestart(): Promise<EmbeddingHostStatus> {
    this.assertNotDisposed('destroyAndRestart');
    this.controlState = 'restarting';
    try {
      this.clearPendingInactiveStatus();
      await this.destroyInferenceHostWindow();
      this.rejectSettledInferenceRequests(
        'Embedding host restarted while inference requests were in flight.'
      );
      this.lifecycle.clearHostWindow();
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
      if (this.stopping) {
        await this.stopping;
      }
      if (this.hostedRequests.retirement) {
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
    const report = await this.documentRequests.request(request, options);
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

  /** Join the actual close/exit event; isDestroyed and a destroy send are not a completion ack. */
  private async destroyInferenceHostWindow(
    initialFailures: readonly unknown[] = []
  ): Promise<void> {
    if (this.retirement) {
      this.retirement.failures.push(...initialFailures);
      const window = this.lifecycle.getHostWindow();
      if (window && !window.isDestroyed()) {
        try {
          window.destroy();
        } catch (error) {
          this.retirement.failures.push(error);
          logger.error(
            'Embedding host retirement retry failed; physical settlement is still pending',
            {
              error,
            }
          );
        }
      }
      return this.retirement.promise;
    }
    const window = this.lifecycle.getHostWindow();
    if (!window || this.documentRequests.size() + this.queryRequests.size() === 0) {
      try {
        this.lifecycle.destroyHostWindow();
      } catch (error) {
        throw initialFailures.length > 0
          ? new AggregateError([...initialFailures, error], 'Embedding host retirement failed.')
          : error;
      }
      return;
    }
    const contents = window.webContents;
    const closed = new Promise<void>((resolve) => {
      const retired = (): void => {
        window.removeListener('closed', retired);
        contents.removeListener('render-process-gone', retired);
        this.lifecycle.clearHostWindow(window);
        resolve();
      };
      window.once('closed', retired);
      contents.once('render-process-gone', retired);
    });
    const failures = [...initialFailures];
    const promise = closed.then(() => {
      this.retirement = null;
      if (failures.length === 0) {
        return;
      }
      const failure =
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Embedding host retirement failed.');
      this.rejectSettledInferenceRequests(
        failure instanceof Error ? failure : new Error(String(failure)),
        true
      );
      throw failure;
    });
    this.retirement = { failures, promise };
    try {
      window.destroy();
    } catch (error) {
      failures.push(error);
      logger.error('Embedding host destruction failed; physical settlement is still pending', {
        error,
      });
    }
    return promise;
  }

  private async retireInferenceHost(message: string): Promise<void> {
    await this.destroyInferenceHostWindow([new Error(message)]);
    this.rejectSettledInferenceRequests(message, true);
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
      if (this.hostedRequests.hasPending) {
        await this.hostedRequests.retire();
      }
      // A trusted renderer status is emitted only after its control listener is
      // registered; a still-loading page cannot acknowledge Stop yet.
      const status = this.lifecycle.getStatus();
      if (status.state !== 'starting' || this.reportedRuntimeId === status.runtimeId) {
        await this.stopHost(EMBEDDING_HOST_SHUTDOWN_TIMEOUT_MS);
      }
    } finally {
      this.disposed = true;
      this.clearPendingInactiveStatus();
      await this.destroyInferenceHostWindow();
      this.rejectSettledInferenceRequests(
        'Embedding host disposed while inference requests were in flight.'
      );
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
    const nextStatus: EmbeddingHostStatus = { ...baseStatus, ...reportedHostFields(report) };
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
  }
}
