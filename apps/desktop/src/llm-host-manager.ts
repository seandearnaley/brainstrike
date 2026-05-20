import { createLogger } from '@brainstrike/utils/logger';
import type { BrowserWindow, WebContents } from 'electron';
import {
  createStoppedLlmHostStatus,
  LLM_HOST_PROGRESS_EVENT,
  LLM_HOST_REQUEST_EVENT,
  LLM_HOST_STATUS_ADAPTER,
  LLM_HOST_STATUS_EVENT,
  type LlmHostGenerateRequestPayload,
  type LlmHostRequest,
  type LlmHostResponseReport,
  type LlmHostStatus,
  type LlmHostStatusReport,
  type LlmHostWarmupRequestPayload,
} from './llm-host-shared';
import {
  createRuntimeHostPlatformStatus,
  type RuntimeHostPlatformStatus,
} from './platform/runtime-host-state';
import { RendererHostLifecycle } from './renderer-host-lifecycle';
import { waitForWindowClosed } from './window-lifecycle-utils';

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

interface PendingLlmRequest {
  cleanupRequesterListener?: () => void;
  deadlineAt: number;
  reject: (error: Error) => void;
  requester: WebContents;
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
            state: 'error',
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
          })
        );
      },
      onRenderProcessGone: ({ exitCode, message, reason }) => {
        logger.error(message, { reason, exitCode, windowRole: 'llm-host' });
        this.rejectPendingRequests(message);
        this.lifecycle.setStatus(
          LLM_HOST_STATUS_ADAPTER.createStatus({
            state: 'error',
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
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
      ...(this.disposed ? { controlState: 'disposed' as const } : {}),
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
        state: 'stopping',
        active: false,
        lastError: null,
        runtimeId: this.getStatus().runtimeId,
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
    await this.stop();
    return this.ensureStarted({ waitForRunning: true });
  }

  async dispose(): Promise<void> {
    try {
      await this.stop();
    } finally {
      this.disposed = true;
      this.lifecycle.dispose();
    }
  }

  acceptStatusReport(senderId: number, report: LlmHostStatusReport): void {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed() || window.webContents.id !== senderId) {
      return;
    }
    this.lifecycle.setStatus(
      LLM_HOST_STATUS_ADAPTER.createStatus({
        state: report.state,
        active: report.active,
        lastError: report.lastError,
        runtimeId: report.runtimeId,
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
        pending.requester.send(LLM_HOST_PROGRESS_EVENT, report);
      } catch (error) {
        logger.warn('Failed to forward llm host progress event', {
          requestId: report.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    clearTimeout(pending.timeoutId);
    pending.cleanupRequesterListener?.();
    this.pendingRequests.delete(report.requestId);

    if (report.type === 'error') {
      logger.error('Llm host reported request failure', {
        requestId: report.requestId,
        runtimeId: report.runtimeId,
        error: report.payload.errorMessage,
        ...(report.payload.errorStack ? { stack: report.payload.errorStack } : {}),
        ...(report.payload.errorDetails ? { errorDetails: report.payload.errorDetails } : {}),
      });
      const enrichedMessage =
        report.payload.errorDetails?.stage && report.payload.errorDetails.stage.length > 0
          ? `${report.payload.errorMessage} (stage: ${report.payload.errorDetails.stage})`
          : report.payload.errorMessage;
      pending.reject(createRequestFailure(enrichedMessage));
      return;
    }
    pending.resolve(report.payload.result);
  }

  async warmup(requester: WebContents, modelId: string): Promise<void> {
    logger.info('Dispatching llm-host warmup request', { modelId });
    await this.sendRequest(requester, { kind: 'warmup', modelId });
  }

  async warmupRequest(
    requester: WebContents,
    payload: { clientRequestId?: string; modelId: string }
  ): Promise<void> {
    logger.info('Dispatching llm-host warmup request', { modelId: payload.modelId });
    await this.sendRequest(requester, {
      kind: 'warmup',
      modelId: payload.modelId,
      ...(payload.clientRequestId ? { clientRequestId: payload.clientRequestId } : {}),
    });
  }

  async cancel(requester: WebContents, requestId: string): Promise<void> {
    const trimmedRequestId = requestId.trim();
    if (trimmedRequestId.length === 0) {
      throw createRequestFailure('Llm host cancel requestId must be a non-empty string.');
    }

    const scopedRequestId = this.scopeClientRequestId(requester, trimmedRequestId);
    const status = this.getStatus();
    const hostWindow = this.lifecycle.getHostWindow();
    if (status.state !== 'running' || !hostWindow || hostWindow.isDestroyed()) {
      this.recordPreCancelledRequest(requester, scopedRequestId);
      logger.debug('Skipping llm-host cancel because the host is not running', {
        requestId: trimmedRequestId,
        state: status.state,
        hasHostWindow: Boolean(hostWindow),
      });
      return;
    }

    this.sendCancelRequestToHost(scopedRequestId, hostWindow);
  }

  async generate(requester: WebContents, payload: LlmHostGenerateRequestPayload): Promise<unknown> {
    logger.info('Dispatching llm-host generate request', {
      modelId: payload.modelId,
      messageCount: payload.messages.length,
      toolCount: payload.options?.tools?.length ?? 0,
      thinkingEnabled: payload.options?.thinking?.enabled ?? true,
    });
    return await this.sendRequest(requester, payload);
  }

  private async sendRequest(
    requester: WebContents,
    payload: LlmHostGenerateRequestPayload | LlmHostWarmupRequestPayload
  ): Promise<unknown> {
    const hostWindow = await this.assertReadyForRequests();
    const requestId = this.createHostRequestId(requester, payload);
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

      const requesterDestroyedHandler = (): void => {
        cancelPendingRequest(`Llm host requester ${requestId} was destroyed.`);
      };

      const cleanupRequesterListener =
        typeof requester.once === 'function' && typeof requester.removeListener === 'function'
          ? () => {
              requester.removeListener('destroyed', requesterDestroyedHandler);
            }
          : null;
      const timeoutMs =
        payload.kind === 'warmup' ? LLM_HOST_WARMUP_TIMEOUT_MS : LLM_HOST_GENERATE_TIMEOUT_MS;
      const deadlineAt = getMonotonicNow() + timeoutMs;

      const pending: PendingLlmRequest = {
        requestId,
        requester,
        resolve,
        reject,
        deadlineAt,
        timeoutMs,
        timeoutId: setTimeout(
          () => {
            pending.cleanupRequesterListener?.();
            this.pendingRequests.delete(requestId);
            this.tryCancelHostRequest(requestId, hostWindow, 'timeout');
            reject(createRequestFailure(`Llm host request ${requestId} timed out.`));
          },
          Math.max(0, deadlineAt - getMonotonicNow())
        ),
        ...(cleanupRequesterListener ? { cleanupRequesterListener } : {}),
      };
      if (typeof requester.once === 'function') {
        requester.once('destroyed', requesterDestroyedHandler);
      }
      this.pendingRequests.set(requestId, pending);

      const request: LlmHostRequest = {
        type: 'request',
        channel: 'llm',
        requestId,
        runtimeId: this.getStatus().runtimeId,
        payload,
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
    requester: WebContents,
    payload: LlmHostGenerateRequestPayload | LlmHostWarmupRequestPayload
  ): string {
    if (
      'clientRequestId' in payload &&
      typeof payload.clientRequestId === 'string' &&
      payload.clientRequestId.trim().length > 0
    ) {
      return this.scopeClientRequestId(requester, payload.clientRequestId);
    }

    // IPC callers must supply clientRequestId so they can later cancel the request.
    // This fallback is reserved for internal manager call sites that do not expose cancellation.
    return this.scopeClientRequestId(requester, crypto.randomUUID());
  }

  private scopeClientRequestId(requester: WebContents, requestId: string): string {
    const trimmedRequestId = requestId.trim();
    const requesterPrefix = `${requester.id}:`;
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
    const remainingMs = Math.max(0, pending.deadlineAt - getMonotonicNow());
    pending.timeoutId = setTimeout(() => {
      pending.cleanupRequesterListener?.();
      this.pendingRequests.delete(pending.requestId);
      this.tryCancelHostRequest(pending.requestId, undefined, 'refreshed-timeout');
      pending.reject(createRequestFailure(`Llm host request ${pending.requestId} timed out.`));
    }, remainingMs);
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

  private recordPreCancelledRequest(requester: WebContents, requestId: string): void {
    const existingCleanup = this.preCancelledRequestCleanups.get(requestId);
    if (existingCleanup) {
      clearTimeout(existingCleanup.timeoutId);
      existingCleanup.cleanupRequesterListener?.();
    }

    this.preCancelledRequestIds.add(requestId);
    const requesterDestroyedHandler = (): void => {
      this.clearPreCancelledRequest(requestId);
    };
    const cleanupRequesterListener =
      typeof requester.once === 'function' && typeof requester.removeListener === 'function'
        ? () => {
            requester.removeListener('destroyed', requesterDestroyedHandler);
          }
        : undefined;
    if (typeof requester.once === 'function') {
      requester.once('destroyed', requesterDestroyedHandler);
    }
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
      type: 'request',
      channel: 'llm',
      requestId: crypto.randomUUID(),
      runtimeId: this.getStatus().runtimeId,
      payload: {
        kind: 'cancel',
        requestId,
      },
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
        requestId,
        reason,
        error: error instanceof Error ? error.message : String(error),
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
