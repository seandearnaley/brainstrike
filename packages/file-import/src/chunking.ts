import type {
  ChunkingStrategy,
  FileChunk,
  FileImportResult,
  FileRecord,
  IDatabase,
} from '@brainstrike/db';
import { CHUNKING_CONFIG } from '@brainstrike/db';
import { createLogger, fileExplorer } from '@brainstrike/utils';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

const logger = createLogger('FileImport:Chunking');

export function getChunkingStrategy(
  filePath: string,
  defaultStrategy?: ChunkingStrategy
): ChunkingStrategy {
  if (defaultStrategy) {
    return defaultStrategy;
  }

  const extension = fileExplorer.getFileExtension(filePath);
  const codeExtensions = [
    'js',
    'ts',
    'jsx',
    'tsx',
    'py',
    'java',
    'cpp',
    'c',
    'h',
    'cs',
    'php',
    'rb',
    'go',
    'rs',
  ];

  if (codeExtensions.includes(extension)) {
    return 'recursive';
  }

  return 'sentence';
}

interface ChunkingDeps {
  chunkRepository: ReturnType<typeof import('@brainstrike/db').useFileChunkRepository> | null;
  repository: ReturnType<typeof import('@brainstrike/db').useFileRecordRepository> | null;
}

interface ChunkingOptions {
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

const MAX_HOST_PROXY_CHUNKING_CONCURRENCY = 1;
const MAX_LOCAL_WORKER_CHUNKING_CONCURRENCY = 10;

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
  timeoutMs: number
): Promise<void> {
  if (workerPort.isReady()) {
    return;
  }

  const startWait = Date.now();
  while (!workerPort.isReady() && Date.now() - startWait < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, CHUNKING_WORKER_READY_POLL_MS));
  }

  if (!workerPort.isReady()) {
    throw new Error(`Chunking worker failed to become ready within ${timeoutMs}ms`);
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
  chunkRepository: NonNullable<ReturnType<typeof import('@brainstrike/db').useFileChunkRepository>>,
  chunks: FileChunk[]
): Promise<void> {
  if (hasTransactionalInsert(chunkRepository)) {
    await chunkRepository.insertManyWithTx(tx, chunks);
  } else {
    await chunkRepository.insertMany(chunks);
  }
}

async function updateFileRecordWithChunkInfo(
  repository: NonNullable<ReturnType<typeof import('@brainstrike/db').useFileRecordRepository>>,
  fileId: string,
  chunksCount: number,
  strategy: ChunkingStrategy
): Promise<void> {
  await repository.update(fileId, {
    chunksProcessedAt: new Date().toISOString(),
    chunksCount,
    chunkingStrategy: strategy,
    updatedAt: new Date().toISOString(),
  });
}

interface ChunkingSkipResult {
  chunksCreated: number;
  enhancedResult: EnhancedImportResult;
  strategyUsed: ChunkingStrategy;
}

type ChunkingPreparation =
  | { kind: 'skip'; response: ChunkingSkipResult }
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
  const repository = deps.repository;
  const chunkRepository = deps.chunkRepository;
  if (!(repository && chunkRepository)) {
    const error = 'Repository not available';
    logger.error(error, { fileId: result.id });
    throw new Error(error);
  }

  const fallbackStrategy = options.chunkingStrategy ?? 'sentence';

  if (!(result.imported || result.existed) || result.error) {
    logger.debug('Skipping file chunking (not imported or has error)', {
      fileId: result.id,
      imported: result.imported,
      existed: result.existed,
      error: result.error,
    });
    return { kind: 'skip', response: createSkipResult(result, fallbackStrategy) };
  }

  const fileRecord = preFetchedRecord || (await repository.findById(result.id));
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
  const hasOverride = requestedStrategy !== undefined && requestedStrategy !== autoStrategy;
  const strategy = requestedStrategy ?? autoStrategy ?? 'sentence';
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
  const preparation = await prepareChunkingExecution(result, deps, options, preFetchedRecord);
  if (preparation.kind === 'skip') {
    return preparation.response;
  }

  const { repository, chunkRepository, fileRecord, strategy, forceStrategy } = preparation;

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

/**
 * Process file chunking using the Web Worker (off main thread).
 * This is the preferred path when a worker port is available.
 */
