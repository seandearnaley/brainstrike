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
import type { FileSystemChange } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useOptionalTokenCacheContext } from '../indexing/token-cache-context';
import { INJECT_ROOT_HANDLE_EVENT, type InjectRootHandleDetail } from '../inject-root-handle-event';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { createFileExplorerRefreshEvent } from './file-explorer-refresh-event';
import { useOptionalRootDataDeletion } from './root-data-deletion-context';

const logger = createLogger('FileSystemContext');

/** Trailing debounce for watcher-change dispatches. */
const WATCHER_DISPATCH_DEBOUNCE_MS = 300;
/**
 * Hard bound on how long pending watcher changes can accumulate: a
 * continuously-busy root resets the trailing window on every batch, so
 * without this cap nothing would ever dispatch while a build keeps writing.
 */
const WATCHER_DISPATCH_MAX_WAIT_MS = 1000;

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
  dialogFailed: 'Could not open the folder selection dialog. Please try again.',
  directoryAccessFailed:
    'Cannot access the selected directory. Please ensure you have proper access permissions.',
  directoryReadFailed:
    'Cannot read the selected directory. Please ensure you have proper access permissions.',
  genericError: 'An unexpected error occurred while selecting the directory.',
  permissionDenied:
    'Permission denied: Unable to access the selected directory. Please check folder permissions and try again.',
} as const satisfies Record<string, string>;

