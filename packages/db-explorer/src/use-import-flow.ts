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
import { getActiveEmbeddingSetId } from './vector-preferences';

export type UseImportFlowOptions = {
  importSettings: {
    enableChunking: boolean;
    chunkingStrategy: ChunkingStrategy;
    chunkingStrategyExplicit: boolean;
    chunkSize: number;
    chunkOverlap: number;
    tokenTrueSizing: boolean;
    chunkTokenLimit: number;
  };
  toast: ReturnType<typeof useToast>['toast'];
  onImportComplete?: (results: EnhancedImportResult[]) => Promise<void> | void;
  onChunkRepositoryChange?: (
    repository: FileChunkRepository | ElectronFileChunkRepository | null
  ) => void;
  embeddingQueue?: QueueAdapter | null;
  resolveActiveCollectionId?: () => string | null;
};

export type UseImportFlowResult = {
  handleImportClick: () => void;
  isImporting: boolean;
  progress: EnhancedImportProgress | null;
  showImportProgress: boolean;
  setShowImportProgress: (show: boolean) => void;
  selectedFileCount: number;
  chunkRepository: FileChunkRepository | ElectronFileChunkRepository | null;
};

export function useImportFlow({
  importSettings,
  toast,
  onImportComplete,
  onChunkRepositoryChange,
  embeddingQueue,
  resolveActiveCollectionId,
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

  const resolveCollectionId = useCallback(
    () => resolveActiveCollectionId?.() ?? getActiveEmbeddingSetId(),
    [resolveActiveCollectionId]
  );

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
    chunkingStrategyExplicit: importSettings.chunkingStrategyExplicit,
    chunkSize: importSettings.chunkSize,
    chunkOverlap: importSettings.chunkOverlap,
    tokenTrueSizing: importSettings.tokenTrueSizing,
    chunkTokenLimit: importSettings.chunkTokenLimit,
    embeddingQueue: embeddingQueue ?? null,
    resolveTargetEmbeddingSetId: resolveCollectionId,
  });

  useEffect(() => {
    onChunkRepositoryChange?.(chunkRepository ?? null);
  }, [chunkRepository, onChunkRepositoryChange]);

  const showDestructiveToast = useCallback(
    (title: string, description: string) => {
      toast({
        title,
        description,
        variant: 'destructive',
      });
    },
    [toast]
  );

  const ensureSelection = useCallback((): boolean => {
    if (selectedFilePaths.size > 0) {
      return true;
    }

    showDestructiveToast(
      'No Files Selected',
      'Please select files in the explorer before importing.'
    );
    return false;
  }, [selectedFilePaths, showDestructiveToast]);

  const ensureCollectionSelected = useCallback((): boolean => {
    const collectionId = resolveCollectionId();
    if (collectionId) {
      return true;
    }

    showDestructiveToast(
      'Select a Collection',
      'Choose a search collection before importing files.'
    );
    return false;
  }, [resolveCollectionId, showDestructiveToast]);

  const runImport = useCallback(async () => {
    if (!ensureSelection()) {
      return;
    }
    if (!ensureCollectionSelected()) {
      return;
    }

    await importFiles(selectedFilePaths, fileTree, fileContents);
  }, [
    ensureSelection,
    ensureCollectionSelected,
    fileContents,
    fileTree,
    importFiles,
    selectedFilePaths,
  ]);

  const handleImportClick = useCallback(() => {
    void runImport();
  }, [runImport]);

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
