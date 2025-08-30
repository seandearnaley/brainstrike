import type {
  ChunkingResult,
  ChunkingStrategy,
  FileChunk,
  FileImportResult,
  IDatabase,
} from '@brainstrike/db';
import { CHUNKING_CONFIG, ChunkingService } from '@brainstrike/db';
import { fileExplorer } from '@brainstrike/utils';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

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
  chunkSize?: number;
  chunkOverlap?: number;
  updateProgress: (
    updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null
  ) => void;
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
}

async function handleChunkInsertion(
  chunkRepository: NonNullable<ReturnType<typeof import('@brainstrike/db').useFileChunkRepository>>,
  chunkingResult: ChunkingResult,
  options: ChunkingOptions,
  result: FileImportResult
): Promise<void> {
  const shouldUseTransaction =
    options.embedQueueEnabled && options.runInTransaction && options.enqueueJobsForChunksTx;

  if (shouldUseTransaction && options.runInTransaction) {
    await options.runInTransaction(async (tx) => {
      await insertChunksWithTransaction(tx, chunkRepository, chunkingResult.chunks);
      await options.enqueueJobsForChunksTx?.(tx, chunkingResult.chunks, result.id);
      return undefined as unknown as undefined;
    });
  } else {
    await chunkRepository.insertMany(chunkingResult.chunks);
    if (options.embedQueueEnabled && options.enqueueJobsForChunks) {
      await options.enqueueJobsForChunks(chunkingResult.chunks, result.id);
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

export async function processFileChunking(
  result: FileImportResult,
  index: number,
  totalFiles: number,
  totalChunksCreated: number,
  deps: ChunkingDeps,
  options: ChunkingOptions
): Promise<{ enhancedResult: EnhancedImportResult; chunksCreated: number; chunks?: FileChunk[] }> {
  const { repository, chunkRepository } = deps;
  if (!repository || !chunkRepository) {
    throw new Error('Repository not available');
  }

  if ((!result.imported && !result.existed) || result.error) {
    return { enhancedResult: { ...result, chunksCreated: 0 }, chunksCreated: 0 };
  }

  const fileRecord = await repository.findById(result.id);
  if (!fileRecord || !fileRecord.content) {
    return { enhancedResult: { ...result, chunksCreated: 0 }, chunksCreated: 0 };
  }

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

  const strategy = getChunkingStrategy(fileRecord.path, options.chunkingStrategy);
  const chunkingService = new ChunkingService();

  const chunkingResult = await chunkingService.chunkContent(fileRecord.content, result.id, {
    strategy,
    maxTokens: options.chunkSize || CHUNKING_CONFIG.defaultMaxTokens,
    overlap: options.chunkOverlap || CHUNKING_CONFIG.defaultOverlap,
    fileName: fileRecord.name,
    filePath: fileRecord.path,
  });

  if (chunkingResult.skipped) {
    await updateFileRecordWithChunkInfo(repository, result.id, 0, strategy);
    return {
      enhancedResult: {
        ...result,
        chunksCreated: 0,
        error: `Chunking skipped: ${chunkingResult.skipReason}`,
      },
      chunksCreated: 0,
    };
  }

  await handleChunkInsertion(chunkRepository, chunkingResult, options, result);
  await updateFileRecordWithChunkInfo(
    repository,
    result.id,
    chunkingResult.chunks.length,
    strategy
  );

  return {
    enhancedResult: { ...result, chunksCreated: chunkingResult.chunks.length },
    chunksCreated: chunkingResult.chunks.length,
    chunks: chunkingResult.chunks,
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
  if (!repository || !chunkRepository) {
    options.updateProgress((prev) => prev);
    throw new Error('Repository not available for chunking');
  }

  const enhancedResults: EnhancedImportResult[] = [];
  let totalChunksCreated = 0;

  for (let i = 0; i < importResults.length; i++) {
    const result = importResults[i];
    if (!result) continue;

    try {
      const { enhancedResult, chunksCreated, chunks } = await processFileChunking(
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

      enhancedResults.push(enhancedResult);
      totalChunksCreated += chunksCreated;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      enhancedResults.push({
        id: result.id,
        imported: result.imported,
        existed: result.existed,
        error: `Chunking failed: ${errorMessage}`,
        chunksCreated: 0,
      });
    }
  }

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
