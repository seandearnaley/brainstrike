import type { EmbedWorkerBatch, EmbedWorkerPipelineCacheDiagnostic } from './shared';

type EmbeddingPipelineCacheDiagnosticEntry = NonNullable<
  EmbedWorkerPipelineCacheDiagnostic['entries']
>[number];

export type EmbeddingPipelineCacheTelemetryEntry = EmbeddingPipelineCacheDiagnosticEntry & {
  readonly sourceId: string;
};

export interface EmbeddingBatchTransferTelemetry {
  readonly batchCount: number;
  readonly lastBytes: number;
  readonly peakBytes: number;
  readonly totalBytes: number;
}

export interface EmbeddingPipelineCacheTelemetry {
  readonly entries: readonly EmbeddingPipelineCacheTelemetryEntry[];
  readonly estimatedGpuBytes: number;
  readonly estimatedHeapBytes: number;
  readonly memoryEstimateUnavailableCount: number;
  readonly residentCount: number;
}

export interface EmbeddingTelemetrySnapshot {
  readonly batchTransfer: EmbeddingBatchTransferTelemetry;
  readonly cache: EmbeddingPipelineCacheTelemetry;
  readonly health: {
    readonly failureCount: number;
    readonly lastFailure: string | null;
  };
  readonly lastUpdatedAt: number | null;
  readonly peakVectorsInFlight: number;
}

interface EmbeddingTelemetrySourceState {
  batchCount: number;
  cacheEntries: Map<string, EmbeddingPipelineCacheDiagnosticEntry>;
  lastBatchSequence: number;
  lastBytes: number;
  peakBytes: number;
  peakVectorsInFlight: number;
  totalBytes: number;
}

type EmbeddingTelemetryListener = () => void;

const MAX_EMBEDDING_TELEMETRY_FAILURE_REASON_LENGTH = 240;

const sources = new Map<string, EmbeddingTelemetrySourceState>();
const listeners = new Set<EmbeddingTelemetryListener>();

let snapshot: EmbeddingTelemetrySnapshot;
let nextBatchSequence = 1;
let snapshotDirty = false;
let lastMutationAt: number | null = null;
let telemetryFailureCount = 0;
let lastTelemetryFailure: string | null = null;

export function createEmptyEmbeddingTelemetrySnapshot(): EmbeddingTelemetrySnapshot {
  return {
    batchTransfer: {
      batchCount: 0,
      lastBytes: 0,
      peakBytes: 0,
      totalBytes: 0,
    },
    cache: {
      entries: [],
      estimatedGpuBytes: 0,
      estimatedHeapBytes: 0,
      memoryEstimateUnavailableCount: 0,
      residentCount: 0,
    },
    health: {
      failureCount: 0,
      lastFailure: null,
    },
    lastUpdatedAt: null,
    peakVectorsInFlight: 0,
  };
}

snapshot = createEmptyEmbeddingTelemetrySnapshot();

function assertNonNegativeNumber(value: unknown, path: string): number {
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    throw new Error(`${path} must be a non-negative finite number.`);
  }
  return value;
}

