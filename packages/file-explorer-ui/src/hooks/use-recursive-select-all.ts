import { useOptionalPGliteDatabase } from '@brainstrike/db/react';
import {
  buildQuerySelectionFingerprint,
  buildQuerySelectionManifest,
  getFocusedSelectionCount,
  getForeignSelectionCount,
} from '@brainstrike/file-explorer';
import { useAdapters, useToastManager } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { useFileFilters } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/logging';
import type {
  IFileNode,
  QuerySelectionManifest,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useOptionalFileExplorerStoreContext,
  useOptionalFileExplorerStoreSelector,
} from '../shell/file-explorer-provider';
import { persistFileExplorerStateImmediately } from '../utils/persist-file-explorer-state';
import { createQuerySelectionSnapshot } from '../utils/query-selection-snapshot';
import { querySelectableFiles } from '../utils/recursive-selection-query';
import { useActiveWorkspaceFilters } from '../utils/workspace-filter-selectors';
import {
  type AddMultipleSelectedFilesChunked,
  applyExplicitSelection,
  buildQuerySelectionDescriptor,
  collectAncestorDirectories,
  hasPersistApi,
  isForestStore,
  yieldToBrowser,
} from './recursive-selection-utils';

const logger = createLogger('RecursiveSelectAll');

/**
 * Scan budget under the WHOLE-FOREST cap: maxSelectionCount minus the
 * selection budget already consumed elsewhere. A focused-root select-all
 * REPLACES the focused selection (only other roots consume budget); a
 * foreign-root select-all leaves the focused selection in place.
 * Falls back to the raw cap when no store is available.
 */
function computeSelectAllScanCap(
  store: ReturnType<typeof useOptionalFileExplorerStoreContext>,
  folderId: string,
  maxSelectionCount: number
): number {
  const getState = (store as { getState?: unknown } | null)?.getState;
  if (typeof getState !== 'function') {
    return maxSelectionCount;
  }
  const state = (
    getState as () => Parameters<typeof getForeignSelectionCount>[0] &
      Parameters<typeof getFocusedSelectionCount>[0]
  )();
  // An absent focus (null/undefined) is single-root legacy — the target IS
  // the focused workspace, matching the selector-default-null convention.
  const focusedRootId = state.currentFolderId ?? null;
  const targetsFocusedRoot = focusedRootId === null || focusedRootId === folderId;
  const othersCount =
    (targetsFocusedRoot ? 0 : getFocusedSelectionCount(state)) +
    getForeignSelectionCount(state, folderId);
  return Math.max(0, maxSelectionCount - othersCount);
}

/** Commit a full select-all result as a top-level query-mode selection. */
async function commitSelectAllQuerySelection(args: {
  db: ReturnType<typeof useOptionalPGliteDatabase>;
  excludeFilters: string[];
  filePaths: string[];
  folderId: string;
  includeFilters: string[];
  setQuerySelection: (
    descriptor: SelectionQueryDescriptor,
    manifest: QuerySelectionManifest,
    materializedPaths?: Set<string>
  ) => void;
  useRegex: boolean;
}): Promise<void> {
  const { db, excludeFilters, filePaths, folderId, includeFilters, setQuerySelection, useRegex } =
    args;
  const manifestFingerprint = buildQuerySelectionFingerprint({
    excludeFilters,
    folderId,
    includeFilters,
    kind: 'recursive-select-all',
    rootPath: null,
    useRegex,
  });
  const snapshotId = await createQuerySelectionSnapshot(db, filePaths);
  const manifest = buildQuerySelectionManifest({
    filePaths,
    fingerprint: manifestFingerprint,
    snapshotId,
  });
  setQuerySelection(
    buildQuerySelectionDescriptor({
      coveredDirectoryPaths: collectAncestorDirectories(filePaths),
      excludedPaths: [],
      excludeFilters,
      folderId,
      includedPaths: [],
      includeFilters,
      kind: 'recursive-select-all',
      manifestFingerprint,
      manifestSnapshotId: snapshotId,
      rootPath: null,
      totalSelectedCount: filePaths.length,
      useRegex,
    }),
    manifest,
    new Set(filePaths)
  );
}

/**
 * Commit phase shared by every successful scan: zero-match feedback, the
 * query-vs-explicit selection decision (query mode is focused-root-only in
 * forest mode), persistence, and the post-commit tree refresh.
 */
