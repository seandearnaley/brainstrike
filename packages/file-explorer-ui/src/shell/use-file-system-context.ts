/**
 * File System Hook (Context-aware)
 *
 * This hook provides file system functionality using the context-based store.
 */

import {
  useAdapters,
  useFileSystem as useCoreFileSystem,
  useFileSystemWatcher,
  useToastManager,
} from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useOptionalTokenCacheContext } from '../indexing/token-cache-context';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { useOptionalRootDataDeletion } from './root-data-deletion-context';

const logger = createLogger('FileSystemContext');

/**
 * Type guard to check if the store has the Zustand persist API.
 */
interface PersistApi {
  hasHydrated: () => boolean;
  onFinishHydration: (callback: () => void) => () => void;
}

function hasPersistApi(
  store: ReturnType<typeof useFileExplorerStoreContext>
): store is ReturnType<typeof useFileExplorerStoreContext> & { persist: PersistApi } {
  const persistObj = (store as unknown as { persist?: unknown }).persist;
  if (typeof persistObj !== 'object' || persistObj === null) {
    return false;
  }
  const persist = persistObj as Record<string, unknown>;
  return (
    typeof persist['hasHydrated'] === 'function' &&
    typeof persist['onFinishHydration'] === 'function'
  );
}

// Error message mappings for consistent user experience
const ERROR_MESSAGES = {
  permissionDenied:
    'Permission denied: Unable to access the selected directory. Please check folder permissions and try again.',
  dialogFailed: 'Could not open the folder selection dialog. Please try again.',
  directoryReadFailed:
    'Cannot read the selected directory. Please ensure you have proper access permissions.',
  directoryAccessFailed:
    'Cannot access the selected directory. Please ensure you have proper access permissions.',
  genericError: 'An unexpected error occurred while selecting the directory.',
} as const satisfies Record<string, string>;

// Error mapping configuration
const ERROR_PATTERNS = [
  { pattern: /Permission denied/i, message: ERROR_MESSAGES.permissionDenied },
  {
    pattern: /Unable to open directory selection dialog|Failed to open directory dialog/i,
    message: ERROR_MESSAGES.dialogFailed,
  },
  {
    pattern: /Unable to read the selected directory/i,
    message: ERROR_MESSAGES.directoryReadFailed,
  },
  {
    pattern: /Cannot access selected directory/i,
    message: ERROR_MESSAGES.directoryAccessFailed,
  },
] as const satisfies ReadonlyArray<{ pattern: RegExp; message: string }>;

// Helper function to map error messages to user-friendly text
function getUserFriendlyErrorMessage(errorMessage: string): string {
  const matchedPattern = ERROR_PATTERNS.find(({ pattern }) => pattern.test(errorMessage));
  return matchedPattern ? matchedPattern.message : errorMessage;
}

// Wrapper: error mapping only (no extra state/hooks)
async function selectDirectoryWithErrorMapping(
  coreApi: ReturnType<typeof useCoreFileSystem>
): Promise<DirectoryHandle | null> {
  const { supported, reason } = coreApi.isFileSystemAccessSupported();
  if (!supported) {
    throw new Error(reason);
  }
  try {
    return await coreApi.selectRootDirectory();
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? getUserFriendlyErrorMessage(error.message)
        : ERROR_MESSAGES.genericError;
    throw new Error(errorMessage);
  }
}

/** Custom event dispatched to all listeners when a watched root reports changes. */
const FILE_EXPLORER_REFRESH_EVENT = 'brainstrike:file-explorer-refreshed';

