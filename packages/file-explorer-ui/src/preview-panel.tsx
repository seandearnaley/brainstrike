import { Badge, Button, Checkbox, Progress } from '@brainstrike/ui';
import { ArrowDown, ArrowUp, FileX2, FolderOpen } from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
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

// Grouping system types
type GroupKey = string | number;
type GroupFunction<T = TableRowData> = (item: T) => GroupKey;
type GroupBandFunction<T = TableRowData> = (item: T) => string;

interface GroupConfig {
  id: string;
  label: string;
  groupBy: GroupFunction | GroupBandFunction;
  sortGroups?: (a: GroupKey, b: GroupKey) => number;
}

interface GroupedData {
  groupKey: GroupKey;
  groupLabel: string;
  items: TableRowData[];
  count: number;
  totalTokens: number;
  totalSize: number;
}

// Predefined grouping configurations
const GROUPING_CONFIGS = {
  none: {
    id: 'none',
    label: 'No Grouping',
    groupBy: () => 'all',
  },
  folder: {
    id: 'folder',
    label: 'By Folder',
    groupBy: (item: TableRowData) => item.rootFolderId,
    sortGroups: (a: GroupKey, b: GroupKey) => String(a).localeCompare(String(b)),
  },
  fileType: {
    id: 'fileType',
    label: 'By File Type',
    groupBy: (item: TableRowData) => item.type,
    sortGroups: (a: GroupKey, b: GroupKey) => String(a).localeCompare(String(b)),
  },
  sizeSteps: {
    id: 'sizeSteps',
    label: 'By Size Range',
    groupBy: (item: TableRowData) => {
      const size = item.size || 0;
      if (size === 0) return 'Unknown';
      if (size < 1024) return 'Small (< 1 KB)';
      if (size < 10240) return 'Medium (1-10 KB)';
      if (size < 102400) return 'Large (10-100 KB)';
      if (size < 1048576) return 'Very Large (100 KB - 1 MB)';
      return 'Huge (> 1 MB)';
    },
    sortGroups: (a: GroupKey, b: GroupKey) => {
      const order = [
        'Unknown',
        'Small (< 1 KB)',
        'Medium (1-10 KB)',
        'Large (10-100 KB)',
        'Very Large (100 KB - 1 MB)',
        'Huge (> 1 MB)',
      ];
      return order.indexOf(String(a)) - order.indexOf(String(b));
    },
  },
  tokenSteps: {
    id: 'tokenSteps',
    label: 'By Token Range',
    groupBy: (item: TableRowData) => {
      const tokens = item.tokens || 0;
      if (tokens === 0) return 'Unknown';
      if (tokens < 100) return 'Small (< 100)';
      if (tokens < 500) return 'Medium (100-500)';
      if (tokens < 1000) return 'Large (500-1K)';
      if (tokens < 5000) return 'Very Large (1K-5K)';
      return 'Huge (> 5K)';
    },
    sortGroups: (a: GroupKey, b: GroupKey) => {
      const order = [
        'Unknown',
        'Small (< 100)',
        'Medium (100-500)',
        'Large (500-1K)',
        'Very Large (1K-5K)',
        'Huge (> 5K)',
      ];
      return order.indexOf(String(a)) - order.indexOf(String(b));
    },
  },
} as const satisfies Record<string, GroupConfig>;

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

  // Grouping state
  const [groupingConfig, setGroupingConfig] = useState<string>('none');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<GroupKey>>(new Set());

  // Helper function to group data
  const groupData = useCallback((data: TableRowData[], config: GroupConfig): GroupedData[] => {
    if (config.id === 'none') {
      return [
        {
          groupKey: 'all',
          groupLabel: 'All Files',
          items: data,
          count: data.length,
          totalTokens: data.reduce((sum, item) => sum + (item.tokens || 0), 0),
          totalSize: data.reduce((sum, item) => sum + (item.size || 0), 0),
        },
      ];
    }

    const groups = new Map<GroupKey, TableRowData[]>();

    for (const item of data) {
      const groupKey = config.groupBy(item);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)?.push(item);
    }

    const result: GroupedData[] = Array.from(groups.entries()).map(([groupKey, items]) => ({
      groupKey,
      groupLabel: String(groupKey),
      items,
      count: items.length,
      totalTokens: items.reduce((sum, item) => sum + (item.tokens || 0), 0),
      totalSize: items.reduce((sum, item) => sum + (item.size || 0), 0),
    }));

    // Sort groups if sorter is provided
    if (config.sortGroups) {
      result.sort((a, b) => config.sortGroups?.(a.groupKey, b.groupKey) ?? 0);
    }

    return result;
  }, []);

  // Toggle group collapse
  const toggleGroupCollapse = useCallback((groupKey: GroupKey) => {
    setCollapsedGroups((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(groupKey)) {
        newSet.delete(groupKey);
      } else {
        newSet.add(groupKey);
      }
      return newSet;
    });
  }, []);

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

  // Memoized sorted and grouped data
  const { sortedData, groupedData } = useMemo(() => {
    // First sort the data
    const sorted = [...tableData].sort((a, b) => {
      const comparison = compareValues(a[sortField], b[sortField], sortField);
      return sortDirection === 'desc' ? -comparison : comparison;
    });

    // Then group the sorted data
    const config =
      GROUPING_CONFIGS[groupingConfig as keyof typeof GROUPING_CONFIGS] ?? GROUPING_CONFIGS.none;
    const grouped = groupData(sorted, config);

    return { sortedData: sorted, groupedData: grouped };
  }, [tableData, sortField, sortDirection, compareValues, groupingConfig, groupData]);

  // Calculate total items for pagination (including group headers)
  const totalItems = useMemo(() => {
    if (groupingConfig === 'none') {
      return sortedData.length;
    }

    let count = 0;
    for (const group of groupedData) {
      count++; // Group header
      if (!collapsedGroups.has(group.groupKey)) {
        count += group.items.length; // Group items
      }
    }
    return count;
  }, [groupedData, collapsedGroups, groupingConfig, sortedData.length]);

  // Flatten grouped data for selection operations
  const flattenedData = useMemo(() => {
    if (groupingConfig === 'none') {
      return sortedData;
    }

    const flattened: TableRowData[] = [];
    for (const group of groupedData) {
      flattened.push(...group.items);
    }
    return flattened;
  }, [groupedData, groupingConfig, sortedData]);

  // Pagination calculations
  const totalPages = Math.ceil(
    (groupingConfig === 'none' ? flattenedData.length : totalItems) / pageSize
  );
  const startIndex = currentPage * pageSize;
  const endIndex = startIndex + pageSize;
  const currentPageData =
    groupingConfig === 'none' ? flattenedData.slice(startIndex, endIndex) : [];

  // Group selection handlers
  const handleGroupSelectAll = useCallback((group: GroupedData) => {
    const groupFiles = new Set(group.items.map((item) => item.compositeKey));
    setPreviewSelections((prev) => {
      const newSelection = new Set(prev);
      for (const key of groupFiles) {
        newSelection.add(key);
      }
      return newSelection;
    });
  }, []);

  const handleGroupDeselectAll = useCallback((group: GroupedData) => {
    const groupFiles = new Set(group.items.map((item) => item.compositeKey));
    setPreviewSelections((prev) => {
      const newSelection = new Set(prev);
      for (const key of groupFiles) {
        newSelection.delete(key);
      }
      return newSelection;
    });
  }, []);

  const isGroupFullySelected = useCallback(
    (group: GroupedData) => {
      if (group.items.length === 0) return false;
      return group.items.every((item) => previewSelections.has(item.compositeKey));
    },
    [previewSelections]
  );

  const isGroupPartiallySelected = useCallback(
    (group: GroupedData) => {
      return (
        group.items.some((item) => previewSelections.has(item.compositeKey)) &&
        !isGroupFullySelected(group)
      );
    },
    [previewSelections, isGroupFullySelected]
  );

  // Group header component
  const GroupHeader = memo(({ group }: { group: GroupedData }) => {
    const isCollapsed = collapsedGroups.has(group.groupKey);
    const isFullySelected = isGroupFullySelected(group);
    const isPartiallySelected = isGroupPartiallySelected(group);

    const handleGroupCheckboxChange = (checked: boolean) => {
      if (checked) {
        handleGroupSelectAll(group);
      } else {
        handleGroupDeselectAll(group);
      }
    };

    return (
      <tr className="bg-muted/50 border-b-2 border-muted-foreground/20">
        <td className="p-4 w-12">
          <Checkbox
            checked={isFullySelected}
            ref={(el) => {
              if (el && isPartiallySelected) {
                // Cast to HTMLInputElement since Checkbox renders an input
                (el as HTMLInputElement).indeterminate = true;
              }
            }}
            onCheckedChange={handleGroupCheckboxChange}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select all files in group ${group.groupLabel}`}
          />
        </td>
        <td className="p-4" colSpan={5}>
          <button
            type="button"
            className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors w-full text-left"
            onClick={() => toggleGroupCollapse(group.groupKey)}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} group ${group.groupLabel}`}
          >
            {isCollapsed ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
            <FolderOpen className="size-4 text-muted-foreground" />
            <span>{group.groupLabel}</span>
            <div className="flex gap-4 ml-auto text-xs text-muted-foreground">
              <span>{group.count} files</span>
              <span>{formatTokenCount(group.totalTokens)}</span>
              <span>{(group.totalSize / 1024).toFixed(1)} KB</span>
            </div>
          </button>
        </td>
      </tr>
    );
  });

  // Helper to render group items within pagination bounds
  const renderGroupItems = (group: GroupedData, itemCount: number, elements: React.ReactNode[]) => {
    let currentItemCount = itemCount;

    for (const item of group.items) {
      if (currentItemCount >= startIndex && currentItemCount < endIndex) {
        elements.push(
          <TableRow
            key={`item-${item.compositeKey}`}
            item={item}
            isSelected={previewSelections.has(item.compositeKey)}
            onToggleSelection={togglePreviewSelection}
            {...(onFileClick && { onFileClick })}
          />
        );
      }
      currentItemCount++;
    }

    return currentItemCount;
  };

  // Grouped table body renderer
  const GroupedTableBody = memo(() => {
    const elements: React.ReactNode[] = [];
    let itemCount = 0;

    for (const group of groupedData) {
      const isCollapsed = collapsedGroups.has(group.groupKey);

      // Add group header if within page bounds
      if (itemCount >= startIndex && itemCount < endIndex) {
        elements.push(<GroupHeader key={`group-${group.groupKey}`} group={group} />);
      }
      itemCount++;

      // Add group items if not collapsed
      if (!isCollapsed) {
        itemCount = renderGroupItems(group, itemCount, elements);
      }

      // Stop if we've reached the end of the page
      if (itemCount >= endIndex) break;
    }

    return <>{elements}</>;
  });

  // Helper to add visible group items
  const addVisibleGroupItems = useCallback(
    (group: GroupedData, itemCount: number, visibleFiles: TableRowData[]) => {
      let currentItemCount = itemCount;

      for (const item of group.items) {
        if (currentItemCount >= startIndex && currentItemCount < endIndex) {
          visibleFiles.push(item);
        }
        currentItemCount++;
      }

      return currentItemCount;
    },
    [startIndex, endIndex]
  );

  // Get files visible on current page (works for both grouped and ungrouped)
  const getVisibleFilesOnPage = useCallback(() => {
    if (groupingConfig === 'none') {
      return currentPageData;
    }

    const visibleFiles: TableRowData[] = [];
    let itemCount = 0;

    for (const group of groupedData) {
      const isCollapsed = collapsedGroups.has(group.groupKey);

      // Skip group header in count
      itemCount++;

      // Add group items if not collapsed
      if (!isCollapsed) {
        itemCount = addVisibleGroupItems(group, itemCount, visibleFiles);
      }

      if (itemCount >= endIndex) break;
    }

    return visibleFiles;
  }, [
    groupingConfig,
    currentPageData,
    groupedData,
    collapsedGroups,
    addVisibleGroupItems,
    endIndex,
  ]);

  // Preview panel selection handlers (internal to this component)
  const handlePreviewSelectAllPage = useCallback(() => {
    const visibleFiles = getVisibleFilesOnPage();
    const allFilesOnPage = new Set(visibleFiles.map((row) => row.compositeKey));
    setPreviewSelections((prev) => {
      const newSelection = new Set(prev);
      for (const key of allFilesOnPage) {
        newSelection.add(key);
      }
      return newSelection;
    });
  }, [getVisibleFilesOnPage]);

  const handlePreviewSelectAllGlobal = useCallback(() => {
    const allFiles = new Set(flattenedData.map((row) => row.compositeKey));
    setPreviewSelections(allFiles);
  }, [flattenedData]);

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
    const visibleFiles = getVisibleFilesOnPage();
    if (visibleFiles.length === 0) return false;
    return visibleFiles.every((item) => previewSelections.has(item.compositeKey));
  }, [getVisibleFilesOnPage, previewSelections]);

  // Check if all items globally are selected
  const isAllGloballySelected = useMemo(() => {
    if (flattenedData.length === 0) return false;
    return flattenedData.every((item) => previewSelections.has(item.compositeKey));
  }, [flattenedData, previewSelections]);

  // Table row component with explicit selection props
  const TableRow = ({
    item,
    isSelected,
    onToggleSelection,
    onFileClick: onFileClickProp,
  }: {
    item: TableRowData;
    isSelected: boolean;
    onToggleSelection: (compositeKey: string, checked: boolean) => void;
    onFileClick?: (compositeKey: string) => void;
  }) => {
    const fileName = item.path.split('/').pop() || item.path;
    const dirPath = item.path.substring(0, item.path.lastIndexOf('/'));

    return (
      <tr className="border-b transition-colors hover:bg-muted/50">
        <td className="p-4 w-12">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) => onToggleSelection(item.compositeKey, !!checked)}
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
              onFileClickProp?.(item.compositeKey);
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
  };

  // Add displayName for debugging
  TableRow.displayName = 'TableRow';

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
  const prevTotalPagesRef = useRef(totalPages);
  const prevGroupingConfigRef = useRef(groupingConfig);
  useEffect(() => {
    if (
      prevTotalPagesRef.current !== totalPages ||
      prevGroupingConfigRef.current !== groupingConfig
    ) {
      prevTotalPagesRef.current = totalPages;
      prevGroupingConfigRef.current = groupingConfig;
      setCurrentPage(0);
      return;
    }
    if (currentPage >= totalPages && totalPages > 0) {
      setCurrentPage(0);
    }
  }, [currentPage, totalPages, groupingConfig]);

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
      <div className="p-3 border-b bg-background">
        {/* Top row - stats and main controls */}
        <div className="flex items-center justify-between mb-3">
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
              Select All ({flattenedData.length})
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
            <Button
              variant="outline"
              size="sm"
              onClick={expandAllFolders}
              title="Expand all folders"
            >
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

        {/* Bottom row - grouping controls */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Group by:</span>
          <select
            value={groupingConfig}
            onChange={(e) => {
              setGroupingConfig(e.target.value);
              setCurrentPage(0);
              setCollapsedGroups(new Set());
            }}
            className="text-sm border border-input bg-background px-2 py-1 rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {Object.entries(GROUPING_CONFIGS).map(([key, config]) => (
              <option key={key} value={key}>
                {config.label}
              </option>
            ))}
          </select>
          {groupingConfig !== 'none' && groupedData.length > 1 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCollapsedGroups(new Set())}
                title="Expand all groups"
              >
                Expand All Groups
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCollapsedGroups(new Set(groupedData.map((g) => g.groupKey)))}
                title="Collapse all groups"
              >
                Collapse All Groups
              </Button>
            </>
          )}
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
            <tbody>
              {groupingConfig === 'none' ? (
                currentPageData.map((item) => (
                  <TableRow
                    key={item.compositeKey}
                    item={item}
                    isSelected={previewSelections.has(item.compositeKey)}
                    onToggleSelection={togglePreviewSelection}
                    {...(onFileClick && { onFileClick })}
                  />
                ))
              ) : (
                <GroupedTableBody />
              )}
            </tbody>
          </table>
          {flattenedData.length === 0 && (
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
              Page {currentPage + 1} of {totalPages} ({flattenedData.length} total files
              {groupingConfig !== 'none' && groupedData.length > 1
                ? `, ${groupedData.length} groups`
                : ''}
              )
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
