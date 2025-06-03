import { Badge, Button, Checkbox, Progress, ScrollArea } from '@brainstrike/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, FileIcon, FileX2, Folder, Loader2 } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';

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

const getFolderColor = (folderId: string) => {
  // Simple hash-based color generation
  let hash = 0;
  for (let i = 0; i < folderId.length; i++) {
    hash = folderId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return {
    light: {
      bg: `hsl(${hue}, 40%, 95%)`,
      text: `hsl(${hue}, 60%, 30%)`,
    },
    dark: {
      bg: `hsl(${hue}, 30%, 15%)`,
      text: `hsl(${hue}, 40%, 80%)`,
    },
  };
};

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

// Folder header component
interface FolderHeaderRowProps {
  item: FolderHeaderItem;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

const FolderHeaderRow = memo<FolderHeaderRowProps>(({ item, isCollapsed, onToggleCollapse }) => {
  const colors = getFolderColor(item.folderId);

  return (
    <button
      type="button"
      className="w-full h-full flex items-center gap-3 px-4 py-3 text-left hover:opacity-80 transition-opacity"
      style={{
        backgroundColor: colors.light.bg,
        color: colors.light.text,
      }}
      onClick={onToggleCollapse}
    >
      <style>
        {`
          :global(.dark) [data-folder-id="${item.folderId}"] {
            background-color: ${colors.dark.bg} !important;
            color: ${colors.dark.text} !important;
          }
        `}
      </style>
      <div className="flex items-center gap-2">
        {isCollapsed ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
        <Folder className="h-4 w-4" />
      </div>
      <span className="flex-1 truncate font-medium">{item.folderId}</span>
      <div className="flex items-center gap-2 text-xs opacity-80">
        <span>{item.fileCount} files</span>
        {item.totalTokens > 0 && (
          <Badge variant="secondary" className="text-xs">
            {formatTokenCount(item.totalTokens)}
          </Badge>
        )}
      </div>
    </button>
  );
});

FolderHeaderRow.displayName = 'FolderHeaderRow';

// File row component
interface FileRowProps {
  item: FileItem;
  isSelected: boolean;
  isLoading: boolean;
  onToggleSelection: (checked: boolean) => void;
  onRemove: () => void;
  onShowDetail: () => void;
  formatFileSize: (bytes?: number) => string;
}

const FileRow = memo<FileRowProps>(
  ({ item, isSelected, isLoading, onToggleSelection, onRemove, onShowDetail, formatFileSize }) => {
    return (
      <div className="w-full h-full flex items-center gap-3 px-4 py-2 hover:bg-muted/50 border-b border-border/50">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onToggleSelection(checked === true)}
          className="flex-shrink-0"
        />

        <FileIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />

        <button
          type="button"
          className="flex-1 min-w-0 text-left hover:text-primary transition-colors"
          onClick={onShowDetail}
        >
          <div className="truncate font-mono text-sm" title={item.path}>
            {item.path}
          </div>
        </button>

        <div className="flex items-center gap-3 flex-shrink-0 text-xs text-muted-foreground">
          {isLoading && <Loader2 className="h-3 w-3 animate-spin" data-testid="loading-spinner" />}
          <span className="min-w-[60px] text-right">{formatFileSize(item.size)}</span>
          <span className="min-w-[50px] text-right">
            {item.tokens ? formatTokenCount(item.tokens) : 'N/A'}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onRemove}
            title="Remove from selection"
          >
            <FileX2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    );
  }
);

FileRow.displayName = 'FileRow';

// File detail panel component
interface FileDetailPanelProps {
  compositeKey: string;
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  onClose: () => void;
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
}

const FileDetailPanel = memo<FileDetailPanelProps>(
  ({ compositeKey, fileContents, loadingFiles, onClose, decodeFileSelection }) => {
    const { path } = decodeFileSelection(compositeKey);
    const content = fileContents[compositeKey];
    const isLoading = loadingFiles.has(compositeKey);

    return (
      <div className="w-96 border-l border-border flex flex-col bg-background">
        <div className="p-3 border-b flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium truncate" title={path}>
              {path}
            </h3>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="flex-shrink-0">
            <FileX2 className="h-4 w-4" />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4">
            {isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : content ? (
              <pre className="whitespace-pre-wrap text-sm bg-muted p-3 rounded-md overflow-x-auto">
                {content.startsWith('File not accessible') ? (
                  <div className="text-amber-600 dark:text-amber-400">
                    <p>{content}</p>
                    <p className="text-sm text-muted-foreground mt-2">
                      To access this file, please open the folder again using the folder selection
                      dialog.
                    </p>
                  </div>
                ) : (
                  content
                )}
              </pre>
            ) : (
              <div className="text-muted-foreground">No content available</div>
            )}
          </div>
        </ScrollArea>
      </div>
    );
  }
);

FileDetailPanel.displayName = 'FileDetailPanel';