async function commitSelectAllResult(args: {
  abortSignal: AbortSignal;
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked | undefined;
  currentFolderId: string | null;
  db: ReturnType<typeof useOptionalPGliteDatabase>;
  excludeFilters: string[];
  folderId: string;
  getCurrentTree: () => IFileNode[];
  includeFilters: string[];
  maxSelectionCount: number;
  onTreeUpdate: (tree: IFileNode[]) => void;
  quiet?: boolean | undefined;
  result: Awaited<ReturnType<typeof querySelectableFiles>>;
  selectionLimit: number;
  setQuerySelection:
    | ((
        descriptor: SelectionQueryDescriptor,
        manifest: QuerySelectionManifest,
        materializedPaths?: Set<string>
      ) => void)
    | undefined;
  showToast: ReturnType<typeof useToastManager>['showToast'];
  storageAdapter: ReturnType<typeof useAdapters>['storageAdapter'];
  store: ReturnType<typeof useOptionalFileExplorerStoreContext>;
  useRegex: boolean;
}): Promise<SelectAllResult> {
  const { result, folderId, includeFilters, excludeFilters, showToast } = args;

  if (result.filePaths.length === 0) {
    // Filters that exclude every file make Select All look broken — toast
    // the cause and commit NOTHING (an empty query selection would clobber
    // the current selection state). Forest sweeps run quiet (one aggregate
    // toast at the end) but the warn log always fires.
    return notifyEmptySelectAllResult({
      excludeFilters,
      filesVisited: result.metrics.filesVisited,
      folderId,
      includeFilters,
      quiet: args.quiet === true,
      showToast,
    });
  }

  const fullSelectionResult =
    args.maxSelectionCount >= result.filePaths.length && !result.limitReached;
  // FOREST INVARIANT: selections are ALWAYS explicit when multiple roots are
  // active. Query mode lives on TOP-LEVEL state (manifest + descriptor) that
  // a focus switch — which forest mode performs on every section click —
  // cannot carry into a folderState snapshot. Single-root keeps query mode
  // for very large select-alls.
  const targetsFocusedRoot = args.currentFolderId === null || args.currentFolderId === folderId;
  const querySelectionSetter =
    targetsFocusedRoot && fullSelectionResult && !isForestStore(args.store)
      ? args.setQuerySelection
      : undefined;

  if (querySelectionSetter) {
    await commitSelectAllQuerySelection({
      db: args.db,
      excludeFilters,
      filePaths: result.filePaths,
      folderId,
      includeFilters,
      setQuerySelection: querySelectionSetter,
      useRegex: args.useRegex,
    });
  } else {
    await applyExplicitSelection(result.filePaths, folderId, args.addMultipleSelectedFiles, {
      ...(args.addMultipleSelectedFilesChunked
        ? { addMultipleSelectedFilesChunked: args.addMultipleSelectedFilesChunked }
        : {}),
      signal: args.abortSignal,
    });
  }

  if (hasPersistApi(args.store)) {
    await persistFileExplorerStateImmediately(args.store, args.storageAdapter);
  }

  // Keep the transition boundary for selection-driven row updates without
  // forcing the selection path to mutate the tree itself.
  await yieldToBrowser();
  startTransition(() => {
    args.onTreeUpdate(args.getCurrentTree());
  });

  if (result.limitReached) {
    notifyCappedSelectAllResult({
      fileCount: result.filePaths.length,
      quiet: args.quiet === true,
      selectionLimit: args.selectionLimit,
      showToast,
    });
  }

  return {
    filePaths: result.filePaths,
    limitReached: result.limitReached,
    success: true,
    totalAvailable: result.filePaths.length,
  };
}

/**
 * No-silent-fallbacks: a Select All that matches nothing must say why.
 * Returns the (empty) result so the caller can return it directly.
 */
