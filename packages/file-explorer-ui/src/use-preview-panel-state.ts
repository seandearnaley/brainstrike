import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePersistentTokenCache } from './use-persistent-token-cache';
import type { TokenCountingState } from './use-token-counting';

/** Debounce delay for token version updates (ms) */
const TOKEN_VERSION_DEBOUNCE_MS = 100;

export type FileItem = {
  compositeKey: string;
  folderId: string;
  path: string;
  size?: number;
  tokens?: number;
  type: 'file';
};

export type FolderHeaderItem = {
  folderId: string;
  type: 'folder-header';
  fileCount: number;
  totalTokens: number;
};

export type ListItem = FileItem | FolderHeaderItem;

type SortConfig = {
  key: string;
  direction: 'asc' | 'desc';
};

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export type UsePreviewPanelStateProps = {
  selectedFiles: Set<string>;
  fileContents: Record<string, string>;
  loadingFiles: Set<string>;
  onSelectionChange: (files: Set<string>) => void;
  fileSizes?: Record<string, number> | undefined;
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  tokenCounting: TokenCountingState;
  performUndoableAction: (
    key: string,
    itemKey: string,
    opts: {
      actionName: string;
      itemDescription: string;
      getStateSnapshot: () => Set<string>;
      onUndo: (key: string, snapshot: Set<string>) => void;
    }
  ) => void;
};

// Helper function to get file size from metadata (no content loading required)
function getFileSizeFromMetadata(
  compositeKey: string,
  fileSizes?: Record<string, number>
): number | undefined {
  return fileSizes?.[compositeKey];
}

// Helper function to sort files
function sortFiles(files: FileItem[], sortConfig: SortConfig): void {
  files.sort((a, b) => {
    const { key, direction } = sortConfig;
    const multiplier = direction === 'asc' ? 1 : -1;
    switch (key) {
      case 'path':
        return multiplier * a.path.localeCompare(b.path);
      case 'size':
        return multiplier * ((a.size || 0) - (b.size || 0));
      case 'tokens':
        return multiplier * ((a.tokens || 0) - (b.tokens || 0));
      default:
        return 0;
    }
  });
}

// Helper function to build final list items
function buildListItems(
  folderGroups: Record<string, FileItem[]>,
  collapsedFolders: Set<string>
): ListItem[] {
  const items: ListItem[] = [];

  for (const [folderId, files] of Object.entries(folderGroups)) {
    const totalTokens = files.reduce((sum, file) => sum + (file.tokens || 0), 0);
    items.push({ folderId, type: 'folder-header', fileCount: files.length, totalTokens });

    if (!collapsedFolders.has(folderId)) {
      items.push(...files);
    }
  }

  return items;
}

