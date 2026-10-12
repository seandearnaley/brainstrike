export type EmbeddingDevice = 'webgpu' | 'wasm';

export type EmbeddingDeviceHint = EmbeddingDevice;

export type EmbeddingDType = 'fp16' | 'q4' | 'q8' | 'fp32';

/** How a model's token states become one vector: a property of the model, like its dtype. */
export type EmbeddingPooling = 'mean' | 'cls';

export type EmbeddingDimensionParameter =
  | 'dimensions'
  | 'output_dimensionality'
  | 'output_dimension';

export interface EmbedWorkerRequest {
  readonly deviceHint: EmbeddingDeviceHint;
  readonly dimensionParameter?: EmbeddingDimensionParameter;
  readonly dtype?: EmbeddingDType;
  readonly estimatedModelBytes?: number;
  readonly id: string;
  readonly maxBatchSize?: number;
  readonly model: string;
  /** BST-1939: the model's pooling; absent means 'mean', every existing profile's. */
  readonly pooling?: EmbeddingPooling;
  readonly provider?: string;
  readonly revision?: string;
  readonly targetDimension?: number;
  readonly texts: readonly string[];
  readonly truncateDim?: number;
  readonly type: 'embed';
}

export interface EmbedWorkerProgress {
  readonly id: string;
  readonly phase: 'initializing' | 'embedding' | 'complete';
  readonly progress: number;
  readonly type: 'progress';
}

export interface EmbedWorkerPipelineCacheMemoryDiagnostic {
  readonly gpuBytes: number | null;
  readonly heapBytes: number | null;
  readonly reason:
    | 'browser-runtime-unavailable'
    | 'measured'
    | 'model-size-estimate'
    | 'model-size-unknown';
}

export interface EmbedWorkerPipelineCacheEntryDiagnostic {
  readonly cacheKey: string;
  readonly createdAt: number;
  readonly device: EmbeddingDevice;
  readonly dtype: EmbeddingDType;
  readonly lastUsedAt: number;
  readonly memory: EmbedWorkerPipelineCacheMemoryDiagnostic;
  readonly model: string;
  readonly residencyMs: number;
}

/** Worker name prefix used to carry a pool-assigned identity through termination callbacks. */
export const EMBED_WORKER_INSTANCE_NAME_PREFIX = 'brainstrike-embedding-worker:';

/** Worker-script fragment key carrying the pool's worker-lifetime telemetry channel. */
export const EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY =
  'brainstrike-embedding-worker-telemetry-channel';

/** Suffix deriving the adapter-to-worker request-control channel from telemetry identity. */
export const EMBED_WORKER_REQUEST_CONTROL_CHANNEL_SUFFIX = ':request-control';

export const EMBED_WORKER_REQUEST_CANCELED_CODE = 'EMBED_WORKER_REQUEST_CANCELED';

/** Own properties survive workerpool's Error serialization across the worker boundary. */
export function createEmbedWorkerRequestCancellationError(requestId: string): Error & {
  readonly code: typeof EMBED_WORKER_REQUEST_CANCELED_CODE;
  readonly requestId: string;
} {
  return Object.assign(new Error('Embedding task was aborted.'), {
    code: EMBED_WORKER_REQUEST_CANCELED_CODE,
    name: 'AbortError',
    requestId,
  } as const);
}

export function isEmbedWorkerRequestCancellation(error: unknown, requestId: string): boolean {
  return !!(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === EMBED_WORKER_REQUEST_CANCELED_CODE &&
    'requestId' in error &&
    error.requestId === requestId
  );
}

/** Pool-wide request control used to abort work without terminating a warmed worker. */
export interface EmbedWorkerRequestControl {
  readonly id: string;
  readonly type: 'cancel-request' | 'clear-request-control';
}

