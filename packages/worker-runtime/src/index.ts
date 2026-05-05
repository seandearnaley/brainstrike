import { generateUUID, type LogRecord } from '@brainstrike/utils';

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

export interface BackgroundRuntimeStatusShapeInput {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly state: BackgroundRuntimeState;
}

export interface BackgroundRuntimeStatusAdapter<TRuntimeKind extends string> {
  assertStatus: (value: unknown) => BackgroundRuntimeStatus<TRuntimeKind>;
  createStatus: (
    status: BackgroundRuntimeStatusShapeInput
  ) => BackgroundRuntimeStatus<TRuntimeKind>;
  createStoppedStatus: (runtimeId?: string) => BackgroundRuntimeStatus<TRuntimeKind>;
  readonly runtimeKind: TRuntimeKind;
}

export type BackgroundRuntimeScopedChannel<
  TRuntimeKind extends string,
  TSuffix extends string,
> = `${TRuntimeKind}:${TSuffix}`;

export type BackgroundRuntimeScopedChannels<
  TRuntimeKind extends string,
  TChannels extends Record<string, string>,
> = {
  readonly [TKey in keyof TChannels]: BackgroundRuntimeScopedChannel<
    TRuntimeKind,
    TChannels[TKey] & string
  >;
};

export interface BackgroundRuntimeLifecycleChannels<TRuntimeKind extends string> {
  readonly ensureStarted: BackgroundRuntimeScopedChannel<TRuntimeKind, 'ensure-started'>;
  readonly getStatus: BackgroundRuntimeScopedChannel<TRuntimeKind, 'get-status'>;
  readonly reportStatus: BackgroundRuntimeScopedChannel<TRuntimeKind, 'report-status'>;
  readonly reset: BackgroundRuntimeScopedChannel<TRuntimeKind, 'reset'>;
  readonly statusEvent: BackgroundRuntimeScopedChannel<TRuntimeKind, 'status'>;
  readonly stop: BackgroundRuntimeScopedChannel<TRuntimeKind, 'stop'>;
}

export interface BackgroundRuntimeDescriptor<TRuntimeKind extends string> {
  createScopedChannel: <TSuffix extends string>(
    suffix: TSuffix
  ) => BackgroundRuntimeScopedChannel<TRuntimeKind, TSuffix>;
  createScopedChannels: <TChannels extends Record<string, string>>(
    channels: TChannels
  ) => BackgroundRuntimeScopedChannels<TRuntimeKind, TChannels>;
  createStoppedStatus: (runtimeId?: string) => BackgroundRuntimeStatus<TRuntimeKind>;
  readonly lifecycleChannels: BackgroundRuntimeLifecycleChannels<TRuntimeKind>;
  readonly runtimeKind: TRuntimeKind;
  readonly statusAdapter: BackgroundRuntimeStatusAdapter<TRuntimeKind>;
  readonly stoppedRuntimeId: `${TRuntimeKind}:stopped`;
}

