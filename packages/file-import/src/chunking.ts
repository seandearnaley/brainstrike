import type {
  ChunkingResult,
  ChunkingStrategy,
  FileChunk,
  FileChunkInsert,
  FileImportResult,
  IDatabase,
} from '@brainstrike/db';
import { CHUNKING_CONFIG, ChunkingService } from '@brainstrike/db';
import { countTokensAccurate, createLogger, fileExplorer } from '@brainstrike/utils';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

const logger = createLogger('FileImport:Chunking');

export function getChunkingStrategy(
  filePath: string,
  defaultStrategy?: ChunkingStrategy
): ChunkingStrategy {
  if (defaultStrategy) return defaultStrategy;

  const extension = fileExplorer.getFileExtension(filePath);
  const codeExtensions = [
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.py',
    '.java',
    '.cpp',
    '.c',
    '.h',
    '.cs',
    '.php',
    '.rb',
    '.go',
    '.rs',
  ];

  if (codeExtensions.includes(extension)) {
    return 'recursive';
  }

  return 'sentence';
}

interface ChunkingDeps {
  repository: ReturnType<typeof import('@brainstrike/db').useFileRecordRepository> | null;
  chunkRepository: ReturnType<typeof import('@brainstrike/db').useFileChunkRepository> | null;
}

interface ChunkingOptions {
  chunkingStrategy?: ChunkingStrategy;
  chunkingStrategyExplicit?: boolean;
  chunkSize?: number;
  chunkOverlap?: number;
  forceStrategy?: boolean;
  updateProgress: (
    updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null
  ) => void;
  tokenTrueSizing?: boolean;
  tokenLimit?: number;
  // Target embedding set ID to associate chunks with a specific collection
  targetEmbeddingSetId?: string;
  // Phase 3: optional queue producer injection
  embedQueueEnabled?: boolean;
  enqueueJobsForChunks?: (chunks: FileChunk[], fileRecordId: string) => Promise<void>;
  // Post-review: support transactional enqueue with chunk insert
  runInTransaction?: <T>(fn: (tx: IDatabase) => Promise<T>) => Promise<T>;
  enqueueJobsForChunksTx?: (
    tx: IDatabase,
    chunks: FileChunk[],
    fileRecordId: string
  ) => Promise<void>;
  // Phase 5: opt-in streaming for large files
  useStreamingForLargeFiles?: boolean;
  streamBatchSize?: number;
}

type ChunkingProgressSnapshot = {
  filesProcessed: number;
  totalFiles: number;
  chunksCreated: number;
  strategyUsed?: ChunkingStrategy;
};

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
      if (timer) return;
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

async function handleChunkInsertion(
  chunkRepository: NonNullable<ReturnType<typeof import('@brainstrike/db').useFileChunkRepository>>,
  chunkingResult: ChunkingResult,
  options: ChunkingOptions,
  result: FileImportResult
): Promise<void> {
  // Apply embeddingSetId to chunks if targetEmbeddingSetId is provided (matches streaming path)
  const setId = options.targetEmbeddingSetId;
  const chunksWithSetId: FileChunkInsert[] = setId
    ? chunkingResult.chunks.map((chunk) => ({
        ...chunk,
        embeddingSetId: setId,
      }))
    : chunkingResult.chunks;

  const shouldUseTransaction =
    options.embedQueueEnabled && options.runInTransaction && options.enqueueJobsForChunksTx;

  if (shouldUseTransaction && options.runInTransaction) {
    await options.runInTransaction(async (tx) => {
      await insertChunksWithTransaction(tx, chunkRepository, chunksWithSetId);
      await options.enqueueJobsForChunksTx?.(tx, chunksWithSetId, result.id);
      return undefined as unknown as undefined;
    });
  } else {
    await chunkRepository.insertMany(chunksWithSetId);
    if (options.embedQueueEnabled && options.enqueueJobsForChunks) {
      await options.enqueueJobsForChunks(chunksWithSetId, result.id);
    }
  }
}

