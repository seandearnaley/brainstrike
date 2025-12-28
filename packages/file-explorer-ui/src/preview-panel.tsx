import { usePagination } from '@brainstrike/hooks';
import { DEFAULT_TOKEN_BUDGET } from '@brainstrike/types';
import {
  Button,
  EmptyState,
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
  FileText,
  FileX2,
  LayoutGrid,
  RotateCcw,
  Table as TableIcon,
} from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import FileExplorerErrorBoundary from './file-explorer-error-boundary';
import { useGroupSelection } from './hooks/use-group-selection';
import { usePreviewPanelPreferences } from './hooks/use-preview-panel-preferences';
import { ColumnVisibilityControls } from './preview-column-visibility-controls';
import { PreviewGroupingControls } from './preview-grouping-controls';
import { PreviewPanelFooter, type TokenUsageMetrics } from './preview-panel-footer';
import { PreviewTable } from './preview-table';
import { buildTapestryFileBase } from './tapestry/tapestry-adapter';
import { TapestryView } from './tapestry/tapestry-view';
import type { TapestryRange } from './tapestry/types';
import { createRangeId, getStableColorForKey } from './tapestry/utils';
import { type FileItem, usePreviewPanelState } from './use-preview-panel-state';
import type { TokenCountingState } from './use-token-counting';
import {
  GROUPING_CONFIGS,
  type GroupedData,
  type GroupKey,
  groupData,
  type TableRowData,
} from './utils/grouping-configs';

const logger = createLogger('PreviewPanel');

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
  onRequestFileContent?: (compositeKey: string) => void;
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

function clampRangeToTotal(range: TapestryRange, totalLines: number): TapestryRange {
  const maxStart = Math.max(totalLines - 1, 0);
  const startLine = Math.min(Math.max(range.startLine, 0), maxStart);
  const endLine = Math.min(Math.max(range.endLine, startLine + 1), totalLines);
  if (startLine === range.startLine && endLine === range.endLine) {
    return range;
  }
  return { ...range, startLine, endLine };
}

function clampRangesToTotal(
  ranges: TapestryRange[],
  totalLines: number
): { ranges: TapestryRange[]; changed: boolean } {
  let changed = false;
  const nextRanges = ranges.map((range) => {
    const nextRange = clampRangeToTotal(range, totalLines);
    if (nextRange !== range) {
      changed = true;
    }
    return nextRange;
  });
  return { ranges: nextRanges, changed };
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

    const clamped = clampRangesToTotal(next[compositeKey], base.totalLines);
    if (clamped.changed) {
      next[compositeKey] = clamped.ranges;
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
    onRequestFileContent,
  } = props;

  // Local selection state for preview panel - separate from file tree selections
  const [previewSelections, setPreviewSelections] = useState<Set<string>>(new Set());

  const [tapestryRangesByKey, setTapestryRangesByKey] = useState<Record<string, TapestryRange[]>>(
    {}
  );
  const tapestryTotalsRef = useRef<Map<string, number>>(new Map());

  const {
    activeTab,
    collapsedGroups,
    columnVisibility,
    groupingConfig,
    setActiveTab,
    setCollapsedGroups,
    setColumnVisibility,
    setGroupingConfig,
    setSortDirection,
    setSortField,
    sortDirection,
    sortField,
  } = usePreviewPanelPreferences({
    activeTab: 'table',
    groupingConfig: 'none',
    sortDirection: 'asc',
    sortField: 'rootFolderId',
  });

  const effectiveColumnVisibility = useMemo(() => {
    // Avoid redundant "Folder" column when grouping by directory or root folder (group headers already show it).
    if (groupingConfig === 'directory' || groupingConfig === 'rootFolder') {
      return { ...columnVisibility, rootFolderId: false };
    }
    return columnVisibility;
  }, [columnVisibility, groupingConfig]);

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

  const pageInfo = useMemo(() => {
    if (groupingConfig === 'none' || groupedData.length <= 1) {
      return;
    }
    return `(${flattenedData.length} total files, ${groupedData.length} groups)`;
  }, [flattenedData.length, groupedData.length, groupingConfig]);

  const paginationInfo = useMemo(() => (pageInfo ? { pageInfo } : {}), [pageInfo]);

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
            visibleFilesOnPage={visibleFilesOnPage}
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
            {...paginationInfo}
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
              pagination={{
                currentPage,
                onPageChange: goToPage,
                totalItems: flattenedData.length,
                totalPages: pagination.totalPages,
                ...paginationInfo,
              }}
              previewSelections={previewSelections}
              totalFiles={flattenedData.length}
              totalLinesSelected={totalLinesSelected}
              ungroupedFiles={tapestryUngroupedFiles}
              visibleFilesOnPage={visibleFilesOnPage}
              {...(onRequestFileContent ? { onRequestFileContent } : {})}
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
