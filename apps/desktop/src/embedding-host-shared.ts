import type {
  BackgroundRuntimeProgress,
  BackgroundRuntimeStatus,
  RuntimeErrorEnvelope,
  RuntimeRequestEnvelope,
  RuntimeResultEnvelope,
} from '@brainstrike/worker-runtime';
import {
  assertRuntimeObjectPayloadEnvelope,
  createBackgroundRuntimeDescriptor,
  createRequestId,
  serializeRuntimeError,
} from '@brainstrike/worker-runtime';

export const EMBEDDING_HOST_RUNTIME = createBackgroundRuntimeDescriptor('embedding-host');
export const EMBEDDING_HOST_LIFECYCLE_CHANNELS = EMBEDDING_HOST_RUNTIME.lifecycleChannels;
const EMBEDDING_HOST_CHANNELS = EMBEDDING_HOST_RUNTIME.createScopedChannels({
  backfillProgress: 'backfill-progress',
  cancelAllBackfills: 'cancel-all-backfills',
  cancelBackfill: 'cancel-backfill',
  command: 'command',
  enqueueBackfill: 'enqueue-backfill',
  getBackfillsInFlight: 'get-backfills-in-flight',
  queryEmbedding: 'query-embedding',
  queryEmbeddingRequest: 'query-embedding-request',
  reportQueryEmbeddingResponse: 'report-query-embedding-response',
});
export const EMBEDDING_HOST_STATUS_EVENT = EMBEDDING_HOST_LIFECYCLE_CHANNELS.statusEvent;
export const EMBEDDING_HOST_COMMAND_EVENT = EMBEDDING_HOST_CHANNELS.command;
export const EMBEDDING_HOST_REPORT_STATUS_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.reportStatus;
export const EMBEDDING_HOST_ENSURE_STARTED_CHANNEL =
  EMBEDDING_HOST_LIFECYCLE_CHANNELS.ensureStarted;
export const EMBEDDING_HOST_STOP_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.stop;
export const EMBEDDING_HOST_RESET_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.reset;
export const EMBEDDING_HOST_GET_STATUS_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.getStatus;
export const EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL = EMBEDDING_HOST_CHANNELS.enqueueBackfill;
export const EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT = EMBEDDING_HOST_CHANNELS.backfillProgress;
export const EMBEDDING_HOST_QUERY_EMBEDDING_REQUEST_EVENT =
  EMBEDDING_HOST_CHANNELS.queryEmbeddingRequest;
export const EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL =
  EMBEDDING_HOST_CHANNELS.reportQueryEmbeddingResponse;
export const EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL =
  EMBEDDING_HOST_CHANNELS.getBackfillsInFlight;
export const EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL =
  EMBEDDING_HOST_CHANNELS.cancelAllBackfills;
export const EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL = EMBEDDING_HOST_CHANNELS.cancelBackfill;
export const EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL = EMBEDDING_HOST_CHANNELS.queryEmbedding;
export const EMBEDDING_BACKFILL_CANCELED_MESSAGE = 'Embedding backfill was canceled.' as const;

export type EmbeddingBackfillSource = 'background-indexing' | 'manual';

export interface EmbeddingHostBackfillRequest {
  readonly embeddingSetId: string;
  readonly source?: EmbeddingBackfillSource;
}

export type EmbeddingHostCommandAction = 'reset' | 'stop';

export type EmbeddingHostCommandPayload =
  | {
      readonly action: 'reset';
      readonly nextRuntimeId: string;
    }
  | {
      readonly action: 'stop';
    };

export interface EmbeddingHostBackfillProgress extends BackgroundRuntimeProgress {
  readonly embeddingSetId: string;
  readonly source: EmbeddingBackfillSource;
}

export interface EmbeddingHostBackfillInfo {
  readonly embeddingSetId: string;
  readonly progress: { current: number; total: number } | null;
  readonly requestId: string;
  readonly source: EmbeddingBackfillSource;
}

export interface EmbeddingHostQueryEmbeddingPayload {
  readonly dimensions: number;
  readonly modelId: string;
  readonly modelKey: string;
  readonly query: string;
}