function notifyEmptySelectAllResult(args: {
  excludeFilters: string[];
  filesVisited: number;
  folderId: string;
  includeFilters: string[];
  quiet?: boolean;
  showToast: ReturnType<typeof useToastManager>['showToast'];
}): SelectAllResult {
  const { excludeFilters, filesVisited, folderId, includeFilters, quiet, showToast } = args;
  logger.warn('Select all matched no files', {
    excludeFilters,
    filesVisited,
    folderId,
    includeFilters,
  });
  if (quiet) {
    return { filePaths: [], success: true, totalAvailable: 0 };
  }
  showToast({
    description:
      includeFilters.length > 0 || excludeFilters.length > 0
        ? 'Everything is hidden by the current view filters. Adjust the workspace filters to select files.'
        : 'There are no files to select.',
    title: 'No selectable files in view',
  });
  return { filePaths: [], success: true, totalAvailable: 0 };
}

function notifyCappedSelectAllResult(args: {
  fileCount: number;
  quiet?: boolean;
  selectionLimit: number;
  showToast: ReturnType<typeof useToastManager>['showToast'];
}): void {
  if (args.quiet) {
    return;
  }
  args.showToast({
    description: `Selected ${args.fileCount} files before hitting the limit. Raise the limit to select more.`,
    title: `Selection limit reached (${args.selectionLimit})`,
    variant: 'destructive',
  });
}

function handleSelectAllError(err: unknown, onError?: (error: Error) => void): SelectAllResult {
  const isCancelled = isAbortError(err);
  if (!isCancelled) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    cancelled: isCancelled,
    filePaths: [],
    success: false,
    ...(isCancelled ? {} : { error: err instanceof Error ? err.message : String(err) }),
  };
}

function validateSelectAllInput(
  fileSystemAdapter: FileSystemAdapter | null | undefined,
  filteredTree: IFileNode[]
): SelectAllResult | null {
  if (filteredTree.length === 0) {
    return { error: 'No files in tree', filePaths: [], success: false };
  }
  if (!fileSystemAdapter) {
    return { error: 'File system adapter not ready', filePaths: [], success: false };
  }
  return null;
}

export interface RecursiveSelectAllState {
  isLoadingForSelectAll: boolean;
  loadingProgress: { loaded: number; total: number } | null;
}

export interface UseRecursiveSelectAllOptions {
  cancelLoadOperations?: () => void;
  fileSystemAdapter?: FileSystemAdapter | null;
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];
  getCurrentTree: () => IFileNode[];
  onError?: (error: Error) => void;
  onTreeUpdate: (tree: IFileNode[]) => void;
  parentRootId?: DirectoryHandle['rootId'];
}

export interface SelectAllResult {
  cancelled?: boolean;
  error?: string;
  filePaths: string[];
  limitReached?: boolean;
  success: boolean;
  totalAvailable?: number;
}

export interface UseRecursiveSelectAllReturn {
  cancelSelectAll: () => void;
  isLoadingForSelectAll: boolean;
  isLoadingForSelectAllRef: React.RefObject<boolean>;
  loadingProgress: { loaded: number; total: number } | null;
  selectAllRecursively: (
    filteredTree: IFileNode[],
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked,
    options?: SelectAllOptions
  ) => Promise<SelectAllResult>;
}

export interface SelectAllOptions {
  /**
   * Suppress per-call toasts (zero-match, budget-exhausted). Used by the
   * forest sweep, which runs one pass per root and owns AGGREGATE feedback —
   * per-root toasts would fire N times. Warn logs still fire (never silent).
   */
  quiet?: boolean;
}

const RESET_STATE: RecursiveSelectAllState = {
  isLoadingForSelectAll: false,
  loadingProgress: null,
};

