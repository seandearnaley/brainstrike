import { usePagination } from '@brainstrike/hooks';
import { DEFAULT_TOKEN_BUDGET } from '@brainstrike/types';
import {
  Badge,
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
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
  type LucideIcon,
  MinusCircle,
} from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useGroupSelection } from './hooks/use-group-selection';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import IncludeProjectTreeSetting from './include-project-tree-setting';
import { PreviewTableRow } from './preview-table-row';
import { TokenBudgetControl } from './token-budget-control';
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

type TokenStatus = {
  label: string;
  description: string;
  variant: 'outline' | 'secondary' | 'destructive';
  icon: LucideIcon;
  spin: boolean;
};

function getTokenStatus(tokenCounting: TokenCountingState): TokenStatus {
  if (tokenCounting.loading) {
    return {
      label: 'Checking tokenizer…',
      description: 'Loading WASM tokenizer to confirm accurate counting is available.',
      variant: 'outline',
      icon: Loader2,
      spin: true,
    };
  }

  if (tokenCounting.mode === 'accurate') {
    return {
      label: 'Accurate tokens (WASM)',
      description: 'Counts generated with the tiktoken WASM encoder.',
      variant: 'secondary',
      icon: CheckCircle2,
      spin: false,
    };
  }

  if (tokenCounting.reason === 'runtime-fallback') {
    return {
      label: 'Heuristic fallback',
      description: 'WASM tokenizer is unavailable; using 4 chars/token heuristic.',
      variant: 'destructive',
      icon: AlertTriangle,
      spin: false,
    };
  }

  return {
    label: 'Heuristic mode',
    description: 'Accurate counting disabled in global token settings.',
    variant: 'outline',
    icon: MinusCircle,
    spin: false,
  };
}

type TokenUsageMetrics = {
  budget: number;
  selectedTokens: number;
  includedTreeTokens: number;
  usedTokens: number;
  treePercent: number;
  selectedPercent: number;
  usedPercent: number;
  treeLabel: string;
  remainingLabel: string;
  isOverBudget: boolean;
};

function getTokenUsageMetrics(args: {
  budget: number;
  selectedTokens: number;
  includeProjectTree: boolean;
  projectTreeTokenCount: number;
  projectTreeTokenCountLoading: boolean;
}): TokenUsageMetrics {
  const budget = args.budget;
  const includedTreeTokens = args.includeProjectTree ? args.projectTreeTokenCount : 0;
  const usedTokens = args.selectedTokens + includedTreeTokens;
  const remainingTokens = budget - usedTokens;
  const isOverBudget = remainingTokens < 0;

  // For the segmented bar, normalize to the budget when under-budget so the "remaining" track is visible,
  // and normalize to total usage when over-budget so both segments remain visible.
  const barBaseTokens = Math.max(budget, usedTokens, 1);
  const treePercent = (includedTreeTokens / barBaseTokens) * 100;
  const selectedPercent = (args.selectedTokens / barBaseTokens) * 100;
  const usedPercent = budget > 0 ? Math.min((usedTokens / budget) * 100, 100) : 0;

  const treeLabel = args.projectTreeTokenCountLoading
    ? '…'
    : args.projectTreeTokenCount.toLocaleString();
  const remainingLabel = isOverBudget
    ? `${Math.abs(remainingTokens).toLocaleString()} over`
    : `${remainingTokens.toLocaleString()} remaining`;

  return {
    budget,
    includedTreeTokens,
    isOverBudget,
    remainingLabel,
    selectedPercent,
    selectedTokens: args.selectedTokens,
    treeLabel,
    treePercent,
    usedPercent,
    usedTokens,
  };
}

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
  includeProjectTree?: boolean;
  onIncludeProjectTreeChange?: (checked: boolean) => void;
  projectTreeTokenCount?: number;
  projectTreeTokenCountLoading?: boolean;
  tokenBudget?: number;
  onTokenBudgetChange?: (budget: number) => void;
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

type PreviewPanelTokenSummaryProps = {
  totalFiles: number;
  includeProjectTree: boolean;
  tokenStatus: TokenStatus;
  tokenUsage: TokenUsageMetrics;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
};

