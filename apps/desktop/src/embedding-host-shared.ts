import {
  assertEmbeddingTelemetrySnapshot,
  type EmbeddingTelemetrySnapshot,
} from '@brainstrike/embedding-worker';
import type { CatalogEmbeddingWorkerPlan } from '@brainstrike/embeddings/inference-plan';
import type {
  BackgroundRuntimeProgress,
  BackgroundRuntimeStatus,
  RuntimeErrorEnvelope,
  RuntimeRequestEnvelope,
  RuntimeResultEnvelope,
} from '@brainstrike/worker-runtime';
import {
  createBackgroundRuntimeDescriptor,
  createRequestId,
  serializeRuntimeError,
} from '@brainstrike/worker-runtime';
import { assertRuntimeObjectPayloadEnvelope } from '@brainstrike/worker-runtime/validation';
import { decodeNativeEmbeddingWorkerPlan } from './platform/native-embedding-validation';

export const EMBEDDING_HOST_RUNTIME = createBackgroundRuntimeDescriptor('embedding-host');
export const EMBEDDING_HOST_LIFECYCLE_CHANNELS = EMBEDDING_HOST_RUNTIME.lifecycleChannels;
const EMBEDDING_HOST_CHANNELS = EMBEDDING_HOST_RUNTIME.createScopedChannels({
  backfillProgress: 'backfill-progress',
  cancelAllBackfills: 'cancel-all-backfills',
  cancelBackfill: 'cancel-backfill',
  command: 'command',
  documentEmbeddings: 'document-embeddings',
  documentEmbeddingsCancel: 'document-embeddings-cancel',
  documentEmbeddingsRequest: 'document-embeddings-request',
  enqueueBackfill: 'enqueue-backfill',
  getBackfillsInFlight: 'get-backfills-in-flight',
  queryEmbedding: 'query-embedding',
  queryEmbeddingCancel: 'query-embedding-cancel',
  queryEmbeddingRequest: 'query-embedding-request',
  reportDocumentEmbeddingsResponse: 'report-document-embeddings-response',
  reportQueryEmbeddingResponse: 'report-query-embedding-response',
  reportWebgpuAdapterResponse: 'report-webgpu-adapter-response',
  webgpuAdapter: 'webgpu-adapter',
  webgpuAdapterRequest: 'webgpu-adapter-request',
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
export const EMBEDDING_HOST_QUERY_EMBEDDING_CANCEL_EVENT =
  EMBEDDING_HOST_CHANNELS.queryEmbeddingCancel;
export const EMBEDDING_HOST_REPORT_QUERY_EMBEDDING_RESPONSE_CHANNEL =
  EMBEDDING_HOST_CHANNELS.reportQueryEmbeddingResponse;
export const EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL =
  EMBEDDING_HOST_CHANNELS.getBackfillsInFlight;
export const EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL =
  EMBEDDING_HOST_CHANNELS.cancelAllBackfills;
export const EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL = EMBEDDING_HOST_CHANNELS.cancelBackfill;
export const EMBEDDING_HOST_QUERY_EMBEDDING_CHANNEL = EMBEDDING_HOST_CHANNELS.queryEmbedding;
export const EMBEDDING_HOST_WEBGPU_ADAPTER_CHANNEL = EMBEDDING_HOST_CHANNELS.webgpuAdapter;
export const EMBEDDING_HOST_WEBGPU_ADAPTER_REQUEST_EVENT =
  EMBEDDING_HOST_CHANNELS.webgpuAdapterRequest;
export const EMBEDDING_HOST_REPORT_WEBGPU_ADAPTER_RESPONSE_CHANNEL =
  EMBEDDING_HOST_CHANNELS.reportWebgpuAdapterResponse;
export const EMBEDDING_BACKFILL_CANCELED_MESSAGE = 'Embedding backfill was canceled.' as const;

export type EmbeddingBackfillSource = 'background-indexing' | 'manual';

export interface EmbeddingHostBackfillRequest {
  readonly embeddingSetId: string;
  readonly source?: EmbeddingBackfillSource;
}

export type EmbeddingHostCommandAction = 'reset' | 'resolve-device' | 'start-background' | 'stop';

export type EmbeddingHostCommandPayload =
  | {
      readonly action: 'reset';
      readonly nextRuntimeId: string;
    }
  | {
      readonly action: 'stop';
    }
  | {
      readonly action: 'start-background';
    }
  | {
      /** Re-resolve `hostDevice` from the saved preference; the worker keeps its device. */
      readonly action: 'resolve-device';
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
  readonly inferencePlan?: CatalogEmbeddingWorkerPlan;
  readonly modelId: string;
  readonly modelKey: string;
  readonly query: string;
}

/** True only after the manager physically settles the exact owned cancellation. */
export interface EmbeddingHostQueryCancellationResult {
  readonly cancelled: boolean;
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
  /**
   * The device this host resolved at start from the saved vector preference
   * and device detection. An unpinned load runs on it; a pinned query changes
   * `selectedDevicePreference`, never this.
   */
  readonly hostDevice?: 'webgpu' | 'wasm';
  /** A preference change could not resolve a device; recall reports this instead. */
  readonly hostDeviceError?: string;
  readonly selectedDevicePreference: 'webgpu' | 'wasm';
  readonly telemetry: EmbeddingTelemetrySnapshot;
}
export type EmbeddingHostStatus = BackgroundRuntimeStatus<'embedding-host'> & {
  readonly commandId?: string;
  readonly embeddingRuntime?: EmbeddingHostRuntimeMetadata;
};
export type EmbeddingHostStatusReport = EmbeddingHostStatus;
export type EmbeddingHostCommand = RuntimeRequestEnvelope<'control', EmbeddingHostCommandPayload>;
export type EmbeddingHostQueryEmbeddingRequest = RuntimeRequestEnvelope<
  'query-embedding',
  EmbeddingHostQueryEmbeddingPayload
>;
export type EmbeddingHostQueryEmbeddingCancel = RuntimeRequestEnvelope<
  'query-embedding-cancel',
  Record<string, never>
>;
export type EmbeddingHostQueryEmbeddingResultReport = RuntimeResultEnvelope<
  'query-embedding-result',
  { readonly embedding: number[] }
>;
export type EmbeddingHostQueryEmbeddingErrorReport = RuntimeErrorEnvelope<'query-embedding-error'>;
export type EmbeddingHostQueryEmbeddingResponseReport =
  | EmbeddingHostQueryEmbeddingErrorReport
  | EmbeddingHostQueryEmbeddingResultReport;

export function createEmbeddingHostQueryEmbeddingCancel(
  request: EmbeddingHostQueryEmbeddingRequest
): EmbeddingHostQueryEmbeddingCancel {
  return {
    channel: 'query-embedding-cancel',
    payload: {},
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'request',
  };
}

export function assertEmbeddingHostQueryEmbeddingCancel(
  value: unknown
): EmbeddingHostQueryEmbeddingCancel {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Embedding host query cancellation'
  );
  if (
    envelopeBase.type !== 'request' ||
    envelopeBase.channel !== 'query-embedding-cancel' ||
    Object.keys(payload).length !== 0
  ) {
    throw new Error(
      'Embedding host query cancellation must be a query-embedding-cancel request with an empty payload.'
    );
  }
  return {
    channel: 'query-embedding-cancel',
    payload: {},
    requestId: envelopeBase.requestId,
    runtimeId: envelopeBase.runtimeId,
    type: 'request',
  };
}

export const EMBEDDING_HOST_STOPPED_RUNTIME_ID = EMBEDDING_HOST_RUNTIME.stoppedRuntimeId;

export function createEmbeddingHostCommand(
  action: 'resolve-device' | 'start-background' | 'stop',
  runtimeId: string
): EmbeddingHostCommand;
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
    throw new Error(`Embedding host ${action} commands must not include nextRuntimeId.`);
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
  if (
    action !== 'reset' &&
    action !== 'resolve-device' &&
    action !== 'start-background' &&
    action !== 'stop'
  ) {
    throw new Error(
      'Embedding host command payload.action must be "reset", "resolve-device", "start-background" or "stop".'
    );
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
    throw new Error(`Embedding host ${action} commands must not include payload.nextRuntimeId.`);
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
  const hostDevice = candidate['hostDevice'];
  if (hostDevice !== undefined && hostDevice !== 'webgpu' && hostDevice !== 'wasm') {
    throw new Error(
      'Embedding host status embeddingRuntime.hostDevice must be "webgpu" or "wasm".'
    );
  }
  const hostDeviceError = candidate['hostDeviceError'];
  if (hostDeviceError !== undefined && typeof hostDeviceError !== 'string') {
    throw new Error('Embedding host status embeddingRuntime.hostDeviceError must be a string.');
  }
  const actualWorkerMetadata = candidate['actualWorkerMetadata'];
  return {
    actualWorkerMetadata:
      actualWorkerMetadata === null
        ? null
        : assertEmbeddingWorkerRuntimeMetadata(actualWorkerMetadata),
    backendMismatch,
    ...(hostDevice === undefined ? {} : { hostDevice }),
    ...(hostDeviceError === undefined ? {} : { hostDeviceError }),
    selectedDevicePreference,
    telemetry: assertEmbeddingTelemetrySnapshot(candidate['telemetry']),
  };
}

export function assertEmbeddingHostStatus(value: unknown): EmbeddingHostStatusReport {
  const baseStatus = EMBEDDING_HOST_STATUS_ADAPTER.assertStatus(value);
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return baseStatus;
  }
  const commandId = (value as Record<string, unknown>)['commandId'];
  if (commandId !== undefined && (typeof commandId !== 'string' || commandId.trim().length === 0)) {
    throw new Error('Embedding host command acknowledgement must have a non-empty commandId.');
  }
  const embeddingRuntime = (value as Record<string, unknown>)['embeddingRuntime'];
  return {
    ...baseStatus,
    ...(commandId === undefined ? {} : { commandId }),
    ...(embeddingRuntime === undefined
      ? {}
      : { embeddingRuntime: assertEmbeddingHostRuntimeMetadata(embeddingRuntime) }),
  };
}

