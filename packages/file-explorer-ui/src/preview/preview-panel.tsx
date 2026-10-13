import { usePagination } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/logging';
import { DEFAULT_TOKEN_BUDGET } from '@brainstrike/types';
import {
  type BulkAction,
  BulkActionBar,
  type CollectionNodeType,
  EmptyState,
  SelectionActionBarOverlay,
} from '@brainstrike/ui';
import { getFileExtension } from '@brainstrike/utils/file-utils';
import { FileText, FileX2 } from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextExportOptions } from '../context-export-options';
import FileExplorerErrorBoundary from '../file-explorer-error-boundary';
import { useGroupSelection } from '../hooks/use-group-selection';
import type { TokenCountingState } from '../indexing/use-token-counting';
import { buildTapestryFileBase, tapestryBaseMatchesItem } from '../tapestry/tapestry-adapter';
import { TapestryView } from '../tapestry/tapestry-view';
import type { FileTapestry, TapestryRange } from '../tapestry/types';
import { useThreadFolderScopeStore } from '../thread-folder-scope-store';
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
import { PreviewPanelSummary } from './preview-panel-summary';
import { usePreviewPanelPreferences } from './use-preview-panel-preferences';
import { type FileItem, usePreviewPanelState } from './use-preview-panel-state';

const logger = createLogger('PreviewPanel');
// Cap tapestry items per page so previews keep a readable "page" density.
const TAPESTRY_PAGE_SIZE = 24;
const EMPTY_PAGINATION_INFO = {};

interface PreviewPanelProps {
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  fileContents: { [compositeKey: string]: string };
  fileSizes?: { [compositeKey: string]: number };
  folderSummaryThreshold?: number;
  includeProjectTree?: boolean;
  loadingFiles: Set<string>;
  onCopyContext?: (options: ContextExportOptions) => void;
  onDownloadContext?: (options: ContextExportOptions) => void;
  onFolderSummaryThresholdChange?: (threshold: number) => void;
  onIncludeProjectTreeChange?: (checked: boolean) => void;
  onProjectTreeUsesViewFiltersChange?: (checked: boolean) => void;
  onRequestFileContent?: (compositeKey: string) => void;
  onSelectionChange: (files: Set<string>) => void;
  onTokenBudgetChange?: (budget: number) => void;
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
  projectTreeValidationError?: string | undefined;
  /**
   * Resolve a RootId to its display name (multi-root, Phase 6) so context
   * snapshots can label same-relative-path files from different roots.
   */
  resolveRootDisplayName?: ((rootId: string) => string | undefined) | undefined;
  /**
   * Resolve a RootId to its absolute root path (storage v5 descriptor) so
   * preview rows can relativize file paths for display.
   */
  resolveRootPath?: ((rootId: string) => string | undefined) | undefined;
  selectedFiles: Set<string>;
  tokenBudget?: number;
  tokenCounting: TokenCountingState;
}

/**
 * Fixed preview ordering: files grouped by their owning root.
 *
 * The Table View owned the only sort controls (column headers plus a reset
 * button), so BST-1211 retired the sort preference with it. This reproduces
 * that surface's DEFAULT ordering exactly — ascending `rootFolderId`, ties
 * resolved by `Array.prototype.sort` stability, i.e. source order.
 */
function compareByRootFolderId(a: TableRowData, b: TableRowData): number {
  if (a.rootFolderId < b.rootFolderId) {
    return -1;
  }
  if (a.rootFolderId > b.rootFolderId) {
    return 1;
  }
  return 0;
}

interface IndexedRowData {
  order: number;
  row: TableRowData;
}

