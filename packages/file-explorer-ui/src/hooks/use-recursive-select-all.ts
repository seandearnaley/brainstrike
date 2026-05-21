import { useOptionalPGliteDatabase } from '@brainstrike/db';
import {
  buildQuerySelectionFingerprint,
  buildQuerySelectionManifest,
} from '@brainstrike/file-explorer';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
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
import {
  selectExcludeFilters,
  selectIncludeFilters,
  selectUseRegex,
} from '../utils/workspace-filter-selectors';
import {
  type AddMultipleSelectedFilesChunked,
  applyExplicitSelection,
  buildQuerySelectionDescriptor,
  collectAncestorDirectories,
  hasPersistApi,
  yieldToBrowser,
} from './recursive-selection-utils';

const logger = createLogger('RecursiveSelectAll');

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
              kind: 'recursive-select-all',
              folderId,
              rootPath: null,
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
            new Set(result.filePaths)
          );
        } else {
          await applyExplicitSelection(result.filePaths, folderId, addMultipleSelectedFiles, {
            ...(addMultipleSelectedFilesChunked ? { addMultipleSelectedFilesChunked } : {}),
            signal: abortController.signal,
          });
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