export function assertEmbedWorkerRequestControl(
  value: unknown
): asserts value is EmbedWorkerRequestControl {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding worker request-control event must be an object.');
  }
  const event = value as Record<string, unknown>;
  if (event['type'] !== 'cancel-request' && event['type'] !== 'clear-request-control') {
    throw new Error('Embedding worker request-control event has an invalid type.');
  }
  if (!(typeof event['id'] === 'string' && event['id'].length > 0)) {
    throw new Error('Embedding worker request-control event requires a request id.');
  }
}

/** Worker-lifetime notice emitted immediately before device-loss self-termination. */
export interface EmbedWorkerTelemetrySourceClosed {
  readonly reason: 'device-lost';
  readonly type: 'telemetry-source-closed';
  readonly workerInstanceId: string;
}

export function assertEmbedWorkerTelemetrySourceClosed(
  value: unknown
): asserts value is EmbedWorkerTelemetrySourceClosed {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding worker telemetry source-close event must be an object.');
  }
  const event = value as Record<string, unknown>;
  if (event['type'] !== 'telemetry-source-closed') {
    throw new Error('Embedding worker telemetry source-close event has an invalid type.');
  }
  if (event['reason'] !== 'device-lost') {
    throw new Error('Embedding worker telemetry source-close event has an invalid reason.');
  }
  if (!(typeof event['workerInstanceId'] === 'string' && event['workerInstanceId'].length > 0)) {
    throw new Error(
      'Embedding worker telemetry source-close event requires a worker instance identity.'
    );
  }
}

/** Worker-lifetime failure delivered outside a workerpool RPC so the owner can replace it. */
export interface EmbedWorkerLifetimeError {
  readonly cause?: string;
  readonly message: string;
  readonly type: 'worker-lifetime-error';
  readonly workerInstanceId: string;
}

export function assertEmbedWorkerLifetimeError(
  value: unknown
): asserts value is EmbedWorkerLifetimeError {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding worker lifetime-error event must be an object.');
  }
  const event = value as Record<string, unknown>;
  if (event['type'] !== 'worker-lifetime-error') {
    throw new Error('Embedding worker lifetime-error event has an invalid type.');
  }
  if (!(typeof event['message'] === 'string' && event['message'].length > 0)) {
    throw new Error('Embedding worker lifetime-error event requires a message.');
  }
  if (event['cause'] !== undefined && typeof event['cause'] !== 'string') {
    throw new Error('Embedding worker lifetime-error event cause must be a string.');
  }
  if (!(typeof event['workerInstanceId'] === 'string' && event['workerInstanceId'].length > 0)) {
    throw new Error('Embedding worker lifetime-error event requires a worker instance identity.');
  }
}

interface EmbedWorkerPipelineCacheDiagnosticBase {
  readonly cacheSize: number;
  readonly diagnostic: 'pipeline-cache';
  readonly emittedAt: number;
  /** Full cache snapshot for non-hot-path events. */
  readonly entries?: readonly EmbedWorkerPipelineCacheEntryDiagnostic[];
  /** Subject pipeline for this diagnostic event. */
  readonly entry?: EmbedWorkerPipelineCacheEntryDiagnostic;
  readonly id?: string;
  readonly type: 'diagnostic';
  /** Ephemeral identity for the live worker instance that owns this cache. */
  readonly workerInstanceId: string;
}

export type EmbedWorkerPipelineCacheDiagnostic = EmbedWorkerPipelineCacheDiagnosticBase &
  (
    | {
        readonly event: 'hit' | 'loaded';
        readonly reason?: never;
      }
    | {
        readonly event: 'disposed';
        readonly reason: 'manual-dispose';
      }
    | {
        readonly event: 'evicted';
        readonly reason: 'device-lost' | 'idle-timeout' | 'resident-limit';
      }
    | {
        readonly event: 'invalidated';
        readonly reason: 'device-lost';
      }
    | {
        readonly event: 'load-failed';
        readonly reason: 'load-failure';
      }
  );

