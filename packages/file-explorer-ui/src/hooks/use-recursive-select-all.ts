import { usePGliteDatabase } from '@brainstrike/db';
import {
  buildQuerySelectionFingerprint,
  buildQuerySelectionManifest,
  CHUNKED_SELECTION_THRESHOLD,
  DEFAULT_SELECTION_CHUNK_SIZE,
  QUERY_SELECTION_MATERIALIZATION_LIMIT,
} from '@brainstrike/file-explorer';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode, SelectionQueryDescriptor } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useOptionalFileExplorerStoreContext,
  useOptionalFileExplorerStoreSelector,
} from '../file-explorer-provider';
import {
  type PersistableFileExplorerStore,
  persistFileExplorerStateImmediately,
} from '../utils/persist-file-explorer-state';
import { createQuerySelectionSnapshot } from '../utils/query-selection-snapshot';
import { querySelectableFiles } from '../utils/recursive-selection-query';
import {
  selectExcludeFilters,
  selectIncludeFilters,
  selectUseRegex,
} from '../utils/workspace-filter-selectors';

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function hasPersistApi(store: unknown): store is PersistableFileExplorerStore {
  return (
    typeof store === 'function' &&
    'persist' in store &&
    typeof (store as { persist?: unknown }).persist === 'object' &&
    (store as { persist?: { getOptions?: unknown } }).persist !== null &&
    typeof (store as { persist?: { getOptions?: unknown } }).persist?.getOptions === 'function'
  );
}

async function applyExplicitSelection(
  filePaths: string[],
  folderId: string,
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void
): Promise<void> {
  if (filePaths.length === 0) {
    return;
  }

  if (filePaths.length <= CHUNKED_SELECTION_THRESHOLD) {
    addMultipleSelectedFiles(folderId, filePaths);
    return;
  }

  for (let index = 0; index < filePaths.length; index += DEFAULT_SELECTION_CHUNK_SIZE) {
    const chunk = filePaths.slice(index, index + DEFAULT_SELECTION_CHUNK_SIZE);
    addMultipleSelectedFiles(folderId, chunk);
    if (index + DEFAULT_SELECTION_CHUNK_SIZE < filePaths.length) {
      await yieldToBrowser();
    }
  }
}

function buildQuerySelectionDescriptor(args: {
  coveredDirectoryPaths: string[];
  excludeFilters: string[];
  excludedPaths: string[];
  folderId: string;
  includeFilters: string[];
  includedPaths: string[];
  manifestFingerprint: string | null;
  manifestSnapshotId: string | null;
  totalSelectedCount: number;
  useRegex: boolean;
}): SelectionQueryDescriptor {
  return {
    kind: 'recursive-select-all',
    folderId: args.folderId,
    rootPath: null,
    coveredDirectoryPaths: [...args.coveredDirectoryPaths],
    includeFilters: [...args.includeFilters],
    excludeFilters: [...args.excludeFilters],
    includedPaths: [...args.includedPaths],
    excludedPaths: [...args.excludedPaths],
    manifestFingerprint: args.manifestFingerprint,
    manifestSnapshotId: args.manifestSnapshotId,
    useRegex: args.useRegex,
    totalSelectedCount: args.totalSelectedCount,
  };
}

function collectAncestorDirectories(filePaths: string[]): string[] {
  const coveredPaths = new Set<string>();

  for (const filePath of filePaths) {
    let separatorIndex = filePath.lastIndexOf('/');
    while (separatorIndex > 0) {
      coveredPaths.add(filePath.slice(0, separatorIndex));
      separatorIndex = filePath.lastIndexOf('/', separatorIndex - 1);
    }
  }

  return Array.from(coveredPaths).sort((left, right) => left.localeCompare(right));
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
    error: err instanceof Error ? err.message : String(err),
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
    maxSelectionCount: number
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
  const db = usePGliteDatabase();
  const { storageAdapter } = useAdapters();
  const includeFilters = useOptionalFileExplorerStoreSelector(selectIncludeFilters, []);
  const excludeFilters = useOptionalFileExplorerStoreSelector(selectExcludeFilters, []);
  const useRegex = useOptionalFileExplorerStoreSelector(selectUseRegex, false);
  const setQuerySelection = useOptionalFileExplorerStoreSelector(
    (state) => state.setQuerySelection,
    undefined
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
    return undefined;
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

  useEffect(() => {
    return () => {
      cancelSelectAll();
    };
  }, [cancelSelectAll]);

  const selectAllRecursively = useCallback(
    async (
      filteredTree: IFileNode[],
      folderId: string,
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
      maxSelectionCount: number
    ): Promise<SelectAllResult> => {
      const validationError = validateSelectAllInput(fileSystemAdapter, filteredTree);
      if (validationError) {
        return validationError;
      }
      const adapter = fileSystemAdapter as FileSystemAdapter;
      if (isOperationInProgressRef.current) {
        return { success: false, filePaths: [], error: 'Operation already in progress' };
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      isOperationInProgressRef.current = true;
      isLoadingForSelectAllRef.current = true;
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

        const fullSelectionResult =
          maxSelectionCount >= result.filePaths.length && !result.limitReached;
        const canUseQuerySelection = Boolean(setQuerySelection) && fullSelectionResult;

        if (canUseQuerySelection) {
          const manifestFingerprint = buildQuerySelectionFingerprint({
            kind: 'recursive-select-all',
            folderId,
            rootPath: null,
            includeFilters,
            excludeFilters,
            useRegex,
          });
          const snapshotId = await createQuerySelectionSnapshot(db, result.filePaths);
          const manifest = buildQuerySelectionManifest({
            filePaths: result.filePaths,
            fingerprint: manifestFingerprint,
            snapshotId,
          });
          setQuerySelection?.(
            buildQuerySelectionDescriptor({
              folderId,
              coveredDirectoryPaths: collectAncestorDirectories(result.filePaths),
              includeFilters,
              excludeFilters,
              useRegex,
              totalSelectedCount: result.filePaths.length,
              manifestFingerprint,
              manifestSnapshotId: snapshotId,
              includedPaths: [],
              excludedPaths: [],
            }),
            manifest,
            new Set(result.filePaths.slice(0, QUERY_SELECTION_MATERIALIZATION_LIMIT))
          );
        } else {
          await applyExplicitSelection(result.filePaths, folderId, addMultipleSelectedFiles);
        }

        if (hasPersistApi(store)) {
          await persistFileExplorerStateImmediately(store, storageAdapter);
        }

        // Keep the transition boundary for selection-driven row updates without
        // forcing the selection path to mutate the tree itself.
        await yieldToBrowser();
        startTransition(() => {
          onTreeUpdate(getCurrentTree());
        });

        return {
          success: true,
          filePaths: result.filePaths,
          totalAvailable: result.filePaths.length,
          limitReached: result.limitReached,
        };
      } catch (err) {
        return handleSelectAllError(err, onError);
      } finally {
        abortControllerRef.current = null;
        isOperationInProgressRef.current = false;
        isLoadingForSelectAllRef.current = false;
        setState(RESET_STATE);
      }
    },
    [
      excludeFilters,
      fileSystemAdapter,
      getCurrentTree,
      includeFilters,
      internalFilterTreeFn,
      onError,
      onTreeUpdate,
      setQuerySelection,
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
