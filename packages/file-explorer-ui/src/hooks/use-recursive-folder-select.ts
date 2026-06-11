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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
} from './recursive-selection-utils';

const logger = createLogger('RecursiveFolderSelect');

function handleSelectionError(err: unknown, onError?: (error: Error) => void): SelectionResult {
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

function validateRecursiveFolderSelectionInput(args: {
  currentSelectionSize: number;
  fileSystemAdapter: FileSystemAdapter | null | undefined;
  isStarting: boolean;
  maxSelectionCount: number;
  node: IFileNode;
}):
  | { availableSlots: number; fileSystemAdapter: FileSystemAdapter; result: null }
  | {
      result: SelectionResult;
    } {
  if (args.node.type !== 'directory') {
    return { result: { success: false, filePaths: [], error: 'Node is not a directory' } };
  }

  const availableSlots = Math.max(0, args.maxSelectionCount - args.currentSelectionSize);
  if (availableSlots === 0) {
    return { result: { success: true, filePaths: [] } };
  }

  if (!args.fileSystemAdapter) {
    return {
      result: { success: false, filePaths: [], error: 'File system adapter not ready' },
    };
  }

  if (args.isStarting) {
    return { result: { success: false, filePaths: [], error: 'Operation already in progress' } };
  }

  return {
    availableSlots,
    fileSystemAdapter: args.fileSystemAdapter,
    result: null,
  };
}

export interface RecursiveFolderSelectState {
  isLoadingForSelection: boolean;
  loadingPath: string | null;
  loadingProgress: { loaded: number; total: number } | null;
}

export interface UseRecursiveFolderSelectOptions {
  cancelLoadOperations?: () => void;
  fileSystemAdapter?: FileSystemAdapter | null;
  filterTreeFn?: (tree: IFileNode[]) => IFileNode[];
  getSubtreeByPath: (path: string) => IFileNode | undefined;
  onError?: (error: Error) => void;
}

export interface SelectionResult {
  cancelled?: boolean;
  error?: string;
  filePaths: string[];
  success: boolean;
}

export interface UseRecursiveFolderSelectReturn {
  cancelRecursiveSelect: () => void;
  isLoadingForSelection: boolean;
  isLoadingForSelectionRef: React.RefObject<boolean>;
  loadingPath: string | null;
  loadingProgress: { loaded: number; total: number } | null;
  selectFolderRecursively: (
    node: IFileNode,
    folderId: string,
    addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
    maxSelectionCount: number,
    currentSelectionSize: number,
    currentDirectorySelectionSize?: number,
    addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
  ) => Promise<SelectionResult>;
}

const RESET_STATE: RecursiveFolderSelectState = {
  isLoadingForSelection: false,
  loadingPath: null,
  loadingProgress: null,
};

export function useRecursiveFolderSelect(
  options: UseRecursiveFolderSelectOptions
): UseRecursiveFolderSelectReturn {
  const { cancelLoadOperations, fileSystemAdapter, filterTreeFn, getSubtreeByPath, onError } =
    options;

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

  const [state, setState] = useState<RecursiveFolderSelectState>(RESET_STATE);
  const isStartingRef = useRef(false);
  const isLoadingForSelectionRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancelRecursiveSelect = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    cancelLoadOperations?.();
    isStartingRef.current = false;
    isLoadingForSelectionRef.current = false;
    setState(RESET_STATE);
  }, [cancelLoadOperations]);

  useEffect(
    () => () => {
      cancelRecursiveSelect();
    },
    [cancelRecursiveSelect]
  );

  const selectFolderRecursively = useCallback(
    async (
      node: IFileNode,
      folderId: string,
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
      maxSelectionCount: number,
      currentSelectionSize: number,
      currentDirectorySelectionSize = 0,
      addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
    ): Promise<SelectionResult> => {
      const validation = validateRecursiveFolderSelectionInput({
        currentSelectionSize,
        fileSystemAdapter,
        isStarting: isStartingRef.current,
        maxSelectionCount,
        node,
      });
      if (validation.result) {
        return validation.result;
      }
      const availableSlots = validation.availableSlots;

      isStartingRef.current = true;
      isLoadingForSelectionRef.current = true;
      const currentNode = getSubtreeByPath(node.path) ?? node;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      setState({
        isLoadingForSelection: true,
        loadingPath: node.path,
        loadingProgress: null,
      });

      try {
        const result = await querySelectableFiles({
          roots: [currentNode],
          fileSystemAdapter: validation.fileSystemAdapter,
          ...(internalFilterTreeFn ? { filterTreeFn: internalFilterTreeFn } : {}),
          includeFilters,
          excludeFilters,
          maxResults: availableSlots,
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

        // Query-mode selection lives on the TOP-LEVEL selection model, which
        // belongs to the FOCUSED root in forest mode. A foreign root's
        // recursive select must use explicit selection instead — the store
        // mutators route those keys into that root's folderState. The
        // null-focus case keeps legacy single-root behavior.
        const targetsFocusedRoot = currentFolderId === null || currentFolderId === folderId;
        const canUseQuerySelection =
          Boolean(setQuerySelection) &&
          targetsFocusedRoot &&
          currentSelectionSize === currentDirectorySelectionSize &&
          availableSlots >= result.filePaths.length &&
          !result.limitReached;

        if (canUseQuerySelection) {
          const manifestFingerprint = buildQuerySelectionFingerprint({
            kind: 'recursive-folder',
            folderId,
            rootPath: node.path,
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
              kind: 'recursive-folder',
              folderId,
              rootPath: node.path,
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

        return {
          success: true,
          filePaths: result.filePaths,
        };
      } catch (err) {
        logger.error('selectFolderRecursively failed', { error: err });
        return handleSelectionError(err, onError);
      } finally {
        abortControllerRef.current = null;
        isStartingRef.current = false;
        isLoadingForSelectionRef.current = false;
        setState(RESET_STATE);
      }
    },
    [
      currentFolderId,
      excludeFilters,
      fileSystemAdapter,
      getSubtreeByPath,
      includeFilters,
      internalFilterTreeFn,
      onError,
      setQuerySelection,
      storageAdapter,
      store,
      useRegex,
      db,
    ]
  );

  return {
    isLoadingForSelection: state.isLoadingForSelection,
    loadingPath: state.loadingPath,
    loadingProgress: state.loadingProgress,
    selectFolderRecursively,
    cancelRecursiveSelect,
    isLoadingForSelectionRef,
  };
}
