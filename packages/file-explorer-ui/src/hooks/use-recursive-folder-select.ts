import { usePGliteDatabase } from '@brainstrike/db';
import {
  buildQuerySelectionFingerprint,
  buildQuerySelectionManifest,
  CHUNKED_SELECTION_THRESHOLD,
  DEFAULT_SELECTION_CHUNK_SIZE,
} from '@brainstrike/file-explorer';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode, SelectionQueryDescriptor } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

const logger = createLogger('RecursiveFolderSelect');

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => {
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

function buildFolderQuerySelectionDescriptor(args: {
  coveredDirectoryPaths: string[];
  excludeFilters: string[];
  excludedPaths: string[];
  folderId: string;
  includeFilters: string[];
  includedPaths: string[];
  manifestFingerprint: string | null;
  manifestSnapshotId: string | null;
  rootPath: string;
  totalSelectedCount: number;
  useRegex: boolean;
}): SelectionQueryDescriptor {
  return {
    kind: 'recursive-folder',
    folderId: args.folderId,
    rootPath: args.rootPath,
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

function handleSelectionError(err: unknown, onError?: (error: Error) => void): SelectionResult {
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
    currentSelectionSize: number
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

  useEffect(() => {
    return () => {
      cancelRecursiveSelect();
    };
  }, [cancelRecursiveSelect]);

  const selectFolderRecursively = useCallback(
    async (
      node: IFileNode,
      folderId: string,
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
      maxSelectionCount: number,
      currentSelectionSize: number
    ): Promise<SelectionResult> => {
      if (node.type !== 'directory') {
        return { success: false, filePaths: [], error: 'Node is not a directory' };
      }
      const availableSlots = Math.max(0, maxSelectionCount - currentSelectionSize);
      if (availableSlots === 0) {
        return { success: true, filePaths: [] };
      }
      if (!fileSystemAdapter) {
        return { success: false, filePaths: [], error: 'File system adapter not ready' };
      }
      if (isStartingRef.current) {
        return { success: false, filePaths: [], error: 'Operation already in progress' };
      }

      const currentNode = getSubtreeByPath(node.path) ?? node;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      isStartingRef.current = true;
      isLoadingForSelectionRef.current = true;
      setState({
        isLoadingForSelection: true,
        loadingPath: node.path,
        loadingProgress: null,
      });

      try {
        const result = await querySelectableFiles({
          roots: [currentNode],
          fileSystemAdapter,
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

        const canUseQuerySelection =
          Boolean(setQuerySelection) &&
          currentSelectionSize === 0 &&
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
            buildFolderQuerySelectionDescriptor({
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
          await applyExplicitSelection(result.filePaths, folderId, addMultipleSelectedFiles);
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
