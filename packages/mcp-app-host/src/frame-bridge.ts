import {
  type McpAppFrameBinding,
  type McpAppFrameEventTarget,
  McpAppFrameSession,
  type McpAppFrameSessionClaim,
  type McpAppFrameSessionMessageContext,
  type McpAppFrameSessionPhase,
  type McpAppFrameSource,
} from './frame-session.js';
import { correlationKey, parsePositiveSafeInteger, toError } from './internal.js';
import {
  McpAppRequestCorrelator,
  type McpAppRequestMethod,
  type McpAppResponse,
  parseMcpAppResponse,
} from './json-rpc.js';
import type { McpAppMessage } from './messages.js';
import { parseMcpAppJsonValue, parseMcpAppMessage } from './messages.js';
import type { UnknownRecord } from './validation.js';

const MAX_PENDING_NOTIFICATIONS = 256;

export type { McpAppFrameBinding, McpAppFrameEventTarget, McpAppFrameSource };

export interface McpAppFrameRequestContext {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface McpAppFrameBridgeOptions {
  readonly eventTarget: McpAppFrameEventTarget;
  readonly isGenerationLive: (generation: number) => boolean;
  readonly onNotification: (
    message: McpAppMessage,
    context: McpAppFrameRequestContext
  ) => Promise<void> | void;
  readonly onProtocolError: (error: Error) => void;
  readonly onRequest: (
    message: McpAppMessage,
    context: McpAppFrameRequestContext
  ) => Promise<Readonly<UnknownRecord>> | Readonly<UnknownRecord>;
  readonly timeoutMs?: number;
}

export interface McpAppFrameBridgeSnapshot {
  readonly generation?: number;
  readonly listenerCount: number;
  readonly pendingCallbacks: number;
  readonly pendingInboundRequests: number;
  readonly pendingNotifications: number;
  readonly pendingOutboundRequests: number;
  readonly phase: McpAppFrameSessionPhase;
  readonly timerCount: number;
}

interface InboundOperation {
  readonly claim: McpAppFrameSessionClaim;
  readonly controller: AbortController;
  readonly generation: number;
  readonly id: number | string;
  readonly key: string;
  readonly method: McpAppRequestMethod;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface NotificationOperation {
  readonly claim: McpAppFrameSessionClaim;
  readonly controller: AbortController;
  readonly generation: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface OutboundOperation {
  readonly abortListener?: () => void;
  readonly reject: (reason: Error) => void;
  readonly resolve: (result: Readonly<UnknownRecord>) => void;
  readonly signal?: AbortSignal;
  readonly timer: ReturnType<typeof setTimeout>;
}

function parseTimeout(value: number | undefined): number {
  return parsePositiveSafeInteger(value ?? 10_000, 'MCP Apps bridge timeout');
}

function parseRequestMethod(method: McpAppMessage['method']): McpAppRequestMethod {
  switch (method) {
    case 'ping':
    case 'resources/read':
    case 'tools/call':
    case 'ui/initialize':
    case 'ui/message':
    case 'ui/open-link':
    case 'ui/request-display-mode':
    case 'ui/resource-teardown':
    case 'ui/update-model-context':
      return method;
    default:
      throw new TypeError(`MCP Apps method "${method}" is not a request`);
  }
}

function abortReason(signal: AbortSignal): Error {
  return toError(signal.reason, 'MCP Apps request was cancelled');
}

function settleWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const claimSettlement = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (claimSettlement()) {
        reject(abortReason(signal));
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    operation.then(
      (value) => {
        if (claimSettlement()) {
          resolve(value);
        }
      },
      (error: unknown) => {
        if (claimSettlement()) {
          reject(error);
        }
      }
    );
  });
}

export class McpAppFrameRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpAppFrameRpcError';
    if (!Number.isSafeInteger(code)) {
      throw new TypeError('MCP Apps RPC error code must be a safe integer');
    }
    if (message.length === 0) {
      throw new TypeError('MCP Apps RPC error message must not be empty');
    }
    this.code = code;
    if (data !== undefined) {
      this.data = parseMcpAppJsonValue(data, 'MCP Apps RPC error data');
    }
  }
}

