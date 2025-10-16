import type {
  ChunkingStrategy,
  ElectronFileChunkRepository,
  FileChunkRepository,
} from '@brainstrike/db';
import { useFileExplorer, useSelectionManager } from '@brainstrike/file-explorer-ui';
import type { QueueAdapter } from '@brainstrike/queue';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEnhancedFileImportService } from './enhanced-file-import-service';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

export interface UseImportFlowOptions {
  importSettings: {
    enableChunking: boolean;
    chunkingStrategy: ChunkingStrategy;
    enableEmbedding: boolean;
    selectedModel: string | null;
    chunkSize: number;
    chunkOverlap: number;
  };
  toast: ReturnType<typeof useToast>['toast'];
  onImportComplete?: (results: EnhancedImportResult[]) => Promise<void> | void;
  onChunkRepositoryChange?: (
    repository: FileChunkRepository | ElectronFileChunkRepository | null
  ) => void;
  embeddingQueue?: QueueAdapter | null;
}

export interface UseImportFlowResult {
  handleImportClick: () => void;
  isImporting: boolean;
  progress: EnhancedImportProgress | null;
  showImportProgress: boolean;
  setShowImportProgress: (show: boolean) => void;
  selectedFileCount: number;
  chunkRepository: FileChunkRepository | ElectronFileChunkRepository | null;
}

export function useImportFlow({
  importSettings,
  toast,
  onImportComplete,
  onChunkRepositoryChange,
  embeddingQueue,
}: UseImportFlowOptions): UseImportFlowResult {
  const [showImportProgress, setShowImportProgress] = useState(false);
  const { fileContents, fileTree } = useFileExplorer();
  const { selectedFilePaths } = useSelectionManager({
    onSelectionLimitExceeded: () => {
      toast({
        title: 'Selection Limit Reached',
        description: 'You have reached the maximum number of files that can be selected.',
        variant: 'destructive',
      });
    },
  });

  const onImportCompleteRef = useRef(onImportComplete);
  useEffect(() => {
    onImportCompleteRef.current = onImportComplete;
  }, [onImportComplete]);

  const { isImporting, progress, importFiles, chunkRepository } = useEnhancedFileImportService({
    onProgress: () => setShowImportProgress(true),
    onComplete: async (results) => {
      await onImportCompleteRef.current?.(results);
    },
    onError: (error) => {
      toast({
        title: 'Import Failed',
        description: error.message,
        variant: 'destructive',
      });
    },
    enableChunking: importSettings.enableChunking,
    chunkingStrategy: importSettings.chunkingStrategy,
    enableEmbedding: importSettings.enableEmbedding,
    ...(importSettings.selectedModel ? { embeddingModel: importSettings.selectedModel } : {}),
    chunkSize: importSettings.chunkSize,
    chunkOverlap: importSettings.chunkOverlap,
    embeddingQueue: embeddingQueue ?? null,
  });

  useEffect(() => {
    onChunkRepositoryChange?.(chunkRepository ?? null);
  }, [chunkRepository, onChunkRepositoryChange]);

  const handleImportClick = useCallback(() => {
    if (selectedFilePaths.size === 0) {
      toast({
        title: 'No Files Selected',
        description: 'Please select files in the explorer before importing.',
        variant: 'destructive',
      });
      return;
    }

    void importFiles(selectedFilePaths, fileTree, fileContents);
  }, [selectedFilePaths, fileTree, fileContents, importFiles, toast]);

  const memoizedProgress = useMemo(() => progress as EnhancedImportProgress | null, [progress]);

  return {
    handleImportClick,
    isImporting,
    progress: memoizedProgress,
    showImportProgress,
    setShowImportProgress,
    selectedFileCount: selectedFilePaths.size,
    chunkRepository: chunkRepository ?? null,
  };
}
