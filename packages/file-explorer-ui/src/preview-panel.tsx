import { usePagination } from '@brainstrike/hooks';
import {
  Badge,
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  SortableTableHeader,
  TableGroupHeader,
  TablePagination,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { ArrowDown, ArrowUp, Columns3, FileX2, FolderOpen } from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useGroupSelection } from './hooks/use-group-selection';
import { PreviewTableRow } from './preview-table-row';
import { type FileItem, formatTokenCount, usePreviewPanelState } from './use-preview-panel-state';
import {
  GROUPING_CONFIGS,
  type GroupKey,
  type GroupedData,
  type TableRowData,
  groupData,
} from './utils/grouping-configs';

const logger = createLogger('PreviewPanel');

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
  pageSize?: number;
}

// Column configuration
interface ColumnConfig {
  id: string;
  label: string;
  accessor: keyof TableRowData | 'checkbox';
  canHide: boolean;
  defaultVisible: boolean;
}

const COLUMN_CONFIGS: ColumnConfig[] = [
  {
    id: 'checkbox',
    label: 'Selection',
    accessor: 'checkbox',
    canHide: false,
    defaultVisible: true,
  },
  {
    id: 'rootFolderId',
    label: 'Folder',
    accessor: 'rootFolderId',
    canHide: true,
    defaultVisible: true,
  },
  { id: 'path', label: 'File Path', accessor: 'path', canHide: false, defaultVisible: true },
  { id: 'type', label: 'Type', accessor: 'type', canHide: true, defaultVisible: true },
  { id: 'tokens', label: 'Tokens', accessor: 'tokens', canHide: true, defaultVisible: true },
  { id: 'size', label: 'Size', accessor: 'size', canHide: true, defaultVisible: true },
];

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

  // Default column visibility
  const defaultColumnVisibility = useMemo(() => {
    const defaults: Record<string, boolean> = {};
    for (const col of COLUMN_CONFIGS) {
      defaults[col.id] = col.defaultVisible;
    }
    return defaults;
  }, []);

  // Simple persistence with localStorage
  const STORAGE_KEY = 'previewPanelPreferences.v1';
  
  // Load initial state from localStorage
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...defaultColumnVisibility, ...parsed.columnVisibility };
      }
    } catch (error) {
      console.warn('Failed to load preferences from localStorage:', error);
    }
    return defaultColumnVisibility;
  });
  
  const [sortField, setSortField] = useState<keyof TableRowData>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.sortField || 'rootFolderId';
      }
    } catch (error) {
      console.warn('Failed to load preferences from localStorage:', error);
    }
    return 'rootFolderId';
  });
  
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.sortDirection || 'asc';
      }
    } catch (error) {
      console.warn('Failed to load preferences from localStorage:', error);
    }
    return 'asc';
  });
  
  const [groupingConfig, setGroupingConfig] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.groupingConfig || 'none';
      }
    } catch (error) {
      console.warn('Failed to load preferences from localStorage:', error);
    }
    return 'none';
  });
  
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return new Set(parsed.collapsedGroups || []);
      }
    } catch (error) {
      console.warn('Failed to load preferences from localStorage:', error);
    }
    return new Set();
  });

  // Save to localStorage whenever state changes
  const savePreferences = useCallback(() => {
    try {
      const preferences = {
        columnVisibility,
        sortField,
        sortDirection,
        groupingConfig,
        collapsedGroups: Array.from(collapsedGroups),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
      console.log('💾 Saved preferences to localStorage');
    } catch (error) {
      console.warn('Failed to save preferences to localStorage:', error);
    }
  }, [columnVisibility, sortField, sortDirection, groupingConfig, collapsedGroups]);

  // Debounced save
  useEffect(() => {
    const timeoutId = setTimeout(savePreferences, 250);
    return () => clearTimeout(timeoutId);
  }, [savePreferences]);

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

  // Transform list items to simplified table data - only files
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
          logger.warn('Failed to decode composite key:', fileItem.compositeKey, error);
          return null;
        }
      })
      .filter((item): item is TableRowData => item !== null);
  }, [deferredFlatListItems, decodeFileSelection]);

  // Using local state variables defined above

  // Toggle group collapse
  const toggleGroupCollapse = useCallback((groupKey: GroupKey) => {
    setCollapsedGroups((prev) => {
      const newSet = new Set(prev);
      const keyStr = String(groupKey);
      if (newSet.has(keyStr)) {
        newSet.delete(keyStr);
      } else {
        newSet.add(keyStr);
      }
      return newSet;
    });
  }, []);

  // Null check helper
  const handleNullValues = useCallback((aVal: unknown, bVal: unknown): number | null => {
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    return null;
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
  }, [tableData, sortField, sortDirection, compareValues, groupingConfig]);

  // Calculate total items for pagination (including group headers)
  const totalItems = useMemo(() => {
    if (groupingConfig === 'none') {
      return sortedData.length;
    }

    let count = 0;
    for (const group of groupedData) {
      count++; // Group header
      if (!collapsedGroups.has(String(group.groupKey))) {
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

  // Use pagination hook
  const pagination = usePagination({
    totalItems: groupingConfig === 'none' ? flattenedData.length : totalItems,
    pageSize,
  });

  const { currentPage, goToPage, resetToFirstPage } = pagination;

  // Use group selection hook
  const groupSelection = useGroupSelection({
    selections: previewSelections,
    onSelectionChange: setPreviewSelections,
    getItemKey: (item: TableRowData) => item.compositeKey,
  });

  const {
    handleGroupSelectAll,
    handleGroupDeselectAll,
    isGroupFullySelected,
    isGroupPartiallySelected,
    toggleItemSelection,
    selectAllOnPage,
    deselectAll,
    isAllSelected,
  } = groupSelection;

  // Current page data
  const currentPageData =
    groupingConfig === 'none'
      ? flattenedData.slice(pagination.startIndex, pagination.endIndex)
      : [];

  // Group header component wrapper
  const GroupHeaderWrapper = memo(({ group }: { group: GroupedData<TableRowData> }) => {
    const handleSelectionChange = (checked: boolean) => {
      if (checked) {
        handleGroupSelectAll(group);
      } else {
        handleGroupDeselectAll(group);
      }
    };

    return (
      <TableGroupHeader
        groupKey={group.groupKey}
        groupLabel={group.groupLabel}
        isCollapsed={collapsedGroups.has(String(group.groupKey))}
        isFullySelected={isGroupFullySelected(group)}
        isPartiallySelected={isGroupPartiallySelected(group)}
        onToggleCollapse={() => toggleGroupCollapse(group.groupKey)}
        onSelectionChange={handleSelectionChange}
        icon={<FolderOpen className="size-4 text-muted-foreground" />}
        stats={
          <>
            <span>{group.count} files</span>
            <span>{formatTokenCount(group.totalTokens)}</span>
            <span>{(group.totalSize / 1024).toFixed(1)} KB</span>
          </>
        }
      />
    );
  });

  // Helper to render group items within pagination bounds
  const renderGroupItems = useCallback(
    (group: GroupedData<TableRowData>, itemCount: number, elements: React.ReactNode[]) => {
      let currentItemCount = itemCount;

      for (const item of group.items) {
        if (currentItemCount >= pagination.startIndex && currentItemCount < pagination.endIndex) {
          elements.push(
            <PreviewTableRow
              key={`item-${item.compositeKey}`}
              item={item}
              isSelected={previewSelections.has(item.compositeKey)}
              onToggleSelection={toggleItemSelection}
              columnVisibility={columnVisibility}
              {...(onFileClick && { onFileClick })}
            />
          );
        }
        currentItemCount++;
      }

      return currentItemCount;
    },
    [
      pagination.startIndex,
      pagination.endIndex,
      previewSelections,
      toggleItemSelection,
      columnVisibility,
      onFileClick,
    ]
  );

  // Grouped table body renderer
  const GroupedTableBody = memo(() => {
    const elements: React.ReactNode[] = [];
    let itemCount = 0;

    for (const group of groupedData) {
      const isCollapsed = collapsedGroups.has(String(group.groupKey));

      // Add group header if within page bounds
      if (itemCount >= pagination.startIndex && itemCount < pagination.endIndex) {
        elements.push(<GroupHeaderWrapper key={`group-${group.groupKey}`} group={group} />);
      }
      itemCount++;

      // Add group items if not collapsed
      if (!isCollapsed) {
        itemCount = renderGroupItems(group, itemCount, elements);
      }

      // Stop if we've reached the end of the page
      if (itemCount >= pagination.endIndex) break;
    }

    return <>{elements}</>;
  });

  // Helper to collect visible items from a group
  const collectVisibleGroupItems = useCallback(
    (group: GroupedData<TableRowData>, startCount: number, visibleFiles: TableRowData[]) => {
      let itemCount = startCount;

      for (const item of group.items) {
        if (itemCount >= pagination.startIndex && itemCount < pagination.endIndex) {
          visibleFiles.push(item);
        }
        itemCount++;
        if (itemCount >= pagination.endIndex) break;
      }

      return itemCount;
    },
    [pagination.startIndex, pagination.endIndex]
  );

  // Get files visible on current page
  const getVisibleFilesOnPage = useCallback(() => {
    if (groupingConfig === 'none') {
      return currentPageData;
    }

    const visibleFiles: TableRowData[] = [];
    let itemCount = 0;

    for (const group of groupedData) {
      itemCount++; // Group header count

      if (!collapsedGroups.has(String(group.groupKey))) {
        itemCount = collectVisibleGroupItems(group, itemCount, visibleFiles);
      }

      if (itemCount >= pagination.endIndex) break;
    }

    return visibleFiles;
  }, [
    groupingConfig,
    currentPageData,
    groupedData,
    collapsedGroups,
    collectVisibleGroupItems,
    pagination.endIndex,
  ]);

  // Batch remove handler
  const handleBatchRemove = useCallback(() => {
    if (previewSelections.size === 0) return;

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
    setPreviewSelections(new Set());
  }, [previewSelections, selectedFiles, onSelectionChange, performUndoableAction]);

  // Check if all items on current page are selected
  const isAllCurrentPageSelected = useMemo(() => {
    const visibleFiles = getVisibleFilesOnPage();
    return isAllSelected(visibleFiles);
  }, [getVisibleFilesOnPage, isAllSelected]);

  // Handle sort changes
  const handleSort = useCallback(
    (field: keyof TableRowData) => {
      if (sortField === field) {
        setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
      resetToFirstPage();
    },
    [sortField, resetToFirstPage]
  );

  const resetSort = useCallback(() => {
    setSortField('rootFolderId');
    setSortDirection('asc');
    resetToFirstPage();
  }, [resetToFirstPage]);

  // Reset to first page when grouping changes
  const prevGroupingConfigRef = useRef(groupingConfig);
  useEffect(() => {
    if (prevGroupingConfigRef.current !== groupingConfig) {
      prevGroupingConfigRef.current = groupingConfig;
      resetToFirstPage();
    }
  }, [groupingConfig, resetToFirstPage]);

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
              onClick={() => groupSelection.selectAll(flattenedData)}
              disabled={isAllSelected(flattenedData)}
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
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <Columns3 className="size-3.5 mr-1" />
                  Columns
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-2">
                <div className="space-y-1">
                  {COLUMN_CONFIGS.filter((col) => col.canHide).map((column) => (
                    <div
                      key={column.id}
                      className="flex items-center space-x-2 py-1.5 px-2 rounded hover:bg-accent cursor-pointer"
                    >
                      <Checkbox
                        id={`column-${column.id}`}
                        checked={columnVisibility[column.id] ?? false}
                        onCheckedChange={(checked) => {
                          setColumnVisibility(prev => ({
                            ...prev,
                            [column.id]: !!checked
                          }));
                        }}
                      />
                      <label
                        htmlFor={`column-${column.id}`}
                        className="text-sm select-none cursor-pointer"
                      >
                        {column.label}
                      </label>
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Bottom row - grouping controls */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Group by:</span>
          <select
            value={groupingConfig}
            onChange={(e) => {
              setGroupingConfig(e.target.value);
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
                onClick={() => setCollapsedGroups(new Set(groupedData.map((g) => String(g.groupKey))))}
                title="Collapse all groups"
              >
                Collapse All Groups
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <div className="min-w-full">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-background border-b">
              <tr>
                {columnVisibility['checkbox'] && (
                  <th className="px-4 py-3 w-12" scope="col">
                    <Checkbox
                      checked={isAllCurrentPageSelected}
                      onCheckedChange={(checked) =>
                        checked ? selectAllOnPage(getVisibleFilesOnPage()) : deselectAll()
                      }
                      aria-label="Select all files on current page"
                      title="Select all files on current page"
                    />
                  </th>
                )}
                {columnVisibility['rootFolderId'] && (
                  <SortableTableHeader
                    field="rootFolderId"
                    title="Folder"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />
                )}
                {columnVisibility['path'] && (
                  <SortableTableHeader
                    field="path"
                    title="File Path"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="min-w-0 flex-1"
                  />
                )}
                {columnVisibility['type'] && (
                  <SortableTableHeader
                    field="type"
                    title="Type"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="w-20"
                  />
                )}
                {columnVisibility['tokens'] && (
                  <SortableTableHeader
                    field="tokens"
                    title="Tokens"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="w-24"
                  />
                )}
                {columnVisibility['size'] && (
                  <SortableTableHeader
                    field="size"
                    title="Size"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="w-24"
                  />
                )}
              </tr>
            </thead>
            <tbody>
              {groupingConfig === 'none' ? (
                currentPageData.map((item) => (
                  <PreviewTableRow
                    key={item.compositeKey}
                    item={item}
                    isSelected={previewSelections.has(item.compositeKey)}
                    onToggleSelection={toggleItemSelection}
                    columnVisibility={columnVisibility}
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

      {/* Pagination */}
      <TablePagination
        currentPage={currentPage}
        totalPages={pagination.totalPages}
        totalItems={flattenedData.length}
        onPageChange={goToPage}
        {...(groupingConfig !== 'none' && groupedData.length > 1
          ? { pageInfo: `(${flattenedData.length} total files, ${groupedData.length} groups)` }
          : {})}
      />

      {/* Fixed bottom action bar */}
      {previewSelections.size > 0 && (
        <div className="flex-shrink-0 p-3 border-t bg-yellow-50 dark:bg-yellow-900/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {previewSelections.size} files selected in preview
            </span>
            <Button size="sm" variant="outline" onClick={deselectAll}>
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