export const EMBEDDING_HOST_STATUS_ADAPTER = EMBEDDING_HOST_RUNTIME.statusAdapter;
export interface EmbeddingHostWorkerRuntimeMetadata {
  readonly device: 'webgpu' | 'wasm';
  readonly dtype: string;
  readonly fallbackApplied: boolean;
}
export interface EmbeddingHostRuntimeMetadata {
  readonly actualWorkerMetadata: EmbeddingHostWorkerRuntimeMetadata | null;
  readonly backendMismatch: boolean;
  readonly selectedDevicePreference: 'webgpu' | 'wasm';
}
export type EmbeddingHostStatus = BackgroundRuntimeStatus<'embedding-host'> & {
  readonly embeddingRuntime?: EmbeddingHostRuntimeMetadata;
};
export type EmbeddingHostStatusReport = EmbeddingHostStatus;
export type EmbeddingHostCommand = RuntimeRequestEnvelope<'control', EmbeddingHostCommandPayload>;
export type EmbeddingHostQueryEmbeddingRequest = RuntimeRequestEnvelope<
  'query-embedding',
  EmbeddingHostQueryEmbeddingPayload
>;
export type EmbeddingHostQueryEmbeddingResultReport = RuntimeResultEnvelope<
  'query-embedding-result',
  { readonly embedding: number[] }
>;
export type EmbeddingHostQueryEmbeddingErrorReport = RuntimeErrorEnvelope<'query-embedding-error'>;
export type EmbeddingHostQueryEmbeddingResponseReport =
  | EmbeddingHostQueryEmbeddingErrorReport
  | EmbeddingHostQueryEmbeddingResultReport;

export const EMBEDDING_HOST_STOPPED_RUNTIME_ID = EMBEDDING_HOST_RUNTIME.stoppedRuntimeId;

export function createEmbeddingHostCommand(action: 'stop', runtimeId: string): EmbeddingHostCommand;
export function createEmbeddingHostCommand(
  action: 'reset',
  runtimeId: string,
  nextRuntimeId: string
): EmbeddingHostCommand;
export function createEmbeddingHostCommand(
  action: EmbeddingHostCommandAction,
  runtimeId: string,
  nextRuntimeId?: string
): EmbeddingHostCommand {
  const normalizedRuntimeId = runtimeId.trim();
  if (normalizedRuntimeId.length === 0) {
    throw new Error('Embedding host command runtimeId must be a non-empty string.');
  }
  if (action === 'reset') {
    if (!(typeof nextRuntimeId === 'string' && nextRuntimeId.trim().length > 0)) {
      throw new Error('Embedding host reset commands require a non-empty nextRuntimeId.');
    }
    const normalizedNextRuntimeId = nextRuntimeId.trim();
    return {
      channel: 'control',
      payload: { action, nextRuntimeId: normalizedNextRuntimeId },
      requestId: createRequestId('embedding-host-command'),
      runtimeId: normalizedRuntimeId,
      type: 'request',
    };
  }
  if (nextRuntimeId !== undefined) {
    throw new Error('Embedding host stop commands must not include nextRuntimeId.');
  }
  return {
    channel: 'control',
    payload: { action },
    requestId: createRequestId('embedding-host-command'),
    runtimeId: normalizedRuntimeId,
    type: 'request',
  };
}

export function assertEmbeddingHostCommand(value: unknown): EmbeddingHostCommand {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Embedding host command'
  );
  if (envelopeBase.type !== 'request') {
    throw new Error('Embedding host command must have type="request".');
  }
  if (envelopeBase.channel !== 'control') {
    throw new Error('Embedding host command must have channel="control".');
  }
  const action = payload['action'];
  if (action !== 'reset' && action !== 'stop') {
    throw new Error('Embedding host command payload.action must be "reset" or "stop".');
  }
  if (action === 'reset') {
    const nextRuntimeId = payload['nextRuntimeId'];
    if (!(typeof nextRuntimeId === 'string' && nextRuntimeId.trim().length > 0)) {
      throw new Error('Embedding host reset commands require a non-empty payload.nextRuntimeId.');
    }
    return {
      channel: 'control',
      payload: { action, nextRuntimeId: nextRuntimeId.trim() },
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      type: 'request',
    };
  }
  if ('nextRuntimeId' in payload) {
    throw new Error('Embedding host stop commands must not include payload.nextRuntimeId.');
  }
  return {
    channel: 'control',
    payload: { action },
    requestId: envelopeBase.requestId,
    runtimeId: envelopeBase.runtimeId,
    type: 'request',
  };
}

