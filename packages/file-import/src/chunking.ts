import type {
  ChunkingStrategy,
  FileChunk,
  FileImportResult,
  FileRecord,
  FileRecordUpdate,
  IDatabase,
  ResolvedChunkingStrategy,
} from '@brainstrike/db';
import { CHUNKING_CONFIG } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { getChunkingStrategy } from './chunking-strategy';
import type { FileImportChunkRepository, FileImportFileRecordRepository } from './repository-ports';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

export { getChunkingStrategy } from './chunking-strategy';

const logger = createLogger('FileImport:Chunking');

interface ChunkingDeps {
  chunkRepository: FileImportChunkRepository | null;
  repository: FileImportFileRecordRepository | null;
}

interface ChunkingOptions {
  abortSignal?: AbortSignal;
  chunkingStrategy?: ChunkingStrategy;
  chunkingStrategyExplicit?: boolean;
  // Worker port for off-main-thread chunking
  chunkingWorkerPort?: import('./chunking-worker-port').ChunkingWorkerPort;
  chunkOverlap?: number;
  chunkSize?: number;
  // Phase 3: optional queue producer injection
  embedQueueEnabled?: boolean;
  enqueueJobsForChunks?: (chunks: FileChunk[], fileRecordId: string) => Promise<void>;
  enqueueJobsForChunksTx?: (
    tx: IDatabase,
    chunks: FileChunk[],
    fileRecordId: string
  ) => Promise<void>;
  forceStrategy?: boolean;
  /**
   * Keep inserted chunk rows on the returned result.
   * Disable this when the caller only needs counts/side effects to avoid
   * retaining large per-file chunk payloads after insert/enqueue completes.
   */
  retainInsertedChunks?: boolean;
  // Post-review: support transactional enqueue with chunk insert
  runInTransaction?: <T>(fn: (tx: IDatabase) => Promise<T>) => Promise<T>;
  streamBatchSize?: number;
  // Target embedding set ID to associate chunks with a specific collection
  targetEmbeddingSetId?: string;
  tokenLimit?: number;
  tokenTrueSizing?: boolean;
  updateProgress: (
    updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null
  ) => void;
  // Phase 5: opt-in streaming for large files
  useStreamingForLargeFiles?: boolean;
}

// Host-proxy chunking still loads file content in the visible renderer per request,
// so concurrency must stay bounded. Serial execution was too slow for real imports,
// but we also do not allow unbounded fan-out that would recreate the earlier crash.
const MAX_HOST_PROXY_CHUNKING_CONCURRENCY = 4;
const MAX_LOCAL_WORKER_CHUNKING_CONCURRENCY = 10;
const LOCAL_WORKER_RECORD_PREFETCH_WINDOW_MULTIPLIER = 4;

interface ChunkingProgressSnapshot {
  chunksCreated: number;
  filesProcessed: number;
  strategyUsed?: ChunkingStrategy;
  totalFiles: number;
}

function createChunkingProgressScheduler(
  updateProgress: ChunkingOptions['updateProgress'],
  throttleMs = 100
) {
  let pending: ChunkingProgressSnapshot | null = null;
  let timer: NodeJS.Timeout | null = null;

  const emit = (snapshot: ChunkingProgressSnapshot) => {
    updateProgress((prev) =>
      prev
        ? {
            ...prev,
            phase: 'chunking',
            chunkingProgress: (() => {
              const progress: NonNullable<EnhancedImportProgress['chunkingProgress']> = {
                filesProcessed: snapshot.filesProcessed,
                totalFiles: snapshot.totalFiles,
                chunksCreated: snapshot.chunksCreated,
              };
              if (prev.chunkingProgress?.currentFile) {
                progress.currentFile = prev.chunkingProgress.currentFile;
              }
              const strategyUsed = snapshot.strategyUsed ?? prev.chunkingProgress?.strategyUsed;
              if (strategyUsed) {
                progress.strategyUsed = strategyUsed;
              }
              return progress;
            })(),
          }
        : null
    );
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      emit(pending);
      pending = null;
    }
  };

  return {
    schedule(snapshot: ChunkingProgressSnapshot) {
      pending = snapshot;
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          emit(pending);
          pending = null;
        }
      }, throttleMs);
    },
    flush,
  };
}

