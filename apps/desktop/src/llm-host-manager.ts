import type { LocalLlmGenerationResult } from '@brainstrike/agent/local-llm';
import { createLogger } from '@brainstrike/logging';
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
import { createHostRequestChannel, type HostRequestChannel } from './platform/host-request-channel';
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

/**
 * One request's binding to its client's lifetime: `signal` fires when the
 * client goes away (WebContents destroyed, main-process AbortSignal aborted)
 * carrying the Error the request rejects with; `release` detaches whatever
 * listener produced it and must run once the request settles.
 */
interface LlmHostRequestTeardown {
  readonly release: () => void;
  readonly signal: AbortSignal | undefined;
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
  /** Bind one request to this client's lifetime. */
  teardown: (requestId: string) => LlmHostRequestTeardown;
}

/** Reserved scope for main-process callers; WebContents ids are numeric, so 'main' cannot collide. */
const MAIN_CLIENT_SCOPE_ID = 'main';

const NO_TEARDOWN: LlmHostRequestTeardown = {
  release: () => undefined,
  signal: undefined,
};

function clientFromWebContents(requester: WebContents): LlmHostRequestClient {
  return {
    forwardProgress: (report) => {
      requester.send(LLM_HOST_PROGRESS_EVENT, report);
    },
    scopeId: String(requester.id),
    teardown: (requestId) => {
      if (typeof requester.once !== 'function') {
        return NO_TEARDOWN;
      }
      const controller = new AbortController();
      const handler = (): void => {
        controller.abort(createRequestFailure(`Llm host requester ${requestId} was destroyed.`));
      };
      requester.once('destroyed', handler);
      return {
        release: () => {
          if (typeof requester.removeListener === 'function') {
            requester.removeListener('destroyed', handler);
          }
        },
        signal: controller.signal,
      };
    },
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
    teardown: (requestId) => {
      const signal = options.signal;
      if (!signal) {
        return NO_TEARDOWN;
      }
      // Chained rather than passed through: a bare `abort()` carries a generic
      // DOMException, and the request must reject with the manager's message.
      const controller = new AbortController();
      const handler = (): void => {
        controller.abort(createRequestFailure(`Llm host request ${requestId} was aborted.`));
      };
      if (signal.aborted) {
        // `addEventListener` never fires for a signal that is already aborted.
        // `assertMainRequestNotAborted` rejects the common case before
        // dispatch, so this closes the window between that check and this
        // registration: without it the derived signal would start un-aborted
        // and the request would run to the generate timeout.
        handler();
      } else {
        signal.addEventListener('abort', handler, { once: true });
      }
      return {
        release: () => {
          signal.removeEventListener('abort', handler);
        },
        signal: controller.signal,
      };
    },
  };
}

interface PreCancelledRequestCleanup {
  release: () => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/** Abandoned ids retained while their host answer may still arrive. */
const MAX_ABANDONED_REQUEST_IDS = 64;

function createRequestFailure(message: string, code?: string): Error {
  const error = new Error(message);
  if (code) {
    (error as Error & { code: string }).code = code;
  }
  return error;
}

export class LlmHostManager {
  private disposed = false;
  private readonly lifecycle: RendererHostLifecycle<LlmHostStatus>;
  private readonly preCancelledRequestCleanups = new Map<string, PreCancelledRequestCleanup>();
  private readonly preCancelledRequestIds = new Set<string>();
  /**
   * Ids this manager abandoned (abort or timeout) whose host answer may still
   * be in flight. Bounded and oldest-evicted: a late report that never arrives
   * must not retain an id forever.
   */
  private readonly abandonedRequestIds = new Set<string>();
  private readonly requests: HostRequestChannel<LlmHostRequest, LlmHostResponseReport>;
  private controlState: RuntimeHostControlState | null = null;
  private engineResetInFlight = false;