function assertEmbeddingWorkerRuntimeMetadata(value: unknown): EmbeddingHostWorkerRuntimeMetadata {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error(
      'Embedding host status embeddingRuntime.actualWorkerMetadata must be an object.'
    );
  }
  const candidate = value as Record<string, unknown>;
  const device = candidate['device'];
  if (device !== 'webgpu' && device !== 'wasm') {
    throw new Error(
      'Embedding host status embeddingRuntime.actualWorkerMetadata.device must be "webgpu" or "wasm".'
    );
  }
  const dtype = assertNonEmptyString(
    candidate['dtype'],
    'Embedding host status embeddingRuntime.actualWorkerMetadata.dtype must be a non-empty string.'
  );
  const fallbackApplied = candidate['fallbackApplied'];
  if (typeof fallbackApplied !== 'boolean') {
    throw new Error(
      'Embedding host status embeddingRuntime.actualWorkerMetadata.fallbackApplied must be a boolean.'
    );
  }
  return { device, dtype, fallbackApplied };
}

function assertEmbeddingHostRuntimeMetadata(value: unknown): EmbeddingHostRuntimeMetadata {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding host status embeddingRuntime must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  const selectedDevicePreference = candidate['selectedDevicePreference'];
  if (selectedDevicePreference !== 'webgpu' && selectedDevicePreference !== 'wasm') {
    throw new Error(
      'Embedding host status embeddingRuntime.selectedDevicePreference must be "webgpu" or "wasm".'
    );
  }
  const backendMismatch = candidate['backendMismatch'];
  if (typeof backendMismatch !== 'boolean') {
    throw new Error('Embedding host status embeddingRuntime.backendMismatch must be a boolean.');
  }
  const actualWorkerMetadata = candidate['actualWorkerMetadata'];
  return {
    actualWorkerMetadata:
      actualWorkerMetadata === null
        ? null
        : assertEmbeddingWorkerRuntimeMetadata(actualWorkerMetadata),
    backendMismatch,
    selectedDevicePreference,
  };
}

export function assertEmbeddingHostStatus(value: unknown): EmbeddingHostStatusReport {
  const baseStatus = EMBEDDING_HOST_STATUS_ADAPTER.assertStatus(value);
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return baseStatus;
  }
  const embeddingRuntime = (value as Record<string, unknown>)['embeddingRuntime'];
  return {
    ...baseStatus,
    ...(embeddingRuntime === undefined
      ? {}
      : { embeddingRuntime: assertEmbeddingHostRuntimeMetadata(embeddingRuntime) }),
  };
}

function assertNonEmptyString(value: unknown, message: string): string {
  if (!(typeof value === 'string' && value.trim().length > 0)) {
    throw new Error(message);
  }
  return value.trim();
}

function assertPositiveInteger(value: unknown, message: string): number {
  if (!(typeof value === 'number' && Number.isInteger(value) && value > 0)) {
    throw new Error(message);
  }
  return value;
}

function assertEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error('Embedding host query embedding result must include an embedding array.');
  }
  return value.map((entry, index) => {
    if (!(typeof entry === 'number' && Number.isFinite(entry))) {
      throw new Error(`Embedding host query embedding result embedding[${index}] must be finite.`);
    }
    return entry;
  });
}

export function createEmbeddingHostQueryEmbeddingRequest(
  runtimeId: string,
  payload: EmbeddingHostQueryEmbeddingPayload
): EmbeddingHostQueryEmbeddingRequest {
  const normalizedRuntimeId = runtimeId.trim();
  if (normalizedRuntimeId.length === 0) {
    throw new Error('Embedding host query embedding runtimeId must be a non-empty string.');
  }
  return {
    channel: 'query-embedding',
    payload,
    requestId: createRequestId('embedding-host-query'),
    runtimeId: normalizedRuntimeId,
    type: 'request',
  };
}