function assertNonEmptyPipelineCacheDiagnosticString(
  value: unknown,
  path: string
): asserts value is string {
  if (!(typeof value === 'string' && value.length > 0)) {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function assertNonNegativePipelineCacheDiagnosticNumber(
  value: unknown,
  path: string
): asserts value is number {
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    throw new Error(`${path} must be a non-negative finite number.`);
  }
}

function assertModelSizeEstimateAttribution(
  device: EmbeddingDevice,
  gpuBytes: unknown,
  heapBytes: unknown,
  path: string
): void {
  if (device === 'webgpu' && (!(typeof gpuBytes === 'number' && gpuBytes > 0) || heapBytes !== 0)) {
    throw new Error(`${path} must attribute a WebGPU model-size estimate to GPU bytes.`);
  }
  if (device === 'wasm' && (!(typeof heapBytes === 'number' && heapBytes > 0) || gpuBytes !== 0)) {
    throw new Error(`${path} must attribute a WASM model-size estimate to heap bytes.`);
  }
}

export function assertEmbedWorkerPipelineCacheMemoryDiagnostic(
  value: unknown,
  device: EmbeddingDevice,
  path: string
): asserts value is EmbedWorkerPipelineCacheMemoryDiagnostic {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error(`${path} must be an object.`);
  }
  const memory = value as Record<string, unknown>;
  for (const field of ['gpuBytes', 'heapBytes'] as const) {
    const bytes = memory[field];
    if (bytes !== null) {
      assertNonNegativePipelineCacheDiagnosticNumber(bytes, `${path}.${field}`);
    }
  }
  const reason = memory['reason'];
  if (
    reason !== 'browser-runtime-unavailable' &&
    reason !== 'measured' &&
    reason !== 'model-size-estimate' &&
    reason !== 'model-size-unknown'
  ) {
    throw new Error(`${path}.reason is invalid.`);
  }
  const gpuBytes = memory['gpuBytes'];
  const heapBytes = memory['heapBytes'];
  if (
    (reason === 'browser-runtime-unavailable' || reason === 'model-size-unknown') &&
    (gpuBytes !== null || heapBytes !== null)
  ) {
    throw new Error(`${path} must not report bytes when its reason is ${reason}.`);
  }
  if (
    (reason === 'measured' || reason === 'model-size-estimate') &&
    gpuBytes === null &&
    heapBytes === null
  ) {
    throw new Error(`${path} must report bytes when its reason is ${reason}.`);
  }
  if (device === 'wasm' && gpuBytes !== null && gpuBytes !== 0) {
    throw new Error(`${path}.gpuBytes must be null or zero for wasm.`);
  }
  if (reason === 'model-size-estimate') {
    assertModelSizeEstimateAttribution(device, gpuBytes, heapBytes, path);
  }
}

function assertEmbedWorkerPipelineCacheEntryDiagnostic(
  value: unknown,
  path: string
): asserts value is EmbedWorkerPipelineCacheEntryDiagnostic {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error(`${path} must be an object.`);
  }
  const entry = value as Record<string, unknown>;
  assertNonEmptyPipelineCacheDiagnosticString(entry['cacheKey'], `${path}.cacheKey`);
  assertNonNegativePipelineCacheDiagnosticNumber(entry['createdAt'], `${path}.createdAt`);
  if (entry['device'] !== 'webgpu' && entry['device'] !== 'wasm') {
    throw new Error(`${path}.device must be "webgpu" or "wasm".`);
  }
  if (
    entry['dtype'] !== 'fp16' &&
    entry['dtype'] !== 'fp32' &&
    entry['dtype'] !== 'q4' &&
    entry['dtype'] !== 'q8'
  ) {
    throw new Error(`${path}.dtype must be "fp16", "fp32", "q4", or "q8".`);
  }
  assertNonNegativePipelineCacheDiagnosticNumber(entry['lastUsedAt'], `${path}.lastUsedAt`);
  assertNonEmptyPipelineCacheDiagnosticString(entry['model'], `${path}.model`);
  assertNonNegativePipelineCacheDiagnosticNumber(entry['residencyMs'], `${path}.residencyMs`);

  assertEmbedWorkerPipelineCacheMemoryDiagnostic(
    entry['memory'],
    entry['device'],
    `${path}.memory`
  );
}

