import { Badge, Button, Checkbox, Progress } from '@brainstrike/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, FileX2 } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import FileDetailPanel from './file-detail-panel';
import FileRow from './file-row';
import FolderHeaderRow from './folder-header-row';

interface VirtualizedPreviewPanelProps {
  selectedFiles: Set<string>;
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  onSelectionChange: (files: Set<string>) => void;
  fileSizes?: { [compositeKey: string]: number };
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  countTokensHeuristic: (content: string) => number;
  estimateTokenCost?: (tokens: number) => number;
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

interface FileItem {
  compositeKey: string;
  folderId: string;
  path: string;
  size?: number;
  tokens?: number;
  type: 'file';
}

interface FolderHeaderItem {
  folderId: string;
  type: 'folder-header';
  fileCount: number;
  totalTokens: number;
}

type ListItem = FileItem | FolderHeaderItem;

interface SortConfig {
  key: string;
  direction: 'asc' | 'desc';
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

export const VirtualizedPreviewPanel = memo<VirtualizedPreviewPanelProps>(
  ({
    selectedFiles,
    fileContents,
    loadingFiles,
    onSelectionChange,
    fileSizes,
    decodeFileSelection,
    countTokensHeuristic,
    // estimateTokenCost,
    performUndoableAction,
  }) => {
    const [batchSelectedFiles, setBatchSelectedFiles] = useState<Set<string>>(new Set());
    const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
    const [sortConfig] = useState<SortConfig>({
      key: 'path',
      direction: 'asc',
    });
    const [selectedFileForDetail, setSelectedFileForDetail] = useState<string | null>(null);

    // Cache token counts per file
    const tokenCacheRef = useRef<Map<string, number>>(new Map());
    const prevSelectedFilesRef = useRef<Set<string> | null>(null);

    // Reset batch selections when selectedFiles change
    if (prevSelectedFilesRef.current !== selectedFiles) {
      prevSelectedFilesRef.current = selectedFiles;
      if (prevSelectedFilesRef.current !== null) {
        setBatchSelectedFiles(new Set());
      }
    }

    // Create flat list of items for virtualization
    const flatListItems = useMemo(() => {
      const folderGroups: Record<string, FileItem[]> = {};

      // Group files by folder
      for (const compositeKey of selectedFiles) {
        const { folderId, path } = decodeFileSelection(compositeKey);

        if (!folderGroups[folderId]) {
          folderGroups[folderId] = [];
        }

        let fileSize: number | undefined;
        let tokenCount: number | undefined;

        if (fileContents[compositeKey]) {
          const content = fileContents[compositeKey];

          // Calculate tokens for non-error content
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

      // Sort files within each folder
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

      // Create flat list with folder headers
      const items: ListItem[] = [];
      for (const [folderId, files] of Object.entries(folderGroups)) {
        const totalTokens = files.reduce((sum, file) => sum + (file.tokens || 0), 0);

        // Add folder header
        items.push({
          folderId,
          type: 'folder-header',
          fileCount: files.length,
          totalTokens,
        });

        // Add files if folder is not collapsed
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

    // Setup virtualizer
    const virtualizer = useVirtualizer({
      count: flatListItems.length,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: (index) => {
        const item = flatListItems[index];
        return item?.type === 'folder-header' ? 60 : 40; // folder headers are taller
      },
      overscan: 10, // Buffer items for smooth scrolling
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
        onUndo: (_, snapshot) => {
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

    // Calculate total stats across ALL selected files (not just visible ones)
    const totalStats = useMemo(() => {
      let totalTokens = 0;
      let totalFiles = 0;

      // Count all selected files regardless of folder collapse state
      for (const compositeKey of selectedFiles) {
        totalFiles++;

        if (fileContents[compositeKey]) {
          const content = fileContents[compositeKey];

          // Calculate tokens for non-error content
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

    // Calculate estimated cost (for future use)
    // const estimatedCost = useMemo(() => {
    //   return (totalStats.totalTokens / 1000000) * 10; // GPT-4 rates
    // }, [totalStats.totalTokens]);

    if (selectedFiles.size === 0) {
      return (
        <div className="p-4">
          <p className="text-sm text-gray-500">No files selected</p>
        </div>
      );
    }

    return (
      <div className="h-full flex">
        {/* Main virtualized list */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="p-3 border-b flex items-center justify-between bg-background">
            <div className="flex items-center gap-3">
              <Checkbox
                checked={isAllFilesSelected}
                onCheckedChange={(checked) => (checked ? handleSelectAll() : handleDeselectAll())}
                className="flex-shrink-0"
              />
              <Badge variant="outline" className="py-1.5">
                {formatTokenCount(totalStats.totalTokens)}
              </Badge>
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">{totalStats.totalFiles}</span> files |{' '}
                <span className="font-medium">{totalStats.totalTokens.toLocaleString()}</span>{' '}
                tokens
              </div>
              <div className="w-32">
                <Progress
                  value={Math.min((totalStats.totalTokens / 100000) * 100, 100)}
                  className="h-2"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={expandAllFolders}>
                <ArrowDown className="size-3.5" />
                <span className="hidden sm:inline ml-1">Expand</span>
              </Button>
              <Button variant="outline" size="sm" onClick={collapseAllFolders}>
                <ArrowUp className="size-3.5" />
                <span className="hidden sm:inline ml-1">Collapse</span>
              </Button>
            </div>
          </div>

          {/* Virtualized list */}
          <div
            ref={scrollElementRef}
            className="flex-1 overflow-auto"
            style={{ contain: 'strict' }}
          >
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const item = flatListItems[virtualItem.index];
                if (!item) return null;

                return (
                  <div
                    key={virtualItem.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    {item.type === 'folder-header' ? (
                      <FolderHeaderRow
                        item={item}
                        isCollapsed={collapsedFolders.has(item.folderId)}
                        onToggleCollapse={() => toggleFolderCollapse(item.folderId)}
                      />
                    ) : (
                      <FileRow
                        item={item}
                        isSelected={batchSelectedFiles.has(item.compositeKey)}
                        isLoading={loadingFiles.has(item.compositeKey)}
                        onToggleSelection={(checked) =>
                          toggleFileSelection(item.compositeKey, checked)
                        }
                        onRemove={() => handleRemoveFile(item.compositeKey)}
                        onShowDetail={() => setSelectedFileForDetail(item.compositeKey)}
                        formatFileSize={formatFileSize}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Batch actions footer */}
          {batchSelectedFiles.size > 0 && (
            <div className="p-3 border-t bg-muted/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{batchSelectedFiles.size} selected</span>
              </div>
              <Button size="sm" variant="destructive" onClick={handleBatchRemove}>
                <FileX2 className="size-3.5 mr-1" />
                Remove Selected
              </Button>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedFileForDetail && (
          <FileDetailPanel
            compositeKey={selectedFileForDetail}
            fileContents={fileContents}
            loadingFiles={loadingFiles}
            onClose={() => setSelectedFileForDetail(null)}
            decodeFileSelection={decodeFileSelection}
          />
        )}
      </div>
    );
  }
);

VirtualizedPreviewPanel.displayName = 'VirtualizedPreviewPanel';
