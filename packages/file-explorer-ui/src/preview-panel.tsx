import { Badge, Button, Checkbox, Progress } from '@brainstrike/ui';
import { ArrowDown, ArrowUp, FileX2, FolderOpen } from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { type FileItem, formatTokenCount, usePreviewPanelState } from './use-preview-panel-state';

interface PreviewPanelProps {
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
  onFileClick?: (compositeKey: string) => void;
  pageSize?: number; // Configurable page size with default 50
}

// Simplified table data structure - only files, no folder headers
type TableRowData = {
  id: string;
  rootFolderId: string;
  path: string;
  type: string; // File extension
  size?: number;
  tokens?: number;
  compositeKey: string;
};

export const PreviewPanel = memo<PreviewPanelProps>(function PreviewPanelComponent(props) {
  const {
    selectedFiles,
    fileContents,
    loadingFiles,
    onSelectionChange,
    fileSizes,
    decodeFileSelection,
    countTokensHeuristic,
    performUndoableAction,
    onFileClick,
    pageSize = 50,
  } = props;

  // Local selection state for preview panel - separate from file tree selections
  const [previewSelections, setPreviewSelections] = useState<Set<string>>(new Set());

  const state = usePreviewPanelState({
    selectedFiles,
    fileContents,
    loadingFiles,
    onSelectionChange,
    ...(fileSizes ? { fileSizes } : {}),
    decodeFileSelection,
    countTokensHeuristic,
    performUndoableAction,
  });

  const { totalStats, expandAllFolders, collapseAllFolders, flatListItems } = state;

  // Use deferred value for expensive transformations to prevent blocking
  const deferredFlatListItems = useDeferredValue(flatListItems);

  // Transform list items to simplified table data - only files (no arbitrary limit now since we have pagination)
  const tableData: TableRowData[] = useMemo(() => {
    const fileItems = deferredFlatListItems.filter(
      (item): item is FileItem => item.type === 'file'
    );

    return fileItems
      .map((fileItem): TableRowData | null => {
        try {
          const { folderId, path } = decodeFileSelection(fileItem.compositeKey);
          const result: TableRowData = {
            id: fileItem.compositeKey,
            rootFolderId: folderId,
            path: path,
            type: path.split('.').pop()?.toUpperCase() || 'FILE',
            compositeKey: fileItem.compositeKey,
          };

          if (fileItem.size !== undefined) {
            result.size = fileItem.size;
          }
          if (fileItem.tokens !== undefined) {
            result.tokens = fileItem.tokens;
          }

          return result;
        } catch (error) {
          // Skip malformed composite keys gracefully
          console.warn('Failed to decode composite key:', fileItem.compositeKey, error);
          return null;
        }
      })
      .filter((item): item is TableRowData => item !== null);
  }, [deferredFlatListItems, decodeFileSelection]);

  // Simple sort state without complex data table
  const [sortField, setSortField] = useState<keyof TableRowData>('rootFolderId');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Simple pagination state
  const [currentPage, setCurrentPage] = useState(0);

  // Null check helper - reduces complexity
  const handleNullValues = useCallback((aVal: unknown, bVal: unknown): number | null => {
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    return null; // Both values are not null
  }, []);

  // Comparison helper with proper type handling
  const compareValues = useCallback(
    (aVal: unknown, bVal: unknown, field: keyof TableRowData): number => {
      const nullResult = handleNullValues(aVal, bVal);
      if (nullResult !== null) return nullResult;

      // Numeric sorting for tokens and size
      if (field === 'tokens' || field === 'size') {
        return (Number(aVal) || 0) - (Number(bVal) || 0);
      }

      // String sorting for other fields
      return String(aVal) < String(bVal) ? -1 : String(aVal) > String(bVal) ? 1 : 0;
    },
    [handleNullValues]
  );

  // Memoized sorted data
  const sortedData = useMemo(() => {
    return [...tableData].sort((a, b) => {
      const comparison = compareValues(a[sortField], b[sortField], sortField);
      return sortDirection === 'desc' ? -comparison : comparison;
    });
  }, [tableData, sortField, sortDirection, compareValues]);

  // Pagination calculations
  const totalPages = Math.ceil(sortedData.length / pageSize);
  const startIndex = currentPage * pageSize;
  const endIndex = startIndex + pageSize;
  const currentPageData = sortedData.slice(startIndex, endIndex);

  // Preview panel selection handlers (internal to this component)
  const handlePreviewSelectAllPage = useCallback(() => {
    const allFilesOnPage = new Set(currentPageData.map((row) => row.compositeKey));
    setPreviewSelections((prev) => {
      const newSelection = new Set(prev);
      for (const key of allFilesOnPage) {
        newSelection.add(key);
      }
      return newSelection;
    });
  }, [currentPageData]);

  const handlePreviewSelectAllGlobal = useCallback(() => {
    const allFiles = new Set(sortedData.map((row) => row.compositeKey));
    setPreviewSelections(allFiles);
  }, [sortedData]);

  const handlePreviewDeselectAll = useCallback(() => {
    setPreviewSelections(new Set());
  }, []);

  const togglePreviewSelection = useCallback((compositeKey: string, checked: boolean) => {
    setPreviewSelections((prev) => {
      const newSelection = new Set(prev);
      if (checked) {
        newSelection.add(compositeKey);
      } else {
        newSelection.delete(compositeKey);
      }
      return newSelection;
    });
  }, []);

  const handleBatchRemove = useCallback(() => {
    if (previewSelections.size === 0) return;

    // Remove preview-selected files from the main file selection
    const newSelectedFiles = new Set(selectedFiles);
    for (const compositeKey of previewSelections) {
      newSelectedFiles.delete(compositeKey);
    }

    performUndoableAction('batch-remove', 'batch-remove', {
      actionName: 'Files removed',
      itemDescription: `Removed ${previewSelections.size} files from selection`,
      getStateSnapshot: () => new Set(selectedFiles),
      onUndo: (_key, snapshot) => {
        onSelectionChange(snapshot);
      },
    });

    onSelectionChange(newSelectedFiles);
    setPreviewSelections(new Set()); // Clear preview selections after removal
  }, [previewSelections, selectedFiles, onSelectionChange, performUndoableAction]);

  // Check if all items on current page are selected
  const isAllCurrentPageSelected = useMemo(() => {
    if (currentPageData.length === 0) return false;
    return currentPageData.every((item) => previewSelections.has(item.compositeKey));
  }, [currentPageData, previewSelections]);

  // Check if all items globally are selected
  const isAllGloballySelected = useMemo(() => {
    if (sortedData.length === 0) return false;
    return sortedData.every((item) => previewSelections.has(item.compositeKey));
  }, [sortedData, previewSelections]);

  // Memoized table row component with all dependencies
  const TableRow = useCallback(
    ({ item }: { item: TableRowData }) => {
      const isPreviewSelected = previewSelections.has(item.compositeKey);
      const fileName = item.path.split('/').pop() || item.path;
      const dirPath = item.path.substring(0, item.path.lastIndexOf('/'));

      return (
        <tr key={item.id} className="border-b transition-colors hover:bg-muted/50">
          <td className="p-4 w-12">
            <Checkbox
              checked={isPreviewSelected}
              onCheckedChange={(checked) => togglePreviewSelection(item.compositeKey, !!checked)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${item.path}`}
            />
          </td>
          <td className="p-4">
            <div className="flex items-center gap-2">
              <FolderOpen className="size-4 text-muted-foreground flex-shrink-0" />
              <span className="font-mono text-sm truncate">{item.rootFolderId}</span>
            </div>
          </td>
          <td className="p-4 min-w-0 flex-1">
            <button
              type="button"
              className="min-w-0 text-left w-full hover:text-primary transition-colors"
              onClick={(e) => {
                e.preventDefault();
                onFileClick?.(item.compositeKey);
              }}
              aria-label={fileName}
            >
              <div className="font-medium text-sm truncate">{fileName}</div>
              {dirPath && (
                <div className="text-xs text-muted-foreground truncate font-mono">{dirPath}</div>
              )}
            </button>
          </td>
          <td className="p-4 w-20">
            <Badge variant="secondary" className="text-xs">
              {item.type}
            </Badge>
          </td>
          <td className="p-4 w-24 text-right">
            {item.tokens ? (
              <span className="font-mono text-sm">{formatTokenCount(item.tokens)}</span>
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )}
          </td>
          <td className="p-4 w-24 text-right">
            {item.size ? (
              <span className="font-mono text-sm">{(item.size / 1024).toFixed(1)} KB</span>
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )}
          </td>
        </tr>
      );
    },
    [previewSelections, togglePreviewSelection, onFileClick]
  );

  // Pagination handlers
  const goToNextPage = useCallback(() => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages - 1));
  }, [totalPages]);

  const goToPreviousPage = useCallback(() => {
    setCurrentPage((prev) => Math.max(prev - 1, 0));
  }, []);

  const goToPage = useCallback(
    (page: number) => {
      setCurrentPage(Math.max(0, Math.min(page, totalPages - 1)));
    },
    [totalPages]
  );

  // Reset to first page when data changes
  useEffect(() => {
    if (currentPage >= totalPages && totalPages > 0) {
      setCurrentPage(0);
    }
  }, [currentPage, totalPages]);

  const handleSort = useCallback(
    (field: keyof TableRowData) => {
      if (sortField === field) {
        setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
      // Reset to first page when sorting changes
      setCurrentPage(0);
    },
    [sortField]
  );

  const resetSort = useCallback(() => {
    setSortField('rootFolderId');
    setSortDirection('asc');
    setCurrentPage(0);
  }, []);

  // Memoized table headers
  const SortableHeader = memo(
    ({
      field,
      title,
      className,
    }: {
      field: keyof TableRowData;
      title: string;
      className?: string;
    }) => {
      const isActive = sortField === field;
      return (
        <th
          className={`px-4 py-3 text-left text-sm font-medium text-muted-foreground cursor-pointer hover:text-foreground ${className}`}
          onClick={() => handleSort(field)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSort(field);
            }
          }}
          scope="col"
          aria-sort={isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
        >
          <div className="flex items-center gap-1">
            {title}
            {isActive &&
              (sortDirection === 'asc' ? (
                <ArrowUp className="size-3" />
              ) : (
                <ArrowDown className="size-3" />
              ))}
          </div>
        </th>
      );
    }
  );

  if (selectedFiles.size === 0) {
    return (
      <div className="p-4">
        <p className="text-sm text-gray-500">No files selected</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header with stats and controls */}
      <div className="p-3 border-b flex items-center justify-between bg-background">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="py-1.5">
            {formatTokenCount(totalStats.totalTokens)}
          </Badge>
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">{totalStats.totalFiles}</span> files |{' '}
            <span className="font-medium">{totalStats.totalTokens.toLocaleString()}</span> tokens
          </div>
          <div className="w-32">
            <Progress
              value={Math.min((totalStats.totalTokens / 100000) * 100, 100)}
              className="h-2"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePreviewSelectAllGlobal}
            disabled={isAllGloballySelected}
            title="Select all files across all pages"
          >
            Select All ({sortedData.length})
          </Button>
          {(sortField !== 'rootFolderId' || sortDirection !== 'asc') && (
            <Button
              variant="outline"
              size="sm"
              onClick={resetSort}
              title="Reset sort to default (by folder)"
            >
              Reset Sort
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={expandAllFolders} title="Expand all folders">
            <ArrowDown className="size-3.5" />
            <span className="hidden sm:inline ml-1">Expand</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={collapseAllFolders}
            title="Collapse all folders"
          >
            <ArrowUp className="size-3.5" />
            <span className="hidden sm:inline ml-1">Collapse</span>
          </Button>
        </div>
      </div>

      {/* Simple Table - No Virtualization, No Pagination */}
      <div className="flex-1 overflow-auto">
        <div className="min-w-full">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-background border-b">
              <tr>
                <th className="px-4 py-3 w-12" scope="col">
                  <Checkbox
                    checked={isAllCurrentPageSelected}
                    onCheckedChange={(checked) =>
                      checked ? handlePreviewSelectAllPage() : handlePreviewDeselectAll()
                    }
                    aria-label="Select all files on current page"
                    title="Select all files on current page"
                  />
                </th>
                <SortableHeader field="rootFolderId" title="Folder" />
                <SortableHeader field="path" title="File Path" className="min-w-0 flex-1" />
                <SortableHeader field="type" title="Type" className="w-20" />
                <SortableHeader field="tokens" title="Tokens" className="w-24" />
                <SortableHeader field="size" title="Size" className="w-24" />
              </tr>
            </thead>
            <tbody>{currentPageData.map((item) => TableRow({ item }))}</tbody>
          </table>
          {sortedData.length === 0 && (
            <div className="p-8 text-center text-muted-foreground">
              No files match your selection criteria
            </div>
          )}
        </div>
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between p-3 border-t bg-background">
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>
              Page {currentPage + 1} of {totalPages} ({sortedData.length} total files)
            </span>
          </div>
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={goToPreviousPage}
              disabled={currentPage === 0}
            >
              Previous
            </Button>
            <div className="flex items-center space-x-1">
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                // Show pages around current page
                let pageNum: number;
                if (totalPages <= 5) {
                  pageNum = i;
                } else if (currentPage < 3) {
                  pageNum = i;
                } else if (currentPage > totalPages - 4) {
                  pageNum = totalPages - 5 + i;
                } else {
                  pageNum = currentPage - 2 + i;
                }

                return (
                  <Button
                    key={pageNum}
                    variant={pageNum === currentPage ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => goToPage(pageNum)}
                    className="w-8 h-8 p-0"
                  >
                    {pageNum + 1}
                  </Button>
                );
              })}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={goToNextPage}
              disabled={currentPage === totalPages - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Fixed bottom action bar */}
      {previewSelections.size > 0 && (
        <div className="flex-shrink-0 p-3 border-t bg-yellow-50 dark:bg-yellow-900/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {previewSelections.size} files selected in preview
            </span>
            <Button size="sm" variant="outline" onClick={handlePreviewDeselectAll}>
              Clear Preview Selection
            </Button>
          </div>
          <Button size="sm" variant="destructive" onClick={handleBatchRemove}>
            <FileX2 className="size-3.5 mr-1" />
            Remove Selected from Project
          </Button>
        </div>
      )}
    </div>
  );
});

PreviewPanel.displayName = 'PreviewPanel';
