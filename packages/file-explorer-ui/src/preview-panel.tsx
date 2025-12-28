import { usePagination } from '@brainstrike/hooks';
import { DEFAULT_TOKEN_BUDGET } from '@brainstrike/types';
import {
  Button,
  Checkbox,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SortableTableHeader,
  TableGroupHeader,
  TablePagination,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import {
  CheckSquare,
  Columns3,
  Download,
  FileText,
  FileX2,
  FolderOpen,
  LayoutGrid,
  RotateCcw,
  Table as TableIcon,
} from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import FileExplorerErrorBoundary from './file-explorer-error-boundary';
import { useGroupSelection } from './hooks/use-group-selection';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import IncludeProjectTreeSetting from './include-project-tree-setting';
import { PreviewGroupingControls } from './preview-grouping-controls';
import { PreviewTableRow } from './preview-table-row';
import { buildTapestryFileBase } from './tapestry/tapestry-adapter';
import { TapestryView } from './tapestry/tapestry-view';
import type { TapestryRange } from './tapestry/types';
import { createRangeId, getStableColorForKey } from './tapestry/utils';
import { TokenBudgetControl } from './token-budget-control';
import { TokenMeter } from './token-meter';
import { TokenSummaryBar } from './token-summary-bar';
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
  folderSummaryThreshold?: number;
  onFolderSummaryThresholdChange?: (threshold: number) => void;
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
  } catch (error) {
    logger.warn('Failed to parse stored preferences', { storageKey, error });
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

/**
 * Migrate legacy grouping config values to current option names.
 * The 'folder' option was renamed to 'rootFolder' in favor of new 'directory' grouping.
 */
function migrateGroupingConfig(value: string): string {
  if (value === 'folder') {
    return 'rootFolder';
  }
  return value;
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
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button className="@[600px]:h-9 h-8 @[600px]:px-3 px-2" size="sm" variant="outline">
                <Columns3 className="@[600px]:mr-2 size-3.5" />
                <span className="@[600px]:inline hidden">Columns</span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Select visible columns</TooltipContent>
        </Tooltip>
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

/**
 * PreviewPanelFooter - Consolidated footer with token controls and report actions.
 *
 * Groups related functionality:
 * - Token meter and usage stats (how much context you're generating)
 * - Budget control (set your limit)
 * - Include project tree toggle (affects token count)
 * - Report actions (download/copy the context)
 */
type PreviewPanelFooterProps = {
  totalFiles: number;
  tokenCounting: TokenCountingState;
  tokenUsage: TokenUsageMetrics;
  includeProjectTree: boolean;
  treeLoading?: boolean;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
  selectedFilesCount: number;
  onIncludeProjectTreeChange?: ((checked: boolean) => void) | undefined;
  onDownloadReport?: (() => void) | undefined;
  onCopyReport?: (() => void) | undefined;
  folderSummaryThreshold?: number;
  onFolderSummaryThresholdChange?: ((threshold: number) => void) | undefined;
};

const PreviewPanelFooter = memo<PreviewPanelFooterProps>(
  function PreviewPanelFooterComponent(props) {
    const {
      totalFiles,
      tokenCounting,
      tokenUsage,
      includeProjectTree,
      treeLoading = false,
      onTokenBudgetChange,
      selectedFilesCount,
      onIncludeProjectTreeChange,
      onDownloadReport,
      onCopyReport,
      folderSummaryThreshold = 5,
      onFolderSummaryThresholdChange,
    } = props;

    return (
      <div className="@container flex flex-shrink-0 flex-row gap-3 border-t bg-background p-3">
        {/* Left column: Token Meter - visually spanning multiple rows */}
        <div className="flex flex-shrink-0 items-center">
          <TokenMeter
            budget={tokenUsage.budget}
            includeTree={includeProjectTree}
            isOverBudget={tokenUsage.isOverBudget}
            selectedTokens={tokenUsage.selectedTokens}
            size="md"
            treeTokens={tokenUsage.includedTreeTokens}
            usedTokens={tokenUsage.usedTokens}
          />
        </div>

        {/* Right column: Stats and controls in two rows */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-2.5">
          {/* Top row: Token Summary Stats */}
          <div className="flex min-w-0 items-center">
            <TokenSummaryBar
              budget={tokenUsage.budget}
              includeTree={includeProjectTree}
              isOverBudget={tokenUsage.isOverBudget}
              selectedTokens={tokenUsage.selectedTokens}
              tokenCounting={tokenCounting}
              totalFiles={totalFiles}
              treeLoading={treeLoading}
              treeTokens={tokenUsage.includedTreeTokens}
            />
          </div>

          {/* Bottom row: Controls and actions */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Budget Control - popover with presets */}
            <TokenBudgetControl budget={tokenUsage.budget} onBudgetChange={onTokenBudgetChange} />

            {/* Visual separator */}
            {onIncludeProjectTreeChange && (
              <div aria-hidden className="@[450px]:block hidden h-6 w-px bg-border" />
            )}

            {/* Include Project Tree toggle */}
            {onIncludeProjectTreeChange && (
              <div className="flex items-center gap-2">
                <TooltipProvider delayDuration={400}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-2">
                        <IncludeProjectTreeSetting
                          checked={includeProjectTree}
                          onChange={onIncludeProjectTreeChange}
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>Include project tree in the context</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}

            {/* Folder Summary Threshold - only show when tree is included and handler exists */}
            {includeProjectTree && onFolderSummaryThresholdChange && (
              <>
                <div aria-hidden className="@[650px]:block hidden h-6 w-px bg-border" />
                <div className="flex items-center gap-2">
                  <label
                    className="whitespace-nowrap text-muted-foreground text-xs"
                    htmlFor="folder-summary-threshold-footer"
                    title="Number of files shown per folder in the project tree before summarizing. Set to 0 to show all."
                  >
                    <span className="@[700px]:inline hidden">Tree detail:</span>
                    <span className="@[500px]:inline @[700px]:hidden hidden">Detail:</span>
                  </label>
                  <input
                    className="h-7 @[500px]:w-14 w-12 rounded-md border border-input bg-background px-1.5 text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
                    id="folder-summary-threshold-footer"
                    min="0"
                    onChange={(e) => {
                      const value = Number.parseInt(e.target.value, 10);
                      if (!Number.isNaN(value) && value >= 0) {
                        onFolderSummaryThresholdChange(value);
                      }
                    }}
                    title="Files per folder before summarizing (0 = show all)"
                    type="number"
                    value={folderSummaryThreshold}
                  />
                </div>
              </>
            )}

            {/* Spacer to push report buttons to the right */}
            <div className="@[850px]:block hidden flex-1" />

            {/* Report action buttons */}
            <div className="flex flex-wrap items-center gap-2">
              <TooltipProvider delayDuration={400}>
                {onDownloadReport && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label={
                          selectedFilesCount === 0
                            ? 'Download Report (no files selected)'
                            : 'Download Report'
                        }
                        className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                        data-testid="download-report-button"
                        disabled={selectedFilesCount === 0}
                        onClick={onDownloadReport}
                        size="sm"
                        variant="outline"
                      >
                        <Download className="@[600px]:mr-2 size-3.5" />
                        <span className="@[700px]:inline hidden">Download Report</span>
                        <span className="@[500px]:inline @[700px]:hidden hidden">Download</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Download report as file</TooltipContent>
                  </Tooltip>
                )}
                {onCopyReport && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label={
                          selectedFilesCount === 0
                            ? 'Copy Report (no files selected)'
                            : 'Copy Report'
                        }
                        className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                        data-testid="copy-report-button"
                        disabled={selectedFilesCount === 0}
                        onClick={onCopyReport}
                        size="sm"
                        variant="outline"
                      >
                        <FileText className="@[600px]:mr-2 size-3.5" />
                        <span className="@[700px]:inline hidden">Copy Report</span>
                        <span className="@[500px]:inline @[700px]:hidden hidden">Copy</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy report to clipboard</TooltipContent>
                  </Tooltip>
                )}
              </TooltipProvider>
            </div>
          </div>
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

type GroupedPageSection = {
  group: GroupedData<TableRowData>;
  isCollapsed: boolean;
  showHeader: boolean;
  items: TableRowData[];
};

type GroupedPageSectionsInput = {
  groupedData: GroupedData<TableRowData>[];
  collapsedGroups: Set<string>;
  startIndex: number;
  endIndex: number;
};

function isIndexInPage(index: number, startIndex: number, endIndex: number): boolean {
  return index >= startIndex && index < endIndex;
}

function collectItemsForGroup(args: {
  group: GroupedData<TableRowData>;
  isCollapsed: boolean;
  startIndex: number;
  endIndex: number;
  itemCount: number;
}): { items: TableRowData[]; nextIndex: number } {
  if (args.isCollapsed) {
    return { items: [], nextIndex: args.itemCount };
  }

  const items: TableRowData[] = [];
  let currentIndex = args.itemCount;

  for (const item of args.group.items) {
    if (isIndexInPage(currentIndex, args.startIndex, args.endIndex)) {
      items.push(item);
    }
    currentIndex += 1;
    if (currentIndex >= args.endIndex) {
      break;
    }
  }

  return { items, nextIndex: currentIndex };
}

function buildGroupedPageSections(input: GroupedPageSectionsInput): GroupedPageSection[] {
  const sections: GroupedPageSection[] = [];
  let itemCount = 0;

  for (const group of input.groupedData) {
    const isCollapsed = input.collapsedGroups.has(String(group.groupKey));
    const showHeader = isIndexInPage(itemCount, input.startIndex, input.endIndex);
    itemCount += 1;
    const { items, nextIndex } = collectItemsForGroup({
      endIndex: input.endIndex,
      group,
      isCollapsed,
      itemCount,
      startIndex: input.startIndex,
    });
    itemCount = nextIndex;

    if (showHeader || items.length > 0) {
      sections.push({ group, isCollapsed, showHeader, items });
    }

    if (itemCount >= input.endIndex) {
      break;
    }
  }

  return sections;
}

type TapestryRangeMap = Record<string, TapestryRange[]>;

function createDefaultTapestryRanges(compositeKey: string, totalLines: number): TapestryRange[] {
  return [
    {
      id: createRangeId(),
      startLine: 0,
      endLine: totalLines,
      isActive: true,
      color: getStableColorForKey(compositeKey),
    },
  ];
}

function shouldStretchDefaultRange(
  ranges: TapestryRange[],
  previousTotal: number
): ranges is [TapestryRange] {
  return ranges.length === 1 && ranges[0]?.startLine === 0 && ranges[0]?.endLine === previousTotal;
}

function stretchDefaultRange(range: TapestryRange, totalLines: number): TapestryRange[] {
  return [{ ...range, endLine: totalLines }];
}

function syncTapestryRanges(args: {
  prev: TapestryRangeMap;
  bases: Map<string, ReturnType<typeof buildTapestryFileBase>>;
  totals: Map<string, number>;
}): { next: TapestryRangeMap; changed: boolean } {
  const next: TapestryRangeMap = { ...args.prev };
  let changed = false;

  for (const [compositeKey, base] of args.bases) {
    const previousTotal = args.totals.get(compositeKey);
    args.totals.set(compositeKey, base.totalLines);

    if (!next[compositeKey]) {
      next[compositeKey] = createDefaultTapestryRanges(compositeKey, base.totalLines);
      changed = true;
      continue;
    }

    if (
      previousTotal !== undefined &&
      previousTotal !== base.totalLines &&
      shouldStretchDefaultRange(next[compositeKey], previousTotal)
    ) {
      next[compositeKey] = stretchDefaultRange(next[compositeKey][0], base.totalLines);
      changed = true;
    }
  }

  for (const key of Object.keys(next)) {
    if (!args.bases.has(key)) {
      delete next[key];
      args.totals.delete(key);
      changed = true;
    }
  }

  return { next, changed };
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

  const totalVisibleColumns = useMemo(
    () => Object.values(columnVisibility).filter(Boolean).length,
    [columnVisibility]
  );

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
        colSpan={totalVisibleColumns - 1}
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
        <table className="w-full min-w-full table-fixed border-collapse">
          <thead className="sticky top-0 z-10 border-b bg-background">
            <tr>
              {columnVisibility.checkbox && (
                <th className="w-12 bg-background px-4 py-2" scope="col">
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
    folderSummaryThreshold,
    onFolderSummaryThresholdChange,
  } = props;

  // Local selection state for preview panel - separate from file tree selections
  const [previewSelections, setPreviewSelections] = useState<Set<string>>(new Set());

  const [tapestryRangesByKey, setTapestryRangesByKey] = useState<Record<string, TapestryRange[]>>(
    {}
  );
  const tapestryTotalsRef = useRef<Map<string, number>>(new Map());

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
    migrateGroupingConfig(getStoredValue(storageKey, 'groupingConfig', 'none'))
  );

  const [activeTab, setActiveTab] = useState<string>(() =>
    getStoredValue(storageKey, 'activeTab', 'table')
  );

  const effectiveColumnVisibility = useMemo(() => {
    // Avoid redundant "Folder" column when grouping by directory or root folder (group headers already show it).
    if (groupingConfig === 'directory' || groupingConfig === 'rootFolder') {
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
          activeTab,
          collapsedGroups: Array.from(collapsedGroups),
        };
        localStorage.setItem(storageKey, JSON.stringify(settings));
      } catch (error) {
        logger.warn('Failed to save preferences to localStorage', { storageKey, error });
      }
    }, 250);

    return () => clearTimeout(timeoutId);
  }, [columnVisibility, sortField, sortDirection, groupingConfig, collapsedGroups, activeTab]);

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
  const decodedSelectionCacheRef = useRef<Map<string, { folderId: string; path: string } | null>>(
    new Map()
  );

  useEffect(() => {
    decodedSelectionCacheRef.current.clear();
  }, [decodeFileSelection]);

  const getDecodedSelection = useCallback(
    (compositeKey: string): { folderId: string; path: string } | null => {
      const cache = decodedSelectionCacheRef.current;
      if (cache.has(compositeKey)) {
        return cache.get(compositeKey) ?? null;
      }

      try {
        const decoded = decodeFileSelection(compositeKey);
        cache.set(compositeKey, decoded);
        return decoded;
      } catch (error) {
        logger.warn('Failed to decode composite key:', compositeKey, error);
        cache.set(compositeKey, null);
        return null;
      }
    },
    [decodeFileSelection]
  );

  // Transform list items to simplified table data - only files
  const tableData: TableRowData[] = useMemo(() => {
    const fileItems = deferredFlatListItems.filter(
      (item): item is FileItem => item.type === 'file'
    );

    return fileItems
      .map((fileItem): TableRowData | null => {
        const decoded = getDecodedSelection(fileItem.compositeKey);
        if (!decoded) {
          return null;
        }

        const { folderId, path } = decoded;
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
      })
      .filter((item): item is TableRowData => item !== null);
  }, [deferredFlatListItems, getDecodedSelection]);

  const tapestryFileBaseByKey = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildTapestryFileBase>>();

    for (const item of tableData) {
      map.set(
        item.compositeKey,
        buildTapestryFileBase({
          item,
          content: fileContents[item.compositeKey],
          isLoading: loadingFiles.has(item.compositeKey),
        })
      );
    }

    return map;
  }, [tableData, fileContents, loadingFiles]);

  useEffect(() => {
    setTapestryRangesByKey((prev) => {
      const { next, changed } = syncTapestryRanges({
        bases: tapestryFileBaseByKey,
        prev,
        totals: tapestryTotalsRef.current,
      });
      return changed ? next : prev;
    });
  }, [tapestryFileBaseByKey]);

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
    selectAll,
    selectAllOnPage,
    deselectAll,
    isAllSelected,
  } = groupSelection;

  const isAllFilesSelected = useMemo(
    () => isAllSelected(flattenedData),
    [flattenedData, isAllSelected]
  );

  // Current page data
  const currentPageData =
    groupingConfig === 'none'
      ? flattenedData.slice(pagination.startIndex, pagination.endIndex)
      : [];

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

  const groupedPageSections = useMemo(
    () =>
      groupingConfig === 'none'
        ? []
        : buildGroupedPageSections({
            collapsedGroups,
            endIndex: pagination.endIndex,
            groupedData,
            startIndex: pagination.startIndex,
          }),
    [collapsedGroups, groupedData, groupingConfig, pagination.endIndex, pagination.startIndex]
  );

  const buildTapestryFile = useCallback(
    (item: TableRowData) => {
      const base = tapestryFileBaseByKey.get(item.compositeKey);
      if (!base) {
        return null;
      }
      return {
        ...base,
        selections: tapestryRangesByKey[item.compositeKey] ?? [],
      };
    },
    [tapestryFileBaseByKey, tapestryRangesByKey]
  );

  const tapestryUngroupedFiles = useMemo(
    () =>
      groupingConfig === 'none'
        ? currentPageData
            .map((item) => buildTapestryFile(item))
            .filter((item): item is NonNullable<typeof item> => item !== null)
        : [],
    [buildTapestryFile, currentPageData, groupingConfig]
  );

  const tapestryGroupedSections = useMemo(
    () =>
      groupingConfig === 'none'
        ? []
        : groupedPageSections.map((section) => ({
            ...section,
            items: section.items
              .map((item) => buildTapestryFile(item))
              .filter((item): item is NonNullable<typeof item> => item !== null),
          })),
    [buildTapestryFile, groupedPageSections, groupingConfig]
  );

  const activeRangesCount = useMemo(
    () =>
      Object.values(tapestryRangesByKey).reduce(
        (acc, ranges) => acc + ranges.filter((range) => range.isActive).length,
        0
      ),
    [tapestryRangesByKey]
  );

  const totalLinesSelected = useMemo(
    () =>
      Object.values(tapestryRangesByKey).reduce(
        (acc, ranges) =>
          acc +
          ranges
            .filter((range) => range.isActive)
            .reduce((sum, range) => sum + (range.endLine - range.startLine), 0),
        0
      ),
    [tapestryRangesByKey]
  );

  const handleTapestryRangesChange = useCallback((fileId: string, ranges: TapestryRange[]) => {
    setTapestryRangesByKey((prev) => ({ ...prev, [fileId]: ranges }));
  }, []);

  const handleResetTapestryRanges = useCallback(
    (fileIds: string[]) => {
      setTapestryRangesByKey((prev) => {
        const next = { ...prev };
        for (const fileId of fileIds) {
          const base = tapestryFileBaseByKey.get(fileId);
          if (!base) {
            continue;
          }
          next[fileId] = [
            {
              id: createRangeId(),
              startLine: 0,
              endLine: base.totalLines,
              isActive: true,
              color: getStableColorForKey(fileId),
            },
          ];
        }
        return next;
      });
    },
    [tapestryFileBaseByKey]
  );

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
        <div className="flex-1">
          <EmptyState
            description="Select files from the explorer to include them in your project context"
            icon={<FileText />}
            title="No files selected"
          />
        </div>
        <PreviewPanelFooter
          folderSummaryThreshold={folderSummaryThreshold ?? 5}
          includeProjectTree={includeProjectTree}
          onCopyReport={onCopyReport}
          onDownloadReport={onDownloadReport}
          onFolderSummaryThresholdChange={onFolderSummaryThresholdChange}
          onIncludeProjectTreeChange={onIncludeProjectTreeChange}
          onTokenBudgetChange={onTokenBudgetChange}
          selectedFilesCount={selectedFiles.size}
          tokenCounting={tokenCounting}
          tokenUsage={tokenUsage}
          totalFiles={0}
          treeLoading={projectTreeTokenCountLoading}
        />
      </div>
    );
  }

  return (
    <div className="@container flex h-full flex-col overflow-hidden bg-linear-to-b from-[#fdfcfb] to-[#f2f0ef] dark:from-[#1a1816] dark:to-[#0a0a0a]">
      <Tabs className="flex min-h-0 flex-1 flex-col" onValueChange={setActiveTab} value={activeTab}>
        <div className="flex flex-shrink-0 items-center justify-between border-b bg-muted/30 px-3">
          <TabsList className="h-9 gap-4 bg-transparent p-0">
            <TabsTrigger
              className="h-9 rounded-none border-transparent border-b-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent"
              value="table"
            >
              <TableIcon className="mr-2 size-3.5" />
              Table View
            </TabsTrigger>
            <TabsTrigger
              className="h-9 rounded-none border-transparent border-b-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent"
              value="tapestry"
            >
              <LayoutGrid className="mr-2 size-3.5" />
              Tapestry View
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
          value="table"
        >
          {/* Header with table controls only */}
          <TooltipProvider delayDuration={400}>
            <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-background p-3">
              <PreviewGroupingControls
                groupedData={groupedData}
                groupingConfig={groupingConfig}
                onCollapseAllGroups={() =>
                  setCollapsedGroups(new Set(groupedData.map((g) => String(g.groupKey))))
                }
                onExpandAllGroups={() => setCollapsedGroups(new Set())}
                onGroupingChange={(value) => {
                  setGroupingConfig(value);
                  setCollapsedGroups(new Set());
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={`Select all ${flattenedData.length} files`}
                      className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                      data-testid="select-all-button"
                      disabled={isAllSelected(flattenedData)}
                      onClick={() => groupSelection.selectAll(flattenedData)}
                      size="sm"
                      variant="outline"
                    >
                      <CheckSquare className="@[600px]:mr-2 size-3.5" />
                      <span className="@[750px]:inline hidden">
                        Select All ({flattenedData.length})
                      </span>
                      <span className="@[550px]:inline @[750px]:hidden hidden">Select All</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Select all files across all pages</TooltipContent>
                </Tooltip>

                {(sortField !== 'rootFolderId' || sortDirection !== 'asc') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="Reset sort"
                        className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                        data-testid="reset-sort-button"
                        onClick={resetSort}
                        size="sm"
                        variant="outline"
                      >
                        <RotateCcw className="@[600px]:mr-2 size-3.5" />
                        <span className="@[600px]:inline hidden">Reset Sort</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Reset sort to default (by folder)</TooltipContent>
                  </Tooltip>
                )}
                <ColumnVisibilityControls
                  columnVisibility={columnVisibility}
                  onColumnVisibilityChange={setColumnVisibility}
                />
              </div>
            </div>
          </TooltipProvider>

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
            <div className="flex-1">
              <EmptyState
                description="Try adjusting your filters or selecting more files"
                icon={<FileX2 />}
                title="No matching files"
              />
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
        </TabsContent>

        <TabsContent
          className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
          value="tapestry"
        >
          <FileExplorerErrorBoundary>
            <TapestryView
              activeRangesCount={activeRangesCount}
              allFilesSelected={isAllFilesSelected}
              groupedData={groupedData}
              groupedSections={tapestryGroupedSections}
              groupingConfig={groupingConfig}
              isAllSelected={isAllSelected}
              isEmpty={flattenedData.length === 0}
              isGroupFullySelected={isGroupFullySelected}
              isGroupPartiallySelected={isGroupPartiallySelected}
              onCollapseAllGroups={() =>
                setCollapsedGroups(new Set(groupedData.map((g) => String(g.groupKey))))
              }
              onDeselectAll={deselectAll}
              onExpandAllGroups={() => setCollapsedGroups(new Set())}
              onGroupDeselectAll={handleGroupDeselectAll}
              onGroupingChange={(value) => {
                setGroupingConfig(value);
                setCollapsedGroups(new Set());
              }}
              onGroupSelectAll={handleGroupSelectAll}
              onRangesChange={handleTapestryRangesChange}
              onResetRanges={handleResetTapestryRanges}
              onSelectAllFiles={() => selectAll(flattenedData)}
              onSelectAllOnPage={selectAllOnPage}
              onToggleGroupCollapse={toggleGroupCollapse}
              onToggleSelection={toggleItemSelection}
              previewSelections={previewSelections}
              totalFiles={flattenedData.length}
              totalLinesSelected={totalLinesSelected}
              ungroupedFiles={tapestryUngroupedFiles}
              visibleFilesOnPage={visibleFilesOnPage}
            />
          </FileExplorerErrorBoundary>
        </TabsContent>
      </Tabs>

      <PreviewPanelFooter
        folderSummaryThreshold={folderSummaryThreshold ?? 5}
        includeProjectTree={includeProjectTree}
        onCopyReport={onCopyReport}
        onDownloadReport={onDownloadReport}
        onFolderSummaryThresholdChange={onFolderSummaryThresholdChange}
        onIncludeProjectTreeChange={onIncludeProjectTreeChange}
        onTokenBudgetChange={onTokenBudgetChange}
        selectedFilesCount={selectedFiles.size}
        tokenCounting={tokenCounting}
        tokenUsage={tokenUsage}
        totalFiles={totalStats.totalFiles}
        treeLoading={projectTreeTokenCountLoading}
      />
    </div>
  );
});

PreviewPanel.displayName = 'PreviewPanel';