async function processFileChunkingWorkerPath(
  workerPort: NonNullable<ChunkingOptions['chunkingWorkerPort']>,
  content: string,
  result: FileImportResult,
  strategy: ChunkingStrategy,
  repository: NonNullable<ReturnType<typeof import('@brainstrike/db').useFileRecordRepository>>,
  chunkRepository: NonNullable<ReturnType<typeof import('@brainstrike/db').useFileChunkRepository>>,
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
  const { toFileChunkInserts } = await import('./chunking-worker-port');

  // Build worker options, only including defined properties
  const workerOptions: import('@brainstrike/chunking-worker').ChunkingRequestOptions = {
    strategy,
    forceStrategy,
    ignoreFileTypeRecommendations: hasUserOverrides,
    ...(options.chunkSize !== undefined ? { maxTokens: options.chunkSize } : {}),
    ...(options.chunkOverlap !== undefined ? { overlap: options.chunkOverlap } : {}),
    ...(options.tokenLimit !== undefined ? { maxTokensCap: options.tokenLimit } : {}),
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

  // Insert chunks into database (on main thread)
  const shouldUseTransaction =
    options.embedQueueEnabled && options.runInTransaction && options.enqueueJobsForChunksTx;

  if (shouldUseTransaction && options.runInTransaction) {
    await options.runInTransaction(async (tx) => {
      await insertChunksWithTransaction(tx, chunkRepository, chunks);
      await options.enqueueJobsForChunksTx?.(tx, chunks, result.id);
      return undefined as unknown as undefined;
    });
  } else {
    await chunkRepository.insertMany(chunks);
    if (options.embedQueueEnabled && options.enqueueJobsForChunks) {
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
    chunks,
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
  const executing: Promise<void>[] = [];

  for (let i = 0; i < items.length; i++) {
    const promise = (async (index: number) => {
      results[index] = await fn(items[index] as T, index);
    })(i);

    const execution = promise.finally(() => {
      executing.splice(executing.indexOf(execution), 1);
    });

    executing.push(execution);

    if (executing.length >= concurrency) {
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
  if (!chunkingWorkerPort) {
    throw new Error(
      'Chunking worker is required for imports but was not provided. ' +
        'Main-thread chunking fallback is disabled.'
    );
  }
  if (!chunkingWorkerPort.isReady()) {
    logger.info('Waiting for chunking worker to be ready before starting chunking phase');
    await waitForChunkingWorkerReady(chunkingWorkerPort, CHUNKING_WORKER_READY_TIMEOUT_MS);
  }

  const isHostProxyTransport = chunkingWorkerPort.transportKind === 'host-proxy';

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

  // Avoid materializing every imported file's content in the visible renderer when
  // chunking is proxied to the hidden desktop host. In that mode, on-demand lookup
  // keeps renderer heap bounded even for large import sets.
  let recordsMap: Map<string, FileRecord> | undefined;
  const validResults = importResults.filter(
    (r): r is FileImportResult => Boolean(r) && (r.imported || r.existed) && !r.error
  );
  const ids = validResults.map((r) => r.id);
  if (!isHostProxyTransport && ids.length > 0) {
    const batchFetchStart = Date.now();
    const records = await repository.findByIds(ids);
    const batchFetchDuration = Date.now() - batchFetchStart;
    recordsMap = new Map(records.map((r) => [r.id, r]));
    logger.debug('Batch fetched file records', {
      count: records.length,
      requested: ids.length,
      durationMs: batchFetchDuration,
    });
  } else if (isHostProxyTransport && ids.length > 0) {
    logger.debug('Skipped batch file-record prefetch for host-proxy chunking transport', {
      requested: ids.length,
      transportKind: chunkingWorkerPort.transportKind,
    });
  }

  // CRITICAL: No per-file fallback. A single chunking failure means import state is inconsistent.
  // Fail fast so we do not spam repeated worker/database errors across the whole selection.
  // This guard prevents "degraded mode" behavior where thousands of files continue after root failure.
  // Process files in parallel with concurrency limit
  const allResults = await parallelLimit(importResults, ChunkingConcurrency, async (result, i) => {
    if (!result) {
      return null; // Mark for filtering
    }
    const preFetchedRecord = recordsMap?.get(result.id);
    const { enhancedResult, chunksCreated, chunks, strategyUsed } = await processFileChunking(
      result,
      i,
      importResults.length,
      totalChunksCreated,
      deps,
      options,
      preFetchedRecord
    );

    if (options.enableEmbedding && options.processEmbeddings && chunks && chunks.length > 0) {
      await options.processEmbeddings(chunks, enhancedResult);
    }

    totalChunksCreated += chunksCreated;
    filesProcessed++;
    progressScheduler.schedule({
      filesProcessed,
      totalFiles: importResults.length,
      chunksCreated: totalChunksCreated,
      strategyUsed,
    });

    return enhancedResult;
  });

  // Filter out null results (from undefined inputs)
  const enhancedResults = allResults.filter((r): r is EnhancedImportResult => r !== null);

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