/** A status report's optional host fields, carried unchanged into main's status. */
export function reportedHostFields(
  status: EmbeddingHostStatus
): Pick<EmbeddingHostStatus, 'commandId' | 'embeddingRuntime'> {
  return {
    ...(status.commandId ? { commandId: status.commandId } : {}),
    ...(status.embeddingRuntime ? { embeddingRuntime: status.embeddingRuntime } : {}),
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

// This shared module is preload reachable: keep the verified-plan decoder plain.
function assertNativeQueryInferencePlan(
  payload: Record<string, unknown>
): CatalogEmbeddingWorkerPlan | undefined {
  if (!Object.hasOwn(payload, 'inferencePlan')) {
    return;
  }
  const ready = decodeNativeEmbeddingWorkerPlan(payload['inferencePlan']);
  if (ready.modelId !== payload['modelId'] || ready.dimensions !== payload['dimensions']) {
    throw new Error('Native query inferencePlan must match model and dimensions.');
  }
  return ready;
}

export function assertEmbeddingHostQueryEmbeddingPayload(
  value: unknown
): EmbeddingHostQueryEmbeddingPayload {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding host query embedding payload must be an object.');
  }
  const payload = value as Record<string, unknown>;
  const inferencePlan = assertNativeQueryInferencePlan(payload);
  return {
    ...(inferencePlan ? { inferencePlan } : {}),
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

export const EMBEDDING_HOST_QUERY_CANCELED_CODE = 'EMBEDDING_HOST_QUERY_CANCELED';

/** Only the exact query cancel listener creates this reason; terminal serialization retains its code. */
export function createEmbeddingHostQueryCancellationError(): Error {
  return Object.assign(new Error('Embedding host query request was canceled.'), {
    code: EMBEDDING_HOST_QUERY_CANCELED_CODE,
    name: 'AbortError',
  });
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
      payload: assertEmbeddingHostErrorPayload(payload),
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

export const EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_CHANNEL =
  EMBEDDING_HOST_CHANNELS.documentEmbeddings;
export const EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_CANCEL_EVENT =
  EMBEDDING_HOST_CHANNELS.documentEmbeddingsCancel;
export const EMBEDDING_HOST_DOCUMENT_EMBEDDINGS_REQUEST_EVENT =
  EMBEDDING_HOST_CHANNELS.documentEmbeddingsRequest;
export const EMBEDDING_HOST_REPORT_DOCUMENT_EMBEDDINGS_RESPONSE_CHANNEL =
  EMBEDDING_HOST_CHANNELS.reportDocumentEmbeddingsResponse;
export const MAX_DOCUMENT_EMBEDDING_BATCH_SIZE = 64;
export interface EmbeddingHostDocumentEmbeddingsPayload {
  readonly dimensions: number;
  readonly inferencePlan: CatalogEmbeddingWorkerPlan;
  readonly modelId: string;
  readonly modelKey: string;
  readonly texts: string[];
}
export type EmbeddingHostDocumentEmbeddingsRequest = RuntimeRequestEnvelope<
  'document-embeddings',
  EmbeddingHostDocumentEmbeddingsPayload
>;
export type EmbeddingHostDocumentEmbeddingsCancel = RuntimeRequestEnvelope<
  'document-embeddings-cancel',
  Record<string, never>
>;
export type EmbeddingHostDocumentEmbeddingsResponseReport =
  | RuntimeResultEnvelope<'document-embeddings-result', { readonly embeddings: number[][] }>
  | RuntimeErrorEnvelope<'document-embeddings-error'>;
export type EmbeddingHostInferenceRequest =
  | EmbeddingHostQueryEmbeddingRequest
  | EmbeddingHostDocumentEmbeddingsRequest;

export function assertEmbeddingHostDocumentEmbeddingsPayload(
  value: unknown
): EmbeddingHostDocumentEmbeddingsPayload {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding host document payload must be an object.');
  }
  const payload = value as Record<string, unknown>;
  const inferencePlan = assertNativeQueryInferencePlan(payload);
  if (!inferencePlan) {
    throw new Error('Document embeddings require a verified inferencePlan.');
  }
  const texts = payload['texts'];
  if (
    !(Array.isArray(texts) && texts.length > 0 && texts.length <= MAX_DOCUMENT_EMBEDDING_BATCH_SIZE)
  ) {
    throw new Error('Document embeddings require between 1 and 64 texts.');
  }
  return {
    dimensions: inferencePlan.dimensions,
    inferencePlan,
    modelId: inferencePlan.modelId,
    modelKey: assertNonEmptyString(payload['modelKey'], 'Document modelKey must be non-empty.'),
    texts: texts.map((text) => {
      if (!(typeof text === 'string' && text.trim().length > 0)) {
        throw new Error('Every document text must be a non-empty string.');
      }
      return text;
    }),
  };
}
export function createEmbeddingHostDocumentEmbeddingsRequest(
  runtimeId: string,
  payload: EmbeddingHostDocumentEmbeddingsPayload
): EmbeddingHostDocumentEmbeddingsRequest {
  return {
    channel: 'document-embeddings',
    payload: assertEmbeddingHostDocumentEmbeddingsPayload(payload),
    requestId: createRequestId('embedding-host-document'),
    runtimeId: assertNonEmptyString(runtimeId, 'Document runtimeId must be non-empty.'),
    type: 'request',
  };
}
export function assertEmbeddingHostDocumentEmbeddingsRequest(
  value: unknown
): EmbeddingHostDocumentEmbeddingsRequest {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Document embeddings request'
  );
  if (envelopeBase.type !== 'request' || envelopeBase.channel !== 'document-embeddings') {
    throw new Error('Invalid document embeddings request envelope.');
  }
  return {
    ...envelopeBase,
    channel: 'document-embeddings',
    payload: assertEmbeddingHostDocumentEmbeddingsPayload(payload),
    type: 'request',
  };
}
export function createEmbeddingHostDocumentEmbeddingsCancel(
  request: EmbeddingHostDocumentEmbeddingsRequest
): EmbeddingHostDocumentEmbeddingsCancel {
  return {
    channel: 'document-embeddings-cancel',
    payload: {},
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'request',
  };
}
export function assertEmbeddingHostDocumentEmbeddingsCancel(
  value: unknown
): EmbeddingHostDocumentEmbeddingsCancel {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Document embeddings cancel'
  );
  if (
    envelopeBase.type !== 'request' ||
    envelopeBase.channel !== 'document-embeddings-cancel' ||
    Object.keys(payload).length !== 0
  ) {
    throw new Error('Invalid document embeddings cancel envelope.');
  }
  return { ...envelopeBase, channel: 'document-embeddings-cancel', payload: {}, type: 'request' };
}
export function createEmbeddingHostDocumentEmbeddingsResultReport(
  request: EmbeddingHostDocumentEmbeddingsRequest,
  embeddings: number[][]
): EmbeddingHostDocumentEmbeddingsResponseReport {
  return {
    channel: 'document-embeddings-result',
    payload: { embeddings },
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'result',
  };
}
export function createEmbeddingHostDocumentEmbeddingsErrorReport(
  request: EmbeddingHostDocumentEmbeddingsRequest,
  error: unknown
): EmbeddingHostDocumentEmbeddingsResponseReport {
  return {
    channel: 'document-embeddings-error',
    payload: serializeRuntimeError(error),
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'error',
  };
}

export const EMBEDDING_HOST_DOCUMENT_CANCELED_CODE = 'EMBEDDING_HOST_DOCUMENT_CANCELED';

/** Only the exact document cancel listener creates this reason; terminal serialization retains its code. */
export function createEmbeddingHostDocumentCancellationError(): Error {
  return Object.assign(new Error('Embedding host document request was canceled.'), {
    code: EMBEDDING_HOST_DOCUMENT_CANCELED_CODE,
    name: 'AbortError',
  });
}
export function assertEmbeddingHostDocumentEmbeddingsResponseReport(
  value: unknown
): EmbeddingHostDocumentEmbeddingsResponseReport {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Document embeddings response'
  );
  if (envelopeBase.type === 'result' && envelopeBase.channel === 'document-embeddings-result') {
    const embeddings = payload['embeddings'];
    if (
      !(
        Array.isArray(embeddings) &&
        embeddings.length > 0 &&
        embeddings.length <= MAX_DOCUMENT_EMBEDDING_BATCH_SIZE
      )
    ) {
      throw new Error('Invalid document embeddings result batch.');
    }
    return {
      ...envelopeBase,
      channel: 'document-embeddings-result',
      payload: { embeddings: embeddings.map(assertEmbeddingVector) },
      type: 'result',
    };
  }
  if (envelopeBase.type === 'error' && envelopeBase.channel === 'document-embeddings-error') {
    return {
      ...envelopeBase,
      channel: 'document-embeddings-error',
      payload: assertEmbeddingHostErrorPayload(payload),
      type: 'error',
    };
  }
  throw new Error('Invalid document embeddings response envelope.');
}

export function assertEmbeddingHostErrorPayload(
  payload: Record<string, unknown>
): EmbeddingHostQueryEmbeddingErrorReport['payload'] {
  return {
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
  };
}
