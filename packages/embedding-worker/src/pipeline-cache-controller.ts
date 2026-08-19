import type {
  EmbeddingDevice,
  EmbeddingDType,
  EmbedWorkerPipelineCacheDiagnostic,
  EmbedWorkerPipelineCacheEntryDiagnostic,
} from '@brainstrike/indexing-contract';

export type { EmbedWorkerPipelineCacheDiagnostic } from '@brainstrike/indexing-contract';
export { assertEmbedWorkerPipelineCacheDiagnostic } from '@brainstrike/indexing-contract';

export const MAX_GPU_PIPELINES = 1;
export const MAX_WASM_PIPELINES = 3;

const PIPELINE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 30_000;

export interface EmbeddingPipelineResource {
  readonly dispose?: () => unknown;
}

export type PipelineCacheDiagnosticSink = (diagnostic: EmbedWorkerPipelineCacheDiagnostic) => void;

export interface EmbeddingPipelineCacheLoadRequest {
  readonly device: EmbeddingDevice;
  readonly diagnostics?: {
    readonly id?: string;
    readonly sink?: PipelineCacheDiagnosticSink;
  };
  readonly dtype: EmbeddingDType;
  readonly estimatedModelBytes: number | null;
  readonly model: string;
}

export interface EmbeddingPipelineCacheController<Resource extends EmbeddingPipelineResource> {
  readonly close: () => Promise<void>;
  readonly getResidentEntries: () => readonly EmbedWorkerPipelineCacheEntryDiagnostic[];
  readonly hasResidentDevice: (device: EmbeddingDevice) => boolean;
  readonly invalidateWebGpuPipelines: () => void;
  readonly load: (request: EmbeddingPipelineCacheLoadRequest) => Promise<Resource>;
  readonly waitForPendingDisposals: () => Promise<void>;
}

interface PipelineCacheEntry<Resource extends EmbeddingPipelineResource> {
  readonly cacheKey: string;
  readonly createdAt: number;
  readonly device: EmbeddingDevice;
  readonly dtype: EmbeddingDType;
  readonly estimatedModelBytes: number | null;
  lastUsedAt: number;
  readonly model: string;
  readonly pipeline: Promise<Resource>;
}

interface EmbeddingPipelineCacheControllerOptions<Resource extends EmbeddingPipelineResource> {
  readonly isIdleSweepAllowed?: () => boolean;
  readonly load: (
    model: string,
    device: EmbeddingDevice,
    dtype: EmbeddingDType
  ) => Promise<Resource>;
  readonly now?: () => number;
  readonly onModelSizeEstimateMismatch?: (details: {
    readonly cachedBytes: number;
    readonly cacheKey: string;
    readonly requestedBytes: number;
  }) => void;
  readonly onResidencyChanged?: () => void;
  readonly publishDiagnostic: PipelineCacheDiagnosticSink;
  readonly workerInstanceId: string;
}

type PipelineCacheRemovalReason = Extract<
  NonNullable<EmbedWorkerPipelineCacheDiagnostic['reason']>,
  'device-lost' | 'idle-timeout' | 'manual-dispose' | 'resident-limit'
>;

type PipelineCacheEvent = EmbedWorkerPipelineCacheDiagnostic['event'];

function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function resolvePipelineMemory(
  entry: PipelineCacheEntry<EmbeddingPipelineResource>
): EmbedWorkerPipelineCacheEntryDiagnostic['memory'] {
  if (entry.estimatedModelBytes === null) {
    return {
      gpuBytes: null,
      heapBytes: null,
      reason: 'model-size-unknown',
    };
  }
  if (entry.device === 'webgpu') {
    return {
      gpuBytes: entry.estimatedModelBytes,
      heapBytes: 0,
      reason: 'model-size-estimate',
    };
  }
  return {
    gpuBytes: 0,
    heapBytes: entry.estimatedModelBytes,
    reason: 'model-size-estimate',
  };
}

