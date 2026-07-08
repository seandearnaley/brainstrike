import type { LocalLlmGenerationResult } from '@brainstrike/agent/local-llm';
import { createLogger } from '@brainstrike/utils/logger';
import type { BrowserWindow, WebContents } from 'electron';
import { BrowserWindow as ElectronBrowserWindow } from 'electron';
import {
  createStoppedLlmHostStatus,
  LLM_HOST_PROGRESS_EVENT,
  LLM_HOST_REQUEST_EVENT,
  LLM_HOST_STATUS_ADAPTER,
  LLM_HOST_STATUS_EVENT,
  type LlmHostGenerateRequestPayload,
  type LlmHostProgressPayload,
  type LlmHostProgressReport,
  type LlmHostRequest,
  type LlmHostResponseReport,
  type LlmHostStatus,
  type LlmHostStatusReport,
  type LlmHostWarmupRequestPayload,
} from './llm-host-shared';
import {
  createRuntimeHostPlatformStatus,
  type RuntimeHostControlState,
  type RuntimeHostPlatformStatus,
} from './platform/runtime-host-state';
import { RendererHostLifecycle } from './renderer-host-lifecycle';
import { waitForWindowClosed } from './window-lifecycle-utils';
import { getWindowRoleByWebContentsId } from './window-role';

const logger = createLogger('LlmHostManager');
const LLM_HOST_GENERATE_TIMEOUT_MS = 5 * 60_000;
const LLM_HOST_WARMUP_TIMEOUT_MS = 20 * 60_000;
const LLM_HOST_STOP_DESTROY_TIMEOUT_MS = 500;
const PRE_CANCELLED_REQUEST_TTL_MS = LLM_HOST_GENERATE_TIMEOUT_MS;

function getMonotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Abstraction over "who asked for this request" so the manager can serve both
 * renderer callers (WebContents, progress forwarded over IPC, torn down when
 * the WebContents is destroyed) and main-process callers (progress delivered
 * to a callback, torn down by an AbortSignal).
 */
interface LlmHostRequestClient {
  forwardProgress: (report: LlmHostProgressReport) => void;
  /** Scope prefix for request ids (WebContents id, or 'main'). */
  readonly scopeId: string;
  /** Subscribe to client teardown; returns cleanup, or null when not removable. */
  subscribeTeardown: (handler: () => void) => (() => void) | null;
  teardownMessage: (requestId: string) => string;
}

/** Reserved scope for main-process callers; WebContents ids are numeric, so 'main' cannot collide. */
const MAIN_CLIENT_SCOPE_ID = 'main';

function clientFromWebContents(requester: WebContents): LlmHostRequestClient {
  return {
    forwardProgress: (report) => {
      requester.send(LLM_HOST_PROGRESS_EVENT, report);
    },
    scopeId: String(requester.id),
    subscribeTeardown: (handler) => {
      if (typeof requester.once !== 'function') {
        return null;
      }
      requester.once('destroyed', handler);
      return typeof requester.removeListener === 'function'
        ? () => {
            requester.removeListener('destroyed', handler);
          }
        : null;
    },
    teardownMessage: (requestId) => `Llm host requester ${requestId} was destroyed.`,
  };
}

export interface LlmHostMainRequestOptions {
  onProgress?: (progress: LlmHostProgressPayload) => void;
  signal?: AbortSignal;
}

/**
 * Main-initiated model LOADS have no renderer request in flight (e.g. the
 * assistant server warming a cold local memory model), so their download
 * progress is broadcast to visible windows — otherwise the user stares at a
 * silent spinner while gigabytes download. Renderer-initiated requests
 * already receive progress over their own IPC reply channel.
 */