  constructor() {
    this.requests = createHostRequestChannel<LlmHostRequest, LlmHostResponseReport>({
      isProgress: (report) => report.type === 'progress',
      onAbort: (_request, { reason, requestId }) => {
        this.rememberAbandonedRequest(requestId);
        this.tryCancelHostRequest(requestId, undefined, 'requester destruction');
        return reason instanceof Error
          ? reason
          : createRequestFailure(`Llm host request ${requestId} was aborted.`);
      },
      onLateResponse: (requestId) => {
        // A terminal report for a request this manager itself abandoned is the
        // host answering a cancel that was already in flight — expected, and
        // routine when a user presses stop. Only an id we never abandoned is
        // an actual correlation fault.
        if (this.abandonedRequestIds.delete(requestId)) {
          logger.debug('Llm host answered an abandoned request', { requestId });
          return;
        }
        logger.warn('Llm host response arrived for a request that is no longer pending', {
          requestId,
        });
      },
      onTimeout: (_request, { progressCount, requestId }) => {
        this.rememberAbandonedRequest(requestId);
        // The timeout is an INACTIVITY window, not a wall-clock ceiling: each
        // progress report (download %, text/reasoning snapshots) proves the
        // host is alive and re-arms the deadline. A wedged host goes silent
        // and still times out one window after its last report — and the
        // host is told to stop the work it may still be doing.
        this.tryCancelHostRequest(
          requestId,
          undefined,
          progressCount > 0 ? 'inactivity-timeout' : 'timeout'
        );
        return {
          error: createRequestFailure(`Llm host request ${requestId} timed out.`),
          policy: 'abandon',
        };
      },
      requestId: (request) => request.requestId,
      responseId: (report) => report.requestId,
      role: 'Llm host',
      send: (request) => {
        this.requireHostWindow().webContents.send(LLM_HOST_REQUEST_EVENT, request);
      },
      timeoutMs: (request) =>
        request.payload.kind === 'warmup'
          ? LLM_HOST_WARMUP_TIMEOUT_MS
          : LLM_HOST_GENERATE_TIMEOUT_MS,
    });
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
      pendingRequestCount: this.requests.size(),
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
   * requester teardown listeners. `stop()`/`rejectPendingRequests` only
   * drain the request channel, so without this a `dispose()` leaks every
   * outstanding pre-cancelled cleanup timer (and its listener).
   */
  private clearAllPreCancelledRequests(): void {
    for (const cleanup of this.preCancelledRequestCleanups.values()) {
      clearTimeout(cleanup.timeoutId);
      cleanup.release();
    }
    this.preCancelledRequestCleanups.clear();
    this.preCancelledRequestIds.clear();
    this.abandonedRequestIds.clear();
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
    this.requests.accept(report);
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
    await this.assertReadyForRequests();
    const requestId = this.createHostRequestId(client, payload);
    if (this.clearPreCancelledRequest(requestId)) {
      logger.warn('Rejecting llm host request because it was pre-cancelled', {
        requestId,
      });
      throw createRequestFailure(`Llm host request ${requestId} was cancelled before dispatch.`);
    }

    // The host-side payload validators REQUIRE clientRequestId; callers that
    // rely on the manager-generated id (main-process clients, the legacy
    // modelId-only warmup) must have the unscoped id stamped back in, or the
    // host rejects the request and the pending entry waits out its timeout.
    const payloadWithClientRequestId: LlmHostGenerateRequestPayload | LlmHostWarmupRequestPayload =
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

    const teardown = client.teardown(requestId);
    try {
      const report = await this.requests.request(request, {
        onProgress: (progress) => {
          if (progress.type !== 'progress') {
            return;
          }
          try {
            client.forwardProgress(progress);
          } catch (error) {
            logger.warn('Failed to forward llm host progress event', {
              error: error instanceof Error ? error.message : String(error),
              requestId,
            });
          }
        },
        signal: teardown.signal,
      });
      return this.interpretResponse(report);
    } finally {
      teardown.release();
    }
  }

  private interpretResponse(report: LlmHostResponseReport): unknown {
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
      // A persistent engine fault means the renderer already disposed the ORT
      // session but the WebGPU device stays wedged (GPU-memory exhaustion +
      // transformers.js#860 tensor leak). Escalate to a host-window reset so the
      // NEXT generation runs on a fresh device instead of failing forever.
      if (report.payload.errorDetails?.engineReset) {
        this.scheduleHostResetAfterEngineFault(report.requestId);
      }
      throw createRequestFailure(enrichedMessage, report.payload.code);
    }
    if (report.type === 'result') {
      return report.payload.result;
    }
    throw createRequestFailure(
      `Unexpected llm host response (type=${report.type}, channel=${report.channel}).`
    );
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

  private rememberAbandonedRequest(requestId: string): void {
    this.abandonedRequestIds.add(requestId);
    while (this.abandonedRequestIds.size > MAX_ABANDONED_REQUEST_IDS) {
      const oldest = this.abandonedRequestIds.values().next();
      if (oldest.done) {
        return;
      }
      this.abandonedRequestIds.delete(oldest.value);
    }
  }

  private clearPreCancelledRequest(requestId: string): boolean {
    const cleanup = this.preCancelledRequestCleanups.get(requestId);
    if (cleanup) {
      clearTimeout(cleanup.timeoutId);
      cleanup.release();
      this.preCancelledRequestCleanups.delete(requestId);
    }
    return this.preCancelledRequestIds.delete(requestId);
  }

  private recordPreCancelledRequest(client: LlmHostRequestClient, requestId: string): void {
    const existingCleanup = this.preCancelledRequestCleanups.get(requestId);
    if (existingCleanup) {
      clearTimeout(existingCleanup.timeoutId);
      existingCleanup.release();
    }

    this.preCancelledRequestIds.add(requestId);
    const teardown = client.teardown(requestId);
    teardown.signal?.addEventListener(
      'abort',
      () => {
        this.clearPreCancelledRequest(requestId);
      },
      { once: true }
    );
    const timeoutId = setTimeout(() => {
      this.clearPreCancelledRequest(requestId);
    }, PRE_CANCELLED_REQUEST_TTL_MS);
    this.preCancelledRequestCleanups.set(requestId, {
      release: teardown.release,
      timeoutId,
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

  private async assertReadyForRequests(): Promise<void> {
    const status = await this.ensureStarted({ waitForRunning: true });
    if (status.state !== 'running') {
      throw createRequestFailure(
        status.lastError ?? 'Llm host is not running and cannot accept requests.'
      );
    }
    this.requireHostWindow();
  }

  private requireHostWindow(): BrowserWindow {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      throw createRequestFailure('Llm host window is unavailable.');
    }
    return window;
  }

  private rejectPendingRequests(message: string): void {
    this.requests.rejectAll((requestId) =>
      createRequestFailure(`${message} (request ${requestId})`)
    );
  }
}