async function insertChunksWithTransaction(
  tx: IDatabase,
  chunkRepository: NonNullable<ReturnType<typeof import('@brainstrike/db').useFileChunkRepository>>,
  chunks: FileChunk[]
): Promise<void> {
  const repoAny = chunkRepository as unknown as {
    insertManyWithTx?: (t: IDatabase, chunks: FileChunk[]) => Promise<FileChunk[]>;
    insertMany: (chunks: FileChunk[]) => Promise<FileChunk[]>;
  };

  if (typeof repoAny.insertManyWithTx === 'function') {
    await repoAny.insertManyWithTx(tx, chunks);
  } else {
    await repoAny.insertMany(chunks);
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

type ChunkingSkipResult = {
  enhancedResult: EnhancedImportResult;
  chunksCreated: number;
  strategyUsed: ChunkingStrategy;
};

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
  options: ChunkingOptions
): Promise<ChunkingPreparation> {
  const repository = deps.repository;
  const chunkRepository = deps.chunkRepository;
  if (!repository || !chunkRepository) {
    const error = 'Repository not available';
    logger.error(error, { fileId: result.id });
    throw new Error(error);
  }

  const fallbackStrategy = options.chunkingStrategy ?? 'sentence';

  if ((!result.imported && !result.existed) || result.error) {
    logger.debug('Skipping file chunking (not imported or has error)', {
      fileId: result.id,
      imported: result.imported,
      existed: result.existed,
      error: result.error,
    });
    return { kind: 'skip', response: createSkipResult(result, fallbackStrategy) };
  }

  const fileRecord = await repository.findById(result.id);
  if (!fileRecord || !fileRecord.content) {
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
  options: ChunkingOptions
): Promise<{
  enhancedResult: EnhancedImportResult;
  chunksCreated: number;
  chunks?: FileChunk[];
  strategyUsed: ChunkingStrategy;
}> {
  const preparation = await prepareChunkingExecution(result, deps, options);
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

  const chunkingService = new ChunkingService();
  const chunkSizeOverride = options.chunkSize;
  const chunkOverlapOverride = options.chunkOverlap;
  const hasUserOverrides = chunkSizeOverride !== undefined || chunkOverlapOverride !== undefined;
  const tokenTrueSizingEnabled = options.tokenTrueSizing ?? true;

  const shouldStream =
    !!options.useStreamingForLargeFiles &&
    fileRecord.content.length > CHUNKING_CONFIG.veryLargeContentThreshold;

  if (shouldStream) {
    const streamed = await processFileChunkingStreamPath(
      chunkingService,
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
    logger.info('File chunked successfully (streaming)', {
      fileId: result.id,
      fileName: fileRecord.name,
      chunksCreated: streamed.chunksCreated,
      requestedStrategy: strategy,
      strategyUsed: streamed.strategyUsed,
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
              chunksCreated: totalChunksCreated + streamed.chunksCreated,
              strategyUsed: streamed.strategyUsed,
            },
          }
        : null
    );
    return streamed;
  }

  const chunkingResult = await chunkingService.chunkContent(fileRecord.content, result.id, {
    strategy,
    ...(chunkSizeOverride !== undefined ? { maxTokens: chunkSizeOverride } : {}),
    ...(chunkOverlapOverride !== undefined ? { overlap: chunkOverlapOverride } : {}),
    fileName: fileRecord.name,
    filePath: fileRecord.path,
    forceStrategy,
    ignoreFileTypeRecommendations: hasUserOverrides,
    tokenTrueSizing: tokenTrueSizingEnabled,
    ...(options.tokenLimit !== undefined ? { maxTokensCap: options.tokenLimit } : {}),
    ...(tokenTrueSizingEnabled ? { tokenCounter: countTokensAccurate } : {}),
  });

  if (chunkingResult.skipped) {
    logger.warn('Chunking skipped for file', {
      fileId: result.id,
      fileName: fileRecord.name,
      skipReason: chunkingResult.skipReason,
    });
    await updateFileRecordWithChunkInfo(repository, result.id, 0, chunkingResult.strategyUsed);
    options.updateProgress((prev) =>
      prev
        ? {
            ...prev,
            phase: 'chunking',
            chunkingProgress: {
              filesProcessed: index + 1,
              totalFiles,
              currentFile: fileRecord.name,
              chunksCreated: totalChunksCreated,
              strategyUsed: chunkingResult.strategyUsed,
            },
          }
        : null
    );
    return {
      enhancedResult: {
        ...result,
        chunksCreated: 0,
        error: `Chunking skipped: ${chunkingResult.skipReason}`,
        chunkingStrategy: chunkingResult.strategyUsed,
      },
      chunksCreated: 0,
      strategyUsed: chunkingResult.strategyUsed,
    };
  }

  logger.info('File chunked successfully', {
    fileId: result.id,
    fileName: fileRecord.name,
    chunksCreated: chunkingResult.chunks.length,
    requestedStrategy: strategy,
    strategyUsed: chunkingResult.strategyUsed,
  });

  await handleChunkInsertion(chunkRepository, chunkingResult, options, result);
  await updateFileRecordWithChunkInfo(
    repository,
    result.id,
    chunkingResult.chunks.length,
    chunkingResult.strategyUsed
  );

  options.updateProgress((prev) =>
    prev
      ? {
          ...prev,
          phase: 'chunking',
          chunkingProgress: {
            filesProcessed: index + 1,
            totalFiles,
            currentFile: fileRecord.name,
            chunksCreated: totalChunksCreated + chunkingResult.chunks.length,
            strategyUsed: chunkingResult.strategyUsed,
          },
        }
      : null
  );

  return {
    enhancedResult: {
      ...result,
      chunksCreated: chunkingResult.chunks.length,
      chunkingStrategy: chunkingResult.strategyUsed,
    },
    chunksCreated: chunkingResult.chunks.length,
    chunks: chunkingResult.chunks,
    strategyUsed: chunkingResult.strategyUsed,
  };
}

async function processFileChunkingStreamPath(
  chunkingService: ChunkingService,
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
  strategyUsed: ChunkingStrategy;
}> {
  const tokenTrueSizingEnabled = options.tokenTrueSizing ?? true;
  /**
   * Maximum chunks per batch to prevent excessive memory usage.
   * Caps streamBatchSize overrides to balance memory efficiency and insertion performance.
   */
  const MaxBatchSize = 1000;
  const requestedBatchSize = options.streamBatchSize ?? 250;
  const batchSize = Math.max(1, Math.min(requestedBatchSize, MaxBatchSize));
  let resolvedStrategy: ChunkingStrategy = strategy;
  const stream = chunkingService.chunkContentStream(content, result.id, {
    strategy,
    ...(options.chunkSize !== undefined ? { maxTokens: options.chunkSize } : {}),
    ...(options.chunkOverlap !== undefined ? { overlap: options.chunkOverlap } : {}),
    fileName,
    filePath,
    allowLargeFiles: true,
    forceStrategy,
    ignoreFileTypeRecommendations: hasUserOverrides,
    tokenTrueSizing: tokenTrueSizingEnabled,
    ...(options.tokenLimit !== undefined ? { maxTokensCap: options.tokenLimit } : {}),
    ...(tokenTrueSizingEnabled ? { tokenCounter: countTokensAccurate } : {}),
    onStrategyResolved: (s) => {
      resolvedStrategy = s;
    },
  });

  let totalCreated = 0;
  const batch: FileChunkInsert[] = [];
  let chunkCount = 0;
  for await (const ch of stream) {
    // Set embedding_set_id on chunk if targetEmbeddingSetId is provided
    const chunkWithSetId: FileChunkInsert = options.targetEmbeddingSetId
      ? { ...ch, embeddingSetId: options.targetEmbeddingSetId }
      : ch;

    // Debug log first chunk to verify embeddingSetId is set
    if (chunkCount === 0) {
      logger.info('[DEBUG] First chunk embeddingSetId', {
        targetEmbeddingSetId: options.targetEmbeddingSetId,
        chunkEmbeddingSetId: chunkWithSetId.embeddingSetId,
        fileRecordId: result.id,
      });
    }
    chunkCount++;

    batch.push(chunkWithSetId);
    if (batch.length >= batchSize) {
      totalCreated += await flushBatch(batch, chunkRepository, options, result.id);
    }
  }

  if (batch.length > 0) {
    totalCreated += await flushBatch(batch, chunkRepository, options, result.id);
  }

  await updateFileRecordWithChunkInfo(repository, result.id, totalCreated, resolvedStrategy);
  return {
    enhancedResult: {
      ...result,
      chunksCreated: totalCreated,
      chunkingStrategy: resolvedStrategy,
    },
    chunksCreated: totalCreated,
    strategyUsed: resolvedStrategy,
  };
}

async function flushBatch(
  batch: FileChunkInsert[],
  chunkRepository: { insertMany: (chunks: FileChunkInsert[]) => Promise<FileChunk[]> },
  options: ChunkingOptions,
  fileRecordId: string
): Promise<number> {
  const inserted = await chunkRepository.insertMany(batch);
  if (options.embedQueueEnabled && options.enqueueJobsForChunks) {
    await options.enqueueJobsForChunks(inserted, fileRecordId);
  }
  batch.length = 0;
  return inserted.length;
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

    const execution = promise.then(() => {
      executing.splice(executing.indexOf(execution), 1);
    });

    executing.push(execution);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
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
  if (!repository || !chunkRepository) {
    options.updateProgress((prev) => prev);
    throw new Error('Repository not available for chunking');
  }

  // Determine concurrency based on environment and file count
  const ChunkingConcurrency = Math.min(
    10, // Max 10 files at once to avoid overwhelming the system
    Math.max(1, Math.floor(importResults.length / 10)) // Scale with file count
  );

  logger.info('Starting parallel chunking', {
    totalFiles: importResults.length,
    concurrency: ChunkingConcurrency,
  });

  let totalChunksCreated = 0;
  let filesProcessed = 0;
  const progressScheduler = createChunkingProgressScheduler(options.updateProgress);

  // Process files in parallel with concurrency limit
  const allResults = await parallelLimit(importResults, ChunkingConcurrency, async (result, i) => {
    if (!result) {
      return null; // Mark for filtering
    }

    try {
      const { enhancedResult, chunksCreated, chunks, strategyUsed } = await processFileChunking(
        result,
        i,
        importResults.length,
        totalChunksCreated,
        deps,
        options
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`Chunking failed for file ${result.id}:`, {
        error: errorMessage,
        stack: errorStack,
        filePath: result.id,
        fileIndex: i,
        totalFiles: importResults.length,
      });
      filesProcessed++;
      progressScheduler.schedule({
        filesProcessed,
        totalFiles: importResults.length,
        chunksCreated: totalChunksCreated,
      });
      return {
        id: result.id,
        imported: result.imported,
        existed: result.existed,
        error: `Chunking failed: ${errorMessage}`,
        chunksCreated: 0,
      };
    }
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
