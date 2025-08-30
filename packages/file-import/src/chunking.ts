import type { ChunkingStrategy, FileChunk, FileImportResult } from '@brainstrike/db';
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
    await repository.update(result.id, {
      chunksProcessedAt: new Date().toISOString(),
      chunksCount: 0,
      chunkingStrategy: strategy,
      updatedAt: new Date().toISOString(),
    });
    return {
      enhancedResult: {
        ...result,
        chunksCreated: 0,
        error: `Chunking skipped: ${chunkingResult.skipReason}`,
      },
      chunksCreated: 0,
    };
  }

  await chunkRepository.insertMany(chunkingResult.chunks);
  await repository.update(result.id, {
    chunksProcessedAt: new Date().toISOString(),
    chunksCount: chunkingResult.chunks.length,
    chunkingStrategy: strategy,
    updatedAt: new Date().toISOString(),
  });

  // Phase 3: enqueue embedding jobs after chunk insert (if provided)
  if (options.embedQueueEnabled && options.enqueueJobsForChunks) {
    await options.enqueueJobsForChunks(chunkingResult.chunks, result.id);
  }

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