export function usePreviewPanelState({
  selectedFiles,
  fileContents,
  loadingFiles,
  onSelectionChange,
  fileSizes,
  decodeFileSelection,
  tokenCounting,
  performUndoableAction,
}: UsePreviewPanelStateProps) {
  const [batchSelectedFiles, setBatchSelectedFiles] = useState<Set<string>>(new Set());
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [sortConfig] = useState<SortConfig>({ key: 'path', direction: 'asc' });

  const [tokenVersion, setTokenVersion] = useState(0);
  const prevSelectedFilesRef = useRef<Set<string> | null>(null);
  const isMountedRef = useRef(true);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // biome-ignore lint/plugin: Cleanup effect for unmount tracking and debounce timer
  useEffect(
    () => () => {
      isMountedRef.current = false;
      // Clean up debounce timer on unmount
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    },
    []
  );

  // Debounced token version update to batch rapid-fire token resolutions
  const handleTokenResolved = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }

    // Cancel any pending update
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Schedule a batched update
    debounceTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        setTokenVersion((prev) => prev + 1);
      }
      debounceTimerRef.current = null;
    }, TOKEN_VERSION_DEBOUNCE_MS);
  }, []);

  // Use the persistent token cache hook
  // This provides automatic caching with PGlite persistence when available
  const persistentCache = usePersistentTokenCache({
    fileContents,
    tokenCounting,
    decodeFileSelection,
    onTokenResolved: handleTokenResolved,
  });

  // Clear hot cache when counting mode changes
  useEffect(() => {
    setTokenVersion((prev) => prev + 1);
  }, [tokenCounting.mode]);

  if (prevSelectedFilesRef.current !== selectedFiles) {
    prevSelectedFilesRef.current = selectedFiles;
    setBatchSelectedFiles(new Set());
  }

  // Build file items using the persistent cache
  const flatListItems = useMemo(() => {
    const folderGroups: Record<string, FileItem[]> = {};

    for (const compositeKey of selectedFiles) {
      const { folderId, path } = decodeFileSelection(compositeKey);
      if (!folderGroups[folderId]) {
        folderGroups[folderId] = [];
      }

      // Get token count from persistent cache (returns undefined if loading)
      const tokenCount = persistentCache.getTokenCount(compositeKey);

      // Get file size from metadata (no content loading required)
      const fileSize = getFileSizeFromMetadata(compositeKey, fileSizes);

      const fileItem: FileItem = {
        compositeKey,
        folderId,
        path,
        type: 'file',
        ...(fileSize !== undefined ? { size: fileSize } : {}),
        ...(tokenCount !== undefined ? { tokens: tokenCount } : {}),
      };

      folderGroups[folderId].push(fileItem);
    }

    // Sort files in each folder
    for (const files of Object.values(folderGroups)) {
      sortFiles(files, sortConfig);
    }

    return buildListItems(folderGroups, collapsedFolders);
  }, [
    selectedFiles,
    sortConfig,
    fileSizes,
    decodeFileSelection,
    collapsedFolders,
    persistentCache,
    persistentCache.cacheVersion,
    tokenVersion,
  ]);

  const handleRemoveFile = useCallback(
    (compositeKey: string) => {
      const { path } = decodeFileSelection(compositeKey);
      const newSelectedFiles = new Set(selectedFiles);
      newSelectedFiles.delete(compositeKey);
      onSelectionChange(newSelectedFiles);

      performUndoableAction(compositeKey, compositeKey, {
        actionName: 'File removed',
        itemDescription: `Removed "${path}" from selection`,
        getStateSnapshot: () => new Set(selectedFiles),
        onUndo: (key, snapshot) => {
          const restoredFiles = new Set(snapshot);
          restoredFiles.add(key);
          onSelectionChange(restoredFiles);
        },
      });
    },
    [selectedFiles, onSelectionChange, performUndoableAction, decodeFileSelection]
  );

  const handleBatchRemove = useCallback(() => {
    if (batchSelectedFiles.size === 0) {
      return;
    }
    const newSelectedFiles = new Set(selectedFiles);
    for (const compositeKey of batchSelectedFiles) {
      newSelectedFiles.delete(compositeKey);
    }
    onSelectionChange(newSelectedFiles);
    performUndoableAction('batch-remove', 'batch-remove', {
      actionName: 'Files removed',
      itemDescription: `Removed ${batchSelectedFiles.size} files from selection`,
      getStateSnapshot: () => new Set(selectedFiles),
      onUndo: (_key, snapshot) => {
        const restoredFiles = new Set(snapshot);
        onSelectionChange(restoredFiles);
      },
    });
    setBatchSelectedFiles(new Set());
  }, [batchSelectedFiles, selectedFiles, onSelectionChange, performUndoableAction]);

  const toggleFileSelection = useCallback((compositeKey: string, checked: boolean) => {
    setBatchSelectedFiles((prev) => {
      const newSelection = new Set(prev);
      if (checked) {
        newSelection.add(compositeKey);
      } else {
        newSelection.delete(compositeKey);
      }
      return newSelection;
    });
  }, []);

  const toggleFolderCollapse = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(folderId)) {
        newSet.delete(folderId);
      } else {
        newSet.add(folderId);
      }
      return newSet;
    });
  }, []);

  const expandAllFolders = useCallback(() => {
    setCollapsedFolders(new Set());
  }, []);

  const collapseAllFolders = useCallback(() => {
    const allFolderIds = new Set<string>();
    for (const item of flatListItems) {
      if (item.type === 'folder-header') {
        allFolderIds.add(item.folderId);
      }
    }
    setCollapsedFolders(allFolderIds);
  }, [flatListItems]);

  const handleSelectAll = useCallback(() => {
    setBatchSelectedFiles(new Set(selectedFiles));
  }, [selectedFiles]);

  const handleDeselectAll = useCallback(() => {
    setBatchSelectedFiles(new Set());
  }, []);

  const isAllFilesSelected = batchSelectedFiles.size === selectedFiles.size;

  const formatFileSize = useCallback((bytes?: number) => {
    if (bytes === undefined) {
      return 'Unknown';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }, []);

  // Calculate total stats using the persistent cache
  const totalStats = useMemo(() => {
    let totalTokens = 0;
    let totalFiles = 0;

    for (const compositeKey of selectedFiles) {
      totalFiles++;
      const tokenCount = persistentCache.getTokenCount(compositeKey);
      if (tokenCount !== undefined) {
        totalTokens += tokenCount;
      }
    }

    return { totalTokens, totalFiles };
  }, [selectedFiles, persistentCache, persistentCache.cacheVersion, tokenVersion]);

  return {
    batchSelectedFiles,
    collapsedFolders,
    flatListItems,
    handleRemoveFile,
    handleBatchRemove,
    toggleFileSelection,
    toggleFolderCollapse,
    expandAllFolders,
    collapseAllFolders,
    handleSelectAll,
    handleDeselectAll,
    isAllFilesSelected,
    formatFileSize,
    totalStats,
    loadingFiles,
  };
}

export type UsePreviewPanelStateReturn = ReturnType<typeof usePreviewPanelState>;
