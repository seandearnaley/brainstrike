import type {
  ChunkingStrategy,
  ElectronFileChunkRepository,
  FileChunkRepository,
} from '@brainstrike/db';
import {
  isHostedProvider,
  parseProviderModelKey,
  resolveHostedProviderApiKey,
} from '@brainstrike/embeddings';
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
    chunkingStrategyExplicit: boolean;
    enableEmbedding: boolean;
    selectedModel: string | null;
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
    chunkingStrategyExplicit: importSettings.chunkingStrategyExplicit,
    enableEmbedding: importSettings.enableEmbedding,
    ...(importSettings.selectedModel ? { embeddingModel: importSettings.selectedModel } : {}),
    chunkSize: importSettings.chunkSize,
    chunkOverlap: importSettings.chunkOverlap,
    tokenTrueSizing: importSettings.tokenTrueSizing,
    chunkTokenLimit: importSettings.chunkTokenLimit,
    embeddingQueue: embeddingQueue ?? null,
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

  const ensureHostedCredentials = useCallback(async (): Promise<boolean> => {
    if (!importSettings.enableEmbedding || !importSettings.selectedModel) {
      return true;
    }

    const parsed = parseProviderModelKey(importSettings.selectedModel);
    if (!parsed || !isHostedProvider(parsed.provider)) {
      return true;
    }

    const apiKey = await resolveHostedProviderApiKey(parsed.provider);
    if (apiKey) {
      return true;
    }

    showDestructiveToast(
      'API Key Required',
      `Configure a ${parsed.provider.toUpperCase()} API key before running hosted embeddings.`
    );
    return false;
  }, [importSettings.enableEmbedding, importSettings.selectedModel, showDestructiveToast]);

  const runImport = useCallback(async () => {
    if (!ensureSelection()) {
      return;
    }

    const hasCredentials = await ensureHostedCredentials();
    if (!hasCredentials) {
      return;
    }

    await importFiles(selectedFilePaths, fileTree, fileContents);
  }, [
    ensureHostedCredentials,
    ensureSelection,
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