// Error mapping configuration
const ERROR_PATTERNS = [
  { message: ERROR_MESSAGES.permissionDenied, pattern: /Permission denied/i },
  {
    message: ERROR_MESSAGES.dialogFailed,
    pattern: /Unable to open directory selection dialog|Failed to open directory dialog/i,
  },
  {
    message: ERROR_MESSAGES.directoryReadFailed,
    pattern: /Unable to read the selected directory/i,
  },
  {
    message: ERROR_MESSAGES.directoryAccessFailed,
    pattern: /Cannot access selected directory/i,
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

/**
 * The file-system INSTANCE hook — owns root handle state, watchers, and
 * restore side effects. MUST be mounted exactly once via FileSystemProvider
 * (file-system-provider.tsx): every call creates an independent handle list,
 * and two instances silently diverge the moment a root is added mid-session
 * (the historical bug: Add Folder updated the explorer's instance while the
 * background-indexing provider's instance never learned the new root, so the
 * indexer stayed idle until the next app launch re-restored every instance).
 * Consumers use useFileSystem() below, which reads the shared instance.
 */
export function useFileSystemInstance() {
  const store = useFileExplorerStoreContext();
  const setCurrentFolderId = useFileExplorerStoreSelector((s) => s.setCurrentFolderId);
  const hydrateFolderState = useFileExplorerStoreSelector((s) => s.hydrateFolderState);
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
    addActiveRoot,
    getFolderAccessOrder,
    getPersistedCurrentFolderId,
    removeActiveRoot,
    setActiveRoots,
    setCurrentFolderId,
    waitForHydration,
  });

  const isFileSystemAccessSupported = coreApi.isFileSystemAccessSupported;

  const selectRootDirectory = async (): Promise<DirectoryHandle | null> => {
    const handle = await selectDirectoryWithErrorMapping(coreApi);
    if (handle) {
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
    // The core hook performs the snapshot → focus-shift → store-purge sequence
    // internally; the reducer is the sole handle owner, so there is no store
    // handle to sync here (B3: the redundant second focus-write is dropped).
    await coreApi.removeRootDirectory(rootId);
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
    if (handle) {
      // v5: prefer the RootId UUID from the store after coreApi has updated currentFolderId.
      // Fall back to handle.path for legacy paths that still write the path as currentFolderId.
      const rootId = store.getState().currentFolderId ?? handle.path;
      rehydrateCurrentFolderStateIfNeeded(rootId);
    }
  };

  // Non-React fixture-injection bridge: the inline-fixture subscription runs
  // outside React and dispatches brainstrike:inject-root-handle (it cannot reach
  // the React-only reducer). Route it through the same reducer path a real
  // set-root uses; mode 'add' appends an additional root instead (multi-root
  // fixture harness — never persisted). Refs keep the listener subscribed ONCE —
  // the handlers are recreated every render.
  const setRootHandleRef = useRef(setRootHandle);
  setRootHandleRef.current = setRootHandle;
  const clearRootDirectoryRef = useRef(clearRootDirectory);
  clearRootDirectoryRef.current = clearRootDirectory;
  const addExternalRootHandleRef = useRef(coreApi.addExternalRootHandle);
  addExternalRootHandleRef.current = coreApi.addExternalRootHandle;
  useEffect(() => {
    const onInject = (event: Event): void => {
      const detail = (event as CustomEvent<InjectRootHandleDetail>).detail;
      if (!detail?.handle) {
        clearRootDirectoryRef.current();
        return;
      }
      if (detail.mode === 'add') {
        addExternalRootHandleRef.current(detail.handle);
        return;
      }
      setRootHandleRef.current(detail.handle);
    };
    window.addEventListener(INJECT_ROOT_HANDLE_EVENT, onInject);
    return () => window.removeEventListener(INJECT_ROOT_HANDLE_EVENT, onInject);
  }, []);

  // On auto-restore (desktop) the core hook restores a handle and sets
  // currentFolderId; rehydrate the restored folder's persisted selection/expansion
  // once. The reducer is the sole handle owner — there is no store handle to sync.
  const hasRehydratedRestoredRootRef = useRef(false);
  // biome-ignore lint/plugin: one-time rehydrate of the auto-restored root's folder state
  useLayoutEffect(() => {
    if (!hasRehydratedRestoredRootRef.current && coreApi.rootDirectoryHandle) {
      hasRehydratedRestoredRootRef.current = true;
      const rootId = store.getState().currentFolderId ?? coreApi.rootDirectoryHandle.path;
      rehydrateCurrentFolderStateIfNeeded(rootId);
    }
  }, [coreApi.rootDirectoryHandle, rehydrateCurrentFolderStateIfNeeded, store]);

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
        handle,
        // Prefer the stamped handle.rootId — the path→id map collides for
        // same-named web roots.
        rootId: handle.rootId ?? coreApi.rootIdByPath.get(handle.path) ?? handle.path,
      })),
    [coreApi.rootDirectoryHandles, coreApi.rootIdByPath]
  );

  // Debounce timer for the refresh event dispatch. Held in a ref so the
  // timer identity never drives re-renders and the callback closure always
  // sees the same ref object without needing it in deps.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watcherRootMetadataRef = useRef<Map<string, { rootId: string; rootPath: string }>>(
    new Map()
  );
  const pendingRefreshRootsRef = useRef<
    Map<
      string,
      {
        rootId: string;
        rootPath: string;
        changes: FileSystemChange[];
      }
    >
  >(new Map());

  const prunePendingRefreshRoots = useCallback((activeRootIds: ReadonlySet<string>): void => {
    const pendingRoots = pendingRefreshRootsRef.current;
    for (const rootId of Array.from(pendingRoots.keys())) {
      if (!activeRootIds.has(rootId)) {
        pendingRoots.delete(rootId);
      }
    }
    if (pendingRoots.size === 0 && refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  // Keep active watcher metadata and pending refresh payloads in lockstep with
  // the active roots. This effect intentionally runs before useFileSystemWatcher
  // below, so watcher disposal flushes observe the pruned metadata.
  useEffect(() => {
    const nextMetadata = new Map(
      watcherRoots.map((root) => [
        root.rootId,
        {
          rootId: root.rootId,
          rootPath: root.handle.path,
        },
      ])
    );
    watcherRootMetadataRef.current = nextMetadata;
    prunePendingRefreshRoots(new Set(nextMetadata.keys()));
  }, [prunePendingRefreshRoots, watcherRoots]);

  // First-pending timestamp for the max-wait bound (null = nothing pending).
  const firstPendingAtRef = useRef<number | null>(null);

  // Debounced watcher callback: 300ms trailing with a 1s max-wait. Multiple
  // rapid change notifications from the same or different roots collapse into
  // a single FILE_EXPLORER_REFRESH_EVENT dispatch, preventing redundant tree
  // reloads during a burst of file-system activity. The max-wait bound keeps a
  // continuously-busy root (a build writing every <300ms) from resetting the
  // trailing window forever and starving every root's refresh.
  const flushPendingWatcherChanges = useCallback((): void => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    firstPendingAtRef.current = null;
    prunePendingRefreshRoots(new Set(watcherRootMetadataRef.current.keys()));
    const roots = Array.from(pendingRefreshRootsRef.current.values()).map((root) => ({
      changes: root.changes,
      rootId: root.rootId,
      rootPath: root.rootPath,
    }));
    pendingRefreshRootsRef.current.clear();
    if (roots.length === 0) {
      return;
    }
    window.dispatchEvent(
      createFileExplorerRefreshEvent({
        roots,
        scope: 'incremental',
        source: 'watcher',
      })
    );
  }, [prunePendingRefreshRoots]);

  const handleWatcherChanges = useCallback(
    (rootId: string, changes: FileSystemChange[]): void => {
      const watcherRoot = watcherRootMetadataRef.current.get(rootId);
      if (!watcherRoot) {
        return;
      }

      const pendingRoots = pendingRefreshRootsRef.current;
      const pendingRoot = pendingRoots.get(rootId);
      if (pendingRoot) {
        pendingRoot.changes.push(...changes);
      } else {
        pendingRoots.set(rootId, {
          changes: [...changes],
          rootId,
          rootPath: watcherRoot.rootPath,
        });
      }

      const now = Date.now();
      if (firstPendingAtRef.current === null) {
        firstPendingAtRef.current = now;
      } else if (now - firstPendingAtRef.current >= WATCHER_DISPATCH_MAX_WAIT_MS) {
        flushPendingWatcherChanges();
        return;
      }

      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = setTimeout(
        flushPendingWatcherChanges,
        WATCHER_DISPATCH_DEBOUNCE_MS
      );
    },
    [flushPendingWatcherChanges]
  );

  // Clear any pending debounced dispatch on unmount to avoid dispatching after
  // the component has been torn down.
  // biome-ignore lint/plugin: cleanup-only effect; not state-as-event-handler
  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
      pendingRefreshRootsRef.current.clear();
    },
    []
  );

  useFileSystemWatcher({
    adapter: fileSystemAdapter,
    onChanges: handleWatcherChanges,
    roots: watcherRoots,
  });

  // Memoize the return object with stable primitive/reference dependencies only
  // Functions are recreated each render but the object identity changes only when
  // the actual data values change
  return useMemo(
    () => ({
      /** Add an additional root directory (multi-root, Phase 4+). */
      addRootDirectory: coreApi.addRootDirectory,
      clearRootDirectory,
      isAccessLoading: coreApi.isAccessLoading,
      isFileSystemAccessSupported,
      /** Register every handle restored by the restore banner (multi-root, Phase 4+). */
      registerRestoredHandles,
      /** Disconnect a root by RootId (multi-root, Phase 5). Indexed data is kept. */
      removeRootDirectory,
      rootDirectoryHandle: coreApi.rootDirectoryHandle,
      /** All active root handles (multi-root, Phase 4+). */
      rootDirectoryHandles: coreApi.rootDirectoryHandles,
      /**
       * Maps handle.path → RootId UUID (storage v5).
       * Consumers use this to resolve the durable identity for a given handle path.
       */
      rootIdByPath: coreApi.rootIdByPath,
      selectRootDirectory,
      setAccessLoading: coreApi.setAccessLoading,
      /** Switch focused root to the given path (multi-root, Phase 4+). */
      setFocusedRoot: coreApi.setFocusedRoot,
      setRootDirectoryHandle: setRootHandle,
    }),
    // Only depend on data values, not functions - functions are stable closures
    // that reference the latest values through the closure scope
    [
      coreApi.rootDirectoryHandle,
      coreApi.rootDirectoryHandles,
      coreApi.isAccessLoading,
      coreApi.rootIdByPath,
    ]
  );
}
