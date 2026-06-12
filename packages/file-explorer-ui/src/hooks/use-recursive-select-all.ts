import { useOptionalPGliteDatabase } from '@brainstrike/db';
import {
  buildQuerySelectionFingerprint,
  buildQuerySelectionManifest,
} from '@brainstrike/file-explorer';
import { useAdapters, useToastManager } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { useFileFilters } from '@brainstrike/hooks';
import type {
  IFileNode,
  QuerySelectionManifest,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { createLogger } from '@brainstrike/utils/logger';
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
  yieldToBrowser,
} from './recursive-selection-utils';

const logger = createLogger('RecursiveSelectAll');

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
    kind: 'recursive-select-all',
    folderId,
    rootPath: null,
    includeFilters,
    excludeFilters,
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
      kind: 'recursive-select-all',
      folderId,
      rootPath: null,
      coveredDirectoryPaths: collectAncestorDirectories(filePaths),
      includeFilters,
      excludeFilters,
      useRegex,
      totalSelectedCount: filePaths.length,
      manifestFingerprint,
      manifestSnapshotId: snapshotId,
      includedPaths: [],
      excludedPaths: [],
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
  result: Awaited<ReturnType<typeof querySelectableFiles>>;
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
    // the current selection state).
    return notifyEmptySelectAllResult({
      excludeFilters,
      filesVisited: result.metrics.filesVisited,
      folderId,
      includeFilters,
      showToast,
    });
  }

  const fullSelectionResult =
    args.maxSelectionCount >= result.filePaths.length && !result.limitReached;
  // Query-mode selection lives on the TOP-LEVEL selection model, which
  // belongs to the FOCUSED root in forest mode — a per-root select-all for
  // any other root must use explicit selection (the store mutators route
  // those keys into that root's folderState).
  const targetsFocusedRoot = args.currentFolderId === null || args.currentFolderId === folderId;
  const querySelectionSetter =
    targetsFocusedRoot && fullSelectionResult ? args.setQuerySelection : undefined;

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

  return {
    success: true,
    filePaths: result.filePaths,
    totalAvailable: result.filePaths.length,
    limitReached: result.limitReached,
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
  showToast: ReturnType<typeof useToastManager>['showToast'];
}): SelectAllResult {
  const { excludeFilters, filesVisited, folderId, includeFilters, showToast } = args;
  logger.warn('Select all matched no files', {
    folderId,
    includeFilters,
    excludeFilters,
    filesVisited,
  });
  showToast({
    title: 'No selectable files in view',
    description:
      includeFilters.length > 0 || excludeFilters.length > 0
        ? 'Everything is hidden by the current view filters. Adjust the workspace filters to select files.'
        : 'There are no files to select.',
  });
  return { success: true, filePaths: [], totalAvailable: 0 };
}

function handleSelectAllError(err: unknown, onError?: (error: Error) => void): SelectAllResult {
  const isCancelled = isAbortError(err);
  if (!isCancelled) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    success: false,
    filePaths: [],
    cancelled: isCancelled,
    ...(isCancelled ? {} : { error: err instanceof Error ? err.message : String(err) }),
  };
}

function validateSelectAllInput(
  fileSystemAdapter: FileSystemAdapter | null | undefined,
  filteredTree: IFileNode[]
): SelectAllResult | null {
  if (filteredTree.length === 0) {
    return { success: false, filePaths: [], error: 'No files in tree' };
  }
  if (!fileSystemAdapter) {
    return { success: false, filePaths: [], error: 'File system adapter not ready' };
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
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
  ) => Promise<SelectAllResult>;
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
      addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
    ): Promise<SelectAllResult> => {
      const validationError = validateSelectAllInput(fileSystemAdapter, filteredTree);
      if (validationError) {
        return validationError;
      }
      const adapter = fileSystemAdapter as FileSystemAdapter;
      if (isOperationInProgressRef.current) {
        return { success: false, filePaths: [], error: 'Operation already in progress' };
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
          roots: filteredTree,
          fileSystemAdapter: adapter,
          ...(internalFilterTreeFn ? { filterTreeFn: internalFilterTreeFn } : {}),
          includeFilters,
          excludeFilters,
          maxResults: maxSelectionCount,
          useRegex,
          abortSignal: abortController.signal,
          onProgress: (progress) => {
            setState((current) => ({
              ...current,
              loadingProgress: {
                loaded: progress.directoriesCompleted,
                total: Math.max(progress.directoriesDiscovered, progress.directoriesCompleted, 1),
              },
            }));
          },
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
          maxSelectionCount,
          onTreeUpdate,
          result,
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
      setQuerySelection,
      showToast,
      storageAdapter,
      store,
      useRegex,
      db,
    ]
  );

  return {
    isLoadingForSelectAll: state.isLoadingForSelectAll,
    loadingProgress: state.loadingProgress,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAllRef,
  };
}