export interface SerializedRuntimeError {
  readonly cause?: string;
  readonly code?: string;
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

export type RuntimeEnvelopeType = 'cancel' | 'error' | 'progress' | 'request' | 'result' | 'status';

export interface RuntimeEnvelopeObjectPayloadBase<
  TType extends RuntimeEnvelopeType = RuntimeEnvelopeType,
> {
  readonly channel: string;
  readonly requestId: string;
  readonly runtimeId: string;
  readonly type: TType;
}

export interface RuntimeRequestPayloadBase<TKind extends string = string> {
  readonly kind: TKind;
  readonly requestId: string;
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

const RUNTIME_ENVELOPE_TYPES = new Set<RuntimeEnvelopeType>([
  'cancel',
  'error',
  'progress',
  'request',
  'result',
  'status',
]);

function isRuntimeEnvelopeType(value: unknown): value is RuntimeEnvelopeType {
  return typeof value === 'string' && RUNTIME_ENVELOPE_TYPES.has(value as RuntimeEnvelopeType);
}

export interface RuntimeStatusStore<TStatus extends BackgroundRuntimeStatus<string>> {
  getStatus: () => TStatus;
  setStatus: (status: TStatus) => TStatus;
  subscribe: (listener: (status: TStatus) => void) => () => void;
}

function areRuntimeStatusesEqual<TStatus extends BackgroundRuntimeStatus<string>>(
  left: TStatus,
  right: TStatus
): boolean {
  // BackgroundRuntimeStatus intentionally treats these five fields as the canonical runtime
  // contract. If a runtime status adds another UI-significant field, update this comparison at
  // the same time so the shared status store does not suppress meaningful transitions.
  return (
    left.runtimeKind === right.runtimeKind &&
    left.runtimeId === right.runtimeId &&
    left.state === right.state &&
    left.active === right.active &&
    left.lastError === right.lastError
  );
}

const canonicalRuntimeStatusKeys = new Set<keyof BackgroundRuntimeStatus<string>>([
  'active',
  'lastError',
  'runtimeId',
  'runtimeKind',
  'state',
]);

function assertCanonicalRuntimeStatusShape<TStatus extends BackgroundRuntimeStatus<string>>(
  status: TStatus,
  context: string
): TStatus {
  for (const key of Object.keys(status)) {
    if (!canonicalRuntimeStatusKeys.has(key as keyof BackgroundRuntimeStatus<string>)) {
      throw new Error(`${context} must not include non-canonical status field "${key}".`);
    }
  }
  return status;
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

export interface WorkerRuntimeClient {
  clearFailure: () => void;
  dispose: () => void;
  getFailure: () => Error | null;
  isFailed: () => boolean;
  isReady: () => boolean;
  markFailed: (error: unknown) => Error;
  markReady: () => void;
  resetReady: () => void;
  throwIfFailed: () => void;
  transport: RuntimeMessageTransport;
}

export interface WorkerRuntimeClientOptions {
  readonly createErrorFromEvent?: (event: ErrorEvent) => Error;
  readonly onFailure?: (error: Error) => void;
}

export function createRuntimeId(runtimeKind: string): string {
  return `${runtimeKind}:${generateUUID()}`;
}

export function createRequestId(prefix: string): string {
  return `${prefix}:${generateUUID()}`;
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

export function createStoppedBackgroundRuntimeStatus<TRuntimeKind extends string>(
  runtimeKind: TRuntimeKind,
  runtimeId = `${runtimeKind}:stopped`
): BackgroundRuntimeStatus<TRuntimeKind> {
  return createBackgroundRuntimeStatus(runtimeKind, runtimeId, 'stopped');
}

export function createBackgroundRuntimeStatusAdapter<TRuntimeKind extends string>(
  runtimeKind: TRuntimeKind
): BackgroundRuntimeStatusAdapter<TRuntimeKind> {
  return {
    runtimeKind,
    assertStatus: (value: unknown) => assertBackgroundRuntimeStatus(value, runtimeKind),
    createStatus: (status: BackgroundRuntimeStatusShapeInput) =>
      createBackgroundRuntimeStatus(runtimeKind, status.runtimeId, status.state, {
        active: status.active,
        lastError: status.lastError,
      }),
    createStoppedStatus: (runtimeId?: string) =>
      createStoppedBackgroundRuntimeStatus(runtimeKind, runtimeId),
  };
}

export function createBackgroundRuntimeScopedChannel<
  TRuntimeKind extends string,
  TSuffix extends string,
>(
  runtimeKind: TRuntimeKind,
  suffix: TSuffix
): BackgroundRuntimeScopedChannel<TRuntimeKind, TSuffix> {
  return `${runtimeKind}:${suffix}`;
}

export function createBackgroundRuntimeLifecycleChannels<TRuntimeKind extends string>(
  runtimeKind: TRuntimeKind
): BackgroundRuntimeLifecycleChannels<TRuntimeKind> {
  return {
    statusEvent: createBackgroundRuntimeScopedChannel(runtimeKind, 'status'),
    reportStatus: createBackgroundRuntimeScopedChannel(runtimeKind, 'report-status'),
    ensureStarted: createBackgroundRuntimeScopedChannel(runtimeKind, 'ensure-started'),
    stop: createBackgroundRuntimeScopedChannel(runtimeKind, 'stop'),
    reset: createBackgroundRuntimeScopedChannel(runtimeKind, 'reset'),
    getStatus: createBackgroundRuntimeScopedChannel(runtimeKind, 'get-status'),
  };
}

export function createBackgroundRuntimeDescriptor<TRuntimeKind extends string>(
  runtimeKind: TRuntimeKind
): BackgroundRuntimeDescriptor<TRuntimeKind> {
  const statusAdapter = createBackgroundRuntimeStatusAdapter(runtimeKind);
  const stoppedRuntimeId = `${runtimeKind}:stopped` as const;
  return {
    runtimeKind,
    lifecycleChannels: createBackgroundRuntimeLifecycleChannels(runtimeKind),
    statusAdapter,
    stoppedRuntimeId,
    createScopedChannel: <TSuffix extends string>(suffix: TSuffix) =>
      createBackgroundRuntimeScopedChannel(runtimeKind, suffix),
    createScopedChannels: <TChannels extends Record<string, string>>(channels: TChannels) =>
      createBackgroundRuntimeScopedChannels(runtimeKind, channels),
    createStoppedStatus: (runtimeId?: string) => statusAdapter.createStoppedStatus(runtimeId),
  };
}

export function createBackgroundRuntimeScopedChannels<
  TRuntimeKind extends string,
  TChannels extends Record<string, string>,
>(
  runtimeKind: TRuntimeKind,
  channels: TChannels
): BackgroundRuntimeScopedChannels<TRuntimeKind, TChannels> {
  const scopedChannels = {} as Record<string, string>;
  for (const [key, suffix] of Object.entries(channels)) {
    scopedChannels[key] = createBackgroundRuntimeScopedChannel(runtimeKind, suffix);
  }
  return scopedChannels as BackgroundRuntimeScopedChannels<TRuntimeKind, TChannels>;
}

export function assertRuntimeObjectPayloadEnvelope(
  value: unknown,
  context: string
): {
  readonly candidate: Record<string, unknown>;
  readonly envelopeBase: RuntimeEnvelopeObjectPayloadBase;
  readonly payload: Record<string, unknown>;
} {
  if (!value || typeof value !== 'object') {
    throw new Error(`${context} must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  if (!isRuntimeEnvelopeType(candidate['type'])) {
    throw new Error(`${context} must include a valid runtime envelope type.`);
  }
  if (typeof candidate['requestId'] !== 'string' || candidate['requestId'].trim().length === 0) {
    throw new Error(`${context} must include a non-empty requestId.`);
  }
  if (typeof candidate['runtimeId'] !== 'string' || candidate['runtimeId'].trim().length === 0) {
    throw new Error(`${context} must include a non-empty runtimeId.`);
  }
  if (typeof candidate['channel'] !== 'string' || candidate['channel'].trim().length === 0) {
    throw new Error(`${context} must include a non-empty channel.`);
  }
  const payload = candidate['payload'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${context} must include a payload object.`);
  }
  const type = candidate['type'];
  const channel = candidate['channel'];
  const requestId = candidate['requestId'];
  const runtimeId = candidate['runtimeId'];
  return {
    candidate,
    envelopeBase: {
      type,
      channel,
      requestId,
      runtimeId,
    },
    payload: payload as Record<string, unknown>,
  };
}

export function assertRuntimeRequestPayloadBase<TKind extends string>(
  value: unknown,
  context: string,
  expectedKind: TKind
): {
  readonly candidate: Record<string, unknown>;
  readonly requestBase: RuntimeRequestPayloadBase<TKind>;
} {
  if (!value || typeof value !== 'object') {
    throw new Error(`${context} must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['kind'] !== expectedKind) {
    throw new Error(`${context} must declare kind="${expectedKind}".`);
  }
  if (typeof candidate['requestId'] !== 'string' || candidate['requestId'].trim().length === 0) {
    throw new Error(`${context} must include a non-empty requestId.`);
  }
  return {
    candidate,
    requestBase: {
      kind: expectedKind,
      requestId: candidate['requestId'],
    },
  };
}

export function createRuntimeStatusStore<TStatus extends BackgroundRuntimeStatus<string>>(
  initialStatus: TStatus
): RuntimeStatusStore<TStatus> {
  let currentStatus = cloneRuntimeStatus(
    assertCanonicalRuntimeStatusShape(initialStatus, 'Runtime status')
  );
  const listeners = new Set<(status: TStatus) => void>();

  return {
    getStatus: () => cloneRuntimeStatus(currentStatus),
    setStatus: (status: TStatus) => {
      const nextStatus = cloneRuntimeStatus(
        assertCanonicalRuntimeStatusShape(status, 'Runtime status')
      );
      if (areRuntimeStatusesEqual(currentStatus, nextStatus)) {
        return cloneRuntimeStatus(currentStatus);
      }
      currentStatus = nextStatus;
      const snapshot = cloneRuntimeStatus(nextStatus);
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

export function assertBackgroundRuntimeStatus<TRuntimeKind extends string>(
  value: unknown,
  runtimeKind: TRuntimeKind
): BackgroundRuntimeStatus<TRuntimeKind> {
  if (!value || typeof value !== 'object') {
    throw new Error(`${runtimeKind} status report must be an object.`);
  }

  const candidate = value as Record<string, unknown>;
  const state = candidate['state'];
  if (
    state !== 'starting' &&
    state !== 'running' &&
    state !== 'stopping' &&
    state !== 'stopped' &&
    state !== 'error'
  ) {
    throw new Error(`${runtimeKind} status report has invalid state.`);
  }
  if (typeof candidate['active'] !== 'boolean') {
    throw new Error(`${runtimeKind} status report must include active boolean.`);
  }
  if (candidate['lastError'] !== null && typeof candidate['lastError'] !== 'string') {
    throw new Error(`${runtimeKind} status report must include string or null lastError.`);
  }
  if (candidate['runtimeKind'] !== runtimeKind) {
    throw new Error(`${runtimeKind} status report must include runtimeKind="${runtimeKind}".`);
  }
  if (typeof candidate['runtimeId'] !== 'string' || candidate['runtimeId'].trim().length === 0) {
    throw new Error(`${runtimeKind} status report must include a non-empty runtimeId.`);
  }

  return {
    state,
    active: candidate['active'],
    lastError: candidate['lastError'],
    runtimeKind,
    runtimeId: candidate['runtimeId'],
  };
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

export function createWorkerRuntimeClient(
  worker: Worker,
  options: WorkerRuntimeClientOptions = {}
): WorkerRuntimeClient {
  const transport = createWorkerTransport(worker);
  const failureLatch = createTerminalRuntimeFailureLatch();
  let ready = false;

  const handleError = (event: ErrorEvent) => {
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    ready = false;
    const failure = failureLatch.markFailed(
      options.createErrorFromEvent?.(event) ??
        new Error(
          event.message
            ? `Worker runtime error: ${event.message}`
            : 'Worker runtime error (missing ErrorEvent.message)'
        )
    );
    options.onFailure?.(failure);
  };

  worker.addEventListener('error', handleError);

  return {
    clearFailure: () => {
      failureLatch.clear();
    },
    dispose: () => {
      worker.removeEventListener('error', handleError);
    },
    getFailure: () => failureLatch.getFailure(),
    isFailed: () => failureLatch.isFailed(),
    isReady: () => ready && !failureLatch.isFailed(),
    markFailed: (error: unknown) => {
      ready = false;
      const failure = failureLatch.markFailed(error);
      options.onFailure?.(failure);
      return failure;
    },
    markReady: () => {
      ready = true;
    },
    resetReady: () => {
      ready = false;
    },
    throwIfFailed: () => {
      failureLatch.throwIfFailed();
    },
    transport,
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