function readEmbedWorkerPipelineCacheEntries(
  value: unknown,
  path: string
): readonly EmbedWorkerPipelineCacheEntryDiagnostic[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  const entries: EmbedWorkerPipelineCacheEntryDiagnostic[] = [];
  value.forEach((candidate: unknown, index: number) => {
    assertEmbedWorkerPipelineCacheEntryDiagnostic(candidate, `${path}[${index}]`);
    entries.push(candidate);
  });
  return entries;
}

function requireFullEmbedWorkerPipelineCacheSnapshot(
  event: string,
  entries: readonly EmbedWorkerPipelineCacheEntryDiagnostic[] | undefined,
  cacheSize: number,
  path: string
): readonly EmbedWorkerPipelineCacheEntryDiagnostic[] {
  if (!entries) {
    throw new Error(`${path}.${event} requires a full entries snapshot.`);
  }
  const uniqueCacheKeys = new Set(entries.map((entry) => entry.cacheKey));
  if (entries.length !== cacheSize || uniqueCacheKeys.size !== cacheSize) {
    throw new Error(`${path}.entries must contain ${cacheSize} unique cache entries.`);
  }
  return entries;
}

function requireEmbedWorkerPipelineCacheSubjectEntry(
  event: string,
  entry: EmbedWorkerPipelineCacheEntryDiagnostic | undefined,
  path: string
): EmbedWorkerPipelineCacheEntryDiagnostic {
  if (!entry) {
    throw new Error(`${path}.${event} requires an entry.`);
  }
  return entry;
}

function assertEmbedWorkerPipelineCacheSubjectMembership(
  event: string,
  entry: EmbedWorkerPipelineCacheEntryDiagnostic,
  entries: readonly EmbedWorkerPipelineCacheEntryDiagnostic[],
  path: string,
  expected: 'absent' | 'present'
): void {
  const includesSubject = entries.some((candidate) => candidate.cacheKey === entry.cacheKey);
  if ((expected === 'present') !== includesSubject) {
    throw new Error(`${path}.${event} subject entry must be ${expected} from entries.`);
  }
}

interface EmbedWorkerPipelineCacheValidationContext {
  readonly cacheSize: number;
  readonly entries: readonly EmbedWorkerPipelineCacheEntryDiagnostic[] | undefined;
  readonly entry: EmbedWorkerPipelineCacheEntryDiagnostic | undefined;
  readonly event: unknown;
  readonly path: string;
  readonly reason: unknown;
}

function assertEmbedWorkerPipelineCacheHit(
  context: EmbedWorkerPipelineCacheValidationContext
): void {
  requireEmbedWorkerPipelineCacheSubjectEntry('hit', context.entry, context.path);
  if (context.cacheSize === 0) {
    throw new Error(`${context.path}.hit requires a positive cacheSize.`);
  }
  if (context.reason !== undefined) {
    throw new Error(`${context.path}.hit must not include a reason.`);
  }
}

function assertEmbedWorkerPipelineCacheLoaded(
  context: EmbedWorkerPipelineCacheValidationContext
): void {
  const subject = requireEmbedWorkerPipelineCacheSubjectEntry(
    'loaded',
    context.entry,
    context.path
  );
  const snapshot = requireFullEmbedWorkerPipelineCacheSnapshot(
    'loaded',
    context.entries,
    context.cacheSize,
    context.path
  );
  assertEmbedWorkerPipelineCacheSubjectMembership(
    'loaded',
    subject,
    snapshot,
    context.path,
    'present'
  );
  if (context.reason !== undefined) {
    throw new Error(`${context.path}.loaded must not include a reason.`);
  }
}

