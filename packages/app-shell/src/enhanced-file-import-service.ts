import type { ChunkingStrategy } from '@brainstrike/db';
import { useFileChunkRepository, useFileRecordRepository } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type { EnhancedImportProgress, EnhancedImportResult } from '@brainstrike/file-import';
import { processChunking, processEmbeddings } from '@brainstrike/file-import';
import type { IFileNode } from '@brainstrike/types';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFileImportService } from './base-file-import-service';

// Extended progress interface for chunking and embedding
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
        try {
          const enhanced = await processChunking(
            results,
            { repository, chunkRepository },
            {
              ...(options.chunkingStrategy !== undefined && {
                chunkingStrategy: options.chunkingStrategy,
              }),
              ...(options.chunkSize !== undefined && { chunkSize: options.chunkSize }),
              ...(options.chunkOverlap !== undefined && { chunkOverlap: options.chunkOverlap }),
              updateProgress: setProgress,
              ...(options.enableEmbedding !== undefined && {
                enableEmbedding: options.enableEmbedding,
              }),
              processEmbeddings: async (chunks, result) => {
                await processEmbeddings(
                  chunks,
                  result,
                  chunkRepository,
                  embeddingService,
                  options.embeddingModel,
                  setProgress
                );
              },
            }
          );
          options.onComplete?.(enhanced);
        } catch (error) {
          options.onError?.(error instanceof Error ? error : new Error('Chunking failed'));
        }
      } else {
        options.onComplete?.(results.map((r) => ({ ...r, chunksCreated: 0 })));
      }
    },
    onError: options.onError || (() => {}),
  });

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