export function createEmbeddingPipelineCacheController<Resource extends EmbeddingPipelineResource>(
  options: EmbeddingPipelineCacheControllerOptions<Resource>
): EmbeddingPipelineCacheController<Resource> {
  if (options.workerInstanceId.length === 0) {
    throw new Error('Embedding pipeline cache requires a worker instance identity.');
  }

  const entries = new Map<string, PipelineCacheEntry<Resource>>();
  const pendingDisposals = new Set<Promise<void>>();
  const readNow = (): number => {
    const timestamp = (options.now ?? defaultNow)();
    if (!(Number.isFinite(timestamp) && timestamp >= 0)) {
      throw new Error('Embedding pipeline cache clock must return a non-negative finite number.');
    }
    return timestamp;
  };
  let idleSweepTimer: ReturnType<typeof setInterval> | null = null;

  const toDiagnosticEntry = (
    entry: PipelineCacheEntry<Resource>,
    timestamp: number
  ): EmbedWorkerPipelineCacheEntryDiagnostic => ({
    cacheKey: entry.cacheKey,
    createdAt: entry.createdAt,
    device: entry.device,
    dtype: entry.dtype,
    lastUsedAt: entry.lastUsedAt,
    memory: resolvePipelineMemory(entry),
    model: entry.model,
    residencyMs: Math.max(0, timestamp - entry.createdAt),
  });

  const buildDiagnosticEntries = (timestamp: number): EmbedWorkerPipelineCacheEntryDiagnostic[] =>
    [...entries.values()].map((entry) => toDiagnosticEntry(entry, timestamp));

  const emitDiagnostic = (args: {
    readonly entry?: PipelineCacheEntry<Resource>;
    readonly event: PipelineCacheEvent;
    readonly id?: string;
    readonly reason?: NonNullable<EmbedWorkerPipelineCacheDiagnostic['reason']>;
    readonly sink?: PipelineCacheDiagnosticSink;
  }): void => {
    const timestamp = readNow();
    const entry = args.entry ? toDiagnosticEntry(args.entry, timestamp) : undefined;
    const base = {
      cacheSize: entries.size,
      diagnostic: 'pipeline-cache' as const,
      emittedAt: timestamp,
      ...(args.event === 'hit' ? {} : { entries: buildDiagnosticEntries(timestamp) }),
      ...(entry ? { entry } : {}),
      ...(args.id ? { id: args.id } : {}),
      type: 'diagnostic' as const,
      workerInstanceId: options.workerInstanceId,
    };
    let diagnostic: EmbedWorkerPipelineCacheDiagnostic;
    switch (args.event) {
      case 'hit':
      case 'loaded':
        diagnostic = { ...base, event: args.event };
        break;
      case 'disposed':
        diagnostic = { ...base, event: 'disposed', reason: 'manual-dispose' };
        break;
      case 'evicted':
        if (
          args.reason !== 'device-lost' &&
          args.reason !== 'idle-timeout' &&
          args.reason !== 'resident-limit'
        ) {
          throw new Error('Embedding pipeline eviction requires a valid eviction reason.');
        }
        diagnostic = { ...base, event: 'evicted', reason: args.reason };
        break;
      case 'invalidated':
        diagnostic = { ...base, event: 'invalidated', reason: 'device-lost' };
        break;
      case 'load-failed':
        diagnostic = { ...base, event: 'load-failed', reason: 'load-failure' };
        break;
      default: {
        const exhaustive: never = args.event;
        throw new Error(`Unhandled pipeline cache event: ${String(exhaustive)}`);
      }
    }
    (args.sink ?? options.publishDiagnostic)(diagnostic);
  };

  const stopIdleSweep = (): void => {
    if (idleSweepTimer === null) {
      return;
    }
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  };

  const trackDisposal = (disposal: Promise<void>): void => {
    pendingDisposals.add(disposal);
    void disposal.finally(() => {
      pendingDisposals.delete(disposal);
    });
  };

  const disposeEntry = (
    cacheKey: string,
    reason: PipelineCacheRemovalReason,
    diagnostics: {
      readonly id?: string;
      readonly sink?: PipelineCacheDiagnosticSink;
    } = {}
  ): void => {
    const entry = entries.get(cacheKey);
    if (!entry) {
      return;
    }
    entries.delete(cacheKey);
    emitDiagnostic({
      entry,
      event: reason === 'manual-dispose' ? 'disposed' : 'evicted',
      ...(diagnostics.id ? { id: diagnostics.id } : {}),
      reason,
      ...(diagnostics.sink ? { sink: diagnostics.sink } : {}),
    });
    const disposal = entry.pipeline
      .then(async (pipeline) => {
        if (pipeline.dispose) {
          await pipeline.dispose();
        }
      })
      .catch(() => undefined);
    trackDisposal(disposal);
    options.onResidencyChanged?.();
    if (entries.size === 0) {
      stopIdleSweep();
    }
  };

  const sweepIdlePipelines = (): void => {
    if (options.isIdleSweepAllowed?.() === false) {
      return;
    }
    const cutoff = readNow() - PIPELINE_IDLE_TIMEOUT_MS;
    const keysToEvict: string[] = [];
    for (const [cacheKey, entry] of entries) {
      if (entry.lastUsedAt < cutoff) {
        keysToEvict.push(cacheKey);
      }
    }
    for (const cacheKey of keysToEvict) {
      disposeEntry(cacheKey, 'idle-timeout');
    }
  };

  const startIdleSweep = (): void => {
    if (idleSweepTimer !== null) {
      return;
    }
    idleSweepTimer = setInterval(sweepIdlePipelines, IDLE_SWEEP_INTERVAL_MS);
  };

  const evictLruByDevice = (
    device: EmbeddingDevice,
    diagnostics: {
      readonly id?: string;
      readonly sink?: PipelineCacheDiagnosticSink;
    }
  ): void => {
    const matching = [...entries.values()].filter((entry) => entry.device === device);
    const maxResident = device === 'webgpu' ? MAX_GPU_PIPELINES : MAX_WASM_PIPELINES;
    if (matching.length < maxResident) {
      return;
    }
    matching.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const evictCount = matching.length - maxResident + 1;
    for (const victim of matching.slice(0, evictCount)) {
      disposeEntry(victim.cacheKey, 'resident-limit', diagnostics);
    }
  };

  const load = async (request: EmbeddingPipelineCacheLoadRequest): Promise<Resource> => {
    if (request.model.length === 0) {
      throw new Error('Embedding pipeline cache requires a non-empty model identifier.');
    }
    if (
      request.estimatedModelBytes !== null &&
      !(Number.isSafeInteger(request.estimatedModelBytes) && request.estimatedModelBytes > 0)
    ) {
      throw new Error('Embedding pipeline cache model bytes must be a positive safe integer.');
    }
    const cacheKey = `${request.model}|${request.device}|${request.dtype}`;
    const existing = entries.get(cacheKey);
    if (existing) {
      if (
        request.estimatedModelBytes !== null &&
        existing.estimatedModelBytes !== null &&
        request.estimatedModelBytes !== existing.estimatedModelBytes
      ) {
        options.onModelSizeEstimateMismatch?.({
          cachedBytes: existing.estimatedModelBytes,
          cacheKey,
          requestedBytes: request.estimatedModelBytes,
        });
      }
      existing.lastUsedAt = readNow();
      emitDiagnostic({
        entry: existing,
        event: 'hit',
        ...(request.diagnostics?.id ? { id: request.diagnostics.id } : {}),
        ...(request.diagnostics?.sink ? { sink: request.diagnostics.sink } : {}),
      });
      return existing.pipeline;
    }

    const pipeline = options.load(request.model, request.device, request.dtype);
    evictLruByDevice(request.device, request.diagnostics ?? {});
    const timestamp = readNow();
    const entry: PipelineCacheEntry<Resource> = {
      cacheKey,
      createdAt: timestamp,
      device: request.device,
      dtype: request.dtype,
      estimatedModelBytes: request.estimatedModelBytes,
      lastUsedAt: timestamp,
      model: request.model,
      pipeline: Promise.resolve(pipeline).then(
        (loaded) => {
          if (entries.get(cacheKey) === entry) {
            emitDiagnostic({
              entry,
              event: 'loaded',
              ...(request.diagnostics?.id ? { id: request.diagnostics.id } : {}),
              ...(request.diagnostics?.sink ? { sink: request.diagnostics.sink } : {}),
            });
          }
          return loaded;
        },
        (error: unknown) => {
          if (entries.get(cacheKey) === entry) {
            entries.delete(cacheKey);
            options.onResidencyChanged?.();
            if (entries.size === 0) {
              stopIdleSweep();
            }
          }
          emitDiagnostic({
            entry,
            event: 'load-failed',
            ...(request.diagnostics?.id ? { id: request.diagnostics.id } : {}),
            ...(request.diagnostics?.sink ? { sink: request.diagnostics.sink } : {}),
          });
          throw error;
        }
      ),
    };
    entries.set(cacheKey, entry);
    startIdleSweep();
    options.onResidencyChanged?.();
    return entry.pipeline;
  };

  const waitForPendingDisposals = async (): Promise<void> => {
    while (pendingDisposals.size > 0) {
      await Promise.all([...pendingDisposals]);
    }
  };

  return {
    close: async (): Promise<void> => {
      stopIdleSweep();
      for (const cacheKey of [...entries.keys()]) {
        disposeEntry(cacheKey, 'manual-dispose');
      }
      await waitForPendingDisposals();
    },
    getResidentEntries: () => buildDiagnosticEntries(readNow()),
    hasResidentDevice: (device) => [...entries.values()].some((entry) => entry.device === device),
    invalidateWebGpuPipelines: () => {
      for (const entry of [...entries.values()]) {
        if (entry.device === 'webgpu') {
          disposeEntry(entry.cacheKey, 'device-lost');
        }
      }
      emitDiagnostic({ event: 'invalidated', reason: 'device-lost' });
    },
    load,
    waitForPendingDisposals,
  };
}