const PreviewPanelTokenSummary = memo<PreviewPanelTokenSummaryProps>(
  function PreviewPanelTokenSummary(props) {
    const { totalFiles, includeProjectTree, tokenStatus, tokenUsage, onTokenBudgetChange } = props;
    const StatusIcon = tokenStatus.icon;

    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <Badge className="py-1.5" variant="outline">
            {formatTokenCount(tokenUsage.usedTokens)}
          </Badge>
          <Badge
            className="flex items-center gap-1 py-1.5"
            title={tokenStatus.description}
            variant={tokenStatus.variant}
          >
            <StatusIcon className={`size-3.5 ${tokenStatus.spin ? 'animate-spin' : ''}`} />
            {tokenStatus.label}
          </Badge>
          <TokenBudgetControl budget={tokenUsage.budget} onBudgetChange={onTokenBudgetChange} />
        </div>
        <div className="flex items-center gap-3">
          <div className="text-muted-foreground text-xs">
            <span className="font-medium">{totalFiles}</span> files •{' '}
            <span className="font-medium tabular-nums">
              {tokenUsage.usedTokens.toLocaleString()}
            </span>{' '}
            / <span className="font-medium tabular-nums">{tokenUsage.budget.toLocaleString()}</span>{' '}
            tokens •{' '}
            <span className="inline-flex items-center gap-1 tabular-nums">
              <span aria-hidden className="size-1.5 rounded-full bg-primary" />
              Selected {tokenUsage.selectedTokens.toLocaleString()}
            </span>{' '}
            •{' '}
            <span
              className={`inline-flex items-center gap-1 tabular-nums ${includeProjectTree ? '' : 'opacity-60'}`}
            >
              <span
                aria-hidden
                className={`size-1.5 rounded-full bg-[hsl(var(--chart-2))] ${includeProjectTree ? '' : 'opacity-60'}`}
              />
              Tree {tokenUsage.treeLabel}
            </span>{' '}
            •{' '}
            <span className={`tabular-nums ${tokenUsage.isOverBudget ? 'text-destructive' : ''}`}>
              {tokenUsage.remainingLabel}
            </span>
          </div>
          <div className="w-32">
            <div
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(tokenUsage.usedPercent)}
              className={`relative h-2.5 w-full overflow-hidden rounded-full bg-secondary shadow-inner ring-1 ring-inset ${tokenUsage.isOverBudget ? 'ring-destructive/70' : 'ring-border/60'}`}
              data-testid="progress"
              data-value={tokenUsage.usedPercent}
              role="progressbar"
              title={`Selected ${tokenUsage.selectedTokens.toLocaleString()} • Tree ${tokenUsage.treeLabel} • ${tokenUsage.usedTokens.toLocaleString()} / ${tokenUsage.budget.toLocaleString()} tokens`}
            >
              <div className="flex h-full w-full">
                {tokenUsage.treePercent > 0 && (
                  <div
                    className={`h-full bg-[hsl(var(--chart-2))] ${tokenUsage.selectedPercent > 0 ? 'border-background/70 border-r' : ''}`}
                    data-testid="token-bar-tree"
                    style={{ width: `${tokenUsage.treePercent}%` }}
                  />
                )}
                {tokenUsage.selectedPercent > 0 && (
                  <div
                    className="h-full bg-primary"
                    data-testid="token-bar-selected"
                    style={{ width: `${tokenUsage.selectedPercent}%` }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground">{tokenStatus.description}</div>
      </div>
    );
  }
);

type PreviewPanelReportActionsProps = {
  selectedFilesCount: number;
  includeProjectTree: boolean;
  onIncludeProjectTreeChange?: ((checked: boolean) => void) | undefined;
  onDownloadReport?: (() => void) | undefined;
  onCopyReport?: (() => void) | undefined;
};

const PreviewPanelReportActions = memo<PreviewPanelReportActionsProps>(
  function PreviewPanelReportActionsComponent(props) {
    const {
      selectedFilesCount,
      includeProjectTree,
      onIncludeProjectTreeChange,
      onDownloadReport,
      onCopyReport,
    } = props;

    if (!(onIncludeProjectTreeChange || onDownloadReport || onCopyReport)) {
      return null;
    }

    return (
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-background p-3">
        <div className="flex items-center gap-3">
          {onIncludeProjectTreeChange && (
            <IncludeProjectTreeSetting
              checked={includeProjectTree}
              onChange={onIncludeProjectTreeChange}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onDownloadReport && (
            <Button
              aria-label={
                selectedFilesCount === 0 ? 'Download Report (no files selected)' : 'Download Report'
              }
              disabled={selectedFilesCount === 0}
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
              aria-label={
                selectedFilesCount === 0 ? 'Copy Report (no files selected)' : 'Copy Report'
              }
              disabled={selectedFilesCount === 0}
              onClick={onCopyReport}
              size="sm"
              variant="outline"
            >
              <FileText className="mr-1 size-3.5" />
              Copy Report
            </Button>
          )}
        </div>
      </div>
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
  previewSelections: Set<string>;
  onSort: (field: keyof TableRowData) => void;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  onSelectAllOnPage: (items: TableRowData[]) => void;
  onDeselectAll: () => void;
  isAllSelected: (items: TableRowData[]) => boolean;
  onFileClick?: ((compositeKey: string) => void) | undefined;
  toggleGroupCollapse: (groupKey: GroupKey) => void;
  isGroupFullySelected: (group: GroupedData<TableRowData>) => boolean;
  isGroupPartiallySelected: (group: GroupedData<TableRowData>) => boolean;
  handleGroupSelectAll: (group: GroupedData<TableRowData>) => void;
  handleGroupDeselectAll: (group: GroupedData<TableRowData>) => void;
  pagination: { startIndex: number; endIndex: number };
};

type VisibleFilesOnPageInput = {
  groupingConfig: string;
  currentPageData: TableRowData[];
  groupedData: GroupedData<TableRowData>[];
  collapsedGroups: Set<string>;
  startIndex: number;
  endIndex: number;
};

function getVisibleFilesOnPage(input: VisibleFilesOnPageInput): TableRowData[] {
  if (input.groupingConfig === 'none') {
    return input.currentPageData;
  }

  const visibleFiles: TableRowData[] = [];
  let itemCount = 0;

  for (const group of input.groupedData) {
    itemCount += 1; // group header

    if (input.collapsedGroups.has(String(group.groupKey))) {
      continue;
    }

    for (const item of group.items) {
      if (itemCount >= input.startIndex && itemCount < input.endIndex) {
        visibleFiles.push(item);
      }
      itemCount += 1;
      if (itemCount >= input.endIndex) {
        break;
      }
    }

    if (itemCount >= input.endIndex) {
      break;
    }
  }

  return visibleFiles;
}

type PushGroupItemsInput = {
  group: GroupedData<TableRowData>;
  itemCount: number;
  columnVisibility: ColumnVisibility;
  previewSelections: Set<string>;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  onFileClick?: ((compositeKey: string) => void) | undefined;
  startIndex: number;
  endIndex: number;
  elements: React.ReactNode[];
};

function pushGroupItemsForPage(input: PushGroupItemsInput): number {
  let currentItemCount = input.itemCount;

  for (const item of input.group.items) {
    if (currentItemCount >= input.endIndex) {
      break;
    }

    if (currentItemCount >= input.startIndex) {
      input.elements.push(
        <PreviewTableRow
          columnVisibility={input.columnVisibility}
          isSelected={input.previewSelections.has(item.compositeKey)}
          item={item}
          key={`item-${item.compositeKey}`}
          onFileClick={input.onFileClick}
          onToggleSelection={input.onToggleSelection}
        />
      );
    }

    currentItemCount += 1;
  }

  return currentItemCount;
}

const PreviewTable = memo<PreviewTableProps>(function PreviewTableComponent(props) {
  const {
    columnVisibility,
    sortField,
    sortDirection,
    groupingConfig,
    groupedData,
    currentPageData,
    onSort,
    onSelectAllOnPage,
    onDeselectAll,
    isAllSelected,
    onFileClick,
    onToggleSelection,
    previewSelections,
    collapsedGroups,
    toggleGroupCollapse,
    isGroupFullySelected,
    isGroupPartiallySelected,
    handleGroupSelectAll,
    handleGroupDeselectAll,
    pagination,
  } = props;

  const visibleFilesOnPage = useMemo(
    () =>
      getVisibleFilesOnPage({
        collapsedGroups,
        currentPageData,
        endIndex: pagination.endIndex,
        groupedData,
        groupingConfig,
        startIndex: pagination.startIndex,
      }),
    [
      collapsedGroups,
      currentPageData,
      groupedData,
      groupingConfig,
      pagination.endIndex,
      pagination.startIndex,
    ]
  );

  const isAllCurrentPageSelected = useMemo(
    () => isAllSelected(visibleFilesOnPage),
    [isAllSelected, visibleFilesOnPage]
  );

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
            <span className="whitespace-nowrap tabular-nums">
              {formatTokenCount(group.totalTokens)}
            </span>
            <span className="whitespace-nowrap tabular-nums">
              {(group.totalSize / 1024).toFixed(1)} KB
            </span>
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
        itemCount = pushGroupItemsForPage({
          columnVisibility,
          elements,
          endIndex: pagination.endIndex,
          group,
          itemCount,
          onFileClick,
          onToggleSelection,
          previewSelections,
          startIndex: pagination.startIndex,
        });
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
        <table className="w-full table-fixed border-collapse">
          <thead className="sticky top-0 border-b bg-background">
            <tr>
              {columnVisibility.checkbox && (
                <th className="w-12 px-4 py-3" scope="col">
                  <Checkbox
                    aria-label="Select all files on current page"
                    checked={isAllCurrentPageSelected}
                    onCheckedChange={(checked) =>
                      checked ? onSelectAllOnPage(visibleFilesOnPage) : onDeselectAll()
                    }
                    title="Select all files on current page"
                  />
                </th>
              )}
              {columnVisibility.rootFolderId && (
                <SortableTableHeader
                  className="w-44"
                  field="rootFolderId"
                  onSort={onSort}
                  sortDirection={sortDirection}
                  sortField={sortField}
                  title="Folder"
                />
              )}
              {columnVisibility.path && (
                <SortableTableHeader
                  className="min-w-0"
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
                  onFileClick={onFileClick}
                  onToggleSelection={onToggleSelection}
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
    includeProjectTree = false,
    onIncludeProjectTreeChange,
    projectTreeTokenCount = 0,
    projectTreeTokenCountLoading = false,
    tokenBudget,
    onTokenBudgetChange,
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

  const effectiveColumnVisibility = useMemo(() => {
    // Avoid redundant "Folder" column when grouping by folder (group headers already show it).
    if (groupingConfig === 'folder') {
      return { ...columnVisibility, rootFolderId: false };
    }
    return columnVisibility;
  }, [columnVisibility, groupingConfig]);

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
    fileSizes,
    decodeFileSelection,
    tokenCounting,
    performUndoableAction,
  });

  const tokenStatus = getTokenStatus(tokenCounting);

  const { totalStats, flatListItems } = state;

  const tokenUsage = getTokenUsageMetrics({
    budget: tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    includeProjectTree,
    projectTreeTokenCount,
    projectTreeTokenCountLoading,
    selectedTokens: totalStats.totalTokens,
  });

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
      <div className="flex h-full flex-col">
        <div className="flex-1 p-4">
          <p className="text-gray-500 text-sm">No files selected</p>
        </div>
        <PreviewPanelReportActions
          includeProjectTree={includeProjectTree}
          onCopyReport={onCopyReport}
          onDownloadReport={onDownloadReport}
          onIncludeProjectTreeChange={onIncludeProjectTreeChange}
          selectedFilesCount={selectedFiles.size}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header with stats and controls */}
      <div className="border-b bg-background p-3">
        <div className="flex flex-col gap-3">
          <PreviewPanelTokenSummary
            includeProjectTree={includeProjectTree}
            onTokenBudgetChange={onTokenBudgetChange}
            tokenStatus={tokenStatus}
            tokenUsage={tokenUsage}
            totalFiles={totalStats.totalFiles}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
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
            <div className="flex flex-wrap items-center gap-2">
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
        </div>
      </div>

      {/* Table */}
      <PreviewTable
        collapsedGroups={collapsedGroups}
        columnVisibility={effectiveColumnVisibility}
        currentPageData={currentPageData}
        groupedData={groupedData}
        groupingConfig={groupingConfig}
        handleGroupDeselectAll={handleGroupDeselectAll}
        handleGroupSelectAll={handleGroupSelectAll}
        isAllSelected={isAllSelected}
        isGroupFullySelected={isGroupFullySelected}
        isGroupPartiallySelected={isGroupPartiallySelected}
        onDeselectAll={deselectAll}
        onFileClick={onFileClick}
        onSelectAllOnPage={selectAllOnPage}
        onSort={handleSort}
        onToggleSelection={toggleItemSelection}
        pagination={pagination}
        previewSelections={previewSelections}
        sortDirection={sortDirection}
        sortField={sortField}
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
            <Button onClick={handleBatchRemove} size="sm" variant="destructive">
              <FileX2 className="mr-1 size-3.5" />
              Remove Selected from Project
            </Button>
          </div>
        </div>
      )}

      <PreviewPanelReportActions
        includeProjectTree={includeProjectTree}
        onCopyReport={onCopyReport}
        onDownloadReport={onDownloadReport}
        onIncludeProjectTreeChange={onIncludeProjectTreeChange}
        selectedFilesCount={selectedFiles.size}
      />
    </div>
  );
});

PreviewPanel.displayName = 'PreviewPanel';
