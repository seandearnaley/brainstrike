import type { LogRecord } from '@brainstrike/utils';

export type BackgroundRuntimeState = 'error' | 'running' | 'starting' | 'stopped' | 'stopping';

export interface BackgroundRuntimeStatus<TRuntimeKind extends string = string> {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly runtimeKind: TRuntimeKind;
  readonly state: BackgroundRuntimeState;
}

export interface BackgroundRuntimeProgress {
  readonly current: number;
  readonly message?: string;
  readonly requestId: string;
  readonly stage: string;
  readonly total: number;
}

export interface SerializedRuntimeError {
  readonly cause?: string;
  readonly code?: string;
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

export interface RuntimeEnvelope<
  TType extends 'cancel' | 'error' | 'progress' | 'request' | 'result' | 'status',
  TChannel extends string = string,
  TPayload = unknown,
> {
  readonly channel: TChannel;
  readonly payload: TPayload;
  readonly requestId: string;
  readonly runtimeId: string;
  readonly type: TType;
}

export type RuntimeRequestEnvelope<
  TChannel extends string = string,
  TPayload = unknown,
> = RuntimeEnvelope<'request', TChannel, TPayload>;

export type RuntimeResultEnvelope<
  TChannel extends string = string,
  TPayload = unknown,
> = RuntimeEnvelope<'result', TChannel, TPayload>;

export type RuntimeProgressEnvelope<
  TChannel extends string = string,
  TPayload = unknown,
> = RuntimeEnvelope<'progress', TChannel, TPayload>;

export type RuntimeStatusEnvelope<
  TRuntimeKind extends string = string,
  TChannel extends string = string,
> = RuntimeEnvelope<'status', TChannel, BackgroundRuntimeStatus<TRuntimeKind>>;

export type RuntimeErrorEnvelope<TChannel extends string = string> = RuntimeEnvelope<
  'error',
  TChannel,
  SerializedRuntimeError
>;

export type RuntimeCancelEnvelope<
  TChannel extends string = string,
  TPayload = unknown,
> = RuntimeEnvelope<'cancel', TChannel, TPayload>;

export interface RuntimeLogBindings {
  readonly channel?: string;
  readonly requestId?: string;
  readonly runtimeId: string;
  readonly runtimeKind: string;
  readonly windowRole?: string;
}

export interface RuntimeStatusStore<TStatus extends BackgroundRuntimeStatus<string>> {
  getStatus: () => TStatus;
  setStatus: (status: TStatus) => TStatus;
  subscribe: (listener: (status: TStatus) => void) => () => void;
}

export interface RuntimeFailureLatch {
  clear: () => void;
  getFailure: () => Error | null;
  isFailed: () => boolean;
  markFailed: (error: unknown) => Error;
  throwIfFailed: () => void;
}

export interface RequestTracker<TValue> {
  clear: () => void;
  delete: (requestId: string) => boolean;
  drain: () => Array<readonly [string, TValue]>;
  entries: () => Array<readonly [string, TValue]>;
  get: (requestId: string) => TValue | undefined;
  has: (requestId: string) => boolean;
  register: (requestId: string, value: TValue) => void;
  size: () => number;
  take: (requestId: string) => TValue | undefined;
}

export interface RuntimeMessageTransport {
  onMessage: (listener: (message: unknown) => void) => () => void;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
}

export function createRuntimeId(runtimeKind: string): string {
  if (
    typeof globalThis.crypto === 'undefined' ||
    typeof globalThis.crypto.randomUUID !== 'function'
  ) {
    throw new Error('Background runtime IDs require crypto.randomUUID().');
  }
  return `${runtimeKind}:${globalThis.crypto.randomUUID()}`;
}

export function createRequestId(prefix: string): string {
  if (
    typeof globalThis.crypto === 'undefined' ||
    typeof globalThis.crypto.randomUUID !== 'function'
  ) {
    throw new Error('Background runtime request IDs require crypto.randomUUID().');
  }
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

export function createBackgroundRuntimeStatus<TRuntimeKind extends string>(
  runtimeKind: TRuntimeKind,
  runtimeId: string,
  state: BackgroundRuntimeState,
  options?: {
    active?: boolean;
    lastError?: string | null;
  }
): BackgroundRuntimeStatus<TRuntimeKind> {
  return {
    runtimeKind,
    runtimeId,
    state,
    active: options?.active ?? false,
    lastError: options?.lastError ?? null,
  };
}

export function createRuntimeStatusStore<TStatus extends BackgroundRuntimeStatus<string>>(
  initialStatus: TStatus
): RuntimeStatusStore<TStatus> {
  let currentStatus = cloneRuntimeStatus(initialStatus);
  const listeners = new Set<(status: TStatus) => void>();

  return {
    getStatus: () => cloneRuntimeStatus(currentStatus),
    setStatus: (status: TStatus) => {
      currentStatus = cloneRuntimeStatus(status);
      const snapshot = cloneRuntimeStatus(currentStatus);
      for (const listener of listeners) {
        listener(snapshot);
      }
      return snapshot;
    },
    subscribe: (listener: (status: TStatus) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createTerminalRuntimeFailureLatch(): RuntimeFailureLatch {
  let failure: Error | null = null;

  return {
    clear: () => {
      failure = null;
    },
    getFailure: () => failure,
    isFailed: () => failure !== null,
    markFailed: (error: unknown) => {
      if (failure) {
        return failure;
      }
      failure = toRuntimeError(error);
      return failure;
    },
    throwIfFailed: () => {
      if (failure) {
        throw failure;
      }
    },
  };
}

export function createRequestTracker<TValue>(): RequestTracker<TValue> {
  const pending = new Map<string, TValue>();

  return {
    clear: () => {
      pending.clear();
    },
    delete: (requestId: string) => pending.delete(requestId),
    drain: () => {
      const entries = Array.from(pending.entries());
      pending.clear();
      return entries;
    },
    entries: () => Array.from(pending.entries()),
    get: (requestId: string) => pending.get(requestId),
    has: (requestId: string) => pending.has(requestId),
    register: (requestId: string, value: TValue) => {
      if (pending.has(requestId)) {
        throw new Error(`Duplicate runtime request ID "${requestId}".`);
      }
      pending.set(requestId, value);
    },
    size: () => pending.size,
    take: (requestId: string) => {
      const value = pending.get(requestId);
      pending.delete(requestId);
      return value;
    },
  };
}

export function serializeRuntimeError(error: unknown): SerializedRuntimeError {
  const normalized = toRuntimeError(error);
  const errorWithCode = normalized as Error & { code?: unknown; cause?: unknown };

  return {
    name: normalized.name,
    message: normalized.message,
    ...(typeof normalized.stack === 'string' ? { stack: normalized.stack } : {}),
    ...(typeof errorWithCode.code === 'string' ? { code: errorWithCode.code } : {}),
    ...(typeof errorWithCode.cause === 'string' ? { cause: errorWithCode.cause } : {}),
  };
}

export function deserializeRuntimeError(error: SerializedRuntimeError | unknown): Error {
  if (isSerializedRuntimeError(error)) {
    const restored = new Error(error.message);
    restored.name = error.name;
    if (error.stack) {
      restored.stack = error.stack;
    }
    if (error.code) {
      (restored as Error & { code?: string }).code = error.code;
    }
    if (error.cause) {
      (restored as Error & { cause?: string }).cause = error.cause;
    }
    return restored;
  }
  return toRuntimeError(error);
}

export function createRuntimeLogBindings(bindings: RuntimeLogBindings): Record<string, unknown> {
  return {
    runtimeKind: bindings.runtimeKind,
    runtimeId: bindings.runtimeId,
    ...(bindings.windowRole ? { windowRole: bindings.windowRole } : {}),
    ...(bindings.channel ? { channel: bindings.channel } : {}),
    ...(bindings.requestId ? { requestId: bindings.requestId } : {}),
  };
}

export function bindRuntimeLogRecord(record: LogRecord, bindings: RuntimeLogBindings): LogRecord {
  return {
    ...record,
    bindings: {
      ...record.bindings,
      ...createRuntimeLogBindings(bindings),
    },
  };
}

export function createWorkerTransport(worker: Worker): RuntimeMessageTransport {
  return {
    onMessage: (listener: (message: unknown) => void) => {
      const handleMessage = (event: MessageEvent<unknown>) => {
        listener(event.data);
      };
      worker.addEventListener('message', handleMessage);
      return () => {
        worker.removeEventListener('message', handleMessage);
      };
    },
    postMessage: (message: unknown, transfer?: Transferable[]) => {
      if (transfer) {
        worker.postMessage(message, transfer);
        return;
      }
      worker.postMessage(message);
    },
  };
}

export function createSubscriptionTransport(options: {
  readonly postMessage: (message: unknown) => void;
  readonly subscribe: (listener: (message: unknown) => void) => () => void;
}): RuntimeMessageTransport {
  return {
    onMessage: options.subscribe,
    postMessage: (message: unknown) => {
      options.postMessage(message);
    },
  };
}

function cloneRuntimeStatus<TStatus extends BackgroundRuntimeStatus<string>>(
  status: TStatus
): TStatus {
  return {
    ...status,
  };
}

function isSerializedRuntimeError(value: unknown): value is SerializedRuntimeError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate['name'] === 'string' && typeof candidate['message'] === 'string';
}

function toRuntimeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (isSerializedRuntimeError(error)) {
    return deserializeRuntimeError(error);
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  return new Error(String(error));
}