function assertEmbedWorkerPipelineCacheRemoval(
  context: EmbedWorkerPipelineCacheValidationContext,
  event: 'disposed' | 'evicted'
): void {
  const subject = requireEmbedWorkerPipelineCacheSubjectEntry(event, context.entry, context.path);
  const snapshot = requireFullEmbedWorkerPipelineCacheSnapshot(
    event,
    context.entries,
    context.cacheSize,
    context.path
  );
  assertEmbedWorkerPipelineCacheSubjectMembership(event, subject, snapshot, context.path, 'absent');
  if (event === 'disposed' && context.reason !== 'manual-dispose') {
    throw new Error(`${context.path}.disposed requires reason "manual-dispose".`);
  }
  if (
    event === 'evicted' &&
    context.reason !== 'device-lost' &&
    context.reason !== 'idle-timeout' &&
    context.reason !== 'resident-limit'
  ) {
    throw new Error(`${context.path}.evicted reason is invalid.`);
  }
}

function assertEmbedWorkerPipelineCacheSnapshotEvent(
  context: EmbedWorkerPipelineCacheValidationContext,
  event: 'invalidated' | 'load-failed'
): void {
  requireFullEmbedWorkerPipelineCacheSnapshot(
    event,
    context.entries,
    context.cacheSize,
    context.path
  );
  if (event === 'invalidated' && context.reason !== 'device-lost') {
    throw new Error(`${context.path}.invalidated requires reason "device-lost".`);
  }
  if (event === 'load-failed' && context.reason !== 'load-failure') {
    throw new Error(`${context.path}.load-failed requires reason "load-failure".`);
  }
}

function assertEmbedWorkerPipelineCacheEvent(
  context: EmbedWorkerPipelineCacheValidationContext
): void {
  switch (context.event) {
    case 'hit':
      assertEmbedWorkerPipelineCacheHit(context);
      return;
    case 'loaded':
      assertEmbedWorkerPipelineCacheLoaded(context);
      return;
    case 'disposed':
    case 'evicted':
      assertEmbedWorkerPipelineCacheRemoval(context, context.event);
      return;
    case 'invalidated':
    case 'load-failed':
      assertEmbedWorkerPipelineCacheSnapshotEvent(context, context.event);
      return;
    default:
      throw new Error(`${context.path}.event is invalid.`);
  }
}