const CHUNKING_WORKER_READY_TIMEOUT_MS = 5000;
const CHUNKING_WORKER_READY_POLL_MS = 100;

async function waitForChunkingWorkerReady(
  workerPort: NonNullable<ChunkingOptions['chunkingWorkerPort']>,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<void> {
  if (abortSignal?.aborted) {
    const error = new Error('Chunking worker startup was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  if (workerPort.isReady()) {
    return;
  }

  const startWait = Date.now();
  while (!workerPort.isReady() && Date.now() - startWait < timeoutMs) {
    if (abortSignal?.aborted) {
      const error = new Error('Chunking worker startup was aborted.');
      error.name = 'AbortError';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, CHUNKING_WORKER_READY_POLL_MS));
  }

  if (!workerPort.isReady()) {
    throw new Error(`Chunking worker failed to become ready within ${timeoutMs}ms`);
  }
}

function createAbortError(): Error {
  const error = new Error('Chunking was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
}

/**
 * Type guard to check if repository supports transactional insert.
 * Used to safely detect if insertManyWithTx is available.
 */
interface RepoWithTransactionalInsert {
  insertManyWithTx: (t: IDatabase, chunks: FileChunk[]) => Promise<FileChunk[]>;
}

function hasTransactionalInsert(repo: unknown): repo is RepoWithTransactionalInsert {
  return Boolean(
    repo &&
      typeof repo === 'object' &&
      'insertManyWithTx' in repo &&
      typeof (repo as Record<string, unknown>)['insertManyWithTx'] === 'function'
  );
}

async function insertChunksWithTransaction(
  tx: IDatabase,
  chunkRepository: NonNullable<FileImportChunkRepository>,
  chunks: FileChunk[]
): Promise<void> {
  if (hasTransactionalInsert(chunkRepository)) {
    await chunkRepository.insertManyWithTx(tx, chunks);
  } else {
    await chunkRepository.insertMany(chunks);
  }
}

async function updateFileRecordWithChunkInfo(
  repository: NonNullable<FileImportFileRecordRepository>,
  fileId: string,
  chunksCount: number,
  strategy: ResolvedChunkingStrategy
): Promise<void> {
  const update: FileRecordUpdate = {
    chunksProcessedAt: new Date().toISOString(),
    chunksCount,
    chunkingStrategy: strategy,
    updatedAt: new Date().toISOString(),
  };
  await repository.update(fileId, update);
}

interface ChunkingSkipResult {
  chunksCreated: number;
  enhancedResult: EnhancedImportResult;
  strategyUsed: ChunkingStrategy;
}

type ChunkingPreparation =
  | { kind: 'skip'; response: ChunkingSkipResult }
  | {
      kind: 'host-proxy';
      repository: NonNullable<ChunkingDeps['repository']>;
      chunkRepository: NonNullable<ChunkingDeps['chunkRepository']>;
      fileRecordId: string;
    }
  | {
      kind: 'ready';
      repository: NonNullable<ChunkingDeps['repository']>;
      chunkRepository: NonNullable<ChunkingDeps['chunkRepository']>;
      fileRecord: {
        id: string;
        name: string;
        path: string;
        content: string;
      };
      strategy: ChunkingStrategy;
      forceStrategy: boolean;
    };

function createSkipResult(
  result: FileImportResult,
  strategyUsed: ChunkingStrategy
): ChunkingSkipResult {
  return {
    enhancedResult: { ...result, chunksCreated: 0 },
    chunksCreated: 0,
    strategyUsed,
  };
}

async function prepareChunkingExecution(
  result: FileImportResult,
  deps: ChunkingDeps,
  options: ChunkingOptions,
  preFetchedRecord?: FileRecord
): Promise<ChunkingPreparation> {
  throwIfAborted(options.abortSignal);
  const repository = deps.repository;
  const chunkRepository = deps.chunkRepository;
  if (!(repository && chunkRepository)) {
    const error = 'Repository not available';
    logger.error(error, { fileId: result.id });
    throw new Error(error);
  }

  const fallbackStrategy = options.chunkingStrategy ?? 'auto';

  if (!(result.imported || result.existed) || result.error) {
    logger.debug('Skipping file chunking (not imported or has error)', {
      fileId: result.id,
      imported: result.imported,
      existed: result.existed,
      error: result.error,
    });
    return { kind: 'skip', response: createSkipResult(result, fallbackStrategy) };
  }

  if (
    options.chunkingWorkerPort?.transportKind === 'host-proxy' &&
    typeof options.chunkingWorkerPort.chunkFileById === 'function'
  ) {
    return {
      kind: 'host-proxy',
      repository,
      chunkRepository,
      fileRecordId: result.id,
    };
  }

  const fileRecord = preFetchedRecord || (await repository.findById(result.id));
  throwIfAborted(options.abortSignal);
  if (!fileRecord?.content) {
    logger.warn('File record not found or has no content', {
      fileId: result.id,
      hasRecord: !!fileRecord,
      hasContent: !!fileRecord?.content,
    });
    return { kind: 'skip', response: createSkipResult(result, fallbackStrategy) };
  }

  const autoStrategy = getChunkingStrategy(fileRecord.path);
  const requestedStrategy = options.chunkingStrategy;
  const forceRequested = options.forceStrategy === true;
  const hasExplicitRequestedStrategy =
    requestedStrategy !== undefined && requestedStrategy !== 'auto';
  const hasOverride = hasExplicitRequestedStrategy && requestedStrategy !== autoStrategy;
  const strategy = hasExplicitRequestedStrategy ? requestedStrategy : autoStrategy;
  const forceStrategy = forceRequested || hasOverride;

  return {
    kind: 'ready',
    repository,
    chunkRepository,
    fileRecord: {
      id: fileRecord.id,
      name: fileRecord.name,
      path: fileRecord.path,
      content: fileRecord.content,
    },
    strategy,
    forceStrategy,
  };
}

export async function processFileChunking(
  result: FileImportResult,
  index: number,
  totalFiles: number,
  totalChunksCreated: number,
  deps: ChunkingDeps,
  options: ChunkingOptions,
  preFetchedRecord?: FileRecord
): Promise<{
  enhancedResult: EnhancedImportResult;
  chunksCreated: number;
  chunks?: FileChunk[];
  strategyUsed: ChunkingStrategy;
}> {
  throwIfAborted(options.abortSignal);
  const preparation = await prepareChunkingExecution(result, deps, options, preFetchedRecord);
  if (preparation.kind === 'skip') {
    return preparation.response;
  }
  if (preparation.kind === 'host-proxy') {
    return await processFileChunkingHostProxyPath(
      result,
      index,
      totalFiles,
      totalChunksCreated,
      preparation,
      options
    );
  }

  const { repository, chunkRepository, fileRecord, strategy, forceStrategy } = preparation;
  throwIfAborted(options.abortSignal);

  logger.debug('Starting file chunking', {
    fileId: result.id,
    fileName: fileRecord.name,
    filePath: fileRecord.path,
    contentLength: fileRecord.content.length,
    fileIndex: index + 1,
    totalFiles,
  });

  options.updateProgress((prev) =>
    prev
      ? {
          ...prev,
          phase: 'chunking',
          chunkingProgress: {
            filesProcessed: index,
            totalFiles,
            currentFile: fileRecord.name,
            chunksCreated: totalChunksCreated,
          },
        }
      : null
  );

  const chunkSizeOverride = options.chunkSize;
  const chunkOverlapOverride = options.chunkOverlap;
  const hasUserOverrides = chunkSizeOverride !== undefined || chunkOverlapOverride !== undefined;

  const shouldStream =
    !!options.useStreamingForLargeFiles &&
    fileRecord.content.length > CHUNKING_CONFIG.veryLargeContentThreshold;

  // Log which chunking path will be taken
  logger.info('Chunking path decision', {
    fileId: result.id,
    hasWorkerPort: !!options.chunkingWorkerPort,
    workerPortIsReady: options.chunkingWorkerPort?.isReady?.() ?? false,
    shouldStream,
    contentLength: fileRecord.content.length,
  });

  // Use worker if available (preferred path - moves chunking off main thread)
  if (options.chunkingWorkerPort) {
    if (!options.chunkingWorkerPort.isReady()) {
      throw new Error(
        'Chunking worker is not ready at chunk execution time. ' +
          'Failing fast to avoid degraded/fallback import behavior.'
      );
    }
    logger.info('Using WORKER path for chunking', { fileId: result.id });
    throwIfAborted(options.abortSignal);
    const workerResult = await processFileChunkingWorkerPath(
      options.chunkingWorkerPort,
      fileRecord.content,
      result,
      strategy,
      repository,
      chunkRepository,
      fileRecord.name,
      fileRecord.path,
      options,
      forceStrategy,
      hasUserOverrides
    );
    throwIfAborted(options.abortSignal);
    logger.info('File chunked successfully (worker)', {
      fileId: result.id,
      fileName: fileRecord.name,
      chunksCreated: workerResult.chunksCreated,
      requestedStrategy: strategy,
      strategyUsed: workerResult.strategyUsed,
    });
    options.updateProgress((prev) =>
      prev
        ? {
            ...prev,
            phase: 'chunking',
            chunkingProgress: {
              filesProcessed: index + 1,
              totalFiles,
              currentFile: fileRecord.name,
              chunksCreated: totalChunksCreated + workerResult.chunksCreated,
              strategyUsed: workerResult.strategyUsed,
            },
          }
        : null
    );
    return workerResult;
  }

  // CRITICAL: No main-thread fallback allowed. Chunking MUST use the Web Worker.
  // If we reach this point, the worker was not provided.
  // Note: The streaming path is also disabled - it was a main-thread fallback for large files.
  // All chunking MUST go through the worker to prevent UI blocking.
  throw new Error(
    'Chunking worker is required but not available. ' +
      'Main-thread chunking (including streaming) is disabled to prevent UI blocking. ' +
      `File: ${fileRecord.name}, contentLength: ${fileRecord.content.length}, ` +
      `wouldHaveStreamed: ${shouldStream}, ` +
      'chunkingWorkerPort: not provided'
  );
}

async function processFileChunkingHostProxyPath(
  result: FileImportResult,
  index: number,
  totalFiles: number,
  totalChunksCreated: number,
  preparation: Extract<ChunkingPreparation, { kind: 'host-proxy' }>,
  options: ChunkingOptions
): Promise<{
  enhancedResult: EnhancedImportResult;
  chunksCreated: number;
  chunks?: FileChunk[];
  strategyUsed: ChunkingStrategy;
}> {
  throwIfAborted(options.abortSignal);
  const workerPort = options.chunkingWorkerPort;
  if (!(workerPort?.transportKind === 'host-proxy' && workerPort.chunkFileById)) {
    throw new Error('Host-proxy chunking requires chunkFileById support.');
  }

  logger.debug('Starting host-proxy file chunking', {
    fileId: preparation.fileRecordId,
    fileIndex: index + 1,
    totalFiles,
  });

  options.updateProgress((prev) =>
    prev
      ? {
          ...prev,
          phase: 'chunking',
          chunkingProgress: {
            filesProcessed: index,
            totalFiles,
            currentFile: preparation.fileRecordId,
            chunksCreated: totalChunksCreated,
          },
        }
      : null
  );

  const hasUserOverrides = options.chunkSize !== undefined || options.chunkOverlap !== undefined;
  throwIfAborted(options.abortSignal);
  const workerResult = await workerPort.chunkFileById(preparation.fileRecordId, {
    ...(options.chunkingStrategy === undefined
      ? {}
      : { requestedStrategy: options.chunkingStrategy }),
    ...(options.forceStrategy === true ? { forceStrategy: true } : {}),
    ...(hasUserOverrides ? { ignoreFileTypeRecommendations: true } : {}),
    ...(options.chunkSize === undefined ? {} : { maxTokens: options.chunkSize }),
    ...(options.chunkOverlap === undefined ? {} : { overlap: options.chunkOverlap }),
    ...(options.tokenLimit === undefined ? {} : { maxTokensCap: options.tokenLimit }),
    ...(options.tokenTrueSizing === undefined ? {} : { tokenTrueSizing: options.tokenTrueSizing }),
  });

  if (workerResult.skipped) {
    await updateFileRecordWithChunkInfo(
      preparation.repository,
      result.id,
      0,
      workerResult.strategyUsed
    );
    return {
      enhancedResult: {
        ...result,
        chunksCreated: 0,
        error: `Chunking skipped: ${workerResult.skipReason}`,
        chunkingStrategy: workerResult.strategyUsed,
      },
      chunksCreated: 0,
      strategyUsed: workerResult.strategyUsed,
    };
  }

  const { toFileChunkInserts } = await import('./chunking-worker-port');
  const chunks = toFileChunkInserts(result.id, workerResult.chunks, options.targetEmbeddingSetId);
  throwIfAborted(options.abortSignal);
  const shouldUseTransaction =
    options.embedQueueEnabled && options.runInTransaction && options.enqueueJobsForChunksTx;

  if (shouldUseTransaction && options.runInTransaction) {
    await options.runInTransaction(async (tx) => {
      await insertChunksWithTransaction(tx, preparation.chunkRepository, chunks);
      await options.enqueueJobsForChunksTx?.(tx, chunks, result.id);
      return;
    });
  } else {
    await preparation.chunkRepository.insertMany(chunks);
    if (options.embedQueueEnabled && options.enqueueJobsForChunks) {
      throwIfAborted(options.abortSignal);
      await options.enqueueJobsForChunks(chunks, result.id);
    }
  }

  await updateFileRecordWithChunkInfo(
    preparation.repository,
    result.id,
    chunks.length,
    workerResult.strategyUsed
  );

  return {
    enhancedResult: {
      ...result,
      chunksCreated: chunks.length,
      chunkingStrategy: workerResult.strategyUsed,
    },
    chunksCreated: chunks.length,
    ...(options.retainInsertedChunks === false ? {} : { chunks }),
    strategyUsed: workerResult.strategyUsed,
  };
}

/**
 * Process file chunking using the Web Worker (off main thread).
 * This is the preferred path when a worker port is available.
 */
async function processFileChunkingWorkerPath(
  workerPort: NonNullable<ChunkingOptions['chunkingWorkerPort']>,
  content: string,
  result: FileImportResult,
  strategy: ChunkingStrategy,
  repository: NonNullable<FileImportFileRecordRepository>,
  chunkRepository: NonNullable<FileImportChunkRepository>,
  fileName: string,
  filePath: string,
  options: ChunkingOptions,
  forceStrategy: boolean,
  hasUserOverrides: boolean
): Promise<{
  enhancedResult: EnhancedImportResult;
  chunksCreated: number;
  chunks?: FileChunk[];
  strategyUsed: ChunkingStrategy;
}> {
  throwIfAborted(options.abortSignal);
  const { toFileChunkInserts } = await import('./chunking-worker-port');

  // Build worker options, only including defined properties
  const workerOptions: import('@brainstrike/chunking-worker').ChunkingRequestOptions = {
    strategy,
    forceStrategy,
    ignoreFileTypeRecommendations: hasUserOverrides,
    ...(options.chunkSize === undefined ? {} : { maxTokens: options.chunkSize }),
    ...(options.chunkOverlap === undefined ? {} : { overlap: options.chunkOverlap }),
    ...(options.tokenLimit === undefined ? {} : { maxTokensCap: options.tokenLimit }),
  };

  // Call worker to chunk content
  const workerResult = await workerPort.chunkFile(
    result.id,
    content,
    fileName,
    filePath,
    workerOptions
  );

  if (workerResult.skipped) {
    logger.warn('Chunking skipped for file (worker)', {
      fileId: result.id,
      fileName,
      skipReason: workerResult.skipReason,
    });
    await updateFileRecordWithChunkInfo(repository, result.id, 0, workerResult.strategyUsed);
    return {
      enhancedResult: {
        ...result,
        chunksCreated: 0,
        error: `Chunking skipped: ${workerResult.skipReason}`,
        chunkingStrategy: workerResult.strategyUsed,
      },
      chunksCreated: 0,
      strategyUsed: workerResult.strategyUsed,
    };
  }

  // Convert portable chunks to database inserts
  const chunks = toFileChunkInserts(result.id, workerResult.chunks, options.targetEmbeddingSetId);
  throwIfAborted(options.abortSignal);

  // Insert chunks into database (on main thread)
  const shouldUseTransaction =
    options.embedQueueEnabled && options.runInTransaction && options.enqueueJobsForChunksTx;

  if (shouldUseTransaction && options.runInTransaction) {
    await options.runInTransaction(async (tx) => {
      await insertChunksWithTransaction(tx, chunkRepository, chunks);
      await options.enqueueJobsForChunksTx?.(tx, chunks, result.id);
      return;
    });
  } else {
    await chunkRepository.insertMany(chunks);
    if (options.embedQueueEnabled && options.enqueueJobsForChunks) {
      throwIfAborted(options.abortSignal);
      await options.enqueueJobsForChunks(chunks, result.id);
    }
  }

  await updateFileRecordWithChunkInfo(
    repository,
    result.id,
    chunks.length,
    workerResult.strategyUsed
  );

  return {
    enhancedResult: {
      ...result,
      chunksCreated: chunks.length,
      chunkingStrategy: workerResult.strategyUsed,
    },
    chunksCreated: chunks.length,
    ...(options.retainInsertedChunks === false ? {} : { chunks }),
    strategyUsed: workerResult.strategyUsed,
  };
}

/**
 * Process up to `concurrency` promises in parallel, with backpressure.
 * Returns results in original order.
 */
async function parallelLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    const promise = (async (index: number) => {
      results[index] = await fn(items[index] as T, index);
    })(i);

    const execution = promise.finally(() => {
      executing.delete(execution);
    });

    executing.add(execution);

    if (executing.size >= concurrency) {
      try {
        await Promise.race(executing);
      } catch (error) {
        await Promise.allSettled(executing);
        throw error;
      }
    }
  }

  await Promise.all(executing);
  return results;
}

