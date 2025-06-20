export interface FileItem {
  compositeKey: string;
  folderId: string;
  path: string;
  size?: number;
  tokens?: number;
  type: 'file';
}

export interface FolderHeaderItem {
  folderId: string;
  type: 'folder-header';
  fileCount: number;
  totalTokens: number;
}

export type ListItem = FileItem | FolderHeaderItem;

interface SortConfig {
  key: string;
  direction: 'asc' | 'desc';
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

export interface UsePreviewPanelStateProps {
  selectedFiles: Set<string>;
  fileContents: Record<string, string>;
  loadingFiles: Set<string>;
  onSelectionChange: (files: Set<string>) => void;
  fileSizes?: Record<string, number>;
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  countTokensHeuristic: (content: string) => number;
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
}

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef, useState } from 'react';

export function usePreviewPanelState({
  selectedFiles,
  fileContents,
  loadingFiles,
  onSelectionChange,
  fileSizes,
  decodeFileSelection,
  countTokensHeuristic,
  performUndoableAction,
}: UsePreviewPanelStateProps) {
  const [batchSelectedFiles, setBatchSelectedFiles] = useState<Set<string>>(new Set());
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [sortConfig] = useState<SortConfig>({ key: 'path', direction: 'asc' });

  const tokenCacheRef = useRef<Map<string, number>>(new Map());
  const prevSelectedFilesRef = useRef<Set<string> | null>(null);

  if (prevSelectedFilesRef.current !== selectedFiles) {
    prevSelectedFilesRef.current = selectedFiles;
    if (prevSelectedFilesRef.current !== null) {
      setBatchSelectedFiles(new Set());
    }
  }

  const flatListItems = useMemo(() => {
    const folderGroups: Record<string, FileItem[]> = {};

    for (const compositeKey of selectedFiles) {
      const { folderId, path } = decodeFileSelection(compositeKey);
      if (!folderGroups[folderId]) {
        folderGroups[folderId] = [];
      }

      let fileSize: number | undefined;
      let tokenCount: number | undefined;

      if (fileContents[compositeKey]) {
        const content = fileContents[compositeKey];
        if (!content.startsWith('File not accessible') && !content.startsWith('Binary file')) {
          if (!tokenCacheRef.current.has(compositeKey)) {
            const count = countTokensHeuristic(content);
            tokenCacheRef.current.set(compositeKey, count);
          }
          tokenCount = tokenCacheRef.current.get(compositeKey);
        }
        if (fileSizes && fileSizes[compositeKey] !== undefined) {
          fileSize = fileSizes[compositeKey];
        } else {
          fileSize = new TextEncoder().encode(content).length;
        }
      }

      folderGroups[folderId].push({
        compositeKey,
        folderId,
        path,
        type: 'file',
        ...(fileSize !== undefined ? { size: fileSize } : {}),
        ...(tokenCount !== undefined ? { tokens: tokenCount } : {}),
      });
    }

    for (const files of Object.values(folderGroups)) {
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

    const items: ListItem[] = [];
    for (const [folderId, files] of Object.entries(folderGroups)) {
      const totalTokens = files.reduce((sum, file) => sum + (file.tokens || 0), 0);
      items.push({ folderId, type: 'folder-header', fileCount: files.length, totalTokens });
      if (!collapsedFolders.has(folderId)) {
        items.push(...files);
      }
    }

    return items;
  }, [
    selectedFiles,
    sortConfig,
    fileSizes,
    fileContents,
    countTokensHeuristic,
    decodeFileSelection,
    collapsedFolders,
  ]);

  const scrollElementRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: flatListItems.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: (index) => {
      const item = flatListItems[index];
      return item?.type === 'folder-header' ? 60 : 40;
    },
    overscan: 10,
  });

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
    if (batchSelectedFiles.size === 0) return;
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
    if (bytes === undefined) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }, []);

  const totalStats = useMemo(() => {
    let totalTokens = 0;
    let totalFiles = 0;
    for (const compositeKey of selectedFiles) {
      totalFiles++;
      if (fileContents[compositeKey]) {
        const content = fileContents[compositeKey];
        if (!content.startsWith('File not accessible') && !content.startsWith('Binary file')) {
          if (!tokenCacheRef.current.has(compositeKey)) {
            const count = countTokensHeuristic(content);
            tokenCacheRef.current.set(compositeKey, count);
          }
          totalTokens += tokenCacheRef.current.get(compositeKey) || 0;
        }
      }
    }
    return { totalTokens, totalFiles };
  }, [selectedFiles, fileContents, countTokensHeuristic]);

  return {
    batchSelectedFiles,
    collapsedFolders,
    flatListItems,
    scrollElementRef,
    virtualizer,
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