function deriveSelectedRows(
  rowDataByCompositeKey: ReadonlyMap<string, IndexedRowData>,
  selectedFiles: ReadonlySet<string>
): TableRowData[] {
  const selectedRows: IndexedRowData[] = [];
  for (const compositeKey of selectedFiles) {
    const indexedRow = rowDataByCompositeKey.get(compositeKey);
    if (indexedRow) {
      selectedRows.push(indexedRow);
    }
  }

  selectedRows.sort((a, b) => a.order - b.order);
  return selectedRows.map(({ row }) => row);
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
    onDownloadContext,
    onCopyContext,
    includeProjectTree = false,
    onIncludeProjectTreeChange,
    projectTreeUsesViewFilters = false,
    onProjectTreeUsesViewFiltersChange,
    projectTreeTokenCount = 0,
    projectTreeTokenCountLoading = false,
    projectTreeValidationError,
    tokenBudget,
    onTokenBudgetChange,
    folderSummaryThreshold,
    onFolderSummaryThresholdChange,
    onRequestFileContent,
  } = props;

  // Local selection state for preview panel - separate from file tree selections
  const [previewSelections, setPreviewSelections] = useState<Set<string>>(new Set());
  // Multi-select affordance. Deliberately NOT persisted: the retired table
  // stored this as `columnVisibility.checkbox` but pinned it back to `true` on
  // every load, so "enabled on mount" has always been the effective behaviour.
  const [selectionControlsEnabled, setSelectionControlsEnabled] = useState(true);

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
    collapsedGroups,
    groupingConfig,
    setCollapsedGroups,
    setGroupingConfig,
    setTapestryScale,
    setFooterMode,
    tapestryScale,
    footerMode,
  } = usePreviewPanelPreferences({
    footerMode: 'default',
    groupingConfig: 'none',
  });

  const state = usePreviewPanelState({
    decodeFileSelection,
    fileContents,
    fileSizes,
    loadingFiles,
    selectedFiles,
    tokenCounting,
  });

  const { totalStats, flatListItems } = state;
  // Defer row membership and its selection as one snapshot. Keeping them
  // paired prevents the gallery pipeline from observing an old/new
  // intersection while React advances the expensive row derivation.
  const previewRowsInput = useMemo(
    () => ({ flatListItems, selectedFiles }),
    [flatListItems, selectedFiles]
  );
  const deferredPreviewRowsInput = useDeferredValue(previewRowsInput);
  const deferredFlatListItems = deferredPreviewRowsInput.flatListItems;
  const deferredSelectedFiles = deferredPreviewRowsInput.selectedFiles;
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
  // Build the O(N) token index only when the deferred snapshot advances, not
  // when current selection changes while that snapshot is intentionally stale.
  const deferredTokenCountByFile = useMemo(
    () => createTokenCountByFile(deferredFlatListItems),
    [deferredFlatListItems]
  );

  const contextSelectedTokenSummary = useMemo<ContextSelectedTokenSummary>(
    () =>
      computeContextSelectedTokenSummary({
        fileContents: selectedFileContentSnapshot,
        selectedFiles,
        sourcePendingCount: totalStats.pendingCount,
        sourceSelectedTokens: totalStats.totalTokens,
        tapestryRangesByKey: deferredTapestryRangesByKey,
        tokenCountByFile: deferredTokenCountByFile,
      }),
    [
      deferredTokenCountByFile,
      totalStats,
      selectedFiles,
      deferredTapestryRangesByKey,
      selectedFileContentSnapshot,
    ]
  );

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

  // Transform list items to simplified row data - only files.
  // The useMemo already provides cross-render memoization, so no per-item cache is needed.
  const rowData: TableRowData[] = useMemo(() => {
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

  // Index the deferred snapshot once. When selection shrinks, React may briefly
  // retain many old rows here; selection-dependent work below must not scan them.
  const rowDataByCompositeKey = useMemo(
    () => new Map(rowData.map((row, order) => [row.compositeKey, { order, row }] as const)),
    [rowData]
  );

  // The context snapshot follows current membership immediately without
  // scanning the potentially stale deferred rows.
  const currentSelectedRowData = useMemo(
    () => deriveSelectedRows(rowDataByCompositeKey, selectedFiles),
    [rowDataByCompositeKey, selectedFiles]
  );

  // Expensive gallery work follows the paired deferred selection and rows, so
  // it never observes an old/new intersection. Newly selected files appear as
  // soon as the paired deferred snapshot advances.
  const selectedRowData = useMemo(
    () => deriveSelectedRows(rowDataByCompositeKey, deferredSelectedFiles),
    [deferredSelectedFiles, rowDataByCompositeKey]
  );

  useEffect(() => {
    const selectedFolderIds = new Set<string>();
    const files = currentSelectedRowData.map((item) => {
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
    setWorkspaceContextSnapshot,
    currentSelectedRowData,
    deferredTapestryRangesByKey,
    tokenBudget,
  ]);

  const tapestryFileBaseByKey = useMemo(() => {
    // Read-only access to previous-commit cache; written in the useEffect below.
    const cache = tapestryBaseCacheRef.current;
    const map = new Map<string, ReturnType<typeof buildTapestryFileBase>>();

    for (const item of selectedRowData) {
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
  }, [selectedRowData, fileContents, loadingFiles]);

  // Prune only when the deferred row index advances. Selection-only updates
  // must not scan or evict the larger deferred cache.
  // biome-ignore lint/plugin: Not fetching data — updating a local memoization cache ref.
  useEffect(() => {
    const cache = tapestryBaseCacheRef.current;
    for (const compositeKey of cache.keys()) {
      if (!rowDataByCompositeKey.has(compositeKey)) {
        cache.delete(compositeKey);
      }
    }
  }, [rowDataByCompositeKey]);

  // Persist selected bases after render in O(S). Deselected bases remain warm
  // until their row leaves the deferred snapshot in the pruning effect above.
  // biome-ignore lint/plugin: Not fetching data — updating a local memoization cache ref.
  useEffect(() => {
    const cache = tapestryBaseCacheRef.current;
    for (const item of selectedRowData) {
      const base = tapestryFileBaseByKey.get(item.compositeKey);
      if (base) {
        cache.set(item.compositeKey, {
          base,
          content: fileContents[item.compositeKey],
          isLoading: loadingFiles.has(item.compositeKey),
        });
      } else {
        cache.delete(item.compositeKey);
      }
    }
  }, [tapestryFileBaseByKey, selectedRowData, fileContents, loadingFiles]);

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
    const sorted = [...selectedRowData].sort(compareByRootFolderId);

    const config =
      GROUPING_CONFIGS[groupingConfig as keyof typeof GROUPING_CONFIGS] ?? GROUPING_CONFIGS.none;
    const grouped = groupData(sorted, config);

    return { groupedData: grouped, sortedData: sorted };
  }, [selectedRowData, groupingConfig]);

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

  const pagination = usePagination({
    pageSize: TAPESTRY_PAGE_SIZE,
    totalItems: groupingConfig === 'none' ? flattenedData.length : totalItems,
  });
  const { currentPage, goToPage, resetToFirstPage, startIndex, endIndex, totalPages } = pagination;

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

  // Current page data
  const currentPageData = useMemo(
    () => (groupingConfig === 'none' ? flattenedData.slice(startIndex, endIndex) : []),
    [endIndex, flattenedData, groupingConfig, startIndex]
  );

  const visibleFilesOnPage = useMemo(
    () =>
      getVisibleFilesOnPage({
        collapsedGroups,
        currentPageData,
        endIndex,
        groupedData,
        groupingConfig,
        startIndex,
      }),
    [collapsedGroups, currentPageData, endIndex, groupedData, groupingConfig, startIndex]
  );

  const isDesktopPreviewTestMode = window.desktopLifecycle?.isTestMode ?? false;
  // Content digest of the ONLY sub-state the snapshot below reads out of
  // `visibleFilesOnPage` (the paths). NUL-joined so a path containing the
  // separator cannot forge a collision.
  const visiblePathsKey = isDesktopPreviewTestMode
    ? visibleFilesOnPage.map((item) => item.path).join('\0')
    : '';

  useEffect(() => {
    if (!isDesktopPreviewTestMode) {
      return;
    }

    window.__brainstrikeContextExplorerPreviewTestHooks__ = {
      getSnapshot: () => ({
        renderedFilePaths: visibleFilesOnPage.map((item) => item.path),
        selectedFilesCount: selectedFiles.size,
        totalRows: flattenedData.length,
      }),
    };

    return () => {
      window.__brainstrikeContextExplorerPreviewTestHooks__ = undefined;
    };
    // `visibleFilesOnPage` is DELIBERATELY excluded in favour of
    // `visiblePathsKey`. `getSnapshot` reads nothing from that array but each
    // item's `path`, so the key is a complete digest of the closure's
    // dependency: a new array identity with unchanged paths would produce a
    // byte-identical snapshot, and re-running the effect for it would only
    // reinstall the same hook. Adding the array itself would re-run this on
    // every pagination/selection re-render for no observable difference.
    // (react-doctor exhaustive-deps, triaged on PR #2381.)
  }, [flattenedData.length, isDesktopPreviewTestMode, selectedFiles.size, visiblePathsKey]);

  const groupedPageSections = useMemo(
    () =>
      groupingConfig === 'none'
        ? []
        : buildGroupedPageSections({
            collapsedGroups,
            endIndex,
            groupedData,
            startIndex,
          }),
    [collapsedGroups, endIndex, groupedData, groupingConfig, startIndex]
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

  // BST-1990: a checked file outside the selected thread's folders reaches the
  // agent as attached content for one run; its card says so and can add the folder.
  const threadScope = useThreadFolderScopeStore((state) => state.scope);
  const requestAddToThread = useThreadFolderScopeStore((state) => state.requestAdd);
  const threadNoticeFor = useCallback(
    (rootFolderId: string): FileTapestry['threadNotice'] => {
      if (!threadScope || threadScope.rootIds.includes(rootFolderId)) {
        return;
      }
      // The explorer's descriptors are exactly the workspace's mounted folders.
      return resolveRootPath?.(rootFolderId) === undefined ? 'unavailable' : 'outside';
    },
    [resolveRootPath, threadScope]
  );
  const handleAddToThread = useCallback(
    (file: FileTapestry) => {
      const path = resolveRootPath?.(file.rootFolderId);
      const displayName = file.rootDisplayName;
      if (!(path && displayName)) {
        logger.error('Add to this thread asked for a folder that is not in the workspace', {
          rootId: file.rootFolderId,
        });
        return;
      }
      requestAddToThread({ displayName, path, rootId: file.rootFolderId });
    },
    [requestAddToThread, resolveRootPath]
  );

  const buildTapestryFile = useCallback(
    (item: TableRowData) => {
      const base = tapestryFileBaseByKey.get(item.compositeKey);
      if (!base) {
        return null;
      }
      const threadNotice = threadNoticeFor(base.rootFolderId);
      return {
        ...base,
        selections: tapestryRangesByKey[item.compositeKey] ?? [],
        ...(threadNotice ? { threadNotice } : {}),
      };
    },
    [tapestryFileBaseByKey, tapestryRangesByKey, threadNoticeFor]
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

  const handleSelectionControlsToggle = useCallback(
    (enabled: boolean) => {
      setSelectionControlsEnabled(enabled);
      if (!enabled) {
        deselectAll();
      }
    },
    [deselectAll]
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
      resetToFirstPage();
    }
  }, [groupingConfig, resetToFirstPage]);

  const selectionActionBar =
    previewSelections.size > 0 ? (
      <SelectionActionBarOverlay className="flex justify-center px-3">
        <output aria-atomic="true" aria-live="polite" className="sr-only">
          {contextSelectionSummaryText}
        </output>
        <BulkActionBar
          actions={contextSelectionActions}
          className="pointer-events-auto w-full max-w-3xl"
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
    ) : null;

  if (selectedFiles.size === 0) {
    return (
      <div className="@container flex h-full flex-col overflow-hidden bg-panel-surface">
        <PreviewPanelSummary
          folderSummaryThreshold={folderSummaryThreshold ?? 5}
          includeProjectTree={includeProjectTree}
          onCopyContext={handleCopyContext}
          onDownloadContext={handleDownloadContext}
          onFolderSummaryThresholdChange={onFolderSummaryThresholdChange}
          onIncludeProjectTreeChange={onIncludeProjectTreeChange}
          onProjectTreeUsesViewFiltersChange={onProjectTreeUsesViewFiltersChange}
          onSummaryModeChange={setFooterMode}
          onTokenBudgetChange={onTokenBudgetChange}
          projectTreeUsesViewFilters={projectTreeUsesViewFilters}
          projectTreeValidationError={projectTreeValidationError}
          selectedFilesCount={selectedFiles.size}
          selectedTokensPendingCount={0}
          summaryMode={footerMode}
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
      <PreviewPanelSummary
        folderSummaryThreshold={folderSummaryThreshold ?? 5}
        includeProjectTree={includeProjectTree}
        onCopyContext={handleCopyContext}
        onDownloadContext={handleDownloadContext}
        onFolderSummaryThresholdChange={onFolderSummaryThresholdChange}
        onIncludeProjectTreeChange={onIncludeProjectTreeChange}
        onProjectTreeUsesViewFiltersChange={onProjectTreeUsesViewFiltersChange}
        onSummaryModeChange={setFooterMode}
        onTokenBudgetChange={onTokenBudgetChange}
        projectTreeUsesViewFilters={projectTreeUsesViewFilters}
        projectTreeValidationError={projectTreeValidationError}
        selectedFilesCount={selectedFiles.size}
        selectedTokensPendingCount={contextSelectedTokenSummary.outputPendingCount}
        summaryMode={footerMode}
        tokenCounting={tokenCounting}
        tokenUsage={tokenUsage}
        totalFiles={totalStats.totalFiles}
        treeLoading={projectTreeTokenCountLoading}
      />

      <FileExplorerErrorBoundary>
        <TapestryView
          activeRangesCount={activeRangesCount}
          groupedSections={tapestryGroupedSections}
          groupingConfig={groupingConfig}
          isAllSelected={isAllSelected}
          isEmpty={flattenedData.length === 0}
          isGroupFullySelected={isGroupFullySelected}
          isGroupPartiallySelected={isGroupPartiallySelected}
          onAddToThread={handleAddToThread}
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
            currentPage,
            onPageChange: goToPage,
            pageSize: TAPESTRY_PAGE_SIZE,
            totalItems: flattenedData.length,
            totalPages,
            ...paginationInfo,
          }}
          previewSelections={previewSelections}
          scale={tapestryScale}
          selectionActionBar={selectionActionBar}
          showSelectionControls={selectionControlsEnabled}
          totalFiles={flattenedData.length}
          ungroupedFiles={tapestryUngroupedFiles}
          visibleFilesOnPage={visibleFilesOnPage}
          {...(onRequestFileContent ? { onRequestFileContent } : {})}
        />
      </FileExplorerErrorBoundary>
    </div>
  );
});

PreviewPanel.displayName = 'PreviewPanel';
