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
import {
  AlertTriangle,
  CheckCircle2,
  Columns3,
  Download,
  FileText,
  FileX2,
  FolderOpen,
  Loader2,
  MinusCircle,
} from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useGroupSelection } from './hooks/use-group-selection';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import { PreviewTableRow } from './preview-table-row';
import { type FileItem, formatTokenCount, usePreviewPanelState } from './use-preview-panel-state';
import type { TokenCountingState } from './use-token-counting';
import {
  GROUPING_CONFIGS,
  type GroupedData,
  type GroupKey,
  groupData,
  type TableRowData,
} from './utils/grouping-configs';

const logger = createLogger('PreviewPanel');

type PreviewPanelProps = {
  selectedFiles: Set<string>;
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  onSelectionChange: (files: Set<string>) => void;
  fileSizes?: { [compositeKey: string]: number };
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  tokenCounting: TokenCountingState;
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
  onDownloadReport?: () => void;
  onCopyReport?: () => void;
};

// Column configuration
type ColumnConfig = {
  id: string;
  label: string;
  accessor: keyof TableRowData | 'checkbox';
  canHide: boolean;
  defaultVisible: boolean;
};

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

// Utility functions to reduce complexity
function loadStoredPreferences(storageKey: string) {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function createDefaultColumnVisibility(): ColumnVisibility {
  return {
    checkbox: true,
    rootFolderId: true,
    path: true,
    type: true,
    tokens: true,
    size: true,
  };
}

function getStoredColumnVisibility(storageKey: string): ColumnVisibility {
  const stored = loadStoredPreferences(storageKey);
  if (stored?.columnVisibility) {
    return {
      checkbox: true,
      rootFolderId: stored.columnVisibility.rootFolderId ?? true,
      path: true, // Always keep path visible
      type: stored.columnVisibility.type ?? true,
      tokens: stored.columnVisibility.tokens ?? true,
      size: stored.columnVisibility.size ?? true,
    };
  }
  return createDefaultColumnVisibility();
}

function getStoredValue<T>(storageKey: string, key: string, defaultValue: T): T {
  const stored = loadStoredPreferences(storageKey);
  return stored?.[key] ?? defaultValue;
}

// Column visibility controls component
type ColumnVisibilityControlsProps = {
  columnVisibility: ColumnVisibility;
  onColumnVisibilityChange: (visibility: ColumnVisibility) => void;
};

const ColumnVisibilityControls = memo<ColumnVisibilityControlsProps>(
  function ColumnVisibilityControlsComponent({ columnVisibility, onColumnVisibilityChange }) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline">
            <Columns3 className="mr-1 size-3.5" />
            Columns
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-48 p-2">
          <div className="space-y-1">
            {COLUMN_CONFIGS.filter((col) => col.canHide).map((column) => (
              <div
                className="flex cursor-pointer items-center space-x-2 rounded px-2 py-1.5 hover:bg-accent"
                key={column.id}
              >
                <Checkbox
                  checked={columnVisibility[column.id as keyof ColumnVisibility] ?? false}
                  disabled={column.id === 'checkbox' || column.id === 'path'}
                  id={`column-${column.id}`} // Keep essential columns always visible
                  onCheckedChange={(checked) => {
                    onColumnVisibilityChange({
                      ...columnVisibility,
                      [column.id]: !!checked,
                    });
                  }}
                />
                <label
                  className="cursor-pointer select-none text-sm"
                  htmlFor={`column-${column.id}`}
                >
                  {column.label}
                </label>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    );
  }
);

// Preview Table component to reduce main component complexity
type PreviewTableProps = {
  columnVisibility: ColumnVisibility;
  sortField: keyof TableRowData;
  sortDirection: 'asc' | 'desc';
  groupingConfig: string;
  groupedData: GroupedData<TableRowData>[];
  currentPageData: TableRowData[];
  collapsedGroups: Set<string>;
  isAllCurrentPageSelected: boolean;
  previewSelections: Set<string>;
  onSort: (field: keyof TableRowData) => void;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  onSelectAllOnPage: (items: TableRowData[]) => void;
  onDeselectAll: () => void;
  getVisibleFilesOnPage: () => TableRowData[];
  onFileClick?: (compositeKey: string) => void;
  toggleGroupCollapse: (groupKey: GroupKey) => void;
  isGroupFullySelected: (group: GroupedData<TableRowData>) => boolean;
  isGroupPartiallySelected: (group: GroupedData<TableRowData>) => boolean;
  handleGroupSelectAll: (group: GroupedData<TableRowData>) => void;
  handleGroupDeselectAll: (group: GroupedData<TableRowData>) => void;
  renderGroupItems: (
    group: GroupedData<TableRowData>,
    itemCount: number,
    elements: React.ReactNode[]
  ) => number;
  pagination: { startIndex: number; endIndex: number };
};

const PreviewTable = memo<PreviewTableProps>(function PreviewTableComponent(props) {
  const {
    columnVisibility,
    sortField,
    sortDirection,
    groupingConfig,
    groupedData,
    currentPageData,
    isAllCurrentPageSelected,
    onSort,
    onSelectAllOnPage,
    onDeselectAll,
    getVisibleFilesOnPage,
    onFileClick,
    onToggleSelection,
    previewSelections,
    collapsedGroups,
    toggleGroupCollapse,
    isGroupFullySelected,
    isGroupPartiallySelected,
    handleGroupSelectAll,
    handleGroupDeselectAll,
    renderGroupItems,
    pagination,
  } = props;

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
        icon={<FolderOpen className="size-4 text-muted-foreground" />}
        isCollapsed={collapsedGroups.has(String(group.groupKey))}
        isFullySelected={isGroupFullySelected(group)}
        isPartiallySelected={isGroupPartiallySelected(group)}
        onSelectionChange={handleSelectionChange}
        onToggleCollapse={() => toggleGroupCollapse(group.groupKey)}
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

  // Grouped table body renderer
  const GroupedTableBody = memo(() => {
    const elements: React.ReactNode[] = [];
    let itemCount = 0;

    for (const group of groupedData) {
      const isCollapsed = collapsedGroups.has(String(group.groupKey));

      // Add group header if within page bounds
      if (itemCount >= pagination.startIndex && itemCount < pagination.endIndex) {
        elements.push(<GroupHeaderWrapper group={group} key={`group-${group.groupKey}`} />);
      }
      itemCount++;

      // Add group items if not collapsed
      if (!isCollapsed) {
        itemCount = renderGroupItems(group, itemCount, elements);
      }

      // Stop if we've reached the end of the page
      if (itemCount >= pagination.endIndex) {
        break;
      }
    }

    return <>{elements}</>;
  });

  return (
    <div className="flex-1 overflow-auto">
      <div className="min-w-full">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 border-b bg-background">
            <tr>
              {columnVisibility.checkbox && (
                <th className="w-12 px-4 py-3" scope="col">
                  <Checkbox
                    aria-label="Select all files on current page"
                    checked={isAllCurrentPageSelected}
                    onCheckedChange={(checked) =>
                      checked ? onSelectAllOnPage(getVisibleFilesOnPage()) : onDeselectAll()
                    }
                    title="Select all files on current page"
                  />
                </th>
              )}
              {columnVisibility.rootFolderId && (
                <SortableTableHeader
                  field="rootFolderId"
                  onSort={onSort}
                  sortDirection={sortDirection}
                  sortField={sortField}
                  title="Folder"
                />
              )}
              {columnVisibility.path && (
                <SortableTableHeader
                  className="min-w-0 flex-1"
                  field="path"
                  onSort={onSort}
                  sortDirection={sortDirection}
                  sortField={sortField}
                  title="File Path"
                />
              )}
              {columnVisibility.type && (
                <SortableTableHeader
                  className="w-20"
                  field="type"
                  onSort={onSort}
                  sortDirection={sortDirection}
                  sortField={sortField}
                  title="Type"
                />
              )}
              {columnVisibility.tokens && (
                <SortableTableHeader
                  className="w-24"
                  field="tokens"
                  onSort={onSort}
                  sortDirection={sortDirection}
                  sortField={sortField}
                  title="Tokens"
                />
              )}
              {columnVisibility.size && (
                <SortableTableHeader
                  className="w-24"
                  field="size"
                  onSort={onSort}
                  sortDirection={sortDirection}
                  sortField={sortField}
                  title="Size"
                />
              )}
            </tr>
          </thead>
          <tbody>
            {groupingConfig === 'none' ? (
              currentPageData.map((item) => (
                <PreviewTableRow
                  columnVisibility={columnVisibility}
                  isSelected={previewSelections.has(item.compositeKey)}
                  item={item}
                  key={item.compositeKey}
                  onToggleSelection={onToggleSelection}
                  {...(onFileClick && { onFileClick })}
                />
              ))
            ) : (
              <GroupedTableBody />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});

export const PreviewPanel = memo<PreviewPanelProps>(function PreviewPanelComponent(props) {
  const {
    selectedFiles,
    fileContents,
    loadingFiles,
    onSelectionChange,
    fileSizes,
    decodeFileSelection,
    tokenCounting,
    performUndoableAction,
    onFileClick,
    pageSize = 50,
    onDownloadReport,
    onCopyReport,
  } = props;

  // Local selection state for preview panel - separate from file tree selections
  const [previewSelections, setPreviewSelections] = useState<Set<string>>(new Set());

  // Safe localStorage persistence without the problematic hook
  const storageKey = 'previewPanelPreferences.v1';

  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(() =>
    getStoredColumnVisibility(storageKey)
  );

  const [sortField, setSortField] = useState<keyof TableRowData>(() =>
    getStoredValue(storageKey, 'sortField', 'rootFolderId')
  );

  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() =>
    getStoredValue(storageKey, 'sortDirection', 'asc')
  );

  const [groupingConfig, setGroupingConfig] = useState<string>(() =>
    getStoredValue(storageKey, 'groupingConfig', 'none')
  );

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const storedGroups = getStoredValue(storageKey, 'collapsedGroups', []);
    return new Set(storedGroups);
  });

  // Debounced save to localStorage
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      try {
        const settings = {
          columnVisibility,
          sortField,
          sortDirection,
          groupingConfig,
          collapsedGroups: Array.from(collapsedGroups),
        };
        localStorage.setItem(storageKey, JSON.stringify(settings));
      } catch {
        // Ignore errors
      }
    }, 250);

    return () => clearTimeout(timeoutId);
  }, [columnVisibility, sortField, sortDirection, groupingConfig, collapsedGroups]);

  const state = usePreviewPanelState({
    selectedFiles,
    fileContents,
    loadingFiles,
    onSelectionChange,
    ...(fileSizes ? { fileSizes } : {}),
    decodeFileSelection,
    tokenCounting,
    performUndoableAction,
  });

  const tokenStatus = useMemo(() => {
    if (tokenCounting.loading) {
      return {
        label: 'Checking tokenizer…',
        description: 'Loading WASM tokenizer to confirm accurate counting is available.',
        variant: 'outline' as const,
        icon: Loader2,
        spin: true,
      };
    }
    if (tokenCounting.mode === 'accurate') {
      return {
        label: 'Accurate tokens (WASM)',
        description: 'Counts generated with the tiktoken WASM encoder.',
        variant: 'secondary' as const,
        icon: CheckCircle2,
        spin: false,
      };
    }
    if (tokenCounting.reason === 'runtime-fallback') {
      return {
        label: 'Heuristic fallback',
        description: 'WASM tokenizer is unavailable; using 4 chars/token heuristic.',
        variant: 'destructive' as const,
        icon: AlertTriangle,
        spin: false,
      };
    }
    return {
      label: 'Heuristic mode',
      description: 'Accurate counting disabled in global token settings.',
      variant: 'outline' as const,
      icon: MinusCircle,
      spin: false,
    };
  }, [tokenCounting.loading, tokenCounting.mode, tokenCounting.reason]);

  const StatusIcon = tokenStatus.icon;

  const { totalStats, flatListItems } = state;

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
            path,
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
    if (aVal === null && bVal === null) {
      return 0;
    }
    if (aVal === null) {
      return 1;
    }
    if (bVal === null) {
      return -1;
    }
    return null;
  }, []);

  // Comparison helper with proper type handling
  const compareValues = useCallback(
    (aVal: unknown, bVal: unknown, field: keyof TableRowData): number => {
      const nullResult = handleNullValues(aVal, bVal);
      if (nullResult !== null) {
        return nullResult;
      }

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

  // Helper to render group items within pagination bounds
  const renderGroupItems = useCallback(
    (group: GroupedData<TableRowData>, itemCount: number, elements: React.ReactNode[]) => {
      let currentItemCount = itemCount;

      for (const item of group.items) {
        if (currentItemCount >= pagination.startIndex && currentItemCount < pagination.endIndex) {
          elements.push(
            <PreviewTableRow
              columnVisibility={columnVisibility}
              isSelected={previewSelections.has(item.compositeKey)}
              item={item}
              key={`item-${item.compositeKey}`}
              onToggleSelection={toggleItemSelection}
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

  // Helper to collect visible items from a group
  const collectVisibleGroupItems = useCallback(
    (group: GroupedData<TableRowData>, startCount: number, visibleFiles: TableRowData[]) => {
      let itemCount = startCount;

      for (const item of group.items) {
        if (itemCount >= pagination.startIndex && itemCount < pagination.endIndex) {
          visibleFiles.push(item);
        }
        itemCount++;
        if (itemCount >= pagination.endIndex) {
          break;
        }
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

      if (itemCount >= pagination.endIndex) {
        break;
      }
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
    if (previewSelections.size === 0) {
      return;
    }

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
  // biome-ignore lint/plugin: Reset pagination when grouping config changes
  useEffect(() => {
    if (prevGroupingConfigRef.current !== groupingConfig) {
      prevGroupingConfigRef.current = groupingConfig;
      resetToFirstPage();
    }
  }, [groupingConfig, resetToFirstPage]);

  if (selectedFiles.size === 0) {
    return (
      <div className="p-4">
        <p className="text-gray-500 text-sm">No files selected</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header with stats and controls */}
      <div className="border-b bg-background p-3">
        {/* Top row - stats and main controls */}
        <div className="mb-3 flex items-center justify-between gap-6">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <Badge className="py-1.5" variant="outline">
                {formatTokenCount(totalStats.totalTokens)}
              </Badge>
              <Badge
                className="flex items-center gap-1 py-1.5"
                title={tokenStatus.description}
                variant={tokenStatus.variant}
              >
                <StatusIcon className={`size-3.5 ${tokenStatus.spin ? 'animate-spin' : ''}`} />
                {tokenStatus.label}
              </Badge>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-muted-foreground text-xs">
                <span className="font-medium">{totalStats.totalFiles}</span> files |{' '}
                <span className="font-medium">{totalStats.totalTokens.toLocaleString()}</span>{' '}
                tokens
              </div>
              <div className="w-32">
                <Progress
                  className="h-2"
                  data-testid="progress"
                  value={Math.min((totalStats.totalTokens / 100_000) * 100, 100)}
                />
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground">{tokenStatus.description}</div>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={isAllSelected(flattenedData)}
              onClick={() => groupSelection.selectAll(flattenedData)}
              size="sm"
              title="Select all files across all pages"
              variant="outline"
            >
              Select All ({flattenedData.length})
            </Button>
            {(sortField !== 'rootFolderId' || sortDirection !== 'asc') && (
              <Button
                onClick={resetSort}
                size="sm"
                title="Reset sort to default (by folder)"
                variant="outline"
              >
                Reset Sort
              </Button>
            )}
            <ColumnVisibilityControls
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={setColumnVisibility}
            />
          </div>
        </div>

        {/* Bottom row - grouping controls */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Group by:</span>
          <select
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            onChange={(e) => {
              setGroupingConfig(e.target.value);
              setCollapsedGroups(new Set());
            }}
            value={groupingConfig}
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
                onClick={() => setCollapsedGroups(new Set())}
                size="sm"
                title="Expand all groups"
                variant="outline"
              >
                Expand All Groups
              </Button>
              <Button
                onClick={() =>
                  setCollapsedGroups(new Set(groupedData.map((g) => String(g.groupKey))))
                }
                size="sm"
                title="Collapse all groups"
                variant="outline"
              >
                Collapse All Groups
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Table */}
      <PreviewTable
        collapsedGroups={collapsedGroups}
        columnVisibility={columnVisibility}
        currentPageData={currentPageData}
        getVisibleFilesOnPage={getVisibleFilesOnPage}
        groupedData={groupedData}
        groupingConfig={groupingConfig}
        isAllCurrentPageSelected={isAllCurrentPageSelected}
        onDeselectAll={deselectAll}
        onSelectAllOnPage={selectAllOnPage}
        onSort={handleSort}
        onToggleSelection={toggleItemSelection}
        previewSelections={previewSelections}
        sortDirection={sortDirection}
        sortField={sortField}
        {...(onFileClick && { onFileClick })}
        handleGroupDeselectAll={handleGroupDeselectAll}
        handleGroupSelectAll={handleGroupSelectAll}
        isGroupFullySelected={isGroupFullySelected}
        isGroupPartiallySelected={isGroupPartiallySelected}
        pagination={pagination}
        renderGroupItems={renderGroupItems}
        toggleGroupCollapse={toggleGroupCollapse}
      />

      {flattenedData.length === 0 && (
        <div className="p-8 text-center text-muted-foreground">
          No files match your selection criteria
        </div>
      )}

      {/* Pagination */}
      <TablePagination
        currentPage={currentPage}
        onPageChange={goToPage}
        totalItems={flattenedData.length}
        totalPages={pagination.totalPages}
        {...(groupingConfig !== 'none' && groupedData.length > 1
          ? { pageInfo: `(${flattenedData.length} total files, ${groupedData.length} groups)` }
          : {})}
      />

      {/* Fixed bottom action bar */}
      {previewSelections.size > 0 && (
        <div className="flex flex-shrink-0 items-center justify-between border-t bg-yellow-50 p-3 dark:bg-yellow-900/20">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">
              {previewSelections.size} files selected in preview
            </span>
            <Button onClick={deselectAll} size="sm" variant="outline">
              Clear Preview Selection
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {onDownloadReport && (
              <Button
                disabled={selectedFiles.size === 0}
                onClick={onDownloadReport}
                size="sm"
                variant="outline"
              >
                <Download className="mr-1 size-3.5" />
                Download Report
              </Button>
            )}
            {onCopyReport && (
              <Button
                disabled={selectedFiles.size === 0}
                onClick={onCopyReport}
                size="sm"
                variant="outline"
              >
                <FileText className="mr-1 size-3.5" />
                Copy Report
              </Button>
            )}
            <Button onClick={handleBatchRemove} size="sm" variant="destructive">
              <FileX2 className="mr-1 size-3.5" />
              Remove Selected from Project
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});

PreviewPanel.displayName = 'PreviewPanel';