export function useRecursiveSelectAll(
  options: UseRecursiveSelectAllOptions
): UseRecursiveSelectAllReturn {
  const {
    cancelLoadOperations,
    fileSystemAdapter,
    filterTreeFn,
    getCurrentTree,
    onError,
    onTreeUpdate,
    parentRootId,
  } = options;

  const store = useOptionalFileExplorerStoreContext();
  const db = useOptionalPGliteDatabase();
  const { storageAdapter } = useAdapters();
  const { showToast } = useToastManager();
  // The EFFECTIVE workspace filters (global lists minus disabled toggles) —
  // the same derivation the tree display uses, so scans select exactly what
  // the trees show.
  const { includeFilters, excludeFilters, useRegex } = useActiveWorkspaceFilters();
  const setQuerySelection = useOptionalFileExplorerStoreSelector(
    (state) => state.setQuerySelection,
    undefined
  );
  const currentFolderId = useOptionalFileExplorerStoreSelector(
    (state) => state.currentFolderId,
    null
  );
  const { applyFileFilters } = useFileFilters();

  const internalFilterTreeFn = useMemo(() => {
    if (filterTreeFn) {
      return filterTreeFn;
    }
    if (store) {
      return (tree: IFileNode[]) =>
        applyFileFilters(tree, includeFilters, excludeFilters, useRegex);
    }
    return;
  }, [applyFileFilters, excludeFilters, filterTreeFn, includeFilters, store, useRegex]);

  const [state, setState] = useState<RecursiveSelectAllState>(RESET_STATE);
  const isOperationInProgressRef = useRef(false);
  const isLoadingForSelectAllRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelSelectAll = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    cancelLoadOperations?.();
    isOperationInProgressRef.current = false;
    isLoadingForSelectAllRef.current = false;
    setState(RESET_STATE);
  }, [cancelLoadOperations]);

  useEffect(
    () => () => {
      cancelSelectAll();
    },
    [cancelSelectAll]
  );

  const selectAllRecursively = useCallback(
    async (
      filteredTree: IFileNode[],
      folderId: string,
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
      maxSelectionCount: number,
      addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked,
      options?: SelectAllOptions
    ): Promise<SelectAllResult> => {
      const validationError = validateSelectAllInput(fileSystemAdapter, filteredTree);
      if (validationError) {
        return validationError;
      }
      const adapter = fileSystemAdapter as FileSystemAdapter;
      if (isOperationInProgressRef.current) {
        return { error: 'Operation already in progress', filePaths: [], success: false };
      }

      // Whole-forest cap: the scan budget is what's left after every OTHER
      // root's selection (and the focused selection, for a foreign target).
      const scanCap = computeSelectAllScanCap(store, folderId, maxSelectionCount);
      if (scanCap === 0) {
        if (!options?.quiet) {
          showToast({
            description: 'Deselect files in other folders or raise the limit to select more.',
            title: `Selection limit reached (${maxSelectionCount})`,
            variant: 'destructive',
          });
        }
        return { filePaths: [], limitReached: true, success: true, totalAvailable: 0 };
      }

      isOperationInProgressRef.current = true;
      isLoadingForSelectAllRef.current = true;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      setState({
        isLoadingForSelectAll: true,
        loadingProgress: null,
      });

      try {
        const result = await querySelectableFiles({
          fileSystemAdapter: adapter,
          roots: filteredTree,
          ...(internalFilterTreeFn ? { filterTreeFn: internalFilterTreeFn } : {}),
          abortSignal: abortController.signal,
          excludeFilters,
          includeFilters,
          maxResults: scanCap,
          onProgress: (progress) => {
            setState((current) => ({
              ...current,
              loadingProgress: {
                loaded: progress.directoriesCompleted,
                total: Math.max(progress.directoriesDiscovered, progress.directoriesCompleted, 1),
              },
            }));
          },
          parentRootId,
          useRegex,
        });

        return await commitSelectAllResult({
          abortSignal: abortController.signal,
          addMultipleSelectedFiles,
          addMultipleSelectedFilesChunked,
          currentFolderId,
          db,
          excludeFilters,
          folderId,
          getCurrentTree,
          includeFilters,
          maxSelectionCount: scanCap,
          onTreeUpdate,
          quiet: options?.quiet,
          result,
          selectionLimit: maxSelectionCount,
          setQuerySelection,
          showToast,
          storageAdapter,
          store,
          useRegex,
        });
      } catch (err) {
        if (!isAbortError(err)) {
          logger.error('selectAllRecursively failed', { error: err });
        }
        return handleSelectAllError(err, onError);
      } finally {
        abortControllerRef.current = null;
        isOperationInProgressRef.current = false;
        isLoadingForSelectAllRef.current = false;
        setState(RESET_STATE);
      }
    },
    [
      currentFolderId,
      excludeFilters,
      fileSystemAdapter,
      getCurrentTree,
      includeFilters,
      internalFilterTreeFn,
      onError,
      onTreeUpdate,
      parentRootId,
      setQuerySelection,
      showToast,
      storageAdapter,
      store,
      useRegex,
      db,
    ]
  );

  return {
    cancelSelectAll,
    isLoadingForSelectAll: state.isLoadingForSelectAll,
    isLoadingForSelectAllRef,
    loadingProgress: state.loadingProgress,
    selectAllRecursively,
  };
}
