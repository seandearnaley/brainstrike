import type { ChunkingStrategy, FileChunk, FileImportResult, FileRecord } from '@brainstrike/db';
import {
  CHUNKING_CONFIG,
  ChunkingService,
  useFileChunkRepository,
  useFileRecordRepository,
} from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type { IFileNode } from '@brainstrike/types';
import type { ImportProgress } from '@brainstrike/ui';
import { createLogger, fileExplorer } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFileImportService } from './base-file-import-service';

const logger = createLogger('EnhancedFileImport');

// Extended progress interface for chunking and embedding
interface EnhancedImportProgress extends ImportProgress {
  phase: 'importing' | 'chunking' | 'embedding' | 'complete';
  chunkingProgress?: {
    filesProcessed: number;
    totalFiles: number;
    currentFile?: string | undefined;
    chunksCreated: number;
  };
  embeddingProgress?: {
    chunksProcessed: number;
    totalChunks: number;
    currentChunk?: string | undefined;
    modelName: string;
  };
}

interface EnhancedFileImportOptions {
  onProgress?: (progress: EnhancedImportProgress) => void;
  onComplete?: (results: EnhancedImportResult[]) => void;
  onError?: (error: Error) => void;
  enableChunking?: boolean;
  chunkingStrategy?: ChunkingStrategy;
  enableEmbedding?: boolean;
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

interface EnhancedImportResult {
  id: string;
  imported: boolean;
  existed: boolean;
  error?: string;
  chunksCreated: number;
  chunksWithEmbeddings?: number;
}

interface EnhancedFileImportServiceReturn {
  importFiles: (
    selectedFilePaths: Set<string>,
    fileTree: IFileNode[],
    fileContents: Record<string, string>
  ) => Promise<void>;
  isImporting: boolean;
  progress: EnhancedImportProgress | null;
  chunkRepository: ReturnType<typeof useFileChunkRepository>;
}

export function useEnhancedFileImportService(
  options: EnhancedFileImportOptions = {}
): EnhancedFileImportServiceReturn {
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<EnhancedImportProgress | null>(null);
  const [embeddingService, setEmbeddingService] = useState<SimpleEmbeddingService | null>(null);

  const repository = useFileRecordRepository();
  const chunkRepository = useFileChunkRepository();

  // Initialize embedding service if enabled
  useEffect(() => {
    if (options.enableEmbedding && options.embeddingModel) {
      const service = new SimpleEmbeddingService();
      setEmbeddingService(service);
    }
  }, [options.enableEmbedding, options.embeddingModel]);

  const baseImportService = useFileImportService({
    onProgress: (progress) => {
      setProgress((prev) =>
        prev
          ? {
              ...prev,
              phase: 'importing',
              total: progress.total,
              completed: progress.completed,
              current: progress.current || '',
              errors: progress.errors,
            }
          : {
              phase: 'importing',
              total: progress.total,
              completed: progress.completed,
              current: progress.current || '',
              errors: progress.errors,
            }
      );
    },
    onComplete: async (results) => {
      if (options.enableChunking) {
        await processChunking(results);
      } else {
        options.onComplete?.(results.map((r) => ({ ...r, chunksCreated: 0 })));
      }
    },
    onError: options.onError || (() => {}),
  });

  const validateChunkingPrerequisites = (result: FileImportResult) => {
    if (!repository || !chunkRepository) {
      logger.error('Repository not available', {
        repository: !!repository,
        chunkRepository: !!chunkRepository,
      });
      throw new Error('Repository not available');
    }

    // Skip only if the file wasn't imported AND didn't exist, OR if there was an error
    if ((!result.imported && !result.existed) || result.error) {
      logger.debug(`Skipping file ${result.id} - failed to import or has error`, {
        imported: result.imported,
        existed: result.existed,
        error: result.error,
      });
      return false;
    }
    return true;
  };

  const updateChunkingProgress = (
    index: number,
    totalFiles: number,
    fileName: string,
    totalChunksCreated: number
  ) => {
    setProgress((prev) =>
      prev
        ? {
            ...prev,
            phase: 'chunking',
            chunkingProgress: {
              filesProcessed: index,
              totalFiles,
              currentFile: fileName,
              chunksCreated: totalChunksCreated,
            },
          }
        : null
    );
  };

  const handleSkippedChunking = async (
    result: FileImportResult,
    strategy: ChunkingStrategy,
    chunkingResult: { skipReason?: string }
  ) => {
    const now = new Date().toISOString();
    await repository?.update(result.id, {
      chunksProcessedAt: now,
      chunksCount: 0,
      chunkingStrategy: strategy,
      updatedAt: now,
    });
    return {
      enhancedResult: {
        ...result,
        chunksCreated: 0,
        error: `Chunking skipped: ${chunkingResult.skipReason}`,
      },
      chunksCreated: 0,
    };
  };

  const processSuccessfulChunking = async (
    result: FileImportResult,
    strategy: ChunkingStrategy,
    chunkingResult: { chunks: FileChunk[] }
  ) => {
    logger.debug(`Inserting ${chunkingResult.chunks.length} chunks into database`);
    await chunkRepository?.insertMany(chunkingResult.chunks);

    const now = new Date().toISOString();
    logger.debug('Updating file record with chunk metadata');
    await repository?.update(result.id, {
      chunksProcessedAt: now,
      chunksCount: chunkingResult.chunks.length,
      chunkingStrategy: strategy,
      updatedAt: now,
    });

    return {
      enhancedResult: { ...result, chunksCreated: chunkingResult.chunks.length },
      chunksCreated: chunkingResult.chunks.length,
      chunks: chunkingResult.chunks,
    };
  };

  const executeChunkingOperation = async (
    fileRecord: FileRecord & { content: string },
    result: FileImportResult,
    strategy: ChunkingStrategy
  ) => {
    const chunkingService = new ChunkingService();
    logger.debug('Starting chunking with options', {
      strategy,
      maxTokens: options.chunkSize || CHUNKING_CONFIG.defaultMaxTokens,
      overlap: options.chunkOverlap || CHUNKING_CONFIG.defaultOverlap,
      fileName: fileRecord.name,
      filePath: fileRecord.path,
    });

    const chunkingResult = await chunkingService.chunkContent(fileRecord.content, result.id, {
      strategy,
      maxTokens: options.chunkSize || CHUNKING_CONFIG.defaultMaxTokens,
      overlap: options.chunkOverlap || CHUNKING_CONFIG.defaultOverlap,
      fileName: fileRecord.name,
      filePath: fileRecord.path,
    });

    logger.debug('Chunking result', {
      skipped: chunkingResult.skipped,
      skipReason: chunkingResult.skipReason,
      chunksCount: chunkingResult.chunks.length,
      totalTokens: chunkingResult.totalTokens,
      avgTokensPerChunk: chunkingResult.avgTokensPerChunk,
    });

    if (chunkingResult.skipped) {
      logger.debug(`Chunking was skipped for ${fileRecord.name}: ${chunkingResult.skipReason}`);
      return await handleSkippedChunking(result, strategy, chunkingResult);
    }

    logger.debug(
      `Successfully processed ${chunkingResult.chunks.length} chunks for ${fileRecord.name}`
    );
    return await processSuccessfulChunking(result, strategy, chunkingResult);
  };

  const processFileChunking = async (
    result: FileImportResult,
    index: number,
    totalFiles: number,
    totalChunksCreated: number
  ): Promise<{
    enhancedResult: EnhancedImportResult;
    chunksCreated: number;
    chunks?: FileChunk[];
  }> => {
    logger.debug(
      `Starting processFileChunking for file ${index + 1}/${totalFiles}, ID: ${result.id}`
    );

    if (!validateChunkingPrerequisites(result)) {
      return { enhancedResult: { ...result, chunksCreated: 0 }, chunksCreated: 0 };
    }

    logger.debug(`Looking up file record for ID: ${result.id}`);
    const fileRecord = await repository?.findById(result.id);
    if (!fileRecord || !fileRecord.content) {
      logger.warn('File record not found or has no content', {
        found: !!fileRecord,
        hasContent: fileRecord?.content ? fileRecord.content.length : 0,
      });
      return { enhancedResult: { ...result, chunksCreated: 0 }, chunksCreated: 0 };
    }

    logger.debug(
      `Found file record: ${fileRecord.name}, content length: ${fileRecord.content.length}`
    );

    updateChunkingProgress(index, totalFiles, fileRecord.name, totalChunksCreated);

    const strategy = getChunkingStrategy(fileRecord.path, options.chunkingStrategy);
    logger.debug(`Using chunking strategy: ${strategy} for file: ${fileRecord.name}`);

    try {
      return await executeChunkingOperation(
        fileRecord as FileRecord & { content: string },
        result,
        strategy
      );
    } catch (chunkingError) {
      logger.error(`Chunking failed for ${fileRecord.name}`, chunkingError);
      throw chunkingError;
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex but necessary for file import orchestration
  const processChunking = async (importResults: FileImportResult[]) => {
    logger.debug(`Starting processChunking for ${importResults.length} import results`);

    if (!repository || !chunkRepository) {
      logger.error('Repository not available for chunking', {
        repository: !!repository,
        chunkRepository: !!chunkRepository,
      });
      options.onError?.(new Error('Repository not available for chunking'));
      return;
    }

    const enhancedResults: EnhancedImportResult[] = [];
    let totalChunksCreated = 0;

    for (let i = 0; i < importResults.length; i++) {
      const result = importResults[i];
      if (!result) {
        logger.warn(`Skipping undefined result at index ${i}`);
        continue;
      }

      logger.debug(`Processing file ${i + 1}/${importResults.length}: ${result.id}`);

      try {
        const { enhancedResult, chunksCreated, chunks } = await processFileChunking(
          result,
          i,
          importResults.length,
          totalChunksCreated
        );

        if (options.enableEmbedding && chunks && chunks.length > 0) {
          logger.debug(`Processing embeddings for ${chunks.length} chunks`);
          await processEmbeddings(chunks, enhancedResult);
        } else if (options.enableEmbedding) {
          logger.debug(`Embedding enabled but no chunks to process for file: ${result.id}`);
        }

        enhancedResults.push(enhancedResult);
        totalChunksCreated += chunksCreated;
        logger.debug(
          `File ${result.id} processed successfully. Total chunks so far: ${totalChunksCreated}`
        );
      } catch (error) {
        logger.error(`ERROR processing file ${result.id}`, error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Full error details', {
          name: error instanceof Error ? error.name : 'Unknown',
          message: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        });

        enhancedResults.push({
          id: result.id,
          imported: result.imported,
          existed: result.existed,
          error: `Chunking failed: ${errorMessage}`,
          chunksCreated: 0,
        });
      }
    }

    setProgress((prev) =>
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

    options.onComplete?.(enhancedResults);
  };

  const getChunkingStrategy = useCallback(
    (filePath: string, defaultStrategy?: ChunkingStrategy): ChunkingStrategy => {
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
    },
    []
  );

  const initializeEmbeddingService = async (): Promise<boolean> => {
    if (!embeddingService || !options.embeddingModel) return false;

    const status = embeddingService.getStatus();
    if (status === 'ready') return true;

    try {
      await embeddingService.initializeWithModel(options.embeddingModel);
      await new Promise((resolve) =>
        setTimeout(resolve, CHUNKING_CONFIG.embeddingInitializationDelay)
      );
      return true;
    } catch {
      return false;
    }
  };

  const processChunkEmbedding = async (chunk: FileChunk): Promise<boolean> => {
    if (!embeddingService || !chunkRepository) return false;

    try {
      if (embeddingService.getStatus() !== 'ready') return false;

      const embeddingResult = await embeddingService.generateEmbedding(chunk.content);
      await chunkRepository.update({
        id: chunk.id,
        embedding: embeddingResult.embedding,
        updatedAt: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      // Skip chunks that fail embedding generation
      if (
        error instanceof Error &&
        (error.message.includes('invalid data location') ||
          error.message.includes('webgpu') ||
          error.message.includes('tensor'))
      ) {
        return false;
      }
      throw error;
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex but necessary for embedding generation
  const processEmbeddings = async (chunks: FileChunk[], result: EnhancedImportResult) => {
    if (!embeddingService || !chunkRepository || !options.embeddingModel) {
      return;
    }

    try {
      const initialized = await initializeEmbeddingService();
      if (!initialized) {
        result.error = 'Embedding initialization failed';
        return;
      }

      let chunksWithEmbeddings = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;

        setProgress((prev) =>
          prev
            ? {
                ...prev,
                phase: 'embedding',
                embeddingProgress: {
                  chunksProcessed: i,
                  totalChunks: chunks.length,
                  currentChunk: `${chunk.content.substring(0, CHUNKING_CONFIG.chunkPreviewLength)}...`,
                  modelName: options.embeddingModel || 'default',
                },
              }
            : null
        );

        const success = await processChunkEmbedding(chunk);
        if (success) chunksWithEmbeddings++;

        if (i < chunks.length - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, CHUNKING_CONFIG.embeddingProcessingDelay)
          );
        }
      }

      result.chunksWithEmbeddings = chunksWithEmbeddings;
    } catch (error) {
      result.error = `Embedding failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  };

  const importFiles = useCallback(
    async (
      selectedFilePaths: Set<string>,
      fileTree: IFileNode[],
      fileContents: Record<string, string>
    ) => {
      setIsImporting(true);

      const initialProgress: EnhancedImportProgress = {
        total: selectedFilePaths.size,
        completed: 0,
        errors: [],
        phase: 'importing',
      };

      setProgress(initialProgress);

      try {
        await baseImportService.importFiles(selectedFilePaths, fileTree, fileContents);
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error('Import failed'));
      } finally {
        setIsImporting(false);
      }
    },
    [baseImportService, options]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (embeddingService) {
        embeddingService.dispose();
      }
    };
  }, [embeddingService]);

  return useMemo(
    () => ({
      importFiles,
      isImporting,
      progress,
      chunkRepository,
    }),
    [importFiles, isImporting, progress, chunkRepository]
  );
}
