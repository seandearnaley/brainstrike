import type { ChunkingStrategy, FileChunk, FileImportResult } from '@brainstrike/db';
import { ChunkingService, FileChunkRepository, useFileRecordRepository } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type { IFileNode } from '@brainstrike/types';
import type { ImportProgress } from '@brainstrike/ui';
import { fileExplorer } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import { useCallback, useMemo, useState } from 'react';
import { useFileImportService } from './file-import-service';

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
  chunkRepository: FileChunkRepository | null;
}

export function useEnhancedFileImportService(
  options: EnhancedFileImportOptions = {}
): EnhancedFileImportServiceReturn {
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<EnhancedImportProgress | null>(null);
  const [chunkRepository, setChunkRepository] = useState<FileChunkRepository | null>(null);
  const [embeddingService, setEmbeddingService] = useState<SimpleEmbeddingService | null>(null);

  const repository = useFileRecordRepository();

  // Initialize chunk repository when database is available
  useMemo(() => {
    if (repository) {
      // TODO: This is a temporary solution until FileChunkRepository is abstracted
      // to work with IDatabase interface like other repositories
      const fileRecordRepo = repository as unknown as { db?: unknown };
      if (fileRecordRepo.db) {
        const chunkRepo = new FileChunkRepository(fileRecordRepo.db as PGlite);
        setChunkRepository(chunkRepo);
      }
    }
  }, [repository]);

  // Initialize embedding service if enabled
  useMemo(() => {
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

  const updateChunkingProgress = useCallback(
    (filesProcessed: number, totalFiles: number, currentFile?: string, chunksCreated?: number) => {
      setProgress((prev) =>
        prev
          ? {
              ...prev,
              phase: 'chunking',
              chunkingProgress: {
                filesProcessed,
                totalFiles,
                currentFile: currentFile || undefined,
                chunksCreated: chunksCreated || 0,
              },
            }
          : null
      );
    },
    []
  );

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

  const processFileChunking = useCallback(
    async (
      result: FileImportResult,
      fileIndex: number,
      totalFiles: number,
      totalChunksCreated: number
    ): Promise<{
      enhancedResult: EnhancedImportResult;
      chunksCreated: number;
      chunks?: FileChunk[];
    }> => {
      if (!repository || !chunkRepository) {
        throw new Error('Repository not available for chunking');
      }

      if (!result.imported || result.error) {
        return { enhancedResult: { ...result, chunksCreated: 0 }, chunksCreated: 0 };
      }

      // Get the file record to access its content
      const fileRecord = await repository.findById(result.id);
      if (!fileRecord || !fileRecord.content) {
        return { enhancedResult: { ...result, chunksCreated: 0 }, chunksCreated: 0 };
      }

      updateChunkingProgress(fileIndex, totalFiles, fileRecord.name, totalChunksCreated);

      // Determine chunking strategy based on file type
      const strategy = getChunkingStrategy(fileRecord.path, options.chunkingStrategy);

      // Chunk the content
      const chunkingService = new ChunkingService();
      const chunkingResult = await chunkingService.chunkContent(fileRecord.content, result.id, {
        strategy,
        maxTokens: options.chunkSize || 3000, // Optimal for Jina and modern embeddings
        overlap: options.chunkOverlap || 300, // 10% overlap
        fileName: fileRecord.name,
        filePath: fileRecord.path,
      });

      // Handle skipped files
      if (chunkingResult.skipped) {
        // Update file record to indicate chunking was skipped
        const now = new Date().toISOString();
        await repository.update(result.id, {
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
          chunks: [],
        };
      }

      // Insert chunks into database
      await chunkRepository.insertMany(chunkingResult.chunks);

      // Update file record with chunking metadata
      const now = new Date().toISOString();
      await repository.update(result.id, {
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
    },
    [
      repository,
      chunkRepository,
      updateChunkingProgress,
      options.chunkingStrategy,
      options.chunkSize,
      options.chunkOverlap,
      getChunkingStrategy,
    ]
  );

  const validateChunkingPrerequisites = (): boolean => {
    if (!repository || !chunkRepository) {
      options.onError?.(new Error('Repository not available for chunking'));
      return false;
    }
    return true;
  };

  const processResultChunking = async (
    result: FileImportResult,
    index: number,
    totalResults: number,
    currentTotalChunks: number
  ): Promise<{
    enhancedResult: EnhancedImportResult;
    chunksCreated: number;
    chunks?: FileChunk[];
  }> => {
    const { enhancedResult, chunksCreated, chunks } = await processFileChunking(
      result,
      index,
      totalResults,
      currentTotalChunks
    );
    return { enhancedResult, chunksCreated, ...(chunks && { chunks }) };
  };

  const handleChunkingError = (result: FileImportResult, error: unknown): EnhancedImportResult => {
    return {
      id: result.id,
      imported: result.imported,
      existed: result.existed,
      error: `Chunking failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      chunksCreated: 0,
    };
  };

  const finalizeChunkingProgress = (totalFiles: number, totalChunksCreated: number): void => {
    setProgress((prev) =>
      prev
        ? {
            ...prev,
            phase: 'complete',
            chunkingProgress: {
              filesProcessed: totalFiles,
              totalFiles: totalFiles,
              chunksCreated: totalChunksCreated,
            },
          }
        : null
    );
  };

  const processSingleImportResult = async (
    result: FileImportResult,
    index: number,
    totalResults: number,
    currentTotalChunks: number,
    enhancedResults: EnhancedImportResult[]
  ): Promise<number> => {
    try {
      const { enhancedResult, chunksCreated, chunks } = await processResultChunking(
        result,
        index,
        totalResults,
        currentTotalChunks
      );

      enhancedResults.push(enhancedResult);

      // Process embeddings if enabled
      if (options.enableEmbedding && chunks && chunks.length > 0) {
        const currentResult = enhancedResults[enhancedResults.length - 1];
        if (currentResult) {
          await processEmbeddings(chunks, currentResult);
        }
      }

      return chunksCreated;
    } catch (error) {
      enhancedResults.push(handleChunkingError(result, error));
      return 0;
    }
  };

  const processChunking = async (importResults: FileImportResult[]) => {
    if (!validateChunkingPrerequisites()) {
      return;
    }

    updateChunkingProgress(0, importResults.length, undefined, 0);

    const enhancedResults: EnhancedImportResult[] = [];
    let totalChunksCreated = 0;

    for (let i = 0; i < importResults.length; i++) {
      const result = importResults[i];
      if (!result) continue;

      const chunksCreated = await processSingleImportResult(
        result,
        i,
        importResults.length,
        totalChunksCreated,
        enhancedResults
      );
      totalChunksCreated += chunksCreated;
    }

    finalizeChunkingProgress(importResults.length, totalChunksCreated);
    options.onComplete?.(enhancedResults);
  };

  const initializeEmbeddingService = useCallback(async (): Promise<boolean> => {
    if (!embeddingService || !options.embeddingModel) {
      return false;
    }

    const status = embeddingService.getStatus();
    if (status === 'ready') {
      return true;
    }

    try {
      await embeddingService.initializeWithModel(options.embeddingModel || 'all-MiniLM-L6-v2');
      // Wait a bit after initialization to ensure the service is fully ready
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    } catch (initError) {
      options.onError?.(
        initError instanceof Error ? initError : new Error('Embedding initialization failed')
      );
      return false;
    }
  }, [embeddingService, options.embeddingModel, options.onError]);

  const processChunkEmbedding = useCallback(
    async (chunk: FileChunk): Promise<boolean> => {
      if (!embeddingService || !chunkRepository) {
        return false;
      }

      // Double-check service is ready before generating embedding
      if (embeddingService.getStatus() !== 'ready') {
        return false;
      }

      try {
        // Generate embedding for chunk with error handling for WebGPU issues
        let embeddingResult: { embedding: number[] };
        try {
          embeddingResult = await embeddingService.generateEmbedding(chunk.content);
        } catch (tensorError) {
          if (
            tensorError instanceof Error &&
            (tensorError.message.includes('invalid data location') ||
              tensorError.message.includes('webgpu') ||
              tensorError.message.includes('tensor'))
          ) {
            // WebGPU tensor error, skip this chunk
            return false;
          }
          throw tensorError; // Re-throw other errors
        }

        // Update chunk with embedding
        await chunkRepository.update({
          id: chunk.id,
          embedding: embeddingResult.embedding,
          updatedAt: new Date().toISOString(),
        });

        return true;
      } catch {
        // Failed to generate embedding for this chunk
        return false;
      }
    },
    [embeddingService, chunkRepository]
  );

  const updateEmbeddingProgress = useCallback(
    (chunksProcessed: number, totalChunks: number, currentChunk?: string) => {
      setProgress((prev) =>
        prev
          ? {
              ...prev,
              phase: 'embedding',
              embeddingProgress: {
                chunksProcessed,
                totalChunks,
                currentChunk,
                modelName: options.embeddingModel || 'default',
              },
            }
          : null
      );
    },
    [options.embeddingModel]
  );

  const validateEmbeddingPrerequisites = (): boolean => {
    return !(!embeddingService || !chunkRepository || !options.embeddingModel);
  };

  const processChunkBatch = async (
    chunks: FileChunk[],
    startIndex: number,
    endIndex: number
  ): Promise<number> => {
    let successCount = 0;

    for (let i = startIndex; i < endIndex && i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;

      updateEmbeddingProgress(i, chunks.length, `${chunk.content.substring(0, 50)}...`);

      const success = await processChunkEmbedding(chunk);
      if (success) {
        successCount++;
      }

      // Small delay between embeddings to avoid overwhelming the service
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    return successCount;
  };

  const handleEmbeddingError = (result: EnhancedImportResult, error: unknown): void => {
    result.error = `Embedding failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    options.onError?.(error instanceof Error ? error : new Error('Embedding processing failed'));
  };

  const processEmbeddings = async (chunks: FileChunk[], result: EnhancedImportResult) => {
    if (!validateEmbeddingPrerequisites()) {
      return;
    }

    updateEmbeddingProgress(0, chunks.length);

    try {
      // Initialize embedding service if not already done
      const initialized = await initializeEmbeddingService();
      if (!initialized) {
        result.error = 'Embedding initialization failed';
        return;
      }

      const chunksWithEmbeddings = await processChunkBatch(chunks, 0, chunks.length);
      result.chunksWithEmbeddings = chunksWithEmbeddings;
    } catch (error) {
      handleEmbeddingError(result, error);
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
  useMemo(() => {
    return () => {
      if (embeddingService) {
        embeddingService.dispose();
      }
      // ChunkingService cleanup is not needed as we create instances per operation
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
