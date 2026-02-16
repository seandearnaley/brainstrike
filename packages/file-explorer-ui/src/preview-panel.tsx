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
import { createLogger, getFileExtension } from '@brainstrike/utils';
import {
  CheckSquare,
  FileText,
  FileX2,
  LayoutGrid,
  RotateCcw,
  Table as TableIcon,
} from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextExportOptions } from './context-export-options';
import FileExplorerErrorBoundary from './file-explorer-error-boundary';
import { useGroupSelection } from './hooks/use-group-selection';
import {
  DEFAULT_PAGE_SIZE,
  usePreviewPanelPreferences,
} from './hooks/use-preview-panel-preferences';
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
  type ContextSelectedTokenSummary,
  computeContextSelectedTokenSummary,
  createSelectedFileContentSnapshot,
  createTokenCountByFile,
  hasSameSelectedFileContentSnapshot,
  type TapestryRangeMap,
} from './utils/context-selected-token-summary';
import {
  EXTENSIONLESS_FILE_TYPE,
  GROUPING_CONFIGS,
  type GroupKey,
  groupData,
  type TableRowData,
} from './utils/grouping-configs';
import { buildGroupedPageSections, getVisibleFilesOnPage } from './utils/preview-pagination';

const logger = createLogger('PreviewPanel');
// Cap tapestry items per page so previews keep a readable "page" density.
const TAPESTRY_MAX_PAGE_SIZE = 24;
const DECODED_SELECTION_CACHE_LIMIT = 2000;
// Keep a stable reference for the "empty snapshot" state to preserve memo identity optimizations.
const EMPTY_SELECTED_FILE_CONTENT_SNAPSHOT: Record<string, string> = {};

function getTokenUsageMetrics(args: {
  budget: number;
  selectedTokens: number;
  sourceSelectedTokens: number;
  rangeAdjustedFilesCount: number;
  activeRangeFilesCount: number;
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
    sourceSelectedTokens: args.sourceSelectedTokens,
    includedTreeTokens,
    isOverBudget,
    rangeAdjustedFilesCount: args.rangeAdjustedFilesCount,
    activeRangeFilesCount: args.activeRangeFilesCount,
    remainingLabel,
    selectedPercent,
    selectedTokens: args.selectedTokens,
    treeLabel,
    treePercent,
    usedPercent,
    usedTokens,
  };
}