export function assertEmbeddingHostQueryEmbeddingPayload(
  value: unknown
): EmbeddingHostQueryEmbeddingPayload {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding host query embedding payload must be an object.');
  }
  const payload = value as Record<string, unknown>;
  return {
    dimensions: assertPositiveInteger(
      payload['dimensions'],
      'Embedding host query embedding payload.dimensions must be a positive integer.'
    ),
    modelId: assertNonEmptyString(
      payload['modelId'],
      'Embedding host query embedding payload.modelId must be a non-empty string.'
    ),
    modelKey: assertNonEmptyString(
      payload['modelKey'],
      'Embedding host query embedding payload.modelKey must be a non-empty string.'
    ),
    query: assertNonEmptyString(
      payload['query'],
      'Embedding host query embedding payload.query must be a non-empty string.'
    ),
  };
}

export function assertEmbeddingHostQueryEmbeddingRequest(
  value: unknown
): EmbeddingHostQueryEmbeddingRequest {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Embedding host query embedding request'
  );
  if (envelopeBase.type !== 'request') {
    throw new Error('Embedding host query embedding request must have type="request".');
  }
  if (envelopeBase.channel !== 'query-embedding') {
    throw new Error('Embedding host query embedding request must have channel="query-embedding".');
  }
  return {
    channel: 'query-embedding',
    payload: assertEmbeddingHostQueryEmbeddingPayload(payload),
    requestId: envelopeBase.requestId,
    runtimeId: envelopeBase.runtimeId,
    type: 'request',
  };
}

export function createEmbeddingHostQueryEmbeddingResultReport(
  request: EmbeddingHostQueryEmbeddingRequest,
  embedding: number[]
): EmbeddingHostQueryEmbeddingResultReport {
  return {
    channel: 'query-embedding-result',
    payload: { embedding },
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'result',
  };
}

export function createEmbeddingHostQueryEmbeddingErrorReport(
  request: EmbeddingHostQueryEmbeddingRequest,
  error: unknown
): EmbeddingHostQueryEmbeddingErrorReport {
  return {
    channel: 'query-embedding-error',
    payload: serializeRuntimeError(error),
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'error',
  };
}

export function assertEmbeddingHostQueryEmbeddingResponseReport(
  value: unknown
): EmbeddingHostQueryEmbeddingResponseReport {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Embedding host query embedding response'
  );
  if (envelopeBase.type === 'result') {
    if (envelopeBase.channel !== 'query-embedding-result') {
      throw new Error(
        'Embedding host query embedding result must have channel="query-embedding-result".'
      );
    }
    return {
      channel: 'query-embedding-result',
      payload: {
        embedding: assertEmbeddingVector(payload['embedding']),
      },
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      type: 'result',
    };
  }
  if (envelopeBase.type === 'error') {
    if (envelopeBase.channel !== 'query-embedding-error') {
      throw new Error(
        'Embedding host query embedding error must have channel="query-embedding-error".'
      );
    }
    return {
      channel: 'query-embedding-error',
      payload: {
        message: assertNonEmptyString(
          payload['message'],
          'Embedding host query embedding error payload.message must be a non-empty string.'
        ),
        name:
          typeof payload['name'] === 'string' && payload['name'].trim().length > 0
            ? payload['name']
            : 'Error',
        ...(typeof payload['stack'] === 'string' ? { stack: payload['stack'] } : {}),
        ...(typeof payload['code'] === 'string' ? { code: payload['code'] } : {}),
        ...(typeof payload['cause'] === 'string' ? { cause: payload['cause'] } : {}),
      },
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      type: 'error',
    };
  }
  throw new Error('Embedding host query embedding response must have type="result" or "error".');
}

export function createStoppedEmbeddingHostStatus(
  runtimeId: string = EMBEDDING_HOST_STOPPED_RUNTIME_ID
): EmbeddingHostStatus {
  return EMBEDDING_HOST_RUNTIME.createStoppedStatus(runtimeId);
}