export function assertEmbedWorkerPipelineCacheDiagnostic(
  value: unknown
): asserts value is EmbedWorkerPipelineCacheDiagnostic {
  const path = 'Embedding worker pipeline-cache diagnostic';
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error(`${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (record['diagnostic'] !== 'pipeline-cache' || record['type'] !== 'diagnostic') {
    throw new Error(`${path} requires type "diagnostic" and diagnostic "pipeline-cache".`);
  }
  const cacheSize = record['cacheSize'];
  assertNonNegativePipelineCacheDiagnosticNumber(cacheSize, `${path}.cacheSize`);
  if (!Number.isSafeInteger(cacheSize)) {
    throw new Error(`${path}.cacheSize must be a safe integer.`);
  }
  assertNonNegativePipelineCacheDiagnosticNumber(record['emittedAt'], `${path}.emittedAt`);
  if (!(typeof record['workerInstanceId'] === 'string' && record['workerInstanceId'].length > 0)) {
    throw new Error(`${path} requires a non-empty workerInstanceId.`);
  }
  if (record['id'] !== undefined) {
    assertNonEmptyPipelineCacheDiagnosticString(record['id'], `${path}.id`);
  }

  const entryValue = record['entry'];
  let entry: EmbedWorkerPipelineCacheEntryDiagnostic | undefined;
  if (entryValue !== undefined) {
    assertEmbedWorkerPipelineCacheEntryDiagnostic(entryValue, `${path}.entry`);
    entry = entryValue;
  }
  const entries = readEmbedWorkerPipelineCacheEntries(record['entries'], `${path}.entries`);
  assertEmbedWorkerPipelineCacheEvent({
    cacheSize,
    entries,
    entry,
    event: record['event'],
    path,
    reason: record['reason'],
  });
}

export interface EmbedWorkerBatch {
  readonly batchIndex: number;
  readonly endIndex: number;
  readonly id: string;
  readonly peakVectorsInFlight: number;
  readonly startIndex: number;
  readonly transferBytes: number;
  readonly type: 'batch';
  readonly vectors: readonly Float32Array[];
  readonly vectorsInFlight: number;
}

function assertNonNegativeEmbedWorkerBatchInteger(value: unknown, field: string): number {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
    throw new Error(`Embedding worker batch.${field} must be a non-negative safe integer.`);
  }
  return value;
}

export function assertEmbedWorkerBatch(value: unknown): asserts value is EmbedWorkerBatch {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding worker batch must be an object.');
  }
  const batch = value as Record<string, unknown>;
  if (batch['type'] !== 'batch') {
    throw new Error('Embedding worker batch.type must be "batch".');
  }
  if (!(typeof batch['id'] === 'string' && batch['id'].length > 0)) {
    throw new Error('Embedding worker batch.id must be a non-empty string.');
  }
  assertNonNegativeEmbedWorkerBatchInteger(batch['batchIndex'], 'batchIndex');
  const endIndex = assertNonNegativeEmbedWorkerBatchInteger(batch['endIndex'], 'endIndex');
  const peakVectorsInFlight = assertNonNegativeEmbedWorkerBatchInteger(
    batch['peakVectorsInFlight'],
    'peakVectorsInFlight'
  );
  const startIndex = assertNonNegativeEmbedWorkerBatchInteger(batch['startIndex'], 'startIndex');
  const transferBytes = assertNonNegativeEmbedWorkerBatchInteger(
    batch['transferBytes'],
    'transferBytes'
  );
  const vectorsInFlight = assertNonNegativeEmbedWorkerBatchInteger(
    batch['vectorsInFlight'],
    'vectorsInFlight'
  );
  if (endIndex <= startIndex) {
    throw new Error('Embedding worker batch.endIndex must be greater than startIndex.');
  }
  const vectors = batch['vectors'];
  if (!Array.isArray(vectors)) {
    throw new Error('Embedding worker batch.vectors must be an array.');
  }
  const expectedVectorCount = endIndex - startIndex;
  if (vectors.length !== expectedVectorCount) {
    throw new Error('Embedding worker batch vector count must match its index range.');
  }

  let dimensions: number | null = null;
  const buffers = new Set<ArrayBufferLike>();
  vectors.forEach((vector: unknown, index: number) => {
    if (!(vector instanceof Float32Array)) {
      throw new Error(`Embedding worker batch.vectors[${index}] must be a Float32Array.`);
    }
    if (vector.length === 0) {
      throw new Error(`Embedding worker batch.vectors[${index}] must not be empty.`);
    }
    vector.forEach((component, componentIndex) => {
      if (!Number.isFinite(component)) {
        throw new Error(
          `Embedding worker batch.vectors[${index}][${componentIndex}] must be finite.`
        );
      }
    });
    if (dimensions === null) {
      dimensions = vector.length;
    } else if (vector.length !== dimensions) {
      throw new Error('Embedding worker batch vectors must have a consistent shape.');
    }
    buffers.add(vector.buffer);
  });

  if (vectorsInFlight !== vectors.length) {
    throw new Error('Embedding worker batch.vectorsInFlight must match its vector count.');
  }
  if (peakVectorsInFlight < vectorsInFlight) {
    throw new Error('Embedding worker batch.peakVectorsInFlight must be at least vectorsInFlight.');
  }
  let transferredBytes = 0;
  for (const buffer of buffers) {
    transferredBytes += buffer.byteLength;
  }
  if (transferBytes !== transferredBytes) {
    throw new Error(
      'Embedding worker batch.transferBytes must match its unique transferred buffers.'
    );
  }
}

export interface EmbedWorkerSuccess {
  readonly id: string;
  readonly metadata: {
    readonly model: string;
    readonly revision?: string;
    readonly device: EmbeddingDevice;
    readonly dtype: EmbeddingDType;
    readonly batchSize: number;
    readonly elapsedMs: number;
    readonly fallbackApplied: boolean;
    readonly dimensions: number;
  };
  readonly type: 'result';
  readonly vectors: readonly Float32Array[];
}

export interface EmbedWorkerError {
  readonly cause?: string | undefined;
  readonly id: string;
  readonly message: string;
  readonly type: 'error';
}

export interface EmbedWorkerComplete {
  readonly id: string;
  readonly metadata: EmbedWorkerSuccess['metadata'];
  readonly type: 'complete';
}

function assertOptionalModelRevision(value: unknown, path: string): void {
  if (value !== undefined && !(typeof value === 'string' && value.length > 0)) {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

export function assertEmbedWorkerComplete(value: unknown): asserts value is EmbedWorkerComplete {
  const path = 'Embedding worker complete';
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error(`${path} must be an object.`);
  }
  const complete = value as Record<string, unknown>;
  if (complete['type'] !== 'complete') {
    throw new Error(`${path}.type must be "complete".`);
  }
  if (!(typeof complete['id'] === 'string' && complete['id'].length > 0)) {
    throw new Error(`${path}.id must be a non-empty string.`);
  }
  const metadataValue = complete['metadata'];
  if (!(metadataValue && typeof metadataValue === 'object' && !Array.isArray(metadataValue))) {
    throw new Error(`${path}.metadata must be an object.`);
  }
  const metadata = metadataValue as Record<string, unknown>;
  if (!(typeof metadata['model'] === 'string' && metadata['model'].length > 0)) {
    throw new Error(`${path}.metadata.model must be a non-empty string.`);
  }
  assertOptionalModelRevision(metadata['revision'], `${path}.metadata.revision`);
  if (metadata['device'] !== 'webgpu' && metadata['device'] !== 'wasm') {
    throw new Error(`${path}.metadata.device is invalid.`);
  }
  if (
    metadata['dtype'] !== 'fp16' &&
    metadata['dtype'] !== 'q4' &&
    metadata['dtype'] !== 'q8' &&
    metadata['dtype'] !== 'fp32'
  ) {
    throw new Error(`${path}.metadata.dtype is invalid.`);
  }
  if (
    !(
      typeof metadata['batchSize'] === 'number' &&
      Number.isSafeInteger(metadata['batchSize']) &&
      metadata['batchSize'] >= 0
    )
  ) {
    throw new Error(`${path}.metadata.batchSize must be a non-negative safe integer.`);
  }
  if (
    !(
      typeof metadata['elapsedMs'] === 'number' &&
      Number.isFinite(metadata['elapsedMs']) &&
      metadata['elapsedMs'] >= 0
    )
  ) {
    throw new Error(`${path}.metadata.elapsedMs must be a non-negative finite number.`);
  }
  if (typeof metadata['fallbackApplied'] !== 'boolean') {
    throw new Error(`${path}.metadata.fallbackApplied must be a boolean.`);
  }
  if (
    !(
      typeof metadata['dimensions'] === 'number' &&
      Number.isSafeInteger(metadata['dimensions']) &&
      metadata['dimensions'] > 0
    )
  ) {
    throw new Error(`${path}.metadata.dimensions must be a positive safe integer.`);
  }
}

export type EmbedWorkerStreamEvent =
  | EmbedWorkerBatch
  | EmbedWorkerComplete
  | EmbedWorkerPipelineCacheDiagnostic
  | EmbedWorkerError
  | EmbedWorkerProgress;