function assertCacheEntry(
  value: unknown,
  index: number
): EmbeddingPipelineCacheTelemetry['entries'][number] {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error(`Embedding telemetry cache.entries[${index}] must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  const cacheKey = candidate['cacheKey'];
  const device = candidate['device'];
  const dtype = candidate['dtype'];
  const memory = candidate['memory'];
  const model = candidate['model'];
  const sourceId = candidate['sourceId'];
  if (!(typeof cacheKey === 'string' && cacheKey.length > 0)) {
    throw new Error(`Embedding telemetry cache.entries[${index}].cacheKey must be non-empty.`);
  }
  if (device !== 'webgpu' && device !== 'wasm') {
    throw new Error(`Embedding telemetry cache.entries[${index}].device is invalid.`);
  }
  if (!(typeof dtype === 'string' && dtype.length > 0)) {
    throw new Error(`Embedding telemetry cache.entries[${index}].dtype must be non-empty.`);
  }
  if (!(typeof model === 'string' && model.length > 0)) {
    throw new Error(`Embedding telemetry cache.entries[${index}].model must be non-empty.`);
  }
  if (!(typeof sourceId === 'string' && sourceId.length > 0)) {
    throw new Error(`Embedding telemetry cache.entries[${index}].sourceId must be non-empty.`);
  }
  if (!(memory && typeof memory === 'object' && !Array.isArray(memory))) {
    throw new Error(`Embedding telemetry cache.entries[${index}].memory must be an object.`);
  }
  const memoryCandidate = memory as Record<string, unknown>;
  const reason = memoryCandidate['reason'];
  if (
    reason !== 'browser-runtime-unavailable' &&
    reason !== 'measured' &&
    reason !== 'model-size-estimate' &&
    reason !== 'model-size-unknown'
  ) {
    throw new Error(`Embedding telemetry cache.entries[${index}].memory.reason is invalid.`);
  }
  const readNullableBytes = (key: 'gpuBytes' | 'heapBytes'): number | null => {
    const bytes = memoryCandidate[key];
    return bytes === null
      ? null
      : assertNonNegativeNumber(bytes, `Embedding telemetry cache.entries[${index}].memory.${key}`);
  };
  return {
    cacheKey,
    createdAt: assertNonNegativeNumber(
      candidate['createdAt'],
      `Embedding telemetry cache.entries[${index}].createdAt`
    ),
    device,
    dtype: dtype as EmbeddingPipelineCacheTelemetry['entries'][number]['dtype'],
    lastUsedAt: assertNonNegativeNumber(
      candidate['lastUsedAt'],
      `Embedding telemetry cache.entries[${index}].lastUsedAt`
    ),
    memory: {
      gpuBytes: readNullableBytes('gpuBytes'),
      heapBytes: readNullableBytes('heapBytes'),
      reason,
    },
    model,
    residencyMs: assertNonNegativeNumber(
      candidate['residencyMs'],
      `Embedding telemetry cache.entries[${index}].residencyMs`
    ),
    sourceId,
  };
}

type EmbeddingCacheAggregateField = Exclude<keyof EmbeddingPipelineCacheTelemetry, 'entries'>;

function calculateCacheAggregates(
  entries: EmbeddingPipelineCacheTelemetry['entries']
): Omit<EmbeddingPipelineCacheTelemetry, 'entries'> {
  let estimatedGpuBytes = 0;
  let estimatedHeapBytes = 0;
  let memoryEstimateUnavailableCount = 0;

  for (const entry of entries) {
    estimatedGpuBytes += entry.memory.gpuBytes ?? 0;
    estimatedHeapBytes += entry.memory.heapBytes ?? 0;
    if (entry.memory.gpuBytes === null && entry.memory.heapBytes === null) {
      memoryEstimateUnavailableCount += 1;
    }
  }

  return {
    estimatedGpuBytes,
    estimatedHeapBytes,
    memoryEstimateUnavailableCount,
    residentCount: entries.length,
  };
}

function assertMatchingCacheAggregate(
  candidate: Record<string, unknown>,
  field: EmbeddingCacheAggregateField,
  expected: number
): number {
  const actual = assertNonNegativeNumber(candidate[field], `Embedding telemetry cache.${field}`);
  if (actual !== expected) {
    throw new Error(`Embedding telemetry cache.${field} does not match cache.entries.`);
  }
  return actual;
}

export function assertEmbeddingTelemetrySnapshot(value: unknown): EmbeddingTelemetrySnapshot {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding telemetry snapshot must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  const batchTransfer = candidate['batchTransfer'];
  const cache = candidate['cache'];
  const health = candidate['health'];
  if (!(batchTransfer && typeof batchTransfer === 'object' && !Array.isArray(batchTransfer))) {
    throw new Error('Embedding telemetry batchTransfer must be an object.');
  }
  if (!(cache && typeof cache === 'object' && !Array.isArray(cache))) {
    throw new Error('Embedding telemetry cache must be an object.');
  }
  if (!(health && typeof health === 'object' && !Array.isArray(health))) {
    throw new Error('Embedding telemetry health must be an object.');
  }
  const batchCandidate = batchTransfer as Record<string, unknown>;
  const cacheCandidate = cache as Record<string, unknown>;
  const healthCandidate = health as Record<string, unknown>;
  const entries = cacheCandidate['entries'];
  if (!Array.isArray(entries)) {
    throw new Error('Embedding telemetry cache.entries must be an array.');
  }
  const validatedEntries = entries.map(assertCacheEntry);
  const expectedCacheAggregates = calculateCacheAggregates(validatedEntries);
  const lastUpdatedAt = candidate['lastUpdatedAt'];
  if (!(lastUpdatedAt === null || typeof lastUpdatedAt === 'number')) {
    throw new Error('Embedding telemetry lastUpdatedAt must be a number or null.');
  }
  const failureCount = assertNonNegativeNumber(
    healthCandidate['failureCount'],
    'Embedding telemetry health.failureCount'
  );
  if (!Number.isSafeInteger(failureCount)) {
    throw new Error('Embedding telemetry health.failureCount must be a safe integer.');
  }
  const lastFailure = healthCandidate['lastFailure'];
  if (
    !(
      lastFailure === null ||
      (typeof lastFailure === 'string' &&
        lastFailure.length > 0 &&
        lastFailure.length <= MAX_EMBEDDING_TELEMETRY_FAILURE_REASON_LENGTH)
    )
  ) {
    throw new Error(
      `Embedding telemetry health.lastFailure must be a string of 1-${MAX_EMBEDDING_TELEMETRY_FAILURE_REASON_LENGTH} characters or null.`
    );
  }
  if ((failureCount === 0) !== (lastFailure === null)) {
    throw new Error(
      'Embedding telemetry health requires lastFailure exactly when failureCount is non-zero.'
    );
  }
  return {
    batchTransfer: {
      batchCount: assertNonNegativeNumber(
        batchCandidate['batchCount'],
        'Embedding telemetry batchTransfer.batchCount'
      ),
      lastBytes: assertNonNegativeNumber(
        batchCandidate['lastBytes'],
        'Embedding telemetry batchTransfer.lastBytes'
      ),
      peakBytes: assertNonNegativeNumber(
        batchCandidate['peakBytes'],
        'Embedding telemetry batchTransfer.peakBytes'
      ),
      totalBytes: assertNonNegativeNumber(
        batchCandidate['totalBytes'],
        'Embedding telemetry batchTransfer.totalBytes'
      ),
    },
    cache: {
      entries: validatedEntries,
      estimatedGpuBytes: assertMatchingCacheAggregate(
        cacheCandidate,
        'estimatedGpuBytes',
        expectedCacheAggregates.estimatedGpuBytes
      ),
      estimatedHeapBytes: assertMatchingCacheAggregate(
        cacheCandidate,
        'estimatedHeapBytes',
        expectedCacheAggregates.estimatedHeapBytes
      ),
      memoryEstimateUnavailableCount: assertMatchingCacheAggregate(
        cacheCandidate,
        'memoryEstimateUnavailableCount',
        expectedCacheAggregates.memoryEstimateUnavailableCount
      ),
      residentCount: assertMatchingCacheAggregate(
        cacheCandidate,
        'residentCount',
        expectedCacheAggregates.residentCount
      ),
    },
    health: {
      failureCount,
      lastFailure,
    },
    lastUpdatedAt:
      lastUpdatedAt === null
        ? null
        : assertNonNegativeNumber(lastUpdatedAt, 'Embedding telemetry lastUpdatedAt'),
    peakVectorsInFlight: assertNonNegativeNumber(
      candidate['peakVectorsInFlight'],
      'Embedding telemetry peakVectorsInFlight'
    ),
  };
}

function getOrCreateSource(sourceId: string): EmbeddingTelemetrySourceState {
  const existing = sources.get(sourceId);
  if (existing) {
    return existing;
  }
  const state: EmbeddingTelemetrySourceState = {
    batchCount: 0,
    cacheEntries: new Map(),
    lastBatchSequence: 0,
    lastBytes: 0,
    peakBytes: 0,
    peakVectorsInFlight: 0,
    totalBytes: 0,
  };
  sources.set(sourceId, state);
  return state;
}

function rebuildSnapshot(): void {
  let batchCount = 0;
  let estimatedGpuBytes = 0;
  let estimatedHeapBytes = 0;
  let lastBytes = 0;
  let lastBatchSequence = 0;
  let memoryEstimateUnavailableCount = 0;
  let peakBytes = 0;
  let peakVectorsInFlight = 0;
  let totalBytes = 0;
  const entries: EmbeddingPipelineCacheTelemetry['entries'][number][] = [];

  for (const [sourceId, source] of sources) {
    batchCount += source.batchCount;
    if (source.lastBatchSequence > lastBatchSequence) {
      lastBatchSequence = source.lastBatchSequence;
      lastBytes = source.lastBytes;
    }
    peakBytes = Math.max(peakBytes, source.peakBytes);
    peakVectorsInFlight = Math.max(peakVectorsInFlight, source.peakVectorsInFlight);
    totalBytes += source.totalBytes;
    for (const entry of source.cacheEntries.values()) {
      entries.push({ ...entry, sourceId });
      if (entry.memory.gpuBytes === null && entry.memory.heapBytes === null) {
        memoryEstimateUnavailableCount += 1;
        continue;
      }
      estimatedGpuBytes += entry.memory.gpuBytes ?? 0;
      estimatedHeapBytes += entry.memory.heapBytes ?? 0;
    }
  }

  snapshot = {
    batchTransfer: { batchCount, lastBytes, peakBytes, totalBytes },
    cache: {
      entries,
      estimatedGpuBytes,
      estimatedHeapBytes,
      memoryEstimateUnavailableCount,
      residentCount: entries.length,
    },
    health: {
      failureCount: telemetryFailureCount,
      lastFailure: lastTelemetryFailure,
    },
    lastUpdatedAt: lastMutationAt,
    peakVectorsInFlight,
  };
  snapshotDirty = false;
}

function markSnapshotDirty(): void {
  snapshotDirty = true;
  lastMutationAt = Date.now();
  for (const listener of listeners) {
    listener();
  }
}

export function recordEmbeddingBatchTelemetry(sourceId: string, event: EmbedWorkerBatch): void {
  const source = getOrCreateSource(sourceId);
  source.batchCount += 1;
  source.lastBatchSequence = nextBatchSequence++;
  source.lastBytes = event.transferBytes;
  source.peakBytes = Math.max(source.peakBytes, event.transferBytes);
  source.peakVectorsInFlight = Math.max(
    source.peakVectorsInFlight,
    event.peakVectorsInFlight,
    event.vectorsInFlight
  );
  source.totalBytes += event.transferBytes;
  markSnapshotDirty();
}

export function recordEmbeddingPipelineCacheTelemetry(
  sourceId: string,
  event: EmbedWorkerPipelineCacheDiagnostic
): void {
  const source = getOrCreateSource(sourceId);
  if (event.entries) {
    source.cacheEntries = new Map(event.entries.map((entry) => [entry.cacheKey, entry]));
  } else if (event.entry) {
    if (event.event === 'disposed' || event.event === 'evicted' || event.event === 'load-failed') {
      source.cacheEntries.delete(event.entry.cacheKey);
    } else {
      source.cacheEntries.set(event.entry.cacheKey, event.entry);
    }
  }
  markSnapshotDirty();
}

export function recordEmbeddingTelemetryFailure(reason: string): void {
  if (
    !(
      typeof reason === 'string' &&
      reason.length > 0 &&
      reason.length <= MAX_EMBEDDING_TELEMETRY_FAILURE_REASON_LENGTH
    )
  ) {
    throw new Error(
      `Embedding telemetry failure reason must contain 1-${MAX_EMBEDDING_TELEMETRY_FAILURE_REASON_LENGTH} characters.`
    );
  }
  telemetryFailureCount += 1;
  lastTelemetryFailure = reason;
  markSnapshotDirty();
}

export function removeEmbeddingTelemetrySource(sourceId: string): void {
  if (!sources.delete(sourceId)) {
    return;
  }
  markSnapshotDirty();
}

export const embeddingWorkerTelemetrySink = {
  recordBatch: recordEmbeddingBatchTelemetry,
  recordFailure: recordEmbeddingTelemetryFailure,
  recordPipelineCache: recordEmbeddingPipelineCacheTelemetry,
  removeSource: removeEmbeddingTelemetrySource,
} as const;

export function getEmbeddingTelemetrySnapshot(): EmbeddingTelemetrySnapshot {
  if (snapshotDirty) {
    rebuildSnapshot();
  }
  return snapshot;
}

export function subscribeEmbeddingTelemetry(listener: EmbeddingTelemetryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeEmbeddingTelemetryThrottled(
  listener: EmbeddingTelemetryListener,
  intervalMs = 250
): () => void {
  if (!(Number.isSafeInteger(intervalMs) && intervalMs > 0)) {
    throw new Error('Embedding telemetry subscription interval must be a positive integer.');
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = subscribeEmbeddingTelemetry(() => {
    if (timeout !== null) {
      return;
    }
    timeout = setTimeout(() => {
      timeout = null;
      listener();
    }, intervalMs);
  });
  return () => {
    unsubscribe();
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
}

export function resetEmbeddingTelemetryForTests(): void {
  sources.clear();
  listeners.clear();
  lastMutationAt = null;
  nextBatchSequence = 1;
  telemetryFailureCount = 0;
  lastTelemetryFailure = null;
  snapshot = createEmptyEmbeddingTelemetrySnapshot();
  snapshotDirty = false;
}
