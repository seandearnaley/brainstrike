import { useOptionalPGliteDatabase } from '@brainstrike/db';
import {
  buildQuerySelectionFingerprint,
  buildQuerySelectionManifest,
} from '@brainstrike/file-explorer';
import { useAdapters, useToastManager } from '@brainstrike/file-explorer-hooks';
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
import { useActiveWorkspaceFilters } from '../utils/workspace-filter-selectors';
import {
  type AddMultipleSelectedFilesChunked,
  applyExplicitSelection,
  buildQuerySelectionDescriptor,
  collectAncestorDirectories,
  hasPersistApi,
  isForestStore,
} from './recursive-selection-utils';

const logger = createLogger('RecursiveFolderSelect');

type ShowToast = ReturnType<typeof useToastManager>['showToast'];

/**
 * No-silent-fallbacks: a folder click that selects nothing must say why.
 * Returns the (empty) result so the caller can return it directly.
 */
function notifyEmptySelectionResult(args: {
  excludeFilters: string[];
  includeFilters: string[];
  node: IFileNode;
  filesVisited: number;
  showToast: ShowToast;
}): SelectionResult {
  const { excludeFilters, includeFilters, node, filesVisited, showToast } = args;
  logger.warn('Recursive folder selection matched no files', {
    excludeFilters,
    filesVisited,
    includeFilters,
    path: node.path,
  });
  showToast({
    description:
      includeFilters.length > 0 || excludeFilters.length > 0
        ? 'Everything in it is hidden by the current view filters. Adjust the workspace filters to select these files.'
        : 'The folder has no files to select.',
    title: 'No selectable files in this folder',
  });
  return { filePaths: [], success: true };
}

/** Surface a limit-blocked folder click (the only success-shaped early return). */
function notifyBlockedSelectionResult(
  validationResult: SelectionResult,
  maxSelectionCount: number,
  showToast: ShowToast
): SelectionResult {
  if (validationResult.success) {
    // Informational, not an error: nothing failed, the cap was reached. The
    // destructive (red) variant overstated it and read as a broken state.
    showToast({
      description: 'Deselect some files or raise the limit to select this folder.',
      title: `Selection limit reached (${maxSelectionCount})`,
    });
  }
  return validationResult;
}

function handleSelectionError(err: unknown, onError?: (error: Error) => void): SelectionResult {
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
    return { result: { error: 'Node is not a directory', filePaths: [], success: false } };
  }

  const availableSlots = Math.max(0, args.maxSelectionCount - args.currentSelectionSize);
  if (availableSlots === 0) {
    // No-silent-fallbacks: this is a user-visible no-op (the checkbox does
    // nothing) — make the cause diagnosable.
    logger.warn('Recursive folder selection skipped: selection limit reached', {
      currentSelectionSize: args.currentSelectionSize,
      maxSelectionCount: args.maxSelectionCount,
      path: args.node.path,
    });
    return { result: { filePaths: [], success: true } };
  }

  if (!args.fileSystemAdapter) {
    logger.warn('Recursive folder selection skipped: file system adapter not ready', {
      path: args.node.path,
    });
    return {
      result: { error: 'File system adapter not ready', filePaths: [], success: false },
    };
  }

  if (args.isStarting) {
    logger.warn('Recursive folder selection skipped: operation already in progress', {
      path: args.node.path,
    });
    return { result: { error: 'Operation already in progress', filePaths: [], success: false } };
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
      logger.debug('Recursive folder selection requested', {
        currentSelectionSize,
        folderId,
        hasAdapter: Boolean(fileSystemAdapter),
        maxSelectionCount,
        path: node.path,
      });
      const validation = validateRecursiveFolderSelectionInput({
        currentSelectionSize,
        fileSystemAdapter,
        isStarting: isStartingRef.current,
        maxSelectionCount,
        node,
      });
      if (validation.result) {
        return notifyBlockedSelectionResult(validation.result, maxSelectionCount, showToast);
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
          fileSystemAdapter: validation.fileSystemAdapter,
          roots: [currentNode],
          ...(internalFilterTreeFn ? { filterTreeFn: internalFilterTreeFn } : {}),
          abortSignal: abortController.signal,
          excludeFilters,
          includeFilters,
          maxResults: availableSlots,
          onProgress: (progress) => {
            setState((current) => ({
              ...current,
              loadingProgress: {
                loaded: progress.directoriesCompleted,
                total: Math.max(progress.directoriesDiscovered, progress.directoriesCompleted, 1),
              },
            }));
          },
          useRegex,
        });

        if (result.filePaths.length === 0) {
          // The historical mystery no-op: a folder whose contents are all
          // excluded by the active view filters (e.g. include *.ts on an
          // html-only folder) scans to zero matches.
          return notifyEmptySelectionResult({
            excludeFilters,
            filesVisited: result.metrics.filesVisited,
            includeFilters,
            node,
            showToast,
          });
        }

        // FOREST INVARIANT: selections are ALWAYS explicit when multiple
        // roots are active — query mode lives on TOP-LEVEL state that a
        // focus switch (every forest section click) cannot carry into a
        // folderState snapshot. Single-root keeps the query fast path; the
        // null-focus case keeps legacy single-root behavior.
        const targetsFocusedRoot = currentFolderId === null || currentFolderId === folderId;
        const canUseQuerySelection =
          Boolean(setQuerySelection) &&
          targetsFocusedRoot &&
          !isForestStore(store) &&
          currentSelectionSize === currentDirectorySelectionSize &&
          availableSlots >= result.filePaths.length &&
          !result.limitReached;

        if (canUseQuerySelection) {
          const manifestFingerprint = buildQuerySelectionFingerprint({
            excludeFilters,
            folderId,
            includeFilters,
            kind: 'recursive-folder',
            rootPath: node.path,
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
              coveredDirectoryPaths: collectAncestorDirectories(result.filePaths),
              excludedPaths: [],
              excludeFilters,
              folderId,
              includedPaths: [],
              includeFilters,
              kind: 'recursive-folder',
              manifestFingerprint,
              manifestSnapshotId: snapshotId,
              rootPath: node.path,
              totalSelectedCount: result.filePaths.length,
              useRegex,
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
          filePaths: result.filePaths,
          success: true,
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
      showToast,
      storageAdapter,
      store,
      useRegex,
      db,
    ]
  );

  return {
    cancelRecursiveSelect,
    isLoadingForSelection: state.isLoadingForSelection,
    isLoadingForSelectionRef,
    loadingPath: state.loadingPath,
    loadingProgress: state.loadingProgress,
    selectFolderRecursively,
  };
}