function broadcastLoadingProgressToVisibleWindows(report: LlmHostProgressReport): void {
  for (const window of ElectronBrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    // Hidden runtime hosts have an assigned role; visible UI windows do not.
    if (getWindowRoleByWebContentsId(window.webContents.id)) {
      continue;
    }
    try {
      window.webContents.send(LLM_HOST_PROGRESS_EVENT, report);
    } catch (error) {
      logger.warn('Failed to broadcast llm host loading progress', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function clientForMain(options: LlmHostMainRequestOptions): LlmHostRequestClient {
  return {
    forwardProgress: (report) => {
      options.onProgress?.(report.payload);
      if (report.payload.kind === 'loading') {
        broadcastLoadingProgressToVisibleWindows(report);
      }
    },
    scopeId: MAIN_CLIENT_SCOPE_ID,
    subscribeTeardown: (handler) => {
      const signal = options.signal;
      if (!signal) {
        return null;
      }
      signal.addEventListener('abort', handler, { once: true });
      return () => {
        signal.removeEventListener('abort', handler);
      };
    },
    teardownMessage: (requestId) => `Llm host request ${requestId} was aborted.`,
  };
}

interface PendingLlmRequest {
  cleanupRequesterListener?: () => void;
  client: LlmHostRequestClient;
  deadlineAt: number;
  reject: (error: Error) => void;
  requestId: string;
  resolve: (result: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

interface PreCancelledRequestCleanup {
  cleanupRequesterListener?: () => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

function createRequestFailure(message: string): Error {
  return new Error(message);
}

export class LlmHostManager {
  private disposed = false;
  private readonly lifecycle: RendererHostLifecycle<LlmHostStatus>;
  private readonly preCancelledRequestCleanups = new Map<string, PreCancelledRequestCleanup>();
  private readonly preCancelledRequestIds = new Set<string>();
  private readonly pendingRequests = new Map<string, PendingLlmRequest>();
  private controlState: RuntimeHostControlState | null = null;
  private engineResetInFlight = false;

  constructor() {
    this.lifecycle = new RendererHostLifecycle<LlmHostStatus>({
      createStatus: LLM_HOST_STATUS_ADAPTER.createStatus,
      createStoppedStatus: createStoppedLlmHostStatus,
      mode: 'llm-host',
      onDidFailLoad: ({ errorCode, errorDescription, message, url }) => {
        logger.error(message, { errorCode, errorDescription, url, windowRole: 'llm-host' });
        this.rejectPendingRequests(message);
        this.lifecycle.setStatus(
          LLM_HOST_STATUS_ADAPTER.createStatus({
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
            state: 'error',
          })
        );
      },
      onRenderProcessGone: ({ exitCode, message, reason }) => {
        logger.error(message, { exitCode, reason, windowRole: 'llm-host' });
        this.rejectPendingRequests(message);
        this.lifecycle.setStatus(
          LLM_HOST_STATUS_ADAPTER.createStatus({
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
            state: 'error',
          })
        );
      },
      onWindowClosed: () => {
        this.rejectPendingRequests('Llm host window closed while requests were in flight.');
        this.lifecycle.setStatus(createStoppedLlmHostStatus());
      },
      role: 'llm-host',
      statusEventName: LLM_HOST_STATUS_EVENT,
      timeoutMessage: 'Timed out waiting for llm host state transition.',
    });
  }

  getStatus(): LlmHostStatus {
    return this.lifecycle.getStatus();
  }

  getPlatformStatus(): RuntimeHostPlatformStatus<'llm-host'> {
    return createRuntimeHostPlatformStatus(this.getStatus(), {
      ...(this.disposed
        ? { controlState: 'disposed' as const }
        : this.controlState
          ? { controlState: this.controlState }
          : {}),
      pendingRequestCount: this.pendingRequests.size,
    });
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.lifecycle.isHostWindow(window);
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<LlmHostStatus> {
    return this.lifecycle.ensureStarted(options);
  }

  async stop(): Promise<LlmHostStatus> {
    this.rejectPendingRequests('Llm host stopped while requests were in flight.');
    this.lifecycle.setStatus(
      LLM_HOST_STATUS_ADAPTER.createStatus({
        active: false,
        lastError: null,
        runtimeId: this.getStatus().runtimeId,
        state: 'stopping',
      })
    );

    const window = this.lifecycle.getHostWindow();
    if (window && !window.isDestroyed()) {
      const closedPromise = waitForWindowClosed(window, LLM_HOST_STOP_DESTROY_TIMEOUT_MS);
      this.lifecycle.destroyHostWindow();
      await closedPromise;
    }

    this.lifecycle.clearHostWindow();
    this.lifecycle.setStatus(createStoppedLlmHostStatus());
    return this.getStatus();
  }

  async reset(): Promise<LlmHostStatus> {
    this.controlState = 'resetting';
    try {
      await this.stop();
      return await this.ensureStarted({ waitForRunning: true });
    } finally {
      this.controlState = null;
    }
  }

  /**
   * Escalate a persistent engine fault (reported with `errorDetails.engineReset`)
   * to a full host-window reset. The renderer already disposed the ORT session,
   * but GPU-memory exhaustion wedges the WebGPU DEVICE, and a transformers.js
   * tensor-disposal leak (huggingface/transformers.js#860) keeps the leaked
   * buffers alive — only recreating the host window gives a fresh device. Fired
   * only when the renderer's own dispose+retry already failed, so it is not
   * over-aggressive. Debounced via `engineResetInFlight` so a burst of failed
   * requests triggers at most one reset; skipped while disposed or already
   * resetting.
   */
  private scheduleHostResetAfterEngineFault(requestId: string): void {
    if (this.disposed || this.engineResetInFlight || this.controlState === 'resetting') {
      return;
    }
    this.engineResetInFlight = true;
    logger.warn('Recovering the llm host WebGPU device with a window reset after an engine fault', {
      requestId,
    });
    void this.reset()
      .catch((error) => {
        logger.error('Llm host window reset after engine fault failed', {
          error: error instanceof Error ? error.message : String(error),
          requestId,
        });
      })
      .finally(() => {
        this.engineResetInFlight = false;
      });
  }

  async dispose(): Promise<void> {
    try {
      await this.stop();
    } finally {
      this.disposed = true;
      this.clearAllPreCancelledRequests();
      this.lifecycle.dispose();
    }
  }

  /**
   * Clear all pre-cancelled request bookkeeping: the TTL timers and the
   * requester `'destroyed'` listeners. `stop()`/`rejectPendingRequests` only
   * drain `pendingRequests`, so without this a `dispose()` leaks every
   * outstanding pre-cancelled cleanup timer (and its listener).
   */
  private clearAllPreCancelledRequests(): void {
    for (const cleanup of this.preCancelledRequestCleanups.values()) {
      clearTimeout(cleanup.timeoutId);
      cleanup.cleanupRequesterListener?.();
    }
    this.preCancelledRequestCleanups.clear();
    this.preCancelledRequestIds.clear();
  }

  acceptStatusReport(senderId: number, report: LlmHostStatusReport): void {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed() || window.webContents.id !== senderId) {
      return;
    }
    this.lifecycle.setStatus(
      LLM_HOST_STATUS_ADAPTER.createStatus({
        active: report.active,
        lastError: report.lastError,
        runtimeId: report.runtimeId,
        state: report.state,
      })
    );
  }

  acceptResponseReport(senderId: number, report: LlmHostResponseReport): void {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed() || window.webContents.id !== senderId) {
      return;
    }

    const pending = this.pendingRequests.get(report.requestId);
    if (!pending) {
      return;
    }
    if (report.type === 'progress') {
      this.refreshPendingRequestTimeout(pending);
      try {
        pending.client.forwardProgress(report);
      } catch (error) {
        logger.warn('Failed to forward llm host progress event', {
          error: error instanceof Error ? error.message : String(error),
          requestId: report.requestId,
        });
      }
      return;
    }
    clearTimeout(pending.timeoutId);
    pending.cleanupRequesterListener?.();
    this.pendingRequests.delete(report.requestId);

    if (report.type === 'error') {
      logger.error('Llm host reported request failure', {
        error: report.payload.errorMessage,
        requestId: report.requestId,
        runtimeId: report.runtimeId,
        ...(report.payload.errorStack ? { stack: report.payload.errorStack } : {}),
        ...(report.payload.errorDetails ? { errorDetails: report.payload.errorDetails } : {}),
      });
      const enrichedMessage =
        report.payload.errorDetails?.stage && report.payload.errorDetails.stage.length > 0
          ? `${report.payload.errorMessage} (stage: ${report.payload.errorDetails.stage})`
          : report.payload.errorMessage;
      pending.reject(createRequestFailure(enrichedMessage));
      // A persistent engine fault means the renderer already disposed the ORT
      // session but the WebGPU device stays wedged (GPU-memory exhaustion +
      // transformers.js#860 tensor leak). Escalate to a host-window reset so the
      // NEXT generation runs on a fresh device instead of failing forever.
      if (report.payload.errorDetails?.engineReset) {
        this.scheduleHostResetAfterEngineFault(report.requestId);
      }
      return;
    }
    pending.resolve(report.payload.result);
  }

  async warmup(requester: WebContents, modelId: string): Promise<void> {
    logger.info('Dispatching llm-host warmup request', { modelId });
    await this.sendRequest(clientFromWebContents(requester), { kind: 'warmup', modelId });
  }

  async warmupRequest(
    requester: WebContents,
    payload: { clientRequestId?: string; modelId: string }
  ): Promise<void> {
    logger.info('Dispatching llm-host warmup request', { modelId: payload.modelId });
    await this.sendRequest(clientFromWebContents(requester), {
      kind: 'warmup',
      modelId: payload.modelId,
      ...(payload.clientRequestId ? { clientRequestId: payload.clientRequestId } : {}),
    });
  }

  /**
   * Warm the model from the main process (e.g. before streaming a Mastra turn),
   * with download/load progress delivered to the callback instead of IPC.
   */
  async warmupForMain(modelId: string, options: LlmHostMainRequestOptions = {}): Promise<void> {
    this.assertMainRequestNotAborted(options);
    logger.info('Dispatching llm-host warmup request from main', { modelId });
    await this.sendRequest(clientForMain(options), { kind: 'warmup', modelId });
    // Terminal 100% lets the renderer badge resolve to ready instead of
    // sticking at the last partial percentage (loading events stop on the
    // final result, which is not broadcast).
    broadcastLoadingProgressToVisibleWindows({
      channel: 'llm-progress',
      payload: { kind: 'loading', message: 'Model loaded', progress: 100 },
      requestId: `${MAIN_CLIENT_SCOPE_ID}:warmup-complete`,
      runtimeId: this.getStatus().runtimeId,
      type: 'progress',
    });
  }

  /**
   * Run a generation from the main process. Progress snapshots (text/reasoning)
   * stream to `options.onProgress`; aborting `options.signal` cancels the host
   * request and rejects. Used by the Mastra local-provider proxy model.
   */
  async generateForMain(
    payload: Omit<LlmHostGenerateRequestPayload, 'kind'>,
    options: LlmHostMainRequestOptions = {}
  ): Promise<LocalLlmGenerationResult> {
    this.assertMainRequestNotAborted(options);
    logger.info('Dispatching llm-host generate request from main', {
      messageCount: payload.messages.length,
      modelId: payload.modelId,
      thinkingEnabled: payload.options?.thinking?.enabled ?? true,
      toolCount: payload.options?.tools?.length ?? 0,
    });
    const result = await this.sendRequest(clientForMain(options), {
      ...payload,
      kind: 'generate',
    });
    if (result === null || result === undefined) {
      throw createRequestFailure(
        `Llm host generate request for model ${payload.modelId} returned no result payload.`
      );
    }
    return result as LocalLlmGenerationResult;
  }

  private assertMainRequestNotAborted(options: LlmHostMainRequestOptions): void {
    if (options.signal?.aborted) {
      throw createRequestFailure('Llm host request was aborted before dispatch.');
    }
  }

  async cancel(requester: WebContents, requestId: string): Promise<void> {
    const trimmedRequestId = requestId.trim();
    if (trimmedRequestId.length === 0) {
      throw createRequestFailure('Llm host cancel requestId must be a non-empty string.');
    }

    const scopedRequestId = this.scopeClientRequestId(String(requester.id), trimmedRequestId);
    const status = this.getStatus();
    const hostWindow = this.lifecycle.getHostWindow();
    if (status.state !== 'running' || !hostWindow || hostWindow.isDestroyed()) {
      this.recordPreCancelledRequest(clientFromWebContents(requester), scopedRequestId);
      logger.debug('Skipping llm-host cancel because the host is not running', {
        hasHostWindow: Boolean(hostWindow),
        requestId: trimmedRequestId,
        state: status.state,
      });
      return;
    }

    this.sendCancelRequestToHost(scopedRequestId, hostWindow);
  }

  async generate(requester: WebContents, payload: LlmHostGenerateRequestPayload): Promise<unknown> {
    logger.info('Dispatching llm-host generate request', {
      messageCount: payload.messages.length,
      modelId: payload.modelId,
      thinkingEnabled: payload.options?.thinking?.enabled ?? true,
      toolCount: payload.options?.tools?.length ?? 0,
    });
    return await this.sendRequest(clientFromWebContents(requester), payload);
  }

  private async sendRequest(
    client: LlmHostRequestClient,
    payload: LlmHostGenerateRequestPayload | LlmHostWarmupRequestPayload
  ): Promise<unknown> {
    const hostWindow = await this.assertReadyForRequests();
    const requestId = this.createHostRequestId(client, payload);
    if (this.clearPreCancelledRequest(requestId)) {
      logger.warn('Rejecting llm host request because it was pre-cancelled', {
        requestId,
      });
      throw createRequestFailure(`Llm host request ${requestId} was cancelled before dispatch.`);
    }
    return await new Promise<unknown>((resolve, reject) => {
      if (this.pendingRequests.has(requestId)) {
        reject(createRequestFailure(`Duplicate llm host requestId ${requestId}.`));
        return;
      }

      const cancelPendingRequest = (message: string): void => {
        const activePending = this.pendingRequests.get(requestId);
        if (!activePending) {
          return;
        }
        clearTimeout(activePending.timeoutId);
        activePending.cleanupRequesterListener?.();
        this.pendingRequests.delete(requestId);
        reject(createRequestFailure(message));
        this.tryCancelHostRequest(requestId, hostWindow, 'requester destruction');
      };

      const teardownHandler = (): void => {
        cancelPendingRequest(client.teardownMessage(requestId));
      };

      const timeoutMs =
        payload.kind === 'warmup' ? LLM_HOST_WARMUP_TIMEOUT_MS : LLM_HOST_GENERATE_TIMEOUT_MS;
      const deadlineAt = getMonotonicNow() + timeoutMs;

      const pending: PendingLlmRequest = {
        client,
        deadlineAt,
        reject,
        requestId,
        resolve,
        timeoutId: setTimeout(
          () => {
            pending.cleanupRequesterListener?.();
            this.pendingRequests.delete(requestId);
            this.tryCancelHostRequest(requestId, hostWindow, 'timeout');
            reject(createRequestFailure(`Llm host request ${requestId} timed out.`));
          },
          Math.max(0, deadlineAt - getMonotonicNow())
        ),
        timeoutMs,
      };
      const cleanupRequesterListener = client.subscribeTeardown(teardownHandler);
      if (cleanupRequesterListener) {
        pending.cleanupRequesterListener = cleanupRequesterListener;
      }
      this.pendingRequests.set(requestId, pending);

      // The host-side payload validators REQUIRE clientRequestId; callers that
      // rely on the manager-generated id (main-process clients, the legacy
      // modelId-only warmup) must have the unscoped id stamped back in, or the
      // host rejects the request and the pending entry waits out its timeout.
      const payloadWithClientRequestId:
        | LlmHostGenerateRequestPayload
        | LlmHostWarmupRequestPayload =
        payload.clientRequestId && payload.clientRequestId.trim().length > 0
          ? payload
          : { ...payload, clientRequestId: requestId.slice(requestId.indexOf(':') + 1) };

      const request: LlmHostRequest = {
        channel: 'llm',
        payload: payloadWithClientRequestId,
        requestId,
        runtimeId: this.getStatus().runtimeId,
        type: 'request',
      };

      try {
        hostWindow.webContents.send(LLM_HOST_REQUEST_EVENT, request);
      } catch (error) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(requestId);
        reject(
          createRequestFailure(
            error instanceof Error
              ? `Llm host request ${requestId} could not be sent: ${error.message}`
              : `Llm host request ${requestId} could not be sent.`
          )
        );
      }
    });
  }

  private createHostRequestId(
    client: LlmHostRequestClient,
    payload: LlmHostGenerateRequestPayload | LlmHostWarmupRequestPayload
  ): string {
    if (
      'clientRequestId' in payload &&
      typeof payload.clientRequestId === 'string' &&
      payload.clientRequestId.trim().length > 0
    ) {
      return this.scopeClientRequestId(client.scopeId, payload.clientRequestId);
    }

    // IPC callers must supply clientRequestId so they can later cancel the request.
    // This fallback is reserved for internal manager call sites that do not expose cancellation.
    return this.scopeClientRequestId(client.scopeId, crypto.randomUUID());
  }

  private scopeClientRequestId(scopeId: string, requestId: string): string {
    const trimmedRequestId = requestId.trim();
    const requesterPrefix = `${scopeId}:`;
    if (trimmedRequestId.startsWith(requesterPrefix)) {
      const unscopedRemainder = trimmedRequestId.slice(requesterPrefix.length);
      if (!(unscopedRemainder.length > 0) || unscopedRemainder.includes(':')) {
        throw createRequestFailure(
          `Llm host clientRequestId ${trimmedRequestId} must not include nested scope prefixes.`
        );
      }
      return `${requesterPrefix}${unscopedRemainder}`;
    }
    if (trimmedRequestId.includes(':')) {
      throw createRequestFailure(
        `Llm host clientRequestId ${trimmedRequestId} must not include scope separators.`
      );
    }
    return `${requesterPrefix}${trimmedRequestId}`;
  }

  private refreshPendingRequestTimeout(pending: PendingLlmRequest): void {
    clearTimeout(pending.timeoutId);
    // The timeout is an INACTIVITY window, not a wall-clock ceiling: each
    // progress report (download %, text/reasoning snapshots) proves the host
    // is alive and extends the deadline by the full window. Long local
    // generations stream progress continuously; a wedged host goes silent
    // and still times out one window after its last report.
    pending.deadlineAt = getMonotonicNow() + pending.timeoutMs;
    pending.timeoutId = setTimeout(() => {
      pending.cleanupRequesterListener?.();
      this.pendingRequests.delete(pending.requestId);
      this.tryCancelHostRequest(pending.requestId, undefined, 'inactivity-timeout');
      pending.reject(createRequestFailure(`Llm host request ${pending.requestId} timed out.`));
    }, pending.timeoutMs);
  }

  private clearPreCancelledRequest(requestId: string): boolean {
    const cleanup = this.preCancelledRequestCleanups.get(requestId);
    if (cleanup) {
      clearTimeout(cleanup.timeoutId);
      cleanup.cleanupRequesterListener?.();
      this.preCancelledRequestCleanups.delete(requestId);
    }
    return this.preCancelledRequestIds.delete(requestId);
  }

  private recordPreCancelledRequest(client: LlmHostRequestClient, requestId: string): void {
    const existingCleanup = this.preCancelledRequestCleanups.get(requestId);
    if (existingCleanup) {
      clearTimeout(existingCleanup.timeoutId);
      existingCleanup.cleanupRequesterListener?.();
    }

    this.preCancelledRequestIds.add(requestId);
    const cleanupRequesterListener = client.subscribeTeardown(() => {
      this.clearPreCancelledRequest(requestId);
    });
    const timeoutId = setTimeout(() => {
      this.clearPreCancelledRequest(requestId);
    }, PRE_CANCELLED_REQUEST_TTL_MS);
    this.preCancelledRequestCleanups.set(requestId, {
      timeoutId,
      ...(cleanupRequesterListener ? { cleanupRequesterListener } : {}),
    });
  }

  private sendCancelRequestToHost(requestId: string, hostWindow?: BrowserWindow): void {
    const targetWindow = hostWindow ?? this.lifecycle.getHostWindow();
    if (!targetWindow || targetWindow.isDestroyed()) {
      throw createRequestFailure('Llm host window is unavailable.');
    }

    const cancelRequest: LlmHostRequest = {
      channel: 'llm',
      payload: {
        kind: 'cancel',
        requestId,
      },
      requestId: crypto.randomUUID(),
      runtimeId: this.getStatus().runtimeId,
      type: 'request',
    };

    targetWindow.webContents.send(LLM_HOST_REQUEST_EVENT, cancelRequest);
  }

  private tryCancelHostRequest(
    requestId: string,
    hostWindow: BrowserWindow | undefined,
    reason: string
  ): void {
    try {
      this.sendCancelRequestToHost(requestId, hostWindow);
    } catch (error) {
      logger.warn('Failed to cancel llm host request', {
        error: error instanceof Error ? error.message : String(error),
        reason,
        requestId,
      });
    }
  }

  private async assertReadyForRequests(): Promise<BrowserWindow> {
    const status = await this.ensureStarted({ waitForRunning: true });
    if (status.state !== 'running') {
      throw createRequestFailure(
        status.lastError ?? 'Llm host is not running and cannot accept requests.'
      );
    }

    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      throw createRequestFailure('Llm host window is unavailable.');
    }
    return window;
  }

  private rejectPendingRequests(message: string): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.cleanupRequesterListener?.();
      pending.reject(createRequestFailure(`${message} (request ${requestId})`));
      this.pendingRequests.delete(requestId);
    }
  }
}