interface PreviewPanelProps {
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
  // TODO(context-migration): remove legacy report-named callbacks after downstream migration.
  /** @deprecated Use `onDownloadContext` instead. */
  onDownloadReport?: () => void;
  /** @deprecated Use `onCopyContext` instead. */
  onCopyReport?: () => void;
  onDownloadContext?: (options: ContextExportOptions) => void;
  onCopyContext?: (options: ContextExportOptions) => void;
  includeProjectTree?: boolean;
  onIncludeProjectTreeChange?: (checked: boolean) => void;
  projectTreeUsesViewFilters?: boolean;
  onProjectTreeUsesViewFiltersChange?: (checked: boolean) => void;
  projectTreeTokenCount?: number;
  projectTreeTokenCountLoading?: boolean;
  tokenBudget?: number;
  onTokenBudgetChange?: (budget: number) => void;
  folderSummaryThreshold?: number;
  onFolderSummaryThresholdChange?: (threshold: number) => void;
  onRequestFileContent?: (compositeKey: string) => void;
}

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
  if (ranges.length !== 1) {
    return false;
  }
  const firstRange = ranges[0];
  if (!firstRange) {
    return false;
  }
  return firstRange.startLine === 0 && firstRange.endLine === previousTotal;
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
}): { next: TapestryRangeMap; changed: boolean; totals: Map<string, number> } {
  const next: TapestryRangeMap = { ...args.prev };
  let changed = false;
  const nextTotals = new Map(args.totals);

  for (const [compositeKey, base] of args.bases) {
    const previousTotal = nextTotals.get(compositeKey);
    nextTotals.set(compositeKey, base.totalLines);

    if (!next[compositeKey]) {
      next[compositeKey] = createDefaultTapestryRanges(compositeKey, base.totalLines);
      changed = true;
      continue;
    }

    const ranges = next[compositeKey];
    if (
      previousTotal !== undefined &&
      previousTotal !== base.totalLines &&
      shouldStretchDefaultRange(ranges, previousTotal)
    ) {
      const [firstRange] = ranges;
      if (firstRange) {
        next[compositeKey] = stretchDefaultRange(firstRange, base.totalLines);
        changed = true;
      }
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
      nextTotals.delete(key);
      changed = true;
    }
  }

  return { next, changed, totals: nextTotals };
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
    onDownloadContext,
    onCopyContext,
    includeProjectTree = false,
    onIncludeProjectTreeChange,
    projectTreeUsesViewFilters = false,
    onProjectTreeUsesViewFiltersChange,
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

  const [tapestryRangesByKey, setTapestryRangesByKey] = useState<TapestryRangeMap>({});
  const tapestryTotalsRef = useRef<Map<string, number>>(new Map());
  const summaryFileContentsRef = useRef<Record<string, string>>({});
  const legacyContextWarningRef = useRef<{ download: boolean; copy: boolean }>({
    download: false,
    copy: false,
  });

  const {
    activeTab,
    collapsedGroups,
    columnVisibility,
    groupingConfig,
    pageSize: persistedPageSize,
    setActiveTab,
    setCollapsedGroups,
    setColumnVisibility,
    setGroupingConfig,
    setPageSize,
    setSortDirection,
    setSortField,
    sortDirection,
    sortField,
    setUseTapestryRangesForContextOutput,
    useTapestryRangesForContextOutput,
  } = usePreviewPanelPreferences({
    activeTab: 'table',
    groupingConfig: 'none',
    sortDirection: 'asc',
    sortField: 'rootFolderId',
    // Keep range-aware export on by default so context output follows the active tapestry selection model.
    useTapestryRangesForContextOutput: true,
  });

  // Gate expensive Tapestry computations behind active tab.
  const isTapestryActive = activeTab === 'tapestry';
  const shouldSyncTapestryRanges = isTapestryActive || useTapestryRangesForContextOutput;

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
  // Defer large list snapshots so expensive token summary work does not block UI updates.
  const deferredFlatListItems = useDeferredValue(flatListItems);
  // Snapshot reconciliation intentionally uses ref + memo together.
  // We commit the selected snapshot inside this memo so rapid consecutive renders
  // do not observe an effect-commit lag between range edits and token recalculation.
  const selectedFileContentSnapshot = useMemo(() => {
    const previousSnapshot = summaryFileContentsRef.current;
    if (!useTapestryRangesForContextOutput) {
      const nextSnapshot =
        Object.keys(previousSnapshot).length === 0
          ? previousSnapshot
          : EMPTY_SELECTED_FILE_CONTENT_SNAPSHOT;
      summaryFileContentsRef.current = nextSnapshot;
      return nextSnapshot;
    }

    const nextSnapshot = createSelectedFileContentSnapshot({
      selectedFiles,
      tapestryRangesByKey,
      fileContents,
    });
    if (hasSameSelectedFileContentSnapshot(previousSnapshot, nextSnapshot)) {
      summaryFileContentsRef.current = previousSnapshot;
      return previousSnapshot;
    }

    summaryFileContentsRef.current = nextSnapshot;
    return nextSnapshot;
  }, [fileContents, selectedFiles, tapestryRangesByKey, useTapestryRangesForContextOutput]);

  const contextSelectedTokenSummary = useMemo<ContextSelectedTokenSummary>(() => {
    const tokenCountByFile = createTokenCountByFile(deferredFlatListItems);

    return computeContextSelectedTokenSummary({
      sourceSelectedTokens: totalStats.totalTokens,
      sourcePendingCount: totalStats.pendingCount,
      selectedFiles,
      useTapestryRangesForContextOutput,
      tapestryRangesByKey,
      tokenCountByFile,
      fileContents: selectedFileContentSnapshot,
    });
  }, [
    deferredFlatListItems,
    totalStats,
    selectedFiles,
    useTapestryRangesForContextOutput,
    tapestryRangesByKey,
    selectedFileContentSnapshot,
  ]);

  const tokenUsage = getTokenUsageMetrics({
    budget: tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    includeProjectTree,
    projectTreeTokenCount,
    projectTreeTokenCountLoading,
    selectedTokens: contextSelectedTokenSummary.outputSelectedTokens,
    sourceSelectedTokens: contextSelectedTokenSummary.sourceSelectedTokens,
    rangeAdjustedFilesCount: contextSelectedTokenSummary.rangeAdjustedFilesCount,
    activeRangeFilesCount: contextSelectedTokenSummary.activeRangeFilesCount,
  });

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
        const cached = cache.get(compositeKey) ?? null;
        if (cached) {
          cache.delete(compositeKey);
          cache.set(compositeKey, cached);
        }
        return cached;
      }

      try {
        const decoded = decodeFileSelection(compositeKey);
        cache.set(compositeKey, decoded);
        if (cache.size > DECODED_SELECTION_CACHE_LIMIT) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey) {
            cache.delete(oldestKey);
          }
        }
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
          type: getFileExtension(path) || EXTENSIONLESS_FILE_TYPE,
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

  // biome-ignore lint/plugin: Cache cleanup for decoded selections; no data fetching
  useEffect(() => {
    const cache = decodedSelectionCacheRef.current;
    if (cache.size === 0) {
      return;
    }

    const visibleKeys = new Set(tableData.map((item) => item.compositeKey));
    for (const key of cache.keys()) {
      if (!visibleKeys.has(key)) {
        cache.delete(key);
      }
    }

    while (cache.size > DECODED_SELECTION_CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      cache.delete(oldestKey);
    }
  }, [tableData]);

  const tapestryFileBaseByKey = useMemo(() => {
    // Skip expensive computation unless ranges must be rendered or exported.
    if (!shouldSyncTapestryRanges) {
      return new Map<string, ReturnType<typeof buildTapestryFileBase>>();
    }

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
  }, [shouldSyncTapestryRanges, tableData, fileContents, loadingFiles]);

  useEffect(() => {
    // Keep ranges synchronized while Tapestry is visible or when range-based export is enabled.
    if (!shouldSyncTapestryRanges) {
      return;
    }

    setTapestryRangesByKey((prev) => {
      const { next, changed, totals } = syncTapestryRanges({
        bases: tapestryFileBaseByKey,
        prev,
        totals: tapestryTotalsRef.current,
      });
      tapestryTotalsRef.current = totals;
      return changed ? next : prev;
    });
  }, [shouldSyncTapestryRanges, tapestryFileBaseByKey]);

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

  // Use prop if explicitly provided (different from default), otherwise persisted, otherwise default
  // This allows tests to override the page size while still supporting user persistence
  const effectivePageSize =
    pageSize !== DEFAULT_PAGE_SIZE ? pageSize : (persistedPageSize ?? pageSize);

  // Use pagination hooks (table + tapestry)
  const tablePagination = usePagination({
    totalItems: groupingConfig === 'none' ? flattenedData.length : totalItems,
    pageSize: effectivePageSize,
  });
  const tapestryPageSize = Math.min(effectivePageSize, TAPESTRY_MAX_PAGE_SIZE);
  const tapestryPagination = usePagination({
    totalItems: groupingConfig === 'none' ? flattenedData.length : totalItems,
    pageSize: tapestryPageSize,
  });

  const {
    currentPage: tableCurrentPage,
    goToPage: goToTablePage,
    resetToFirstPage: resetTableToFirstPage,
  } = tablePagination;
  const {
    currentPage: tapestryCurrentPage,
    goToPage: goToTapestryPage,
    resetToFirstPage: resetTapestryToFirstPage,
  } = tapestryPagination;
  const resetAllPages = useCallback(() => {
    resetTableToFirstPage();
    resetTapestryToFirstPage();
  }, [resetTableToFirstPage, resetTapestryToFirstPage]);

  // Handle page size changes - reset to first page when size changes
  const handlePageSizeChange = useCallback(
    (newPageSize: number) => {
      setPageSize(newPageSize);
      resetAllPages();
    },
    [setPageSize, resetAllPages]
  );

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
  const tablePageData =
    groupingConfig === 'none'
      ? flattenedData.slice(tablePagination.startIndex, tablePagination.endIndex)
      : [];
  const tapestryPageData =
    groupingConfig === 'none'
      ? flattenedData.slice(tapestryPagination.startIndex, tapestryPagination.endIndex)
      : [];

  const tableVisibleFilesOnPage = useMemo(
    () =>
      getVisibleFilesOnPage({
        collapsedGroups,
        currentPageData: tablePageData,
        endIndex: tablePagination.endIndex,
        groupedData,
        groupingConfig,
        startIndex: tablePagination.startIndex,
      }),
    [
      collapsedGroups,
      groupedData,
      groupingConfig,
      tablePageData,
      tablePagination.endIndex,
      tablePagination.startIndex,
    ]
  );

  const tapestryVisibleFilesOnPage = useMemo(
    () =>
      getVisibleFilesOnPage({
        collapsedGroups,
        currentPageData: tapestryPageData,
        endIndex: tapestryPagination.endIndex,
        groupedData,
        groupingConfig,
        startIndex: tapestryPagination.startIndex,
      }),
    [
      collapsedGroups,
      groupedData,
      groupingConfig,
      tapestryPageData,
      tapestryPagination.endIndex,
      tapestryPagination.startIndex,
    ]
  );

  const tapestryGroupedPageSections = useMemo(
    () =>
      groupingConfig === 'none'
        ? []
        : buildGroupedPageSections({
            collapsedGroups,
            endIndex: tapestryPagination.endIndex,
            groupedData,
            startIndex: tapestryPagination.startIndex,
          }),
    [
      collapsedGroups,
      groupedData,
      groupingConfig,
      tapestryPagination.endIndex,
      tapestryPagination.startIndex,
    ]
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
        ? tapestryPageData
            .map((item) => buildTapestryFile(item))
            .filter((item): item is NonNullable<typeof item> => item !== null)
        : [],
    [buildTapestryFile, groupingConfig, tapestryPageData]
  );

  const tapestryGroupedSections = useMemo(
    () =>
      groupingConfig === 'none'
        ? []
        : tapestryGroupedPageSections.map((section) => ({
            ...section,
            items: section.items
              .map((item) => buildTapestryFile(item))
              .filter((item): item is NonNullable<typeof item> => item !== null),
          })),
    [buildTapestryFile, groupingConfig, tapestryGroupedPageSections]
  );

  const activeRangesCount = useMemo(() => {
    // Skip computation when Tapestry tab is not active
    if (!isTapestryActive) {
      return 0;
    }
    return Object.values(tapestryRangesByKey).reduce(
      (acc, ranges) => acc + ranges.filter((range) => range.isActive).length,
      0
    );
  }, [isTapestryActive, tapestryRangesByKey]);

  const totalLinesSelected = useMemo(() => {
    // Skip computation when Tapestry tab is not active
    if (!isTapestryActive) {
      return 0;
    }
    return Object.values(tapestryRangesByKey).reduce(
      (acc, ranges) =>
        acc +
        ranges
          .filter((range) => range.isActive)
          .reduce((sum, range) => sum + (range.endLine - range.startLine), 0),
      0
    );
  }, [isTapestryActive, tapestryRangesByKey]);

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

  // Keep export payload synchronized with the latest range edits and tree toggle state.
  const contextExportOptions = useMemo<ContextExportOptions>(
    () => ({
      selectedLineRangesByFile: tapestryRangesByKey,
      useTapestryRanges: useTapestryRangesForContextOutput,
      projectTreeUsesViewFilters,
    }),
    [projectTreeUsesViewFilters, tapestryRangesByKey, useTapestryRangesForContextOutput]
  );

  const handleDownloadContext = useCallback(() => {
    if (onDownloadContext) {
      onDownloadContext(contextExportOptions);
      return;
    }
    if (onDownloadReport) {
      // Legacy compatibility path while report-named callbacks are phased out.
      if (!legacyContextWarningRef.current.download) {
        legacyContextWarningRef.current.download = true;
        logger.warn(
          'PreviewPanel is using deprecated onDownloadReport callback without context options'
        );
      }
      onDownloadReport();
    }
  }, [contextExportOptions, onDownloadContext, onDownloadReport]);

  const handleCopyContext = useCallback(() => {
    if (onCopyContext) {
      onCopyContext(contextExportOptions);
      return;
    }
    if (onCopyReport) {
      // Legacy compatibility path while report-named callbacks are phased out.
      if (!legacyContextWarningRef.current.copy) {
        legacyContextWarningRef.current.copy = true;
        logger.warn(
          'PreviewPanel is using deprecated onCopyReport callback without context options'
        );
      }
      onCopyReport();
    }
  }, [contextExportOptions, onCopyContext, onCopyReport]);

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
      resetAllPages();
    },
    [sortField, resetAllPages]
  );

  const resetSort = useCallback(() => {
    setSortField('rootFolderId');
    setSortDirection('asc');
    resetAllPages();
  }, [resetAllPages]);

  // Reset to first page when grouping changes
  const prevGroupingConfigRef = useRef(groupingConfig);
  // biome-ignore lint/plugin: Reset pagination when grouping config changes
  useEffect(() => {
    if (prevGroupingConfigRef.current !== groupingConfig) {
      prevGroupingConfigRef.current = groupingConfig;
      resetAllPages();
    }
  }, [groupingConfig, resetAllPages]);

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
          onCopyContext={handleCopyContext}
          onDownloadContext={handleDownloadContext}
          onFolderSummaryThresholdChange={onFolderSummaryThresholdChange}
          onIncludeProjectTreeChange={onIncludeProjectTreeChange}
          onProjectTreeUsesViewFiltersChange={onProjectTreeUsesViewFiltersChange}
          onTokenBudgetChange={onTokenBudgetChange}
          onUseTapestryRangesChange={setUseTapestryRangesForContextOutput}
          projectTreeUsesViewFilters={projectTreeUsesViewFilters}
          selectedFilesCount={selectedFiles.size}
          selectedTokensPendingCount={0}
          tokenCounting={tokenCounting}
          tokenUsage={tokenUsage}
          totalFiles={0}
          treeLoading={projectTreeTokenCountLoading}
          useTapestryRanges={useTapestryRangesForContextOutput}
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
          <FileExplorerErrorBoundary>
            <PreviewTable
              collapsedGroups={collapsedGroups}
              columnVisibility={effectiveColumnVisibility}
              currentPageData={tablePageData}
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
              pagination={tablePagination}
              previewSelections={previewSelections}
              sortDirection={sortDirection}
              sortField={sortField}
              toggleGroupCollapse={toggleGroupCollapse}
              visibleFilesOnPage={tableVisibleFilesOnPage}
            />
          </FileExplorerErrorBoundary>

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
            currentPage={tableCurrentPage}
            onPageChange={goToTablePage}
            onPageSizeChange={handlePageSizeChange}
            pageSize={effectivePageSize}
            totalItems={flattenedData.length}
            totalPages={tablePagination.totalPages}
            {...paginationInfo}
          />

          {/* Fixed bottom action bar */}
          {previewSelections.size > 0 && (
            <output
              aria-atomic="true"
              aria-live="polite"
              className="flex flex-shrink-0 items-center justify-between border-t bg-yellow-50 p-3 dark:bg-yellow-900/20"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">
                  {previewSelections.size} files selected in Context Explorer
                </span>
                <Button onClick={deselectAll} size="sm" variant="outline">
                  Clear Context Selection
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={handleBatchRemove} size="sm" variant="destructive">
                  <FileX2 className="mr-1 size-3.5" />
                  Remove Selected from Project
                </Button>
              </div>
            </output>
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
                currentPage: tapestryCurrentPage,
                onPageChange: goToTapestryPage,
                pageSize: tapestryPageSize,
                totalItems: flattenedData.length,
                totalPages: tapestryPagination.totalPages,
                ...paginationInfo,
              }}
              previewSelections={previewSelections}
              totalFiles={flattenedData.length}
              totalLinesSelected={totalLinesSelected}
              ungroupedFiles={tapestryUngroupedFiles}
              visibleFilesOnPage={tapestryVisibleFilesOnPage}
              {...(onRequestFileContent ? { onRequestFileContent } : {})}
            />
          </FileExplorerErrorBoundary>
        </TabsContent>
      </Tabs>

      <PreviewPanelFooter
        folderSummaryThreshold={folderSummaryThreshold ?? 5}
        includeProjectTree={includeProjectTree}
        onCopyContext={handleCopyContext}
        onDownloadContext={handleDownloadContext}
        onFolderSummaryThresholdChange={onFolderSummaryThresholdChange}
        onIncludeProjectTreeChange={onIncludeProjectTreeChange}
        onProjectTreeUsesViewFiltersChange={onProjectTreeUsesViewFiltersChange}
        onTokenBudgetChange={onTokenBudgetChange}
        onUseTapestryRangesChange={setUseTapestryRangesForContextOutput}
        projectTreeUsesViewFilters={projectTreeUsesViewFilters}
        selectedFilesCount={selectedFiles.size}
        selectedTokensPendingCount={contextSelectedTokenSummary.outputPendingCount}
        tokenCounting={tokenCounting}
        tokenUsage={tokenUsage}
        totalFiles={totalStats.totalFiles}
        treeLoading={projectTreeTokenCountLoading}
        useTapestryRanges={useTapestryRangesForContextOutput}
      />
    </div>
  );
});

PreviewPanel.displayName = 'PreviewPanel';