export function useFileSystem() {
  const store = useFileExplorerStoreContext();
  const setCurrentFolderId = useFileExplorerStoreSelector((s) => s.setCurrentFolderId);
  const hydrateFolderState = useFileExplorerStoreSelector((s) => s.hydrateFolderState);
  const storedRootDirectoryHandle = useFileExplorerStoreSelector((s) => s.rootDirectoryHandle);
  const setRootDirectoryHandle = useFileExplorerStoreSelector((s) => s.setRootDirectoryHandle);
  const setStoreIsAccessLoading = useFileExplorerStoreSelector((s) => s.setIsAccessLoading);
  // Multi-root store actions: without these the boot restore never populates
  // activeRootIds and focus-by-recency always falls back to handles[0].
  const addActiveRoot = useFileExplorerStoreSelector((s) => s.addActiveRoot);
  const removeActiveRoot = useFileExplorerStoreSelector((s) => s.removeActiveRoot);
  const setActiveRoots = useFileExplorerStoreSelector((s) => s.setActiveRoots);
  // Token cache seam: the core hook does not own the token cache, so the
  // disconnect wrapper below clears the removed root's cached token counts via
  // the (optional) TokenCacheProvider context.
  const tokenCacheContext = useOptionalTokenCacheContext();
  // Cascade-delete seam (Phase 6): app-shell injects the DB deletion; the
  // disconnect wrapper aborts (with a toast) when deletion is requested but
  // fails or no provider is mounted — never a silent no-op.
  const deleteRootData = useOptionalRootDataDeletion();
  const { showToast: showToastRaw } = useToastManager();
  const showToast = useCallback(
    (description: string) => {
      showToastRaw({ description, title: 'Disconnect failed', variant: 'destructive' });
    },
    [showToastRaw]
  );

  const rehydrateCurrentFolderStateIfNeeded = useCallback(
    (folderId: string) => {
      const state = store.getState();
      if (state.currentFolderId !== folderId) {
        return;
      }

      const persistedFolderState = state.folderStates[folderId];
      if (!persistedFolderState) {
        return;
      }

      const selectionModeChanged =
        state.selectionModel.mode !== persistedFolderState.selectionModel.mode;
      const selectedCountChanged =
        state.selectedFilePaths.size !== persistedFolderState.selectedFilePaths.size;
      const expandedPathCountChanged =
        state.expandedDirectoryPaths.size !== persistedFolderState.expandedDirectoryPaths.size;

      if (selectionModeChanged || selectedCountChanged || expandedPathCountChanged) {
        hydrateFolderState(folderId);
      }
    },
    [hydrateFolderState, store]
  );

  /**
   * Wait for store hydration to complete before proceeding.
   * This prevents race conditions during auto-restore where setCurrentFolderId
   * might be called before persisted state is loaded, causing empty state to
   * overwrite the persisted selections.
   */
  const waitForHydration = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      if (!hasPersistApi(store)) {
        // No persist API, resolve immediately
        resolve();
        return;
      }

      if (store.persist.hasHydrated()) {
        resolve();
        return;
      }

      // Wait for hydration to complete
      const unsubscribe = store.persist.onFinishHydration(() => {
        unsubscribe();
        resolve();
      });
    });
  }, [store]);

  /**
   * Get the current folder ID from the store after hydration.
   * This is used to check if setCurrentFolderId would be a no-op.
   */
  const getPersistedCurrentFolderId = useCallback(
    (): string | null => store.getState().currentFolderId,
    [store]
  );

  /**
   * Getter for the store's folderAccessOrder (focus-by-recency during boot
   * restore). Read lazily via getState so it is always fresh at call time.
   */
  const getFolderAccessOrder = useCallback(
    (): readonly string[] => store.getState().folderAccessOrder,
    [store]
  );

  const coreApi = useCoreFileSystem({
    setCurrentFolderId,
    waitForHydration,
    getPersistedCurrentFolderId,
    addActiveRoot,
    removeActiveRoot,
    setActiveRoots,
    getFolderAccessOrder,
  });

  const isFileSystemAccessSupported = coreApi.isFileSystemAccessSupported;

  const selectRootDirectory = async (): Promise<DirectoryHandle | null> => {
    const handle = await selectDirectoryWithErrorMapping(coreApi);
    if (handle) {
      setRootDirectoryHandle(handle);
      // v5: currentFolderId is now a RootId UUID (set by coreApi.selectRootDirectory
      // → addRootDirectory → updateCurrentFolderId(rootId)).  Read it from the store
      // rather than using handle.path so the rehydration key matches the store key.
      const rootId = store.getState().currentFolderId;
      if (rootId) {
        rehydrateCurrentFolderStateIfNeeded(rootId);
      }
    }
    return handle;
  };

  const clearRootDirectory = () => {
    coreApi.clearRootDirectory();
    setRootDirectoryHandle(null);
  };

  /**
   * Disconnect a root by RootId (multi-root, Phase 5).
   *
   * Delegates the orchestration (adapter forget, handle removal, focus shift,
   * store purge) to the core hook, then syncs the store's handle copy and
   * clears the root's cached token counts. Disconnect ≠ delete: indexed DB
   * rows are deliberately KEPT so re-adding the folder resumes instantly.
   *
   * Phase 6 opt-in (`options.deleteData`): the root's indexed rows are
   * deleted FIRST via the app-shell-injected seam — if the delete fails the
   * disconnect is ABORTED (toast + root stays connected, so the user can
   * retry). The reverse order would orphan rows with no UI left to retry.
   */
  const removeRootDirectory = async (
    rootId: string,
    options?: { deleteData?: boolean }
  ): Promise<void> => {
    if (options?.deleteData) {
      try {
        if (!deleteRootData) {
          throw new Error('Root data deletion is not available in this environment.');
        }
        await deleteRootData(rootId);
      } catch (error) {
        logger.error('removeRootDirectory: data deletion failed — disconnect aborted', {
          error,
          rootId,
        });
        showToast('Could not delete the folder’s indexed data. The folder stays connected.');
        return;
      }
    }
    const nextFocused = await coreApi.removeRootDirectory(rootId);
    // Keep the store's handle copy coherent with the core hook (the store
    // value is the render source of truth for rootDirectoryHandle below).
    setRootDirectoryHandle(nextFocused);
    // Token cache: best-effort — a failure must not block the disconnect.
    if (tokenCacheContext) {
      try {
        await tokenCacheContext.store.clearFolder(rootId);
      } catch (error) {
        logger.warn('removeRootDirectory: token cache clearFolder failed', { error, rootId });
      }
    }
  };

  /**
   * Register ALL handles returned by the restore-access flow (multi-root).
   * Delegates to the core hook (per-handle addOrFocusHandle + addActiveRoot,
   * handles[0] focused), then syncs the focused handle to the store and
   * rehydrates its persisted folder state — same store side effects as
   * setRootHandle, but without dropping handles[1..n].
   */
  const registerRestoredHandles = async (handles: readonly DirectoryHandle[]): Promise<void> => {
    await coreApi.registerRestoredHandles(handles);
    const first = handles[0];
    if (first) {
      setRootDirectoryHandle(first);
      // v5: use the resolved RootId UUID from the store (same rationale as selectRootDirectory).
      const rootId = store.getState().currentFolderId;
      if (rootId) {
        rehydrateCurrentFolderStateIfNeeded(rootId);
      }
    }
  };

  /**
   * Set root directory handle from external source (e.g., restore banner).
   * Updates both the store and the core hook's internal state.
   */
  const setRootHandle = (handle: DirectoryHandle | null) => {
    coreApi.setRootDirectoryHandle(handle);
    setRootDirectoryHandle(handle);
    if (handle) {
      // v5: prefer the RootId UUID from the store after coreApi has updated currentFolderId.
      // Fall back to handle.path for legacy paths that still write the path as currentFolderId.
      const rootId = store.getState().currentFolderId ?? handle.path;
      rehydrateCurrentFolderStateIfNeeded(rootId);
    }
  };

  // Sync core hook's restoration to the store (desktop auto-restore)
  // Initial one-way sync only: if the core restored a handle and the store is empty.
  // biome-ignore lint/plugin: One-time sync from core hook to store - controlled state restoration
  useLayoutEffect(() => {
    if (!storedRootDirectoryHandle && coreApi.rootDirectoryHandle) {
      setRootDirectoryHandle(coreApi.rootDirectoryHandle);
      // v5: use the RootId UUID from the store after coreApi's restore has set currentFolderId.
      const rootId = store.getState().currentFolderId ?? coreApi.rootDirectoryHandle.path;
      rehydrateCurrentFolderStateIfNeeded(rootId);
    }
  }, [
    storedRootDirectoryHandle,
    coreApi.rootDirectoryHandle,
    setRootDirectoryHandle,
    rehydrateCurrentFolderStateIfNeeded,
  ]);

  // CRITICAL: Sync isAccessLoading from core hook to store.
  // The stale state clearing effect in use-file-explorer-context checks the STORE's
  // isAccessLoading value. On Electron, restoreLastFolder sets the core hook's local
  // isAccessLoading but not the store's. Without this sync, the stale clearing effect
  // sees store.isAccessLoading=false and incorrectly clears selections/expansions.
  useEffect(() => {
    setStoreIsAccessLoading(coreApi.isAccessLoading);
  }, [coreApi.isAccessLoading, setStoreIsAccessLoading]);

  // Per-root file watcher lifecycle (multi-root, Phase 4+).
  // Dispatches the file-explorer refresh event whenever any root reports changes,
  // which triggers the sync provider to pick up new / deleted files.
  const { fileSystemAdapter } = useAdapters();

  const watcherRoots = useMemo(
    () =>
      coreApi.rootDirectoryHandles.map((handle) => ({
        rootId: coreApi.rootIdByPath.get(handle.path) ?? handle.path,
        handle,
      })),
    [coreApi.rootDirectoryHandles, coreApi.rootIdByPath]
  );

  // Debounce timer for the refresh event dispatch. Held in a ref so the
  // timer identity never drives re-renders and the callback closure always
  // sees the same ref object without needing it in deps.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced watcher callback: 300ms trailing. Multiple rapid change
  // notifications from the same or different roots collapse into a single
  // FILE_EXPLORER_REFRESH_EVENT dispatch, preventing redundant tree reloads
  // during a burst of file-system activity (e.g. a build writing many files).
  const handleWatcherChanges = useCallback((_rootId: string): void => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      window.dispatchEvent(new CustomEvent(FILE_EXPLORER_REFRESH_EVENT));
    }, 300);
  }, []);

  // Clear any pending debounced dispatch on unmount to avoid dispatching after
  // the component has been torn down.
  // biome-ignore lint/plugin: cleanup-only effect; not state-as-event-handler
  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    },
    []
  );

  useFileSystemWatcher({
    adapter: fileSystemAdapter,
    roots: watcherRoots,
    onChanges: handleWatcherChanges,
  });

  // Memoize the return object with stable primitive/reference dependencies only
  // Functions are recreated each render but the object identity changes only when
  // the actual data values change
  return useMemo(
    () => ({
      rootDirectoryHandle: storedRootDirectoryHandle ?? coreApi.rootDirectoryHandle,
      /** All active root handles (multi-root, Phase 4+). */
      rootDirectoryHandles: coreApi.rootDirectoryHandles,
      isAccessLoading: coreApi.isAccessLoading,
      selectRootDirectory,
      isFileSystemAccessSupported,
      clearRootDirectory,
      setRootDirectoryHandle: setRootHandle,
      setAccessLoading: coreApi.setAccessLoading,
      /** Add an additional root directory (multi-root, Phase 4+). */
      addRootDirectory: coreApi.addRootDirectory,
      /** Register every handle restored by the restore banner (multi-root, Phase 4+). */
      registerRestoredHandles,
      /** Disconnect a root by RootId (multi-root, Phase 5). Indexed data is kept. */
      removeRootDirectory,
      /** Switch focused root to the given path (multi-root, Phase 4+). */
      setFocusedRoot: coreApi.setFocusedRoot,
      /**
       * Maps handle.path → RootId UUID (storage v5).
       * Consumers use this to resolve the durable identity for a given handle path.
       */
      rootIdByPath: coreApi.rootIdByPath,
    }),
    // Only depend on data values, not functions - functions are stable closures
    // that reference the latest values through the closure scope
    [
      storedRootDirectoryHandle,
      coreApi.rootDirectoryHandle,
      coreApi.rootDirectoryHandles,
      coreApi.isAccessLoading,
      coreApi.rootIdByPath,
    ]
  );
}
