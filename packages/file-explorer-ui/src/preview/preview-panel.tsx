import { usePagination } from '@brainstrike/hooks';
import { DEFAULT_TOKEN_BUDGET } from '@brainstrike/types';
import {
  type BulkAction,
  BulkActionBar,
  Button,
  type CollectionNodeType,
  EmptyState,
  SelectionActionBarOverlay,
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
import { getFileExtension } from '@brainstrike/utils/file-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { FileText, FileX2, LayoutGrid, RotateCcw, Table as TableIcon } from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextExportOptions } from '../context-export-options';
import FileExplorerErrorBoundary from '../file-explorer-error-boundary';
import { useGroupSelection } from '../hooks/use-group-selection';
import type { TokenCountingState } from '../indexing/use-token-counting';
import { buildTapestryFileBase, tapestryBaseMatchesItem } from '../tapestry/tapestry-adapter';
import { TapestryView } from '../tapestry/tapestry-view';
import type { TapestryRange } from '../tapestry/types';
import {
  type ContextSelectedTokenSummary,
  computeContextSelectedTokenSummary,
  createSelectedFileContentSnapshot,
  createTokenCountByFile,
} from '../utils/context-selected-token-summary';
import {
  EXTENSIONLESS_FILE_TYPE,
  GROUPING_CONFIGS,
  type GroupKey,
  groupData,
  type TableRowData,
} from '../utils/grouping-configs';
import { buildGroupedPageSections, getVisibleFilesOnPage } from '../utils/preview-pagination';
import {
  clearUserOwnedTapestryRanges,
  reconcileUserOwnedTapestryRanges,
  syncTapestryRanges,
} from '../utils/tapestry-range-sync';
import { getTokenUsageMetrics } from '../utils/token-usage-metrics';
import { useWorkspaceContextCurationStore } from '../workspace-context-curation-store';
import { tapestryLineRangeToToolRange } from '../workspace-context-line-ranges';
import { ColumnVisibilityControls } from './preview-column-visibility-controls';
import { PreviewPanelFooter } from './preview-panel-footer';
import { PreviewTable } from './preview-table';
import { PreviewViewToolbar } from './preview-view-toolbar';
import { DEFAULT_PAGE_SIZE, usePreviewPanelPreferences } from './use-preview-panel-preferences';
import { type FileItem, usePreviewPanelState } from './use-preview-panel-state';

const logger = createLogger('PreviewPanel');
// Cap tapestry items per page so previews keep a readable "page" density.
const TAPESTRY_MAX_PAGE_SIZE = 24;
const EMPTY_PAGINATION_INFO = {};

interface PreviewPanelProps {
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  estimateTokenCost?: (tokens: number) => number;
  fileContents: { [compositeKey: string]: string };
  fileSizes?: { [compositeKey: string]: number };
  folderSummaryThreshold?: number;
  includeProjectTree?: boolean;
  loadingFiles: Set<string>;
  onCopyContext?: (options: ContextExportOptions) => void;
  onDownloadContext?: (options: ContextExportOptions) => void;
  onFileClick?: (compositeKey: string) => void;
  onFolderSummaryThresholdChange?: (threshold: number) => void;
  onIncludeProjectTreeChange?: (checked: boolean) => void;
  onProjectTreeUsesViewFiltersChange?: (checked: boolean) => void;
  onRequestFileContent?: (compositeKey: string) => void;
  onSelectionChange: (files: Set<string>) => void;
  onTokenBudgetChange?: (budget: number) => void;
  pageSize?: number;
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
  projectTreeTokenCount?: number;
  projectTreeTokenCountLoading?: boolean;
  projectTreeUsesViewFilters?: boolean;
  /**
   * Resolve a RootId to its display name (multi-root, Phase 6) so context
   * snapshots can label same-relative-path files from different roots.
   */
  resolveRootDisplayName?: ((rootId: string) => string | undefined) | undefined;
  /**
   * Resolve a RootId to its absolute root path (storage v5 descriptor) so
   * table rows can relativize file paths for display.
   */
  resolveRootPath?: ((rootId: string) => string | undefined) | undefined;
  selectedFiles: Set<string>;
  tokenBudget?: number;
  tokenCounting: TokenCountingState;
}

function handleNullValues(aVal: unknown, bVal: unknown): number | null {
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
}

function compareValues(aVal: unknown, bVal: unknown, field: keyof TableRowData): number {
  const nullResult = handleNullValues(aVal, bVal);
  if (nullResult !== null) {
    return nullResult;
  }

  // Numeric sorting for tokens and size
  if (field === 'tokens' || field === 'size') {
    return (Number(aVal) || 0) - (Number(bVal) || 0);
  }

  // String sorting for other fields
  const aStr = String(aVal);
  const bStr = String(bVal);
  if (aStr < bStr) {
    return -1;
  }
  if (aStr > bStr) {
    return 1;
  }
  return 0;
}

export const PreviewPanel = memo<PreviewPanelProps>(function PreviewPanelComponent(props) {
  const {
    selectedFiles,
    fileContents,
    loadingFiles,
    onSelectionChange,
    fileSizes,
    decodeFileSelection,
    resolveRootDisplayName,
    resolveRootPath,
    tokenCounting,
    performUndoableAction,
    onFileClick,
    pageSize = 50,
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

  const tapestryRangesByKey = useWorkspaceContextCurationStore(
    (store) => store.tapestryRangesByKey
  );
  const setTapestryRangesByKey = useWorkspaceContextCurationStore(
    (store) => store.setTapestryRanges
  );
  const setWorkspaceContextSnapshot = useWorkspaceContextCurationStore(
    (store) => store.setContextSnapshot
  );
  const deferredTapestryRangesByKey = useDeferredValue(tapestryRangesByKey);
  const tapestryTotalsRef = useRef<Map<string, number>>(new Map());
  // Per-file cache for buildTapestryFileBase — avoids recomputing ALL files when
  // a single file's content loads. Cache is read during render (safe) and updated
  // in a useEffect after commit (safe with React 18 Strict Mode). Validity is
  // checked by the FIELDS the base derives from (tapestryBaseMatchesItem), NOT
  // TableRowData identity — row objects are rebuilt on every ~100ms token-
  // resolution tick, and identity-keying invalidated every file per tick.
  const tapestryBaseCacheRef = useRef<
    Map<
      string,
      {
        base: ReturnType<typeof buildTapestryFileBase>;
        content: string | undefined;
        isLoading: boolean;
      }
    >
  >(new Map());

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
    setTapestryScale,
    setFooterMode,
    sortDirection,
    sortField,
    tapestryScale,
    footerMode,
  } = usePreviewPanelPreferences({
    activeTab: 'table',
    footerMode: 'default',
    groupingConfig: 'none',
    sortDirection: 'asc',
    sortField: 'rootFolderId',
  });

  // Gate expensive Tapestry computations behind active tab.
  const isTapestryActive = activeTab === 'tapestry';
  const effectiveColumnVisibility = useMemo(() => {
    // Folder-based grouping already carries the root context in the group row,
    // so keeping the standalone folder column only duplicates that information.
    if (groupingConfig === 'directory' || groupingConfig === 'rootFolder') {
      return { ...columnVisibility, rootFolderId: false };
    }
    return columnVisibility;
  }, [columnVisibility, groupingConfig]);

  const state = usePreviewPanelState({
    decodeFileSelection,
    fileContents,
    fileSizes,
    loadingFiles,
    onSelectionChange,
    performUndoableAction,
    selectedFiles,
    tokenCounting,
  });

  const { totalStats, flatListItems } = state;
  // Defer large list snapshots so expensive token summary work does not block UI updates.
  const deferredFlatListItems = useDeferredValue(flatListItems);
  // Compute the content snapshot for context-selected token summary.
  // Uses a pure useMemo — no ref access during render.
  const selectedFileContentSnapshot = useMemo(
    () =>
      createSelectedFileContentSnapshot({
        fileContents,
        selectedFiles,
        tapestryRangesByKey: deferredTapestryRangesByKey,
      }),
    [fileContents, selectedFiles, deferredTapestryRangesByKey]
  );

  const contextSelectedTokenSummary = useMemo<ContextSelectedTokenSummary>(() => {
    const tokenCountByFile = createTokenCountByFile(deferredFlatListItems);

    return computeContextSelectedTokenSummary({
      fileContents: selectedFileContentSnapshot,
      selectedFiles,
      sourcePendingCount: totalStats.pendingCount,
      sourceSelectedTokens: totalStats.totalTokens,
      tapestryRangesByKey: deferredTapestryRangesByKey,
      tokenCountByFile,
    });
  }, [
    deferredFlatListItems,
    totalStats,
    selectedFiles,
    deferredTapestryRangesByKey,
    selectedFileContentSnapshot,
  ]);

  const tokenUsage = useMemo(
    () =>
      getTokenUsageMetrics({
        activeRangeFilesCount: contextSelectedTokenSummary.activeRangeFilesCount,
        budget: tokenBudget ?? DEFAULT_TOKEN_BUDGET,
        includeProjectTree,
        projectTreeTokenCount,
        projectTreeTokenCountLoading,
        rangeAdjustedFilesCount: contextSelectedTokenSummary.rangeAdjustedFilesCount,
        selectedTokens: contextSelectedTokenSummary.outputSelectedTokens,
        sourceSelectedTokens: contextSelectedTokenSummary.sourceSelectedTokens,
      }),
    [
      tokenBudget,
      includeProjectTree,
      projectTreeTokenCount,
      projectTreeTokenCountLoading,
      contextSelectedTokenSummary.outputSelectedTokens,
      contextSelectedTokenSummary.sourceSelectedTokens,
      contextSelectedTokenSummary.rangeAdjustedFilesCount,
      contextSelectedTokenSummary.activeRangeFilesCount,
    ]
  );

  // Transform list items to simplified table data - only files.
  // The useMemo already provides cross-render memoization, so no per-item cache is needed.
  const tableData: TableRowData[] = useMemo(() => {
    const fileItems = deferredFlatListItems.filter(
      (item): item is FileItem => item.type === 'file'
    );

    return fileItems
      .map((fileItem): TableRowData | null => {
        let decoded: { folderId: string; path: string };
        try {
          decoded = decodeFileSelection(fileItem.compositeKey);
        } catch (error) {
          logger.warn('Failed to decode composite key:', fileItem.compositeKey, error);
          return null;
        }

        // Storage v5: folderId is a RootId UUID — resolve display metadata
        // from the descriptor registry so no surface ever renders the UUID.
        const rootDisplayName = resolveRootDisplayName?.(decoded.folderId);
        const rootPath = resolveRootPath?.(decoded.folderId);
        const result: TableRowData = {
          compositeKey: fileItem.compositeKey,
          id: fileItem.compositeKey,
          path: decoded.path,
          rootFolderId: decoded.folderId,
          type: getFileExtension(decoded.path) || EXTENSIONLESS_FILE_TYPE,
        };

        if (rootDisplayName !== undefined) {
          result.rootDisplayName = rootDisplayName;
        }
        if (rootPath !== undefined) {
          result.rootPath = rootPath;
        }
        if (fileItem.size !== undefined) {
          result.size = fileItem.size;
        }
        if (fileItem.tokens !== undefined) {
          result.tokens = fileItem.tokens;
        }

        return result;
      })
      .filter((item): item is TableRowData => item !== null);
  }, [deferredFlatListItems, decodeFileSelection, resolveRootDisplayName, resolveRootPath]);

  useEffect(() => {
    const selectedFolderIds = new Set<string>();
    const files = tableData
      .filter((item) => selectedFiles.has(item.compositeKey))
      .map((item) => {
        selectedFolderIds.add(item.rootFolderId);
        const ranges = (deferredTapestryRangesByKey[item.compositeKey] ?? []).map((range) => ({
          ...tapestryLineRangeToToolRange(range),
          isActive: range.isActive !== false,
        }));
        const hasRanges = ranges.length > 0;
        const rootDisplayName = resolveRootDisplayName?.(item.rootFolderId);
        return {
          approxTokens: item.tokens ?? null,
          outputApproxTokens: hasRanges ? null : (item.tokens ?? null),
          path: item.path,
          ranges,
          // Multi-root (Phase 6): citations need the root identity to
          // disambiguate the same relative path across roots.
          rootId: item.rootFolderId,
          ...(rootDisplayName !== undefined && { rootDisplayName }),
        };
      });
    const selectionFolderId =
      selectedFolderIds.size === 1 ? (Array.from(selectedFolderIds)[0] ?? null) : null;

    setWorkspaceContextSnapshot({
      files,
      includeProjectTree,
      projectTreeApproxTokens: projectTreeTokenCountLoading ? null : projectTreeTokenCount,
      projectTreeTokenCountLoading,
      selectedOutputApproxTokens: contextSelectedTokenSummary.outputSelectedTokens,
      selectedSourceApproxTokens: contextSelectedTokenSummary.sourceSelectedTokens,
      selectionFolderId,
      tokenBudget: tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    });
  }, [
    contextSelectedTokenSummary.outputSelectedTokens,
    contextSelectedTokenSummary.sourceSelectedTokens,
    includeProjectTree,
    projectTreeTokenCount,
    projectTreeTokenCountLoading,
    resolveRootDisplayName,
    selectedFiles,
    setWorkspaceContextSnapshot,
    tableData,
    deferredTapestryRangesByKey,
    tokenBudget,
  ]);

  const tapestryFileBaseByKey = useMemo(() => {
    // Read-only access to previous-commit cache; written in the useEffect below.
    const cache = tapestryBaseCacheRef.current;
    const map = new Map<string, ReturnType<typeof buildTapestryFileBase>>();

    for (const item of tableData) {
      const content = fileContents[item.compositeKey];
      const isLoading = loadingFiles.has(item.compositeKey);
      const cached = cache.get(item.compositeKey);

      if (
        cached &&
        cached.content === content &&
        cached.isLoading === isLoading &&
        tapestryBaseMatchesItem(cached.base, item)
      ) {
        map.set(item.compositeKey, cached.base);
      } else {
        // Metadata changed (e.g. this file's token count resolved): rebuild
        // the base but reuse the content-derived lines/structure when the
        // content itself is unchanged (verified inside via previous.content).
        map.set(
          item.compositeKey,
          buildTapestryFileBase({
            content,
            isLoading,
            item,
            ...(cached ? { previous: { base: cached.base, content: cached.content } } : {}),
          })
        );
      }
    }

    return map;
  }, [tableData, fileContents, loadingFiles]);

  // Persist per-file cache after render — useEffect is a safe place for ref mutation.
  // biome-ignore lint/plugin: Not fetching data — updating a local memoization cache ref.
  useEffect(() => {
    const newCache = new Map<
      string,
      {
        base: ReturnType<typeof buildTapestryFileBase>;
        content: string | undefined;
        isLoading: boolean;
      }
    >();
    for (const item of tableData) {
      const base = tapestryFileBaseByKey.get(item.compositeKey);
      if (base) {
        newCache.set(item.compositeKey, {
          base,
          content: fileContents[item.compositeKey],
          isLoading: loadingFiles.has(item.compositeKey),
        });
      }
    }
    tapestryBaseCacheRef.current = newCache;
  }, [tapestryFileBaseByKey, tableData, fileContents, loadingFiles]);

  useEffect(() => {
    // Capture pending totals outside the setState updater to avoid mutating the
    // ref inside the callback. React 18 Strict Mode invokes updaters twice — if
    // the ref were mutated inside, the second (real) invocation would see
    // corrupted previousTotal values, so syncTapestryRanges could not detect a
    // per-file line-total change on content load.
    let pendingTotals: Map<string, number> | null = null;
    setTapestryRangesByKey((prev) => {
      const { next, changed, totals } = syncTapestryRanges({
        bases: tapestryFileBaseByKey,
        prev,
        totals: tapestryTotalsRef.current,
      });
      pendingTotals = totals;
      return changed ? next : prev;
    });
    if (pendingTotals) {
      tapestryTotalsRef.current = pendingTotals;
    }
  }, [tapestryFileBaseByKey]);

  // Toggle group collapse
  const toggleGroupCollapse = useCallback(
    (groupKey: GroupKey) => {
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
    },
    [setCollapsedGroups]
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

    return { groupedData: grouped, sortedData: sorted };
  }, [tableData, sortField, sortDirection, groupingConfig]);

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
    pageSize === DEFAULT_PAGE_SIZE ? (persistedPageSize ?? pageSize) : pageSize;

  // Use pagination hooks (table + tapestry)
  const tablePagination = usePagination({
    pageSize: effectivePageSize,
    totalItems: groupingConfig === 'none' ? flattenedData.length : totalItems,
  });
  const tapestryPageSize = Math.min(effectivePageSize, TAPESTRY_MAX_PAGE_SIZE);
  const tapestryPagination = usePagination({
    pageSize: tapestryPageSize,
    totalItems: groupingConfig === 'none' ? flattenedData.length : totalItems,
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
    getItemKey: (item: TableRowData) => item.compositeKey,
    onSelectionChange: setPreviewSelections,
    selections: previewSelections,
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

  const selectionControlsEnabled = columnVisibility.checkbox;

  // Current page data
  const tablePageData =
    groupingConfig === 'none'
      ? flattenedData.slice(tablePagination.startIndex, tablePagination.endIndex)
      : [];
  const tapestryPageData =
    groupingConfig === 'none'
      ? flattenedData.slice(tapestryPagination.startIndex, tapestryPagination.endIndex)
      : [];
  const isDesktopPreviewTestMode = window.desktopLifecycle?.isTestMode ?? false;
  const tablePageDataPathsKey = isDesktopPreviewTestMode
    ? tablePageData.map((item) => item.path).join('\u0000')
    : '';

  useEffect(() => {
    if (!isDesktopPreviewTestMode) {
      return;
    }

    window.__brainstrikeContextExplorerPreviewTestHooks__ = {
      getSnapshot: () => ({
        activeTab,
        renderedFilePaths: tablePageData.map((item) => item.path),
        selectedFilesCount: selectedFiles.size,
        totalRows: flattenedData.length,
      }),
    };

    return () => {
      window.__brainstrikeContextExplorerPreviewTestHooks__ = undefined;
    };
  }, [
    activeTab,
    flattenedData.length,
    isDesktopPreviewTestMode,
    selectedFiles.size,
    tablePageDataPathsKey,
  ]);

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

  const paginationInfo = useMemo(
    () => (pageInfo ? { pageInfo } : EMPTY_PAGINATION_INFO),
    [pageInfo]
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

  const handleTapestryRangesChange = useCallback((fileId: string, ranges: TapestryRange[]) => {
    setTapestryRangesByKey((prev) => reconcileUserOwnedTapestryRanges(prev, fileId, ranges));
  }, []);

  const handleResetTapestryRanges = useCallback((fileIds: string[]) => {
    setTapestryRangesByKey((prev) => clearUserOwnedTapestryRanges(prev, fileIds));
  }, []);

  // Keep export payload synchronized with the latest range edits and tree toggle state.
  const contextExportOptions = useMemo<ContextExportOptions>(
    () => ({
      projectTreeUsesViewFilters,
      selectedLineRangesByFile: tapestryRangesByKey,
    }),
    [projectTreeUsesViewFilters, tapestryRangesByKey]
  );

  const handleDownloadContext = useCallback(() => {
    if (onDownloadContext) {
      onDownloadContext(contextExportOptions);
    }
  }, [contextExportOptions, onDownloadContext]);

  const handleCopyContext = useCallback(() => {
    if (onCopyContext) {
      onCopyContext(contextExportOptions);
    }
  }, [contextExportOptions, onCopyContext]);

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
      getStateSnapshot: () => new Set(selectedFiles),
      itemDescription: `Removed ${previewSelections.size} files from selection`,
      onUndo: (_key, snapshot) => {
        onSelectionChange(snapshot);
      },
    });

    onSelectionChange(newSelectedFiles);
    setPreviewSelections(new Set());
  }, [previewSelections, selectedFiles, onSelectionChange, performUndoableAction]);

  const contextSelectionNodeTypes = useMemo(() => {
    const nodeTypes = new Map<string, CollectionNodeType>();
    for (const compositeKey of previewSelections) {
      nodeTypes.set(compositeKey, 'file');
    }
    return nodeTypes;
  }, [previewSelections]);

  const contextSelectionActions = useMemo<BulkAction[]>(
    () => [
      {
        applicableTypes: ['file'],
        compactLabel: 'Remove',
        destructive: true,
        icon: <FileX2 className="size-3.5" />,
        id: 'remove-selected-from-project',
        label: 'Remove Selected from Project',
        onAction: () => {
          handleBatchRemove();
        },
      },
    ],
    [handleBatchRemove]
  );

  const contextSelectionSummaryText = useMemo(
    () => (previewSelections.size === 1 ? '1 file selected' : `${previewSelections.size} selected`),
    [previewSelections.size]
  );

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
    [sortField, setSortDirection, setSortField, resetAllPages]
  );

  const resetSort = useCallback(() => {
    setSortField('rootFolderId');
    setSortDirection('asc');
    resetAllPages();
  }, [setSortField, setSortDirection, resetAllPages]);

  const handleSelectionControlsToggle = useCallback(
    (enabled: boolean) => {
      setColumnVisibility({ ...columnVisibility, checkbox: enabled });
      if (!enabled) {
        deselectAll();
      }
    },
    [columnVisibility, deselectAll, setColumnVisibility]
  );

  const handleGroupingChange = useCallback(
    (value: string) => {
      setGroupingConfig(value);
      setCollapsedGroups(new Set());
    },
    [setCollapsedGroups, setGroupingConfig]
  );

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
      <div className="@container flex h-full flex-col overflow-hidden bg-panel-surface">
        <PreviewPanelFooter
          folderSummaryThreshold={folderSummaryThreshold ?? 5}
          footerMode={footerMode}
          includeProjectTree={includeProjectTree}
          onCopyContext={handleCopyContext}
          onDownloadContext={handleDownloadContext}
          onFolderSummaryThresholdChange={onFolderSummaryThresholdChange}
          onFooterModeChange={setFooterMode}
          onIncludeProjectTreeChange={onIncludeProjectTreeChange}
          onProjectTreeUsesViewFiltersChange={onProjectTreeUsesViewFiltersChange}
          onTokenBudgetChange={onTokenBudgetChange}
          projectTreeUsesViewFilters={projectTreeUsesViewFilters}
          selectedFilesCount={selectedFiles.size}
          selectedTokensPendingCount={0}
          tokenCounting={tokenCounting}
          tokenUsage={tokenUsage}
          totalFiles={0}
          treeLoading={projectTreeTokenCountLoading}
        />
        <div className="flex-1">
          <EmptyState
            description="Select files from the explorer to include them in your project context"
            icon={<FileText />}
            title="No files selected"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="@container flex h-full flex-col overflow-hidden bg-panel-surface">
      <PreviewPanelFooter
        folderSummaryThreshold={folderSummaryThreshold ?? 5}
        footerMode={footerMode}
        includeProjectTree={includeProjectTree}
        onCopyContext={handleCopyContext}
        onDownloadContext={handleDownloadContext}
        onFolderSummaryThresholdChange={onFolderSummaryThresholdChange}
        onFooterModeChange={setFooterMode}
        onIncludeProjectTreeChange={onIncludeProjectTreeChange}
        onProjectTreeUsesViewFiltersChange={onProjectTreeUsesViewFiltersChange}
        onTokenBudgetChange={onTokenBudgetChange}
        projectTreeUsesViewFilters={projectTreeUsesViewFilters}
        selectedFilesCount={selectedFiles.size}
        selectedTokensPendingCount={contextSelectedTokenSummary.outputPendingCount}
        tokenCounting={tokenCounting}
        tokenUsage={tokenUsage}
        totalFiles={totalStats.totalFiles}
        treeLoading={projectTreeTokenCountLoading}
      />

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

        {activeTab === 'table' ? (
          <TooltipProvider delayDuration={400}>
            <PreviewViewToolbar
              additionalControls={
                <>
                  {(sortField !== 'rootFolderId' || sortDirection !== 'asc') && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label="Reset sort"
                          className="h-9 w-9 p-0"
                          data-testid="reset-sort-button"
                          onClick={resetSort}
                          size="sm"
                          title="Reset sort"
                          variant="ghost"
                        >
                          <RotateCcw className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Reset sort to default (by folder)</TooltipContent>
                    </Tooltip>
                  )}
                  <ColumnVisibilityControls
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={setColumnVisibility}
                  />
                </>
              }
              canCollapseExpandGroups={groupingConfig !== 'none' && groupedData.length > 1}
              groupingConfig={groupingConfig}
              onCollapseAllGroups={() =>
                setCollapsedGroups(new Set(groupedData.map((group) => String(group.groupKey))))
              }
              onExpandAllGroups={() => setCollapsedGroups(new Set())}
              onGroupingChange={handleGroupingChange}
              onSelectionControlsToggle={handleSelectionControlsToggle}
              selectionControlsEnabled={selectionControlsEnabled}
            />
          </TooltipProvider>
        ) : null}

        <TabsContent
          className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
          value="table"
        >
          <div className="relative flex min-h-0 flex-1 flex-col">
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
                scrollAreaClassName={previewSelections.size > 0 ? 'pb-20' : undefined}
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

            {previewSelections.size > 0 && (
              <SelectionActionBarOverlay className="flex justify-center px-4">
                <output aria-atomic="true" aria-live="polite" className="sr-only">
                  {contextSelectionSummaryText}
                </output>
                <BulkActionBar
                  actions={contextSelectionActions}
                  className="pointer-events-auto"
                  clearButtonAriaLabel="Clear context selection"
                  clearButtonLabel="Clear Selection"
                  compact
                  nodeTypes={contextSelectionNodeTypes}
                  onClearSelection={deselectAll}
                  selectedIds={previewSelections}
                  summarySubtext={null}
                  summaryText={contextSelectionSummaryText}
                />
              </SelectionActionBarOverlay>
            )}
          </div>

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
        </TabsContent>

        <TabsContent
          className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
          value="tapestry"
        >
          <FileExplorerErrorBoundary>
            <TapestryView
              activeRangesCount={activeRangesCount}
              groupedSections={tapestryGroupedSections}
              groupingConfig={groupingConfig}
              isAllSelected={isAllSelected}
              isEmpty={flattenedData.length === 0}
              isGroupFullySelected={isGroupFullySelected}
              isGroupPartiallySelected={isGroupPartiallySelected}
              onDeselectAll={deselectAll}
              onGroupDeselectAll={handleGroupDeselectAll}
              onGroupingChange={handleGroupingChange}
              onGroupSelectAll={handleGroupSelectAll}
              onRangesChange={handleTapestryRangesChange}
              onResetRanges={handleResetTapestryRanges}
              onScaleChange={setTapestryScale}
              onSelectAllOnPage={selectAllOnPage}
              onSelectionControlsToggle={handleSelectionControlsToggle}
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
              scale={tapestryScale}
              showSelectionControls={selectionControlsEnabled}
              totalFiles={flattenedData.length}
              ungroupedFiles={tapestryUngroupedFiles}
              visibleFilesOnPage={tapestryVisibleFilesOnPage}
              {...(onRequestFileContent ? { onRequestFileContent } : {})}
            />
          </FileExplorerErrorBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
});

PreviewPanel.displayName = 'PreviewPanel';