function createChunkingProgressAccumulator(
  schedule: (update: {
    chunksCreatedDelta: number;
    strategyUsed: ChunkingStrategy;
  }) => Promise<void>
): (update: { chunksCreatedDelta: number; strategyUsed: ChunkingStrategy }) => Promise<void> {
  let chain = Promise.resolve();

  return async (update) => {
    chain = chain.then(() => schedule(update));
    await chain;
  };
}

export async function processChunking(
  importResults: FileImportResult[],
  deps: ChunkingDeps,
  options: ChunkingOptions & {
    enableEmbedding?: boolean;
    processEmbeddings?: (chunks: FileChunk[], result: EnhancedImportResult) => Promise<void>;
  }
): Promise<EnhancedImportResult[]> {
  const { repository, chunkRepository } = deps;
  if (!(repository && chunkRepository)) {
    options.updateProgress((prev) => prev);
    throw new Error('Repository not available for chunking');
  }

  const chunkingWorkerPort = options.chunkingWorkerPort;
  throwIfAborted(options.abortSignal);
  if (!chunkingWorkerPort) {
    throw new Error(
      'Chunking worker is required for imports but was not provided. ' +
        'Main-thread chunking fallback is disabled.'
    );
  }
  if (!chunkingWorkerPort.isReady()) {
    logger.info('Waiting for chunking worker to be ready before starting chunking phase');
    await waitForChunkingWorkerReady(
      chunkingWorkerPort,
      CHUNKING_WORKER_READY_TIMEOUT_MS,
      options.abortSignal
    );
  }

  const isHostProxyTransport = chunkingWorkerPort.transportKind === 'host-proxy';
  const fileProcessingOptions: ChunkingOptions = {
    ...options,
    retainInsertedChunks:
      options.retainInsertedChunks ?? Boolean(options.enableEmbedding && options.processEmbeddings),
  };

  // Determine concurrency based on environment and file count
  const ChunkingConcurrency = Math.min(
    isHostProxyTransport
      ? MAX_HOST_PROXY_CHUNKING_CONCURRENCY
      : MAX_LOCAL_WORKER_CHUNKING_CONCURRENCY,
    Math.max(1, Math.floor(importResults.length / 10))
  );

  logger.info('Starting parallel chunking', {
    totalFiles: importResults.length,
    concurrency: ChunkingConcurrency,
    transportKind: chunkingWorkerPort.transportKind,
  });

  let totalChunksCreated = 0;
  let filesProcessed = 0;
  const progressScheduler = createChunkingProgressScheduler(options.updateProgress);
  const recordProgress = createChunkingProgressAccumulator(async (update) => {
    totalChunksCreated += update.chunksCreatedDelta;
    filesProcessed += 1;
    progressScheduler.schedule({
      filesProcessed,
      totalFiles: importResults.length,
      chunksCreated: totalChunksCreated,
      strategyUsed: update.strategyUsed,
    });
  });

  // CRITICAL: No per-file fallback. A single chunking failure means import state is inconsistent.
  // Fail fast so we do not spam repeated worker/database errors across the whole selection.
  // This guard prevents "degraded mode" behavior where thousands of files continue after root failure.
  const enhancedResults: EnhancedImportResult[] = [];
  const prefetchWindowSize = isHostProxyTransport
    ? importResults.length
    : Math.max(ChunkingConcurrency * LOCAL_WORKER_RECORD_PREFETCH_WINDOW_MULTIPLIER, 1);

  for (
    let sliceStart = 0;
    sliceStart < importResults.length;
    sliceStart += Math.max(prefetchWindowSize, 1)
  ) {
    throwIfAborted(options.abortSignal);
    const sliceEnd = Math.min(sliceStart + Math.max(prefetchWindowSize, 1), importResults.length);
    const importResultsSlice = importResults.slice(sliceStart, sliceEnd);
    let recordsMap: Map<string, FileRecord> | undefined;

    if (!isHostProxyTransport) {
      const validResults = importResultsSlice.filter(
        (result): result is FileImportResult =>
          Boolean(result) && (result.imported || result.existed) && !result.error
      );
      const ids = validResults.map((result) => result.id);
      if (ids.length > 0) {
        const batchFetchStart = Date.now();
        const records = await repository.findByIds(ids);
        throwIfAborted(options.abortSignal);
        const batchFetchDuration = Date.now() - batchFetchStart;
        recordsMap = new Map(records.map((record) => [record.id, record]));
        logger.debug('Window-fetched file records for chunking', {
          count: records.length,
          requested: ids.length,
          durationMs: batchFetchDuration,
          sliceStart,
          sliceEnd,
        });
      }
    }

    const sliceResults = await parallelLimit(
      importResultsSlice,
      ChunkingConcurrency,
      async (result, offset) => {
        throwIfAborted(options.abortSignal);
        if (!result) {
          return null;
        }

        const absoluteIndex = sliceStart + offset;
        const preFetchedRecord = recordsMap?.get(result.id);
        const { enhancedResult, chunksCreated, chunks, strategyUsed } = await processFileChunking(
          result,
          absoluteIndex,
          importResults.length,
          totalChunksCreated,
          deps,
          fileProcessingOptions,
          preFetchedRecord
        );

        if (options.enableEmbedding && options.processEmbeddings && chunks && chunks.length > 0) {
          throwIfAborted(options.abortSignal);
          await options.processEmbeddings(chunks, enhancedResult);
        }

        await recordProgress({
          chunksCreatedDelta: chunksCreated,
          strategyUsed,
        });

        return enhancedResult;
      }
    );

    enhancedResults.push(
      ...sliceResults.filter((result): result is EnhancedImportResult => result !== null)
    );
  }

  logger.info('Parallel chunking complete', {
    totalFiles: enhancedResults.length,
    totalChunks: totalChunksCreated,
    filesWithErrors: enhancedResults.filter((r) => r.error).length,
  });

  progressScheduler.flush();

  options.updateProgress((prev) =>
    prev
      ? {
          ...prev,
          phase: 'complete',
          chunkingProgress: {
            filesProcessed: importResults.length,
            totalFiles: importResults.length,
            chunksCreated: totalChunksCreated,
          },
        }
      : null
  );

  return enhancedResults;
}