export class McpAppFrameRemoteError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: Extract<McpAppResponse, { error: unknown }>['error']) {
    super(error.message);
    this.name = 'McpAppFrameRemoteError';
    this.code = error.code;
    if (error.data !== undefined) {
      this.data = error.data;
    }
  }
}

export class McpAppFrameBridge {
  readonly #inbound = new Map<string, InboundOperation>();
  /** Id admission (pending cap, one-shot ids) for requests the app sends. */
  readonly #inboundIds = new McpAppRequestCorrelator();
  readonly #notifications = new Set<NotificationOperation>();
  readonly #onNotification: McpAppFrameBridgeOptions['onNotification'];
  readonly #onRequest: McpAppFrameBridgeOptions['onRequest'];
  readonly #outbound = new Map<string, OutboundOperation>();
  /** Id admission and response settlement for requests the host sends. */
  readonly #outboundIds = new McpAppRequestCorrelator();
  readonly #session: McpAppFrameSession;
  readonly #timeoutMs: number;

  constructor(options: McpAppFrameBridgeOptions) {
    this.#onNotification = options.onNotification;
    this.#onRequest = options.onRequest;
    this.#timeoutMs = parseTimeout(options.timeoutMs);
    this.#session = new McpAppFrameSession({
      eventTarget: options.eventTarget,
      isGenerationLive: options.isGenerationLive,
      onMessage: (value, context) => this.#receive(value, context),
      onProtocolError: options.onProtocolError,
      onTeardown: (reason) => this.#teardownOperations(reason),
    });
  }

  get snapshot(): McpAppFrameBridgeSnapshot {
    const session = this.#session.snapshot;
    return Object.freeze({
      ...(session.generation === undefined ? {} : { generation: session.generation }),
      listenerCount: session.listenerCount,
      pendingCallbacks: this.#inbound.size + this.#notifications.size,
      pendingInboundRequests: this.#inbound.size,
      pendingNotifications: this.#notifications.size,
      pendingOutboundRequests: this.#outbound.size,
      phase: session.phase,
      timerCount: this.#inbound.size + this.#notifications.size + this.#outbound.size,
    });
  }

  connect(binding: McpAppFrameBinding): void {
    this.#session.connect(binding);
  }

  replace(binding: McpAppFrameBinding): void {
    this.#session.replace(binding);
  }

  disconnect(): void {
    this.#session.disconnect();
  }

  close(): void {
    this.#session.close();
  }

  sendNotification(value: unknown): void {
    const generation = this.#session.requireReadyGeneration();
    const message = parseMcpAppMessage(value, 'host-to-app');
    if (message.id !== undefined) {
      throw new TypeError('MCP Apps host notification must not contain an id');
    }
    this.#session.post(generation, message);
  }

  /** Every precondition failure is a rejection; this method never throws synchronously. */
  sendRequest(
    value: unknown,
    options: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<Readonly<UnknownRecord>> {
    let generation: number;
    let message: McpAppMessage;
    let id: number | string;
    const signal = options.signal;
    try {
      generation = this.#session.requireReadyGeneration();
      message = parseMcpAppMessage(value, 'host-to-app');
      if (message.id === undefined) {
        throw new TypeError('MCP Apps host request must contain an id');
      }
      if (signal?.aborted === true) {
        throw abortReason(signal);
      }
      // The correlator retains the method so the reply is validated against
      // its canonical result schema when it settles.
      id = this.#outboundIds.register(message.id, parseRequestMethod(message.method));
    } catch (cause: unknown) {
      return Promise.reject(cause);
    }
    const key = correlationKey(id);

    return new Promise((resolve, reject) => {
      const finish = (reason?: Error): void => {
        const operation = this.#outbound.get(key);
        if (operation === undefined) {
          return;
        }
        this.#outbound.delete(key);
        this.#outboundIds.cancel(id);
        clearTimeout(operation.timer);
        if (operation.signal !== undefined && operation.abortListener !== undefined) {
          operation.signal.removeEventListener('abort', operation.abortListener);
        }
        if (reason !== undefined) {
          reject(reason);
        }
      };
      const abortListener = signal === undefined ? undefined : () => finish(abortReason(signal));
      const timer = setTimeout(
        () => finish(new Error(`MCP Apps request ${JSON.stringify(message.id)} timed out`)),
        this.#timeoutMs
      );
      this.#outbound.set(key, {
        ...(abortListener === undefined ? {} : { abortListener }),
        reject,
        resolve,
        ...(signal === undefined ? {} : { signal }),
        timer,
      });
      if (signal !== undefined && abortListener !== undefined) {
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) {
          abortListener();
          return;
        }
      }
      this.#session.post(generation, message);
    });
  }

  #receive(value: unknown, context: McpAppFrameSessionMessageContext): void {
    if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'method')) {
      const message = parseMcpAppMessage(value, 'app-to-host');
      const claim = context.claim({
        kind: message.id === undefined ? 'notification' : 'request',
        method: message.method,
      });
      if (message.id === undefined) {
        this.#acceptNotification(message, claim);
        return;
      }
      this.#acceptRequest(message, claim);
      return;
    }
    this.#receiveResponse(value, context.generation);
  }

  #acceptRequest(message: McpAppMessage, claim: McpAppFrameSessionClaim): void {
    if (message.id === undefined) {
      throw new TypeError('MCP Apps request is missing its id');
    }
    // One-shot ids and the pending cap are the correlator's contract: a
    // replayed id is "already used", a live duplicate "already pending".
    const method = parseRequestMethod(message.method);
    const id = this.#inboundIds.register(message.id, method);
    this.#dispatchRequest(message, correlationKey(id), claim, id, method);
  }

  #dispatchRequest(
    message: McpAppMessage,
    key: string,
    claim: McpAppFrameSessionClaim,
    id: number | string,
    method: McpAppRequestMethod
  ): void {
    const controller = new AbortController();
    const operation: InboundOperation = {
      claim,
      controller,
      generation: claim.generation,
      id,
      key,
      method,
      timer: setTimeout(() => {
        try {
          this.#timeoutInbound(operation);
        } catch (error: unknown) {
          this.#failIfConnected(toError(error, 'MCP Apps inbound request timeout failed'));
        }
      }, this.#timeoutMs),
    };
    this.#inbound.set(key, operation);
    const callback = Promise.resolve().then(() => {
      if (controller.signal.aborted) {
        throw abortReason(controller.signal);
      }
      return this.#onRequest(message, {
        generation: claim.generation,
        signal: controller.signal,
      });
    });
    settleWithAbort(callback, controller.signal)
      .then(
        (result) => this.#settleInboundSuccess(operation, result),
        (error: unknown) => this.#settleInboundError(operation, error)
      )
      .catch((error: unknown) =>
        this.#failIfConnected(toError(error, 'MCP Apps request settlement failed'))
      );
  }

  #settleInboundSuccess(operation: InboundOperation, value: unknown): void {
    if (!this.#releaseInbound(operation)) {
      return;
    }
    this.#session.assertGeneration(operation.generation);
    this.#postResponse(
      operation.generation,
      Object.freeze({ id: operation.id, jsonrpc: '2.0' as const, result: value }),
      operation.method
    );
    operation.claim.complete();
  }

  #settleInboundError(operation: InboundOperation, value: unknown): void {
    if (!this.#releaseInbound(operation)) {
      return;
    }
    this.#session.assertGeneration(operation.generation);
    const error =
      value instanceof McpAppFrameRpcError
        ? Object.freeze({
            code: value.code,
            ...(value.data === undefined ? {} : { data: value.data }),
            message: value.message,
          })
        : Object.freeze({ code: -32_603, message: 'MCP Apps request failed' });
    this.#postResponse(
      operation.generation,
      Object.freeze({ error, id: operation.id, jsonrpc: '2.0' as const }),
      operation.method
    );
    if (operation.claim.kind === 'initialize') {
      this.#session.disconnect();
      return;
    }
    operation.claim.complete();
  }

  #timeoutInbound(operation: InboundOperation): void {
    if (!this.#releaseInbound(operation)) {
      return;
    }
    operation.controller.abort(new Error('MCP Apps inbound request timed out'));
    this.#session.assertGeneration(operation.generation);
    this.#postResponse(
      operation.generation,
      Object.freeze({
        error: Object.freeze({ code: -32_000, message: 'MCP Apps request timed out' }),
        id: operation.id,
        jsonrpc: '2.0' as const,
      }),
      operation.method
    );
    if (operation.claim.kind === 'initialize') {
      this.#session.disconnect();
      return;
    }
    operation.claim.complete();
  }

  #postResponse(generation: number, value: unknown, method: McpAppRequestMethod): void {
    this.#session.post(generation, parseMcpAppResponse(value, method));
  }

  #releaseInbound(operation: InboundOperation): boolean {
    if (this.#inbound.get(operation.key) !== operation) {
      return false;
    }
    this.#inbound.delete(operation.key);
    this.#inboundIds.cancel(operation.id);
    clearTimeout(operation.timer);
    return true;
  }

  #acceptNotification(message: McpAppMessage, claim: McpAppFrameSessionClaim): void {
    if (this.#notifications.size >= MAX_PENDING_NOTIFICATIONS) {
      throw new TypeError(
        `MCP Apps bridge exceeds ${MAX_PENDING_NOTIFICATIONS} pending notifications`
      );
    }
    const controller = new AbortController();
    const operation: NotificationOperation = {
      claim,
      controller,
      generation: claim.generation,
      timer: setTimeout(
        () => this.#failNotification(operation, new Error('MCP Apps notification timed out')),
        this.#timeoutMs
      ),
    };
    this.#notifications.add(operation);
    const callback = Promise.resolve().then(() => {
      if (controller.signal.aborted) {
        throw abortReason(controller.signal);
      }
      return this.#onNotification(message, {
        generation: claim.generation,
        signal: controller.signal,
      });
    });
    settleWithAbort(callback, controller.signal)
      .then(
        () => {
          if (!this.#releaseNotification(operation)) {
            return;
          }
          this.#session.assertGeneration(operation.generation);
          operation.claim.complete();
        },
        (error: unknown) => this.#failNotification(operation, error)
      )
      .catch((error: unknown) =>
        this.#failIfConnected(toError(error, 'MCP Apps notification settlement failed'))
      );
  }

  #releaseNotification(operation: NotificationOperation): boolean {
    if (!this.#notifications.delete(operation)) {
      return false;
    }
    clearTimeout(operation.timer);
    return true;
  }

  #failNotification(operation: NotificationOperation, value: unknown): void {
    if (!this.#releaseNotification(operation)) {
      return;
    }
    operation.controller.abort(value);
    operation.claim.fail(toError(value, 'MCP Apps notification failed'));
  }

  #receiveResponse(value: unknown, generation: number): void {
    this.#session.assertGeneration(generation);
    // settle() validates the reply against the pending request's canonical
    // result schema, rejects an id-less error response (it cannot be
    // correlated), and releases the pending id, or throws.
    const response = this.#outboundIds.settle(value);
    if (response.id === null) {
      throw new TypeError('MCP Apps error response without a request id cannot be correlated');
    }
    const key = correlationKey(response.id);
    const operation = this.#outbound.get(key);
    if (operation === undefined) {
      throw new TypeError(`MCP Apps response id ${JSON.stringify(response.id)} is not pending`);
    }
    this.#outbound.delete(key);
    clearTimeout(operation.timer);
    if (operation.signal !== undefined && operation.abortListener !== undefined) {
      operation.signal.removeEventListener('abort', operation.abortListener);
    }
    if ('error' in response) {
      operation.reject(new McpAppFrameRemoteError(response.error));
      return;
    }
    operation.resolve(response.result);
  }

  #failIfConnected(error: Error): void {
    const phase = this.#session.snapshot.phase;
    if (phase === 'closed' || phase === 'disconnected') {
      return;
    }
    this.#session.fail(error);
  }

  #teardownOperations(reason: Error): void {
    for (const operation of this.#inbound.values()) {
      clearTimeout(operation.timer);
      operation.controller.abort(reason);
    }
    this.#inbound.clear();
    for (const operation of this.#notifications) {
      clearTimeout(operation.timer);
      operation.controller.abort(reason);
    }
    this.#notifications.clear();
    for (const operation of this.#outbound.values()) {
      clearTimeout(operation.timer);
      if (operation.signal !== undefined && operation.abortListener !== undefined) {
        operation.signal.removeEventListener('abort', operation.abortListener);
      }
      operation.reject(reason);
    }
    this.#outbound.clear();
    this.#inboundIds.reset();
    this.#outboundIds.reset();
  }
}
