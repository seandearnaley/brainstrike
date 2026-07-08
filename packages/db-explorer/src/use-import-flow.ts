import type {
  ChunkingStrategy,
  DrizzleFileChunkRepository,
  ElectronFileChunkRepository,
} from '@brainstrike/db';
import { useFileExplorer, useSelectionManager } from '@brainstrike/file-explorer-ui/shell';
import type { QueueAdapter } from '@brainstrike/queue';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEnhancedFileImportService } from './enhanced-file-import-service';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';
import { getActiveEmbeddingSetId } from './vector-preferences';

export interface UseImportFlowOptions {
  embeddingQueue?: QueueAdapter | null;
  importSettings: {
    enableChunking: boolean;
    chunkingStrategy: ChunkingStrategy;
    chunkingStrategyExplicit: boolean;
    chunkSize: number;
    chunkOverlap: number;
    tokenTrueSizing: boolean;
    chunkTokenLimit: number;
  };
  onChunkRepositoryChange?: (
    repository: DrizzleFileChunkRepository | ElectronFileChunkRepository | null
  ) => void;
  onImportComplete?: (results: EnhancedImportResult[]) => Promise<void> | void;
  resolveActiveCollectionId?: () => string | null;
  toast: ReturnType<typeof useToast>['toast'];
}

export interface UseImportFlowResult {
  chunkRepository: DrizzleFileChunkRepository | ElectronFileChunkRepository | null;
  handleCancelImport: () => void;
  handleImportClick: () => void;
  isCancelling: boolean;
  isImporting: boolean;
  progress: EnhancedImportProgress | null;
  selectedFileCount: number;
  setShowImportProgress: (show: boolean) => void;
  showImportProgress: boolean;
}

export function useImportFlow({
  importSettings,
  toast,
  onImportComplete,
  onChunkRepositoryChange,
  embeddingQueue,
  resolveActiveCollectionId,
}: UseImportFlowOptions): UseImportFlowResult {
  const [showImportProgress, setShowImportProgress] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const { fileContents, fileTree, unfilteredFileTree } = useFileExplorer();
  const { selectedFilePaths } = useSelectionManager();

  const onImportCompleteRef = useRef(onImportComplete);
  onImportCompleteRef.current = onImportComplete;

  const resolveCollectionId = useCallback(
    () => resolveActiveCollectionId?.() ?? getActiveEmbeddingSetId(),
    [resolveActiveCollectionId]
  );

  const { isImporting, progress, importFiles, chunkRepository, cancelImport } =
    useEnhancedFileImportService({
      chunkingStrategy: importSettings.chunkingStrategy,
      chunkingStrategyExplicit: importSettings.chunkingStrategyExplicit,
      chunkOverlap: importSettings.chunkOverlap,
      chunkSize: importSettings.chunkSize,
      chunkTokenLimit: importSettings.chunkTokenLimit,
      embeddingQueue: embeddingQueue ?? null,
      enableChunking: importSettings.enableChunking,
      onComplete: async (results) => {
        await onImportCompleteRef.current?.(results);
      },
      onError: (error) => {
        toast({
          description: error.message,
          title: 'Import Failed',
          variant: 'destructive',
        });
      },
      onProgress: () => setShowImportProgress(true),
      resolveTargetEmbeddingSetId: resolveCollectionId,
      tokenTrueSizing: importSettings.tokenTrueSizing,
    });

  useEffect(() => {
    onChunkRepositoryChange?.(chunkRepository ?? null);
  }, [chunkRepository, onChunkRepositoryChange]);

  const showDestructiveToast = useCallback(
    (title: string, description: string) => {
      toast({
        description,
        title,
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

    try {
      await importFiles(selectedFilePaths, unfilteredFileTree ?? fileTree, fileContents);
    } finally {
      setIsCancelling(false);
    }
  }, [
    ensureSelection,
    ensureCollectionSelected,
    fileContents,
    fileTree,
    unfilteredFileTree,
    importFiles,
    selectedFilePaths,
  ]);

  const handleImportClick = useCallback(() => {
    setIsCancelling(false);
    void runImport();
  }, [runImport]);

  const handleCancelImport = useCallback(() => {
    if (isImporting) {
      setIsCancelling(true);
      cancelImport();
      toast({
        description: 'The import was cancelled. Already imported files and chunks have been kept.',
        title: 'Import Cancelled',
      });
    }
  }, [isImporting, cancelImport, toast]);

  const memoizedProgress = useMemo(() => progress as EnhancedImportProgress | null, [progress]);

  return {
    chunkRepository: chunkRepository ?? null,
    handleCancelImport,
    handleImportClick,
    isCancelling,
    isImporting,
    progress: memoizedProgress,
    selectedFileCount: selectedFilePaths.size,
    setShowImportProgress,
    showImportProgress,
  };
}
