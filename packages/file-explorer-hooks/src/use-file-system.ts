import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileExplorerState, RootDescriptor, StoredRootDescriptor } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useAdapters } from './adapters-context';
import { isUserCancellation, mapFileSystemError } from './file-system-error-helpers';

const logger = createLogger('FileSystemHook');

interface UseFileSystemParams {
  /**
   * Store action to append a single root (deduped by rootId).
   * Called by addRootDirectory on success (only when descriptor.persisted is true).
   */
  addActiveRoot?: FileExplorerState['addActiveRoot'];
  /**
   * Optional getter for the store's folderAccessOrder array.
   * Used during restoreRoots boot to determine which root to focus.
   */
  getFolderAccessOrder?: () => readonly string[];
  /**
   * Optional getter for the store's persisted currentFolderId.
   * Used during auto-restore to avoid redundant setCurrentFolderId calls
   * when the folder ID matches what will be hydrated from persistence.
   */
  getPersistedCurrentFolderId?: () => string | null;
  /**
   * Store action to replace all active roots atomically.
   * Called during restoreRoots boot.
   */
  setActiveRoots?: FileExplorerState['setActiveRoots'];
  setCurrentFolderId: FileExplorerState['setCurrentFolderId'];
  /**
   * Optional callback to check if store has finished hydrating from persistence.
   * When provided, the auto-restore effect will wait for hydration before calling
   * setCurrentFolderId, preventing race conditions where empty initial state
   * overwrites persisted selections.
   */
  waitForHydration?: () => Promise<void>;
}

interface FileSystemState {
  isAccessLoading: boolean;
  rootDirectoryHandle: DirectoryHandle | null;
  /** All active roots (ordered). rootDirectoryHandle is always in this list (or null when empty). */
  rootDirectoryHandles: DirectoryHandle[];
  /** Maps handle.path → rootId for handles added via addRoot/restoreRoots descriptors. */
  rootIdByPath: Map<string, string>;
}

type FileSystemAction =
  | { type: 'setRoot'; handle: DirectoryHandle | null }
  | { type: 'setAccessLoading'; loading: boolean }
  | { type: 'addOrFocusHandle'; handle: DirectoryHandle; rootId?: string }
  | {
      type: 'setAllHandles';
      handles: DirectoryHandle[];
      rootIdByPath: Map<string, string>;
      focused: DirectoryHandle | null;
    };

function getCanonicalFolderId(handle: DirectoryHandle): string {
  if (!handle.path) {
    throw new Error('Directory handle is missing its canonical path');
  }
  return handle.path;
}

function reducer(state: FileSystemState, action: FileSystemAction): FileSystemState {
  switch (action.type) {
    case 'setRoot': {
      // null clears everything (legacy clear semantics).
      if (action.handle === null) {
        return {
          ...state,
          rootDirectoryHandle: null,
          rootDirectoryHandles: [],
          rootIdByPath: new Map<string, string>(),
        };
      }
      // INVARIANT: rootDirectoryHandle must always be a member of
      // rootDirectoryHandles. Non-null setRoot therefore uses
      // addOrFocusHandle semantics: append when missing, focus always.
      const handle = action.handle;
      const alreadyListed = state.rootDirectoryHandles.some((h) => h.path === handle.path);
      return {
        ...state,
        rootDirectoryHandle: handle,
        rootDirectoryHandles: alreadyListed
          ? state.rootDirectoryHandles
          : [...state.rootDirectoryHandles, handle],
      };
    }
    case 'setAccessLoading':
      return { ...state, isAccessLoading: action.loading };
    case 'addOrFocusHandle': {
      const exists = state.rootDirectoryHandles.some((h) => h.path === action.handle.path);
      const newHandles = exists
        ? state.rootDirectoryHandles
        : [...state.rootDirectoryHandles, action.handle];
      const newRootIdByPath = action.rootId
        ? new Map([...state.rootIdByPath, [action.handle.path, action.rootId]])
        : state.rootIdByPath;
      return {
        ...state,
        rootDirectoryHandle: action.handle,
        rootDirectoryHandles: newHandles,
        rootIdByPath: newRootIdByPath,
      };
    }
    case 'setAllHandles':
      return {
        ...state,
        rootDirectoryHandles: action.handles,
        rootDirectoryHandle: action.focused,
        rootIdByPath: action.rootIdByPath,
      };
    default:
      return state;
  }
}

/** Params bag threaded into the module-level multi-root restore helper. */
interface MultiRootRestoreParams {
  cancelledRef: { value: boolean };
  dispatch: (action: FileSystemAction) => void;
  getFolderAccessOrderRef: { current: (() => readonly string[]) | undefined };
  // Use explicit union (not ?) to satisfy exactOptionalPropertyTypes.
  getPersistedCurrentFolderId: (() => string | null) | undefined;
  hasAttemptedRestoreRef: { current: boolean };
  isRestoringRef: { current: boolean };
  restoreRoots: () => Promise<RootDescriptor[]>;
  setActiveRootsRef: { current: FileExplorerState['setActiveRoots'] | undefined };
  updateCurrentFolderId: (id: string | null) => void;
  // Use explicit union (not ?) to satisfy exactOptionalPropertyTypes.
  waitForHydration: (() => Promise<void>) | undefined;
}

/**
 * Module-level async helper for the multi-root restore branch.
 * Extracted to keep `useFileSystem` complexity within lint limits.
 */
async function runMultiRootRestore({
  cancelledRef,
  dispatch,
  getFolderAccessOrderRef,
  getPersistedCurrentFolderId,
  hasAttemptedRestoreRef,
  isRestoringRef,
  restoreRoots,
  setActiveRootsRef,
  updateCurrentFolderId,
  waitForHydration,
}: MultiRootRestoreParams): Promise<void> {
  try {
    const allDescriptors = await restoreRoots();
    if (cancelledRef.value || !allDescriptors) {
      return;
    }

    // Only restore granted roots; non-granted shown via the restore banner (Task 3).
    const granted = allDescriptors.filter((d) => d.permissionState === 'granted');
    if (granted.length === 0) {
      return;
    }

    if (waitForHydration) {
      await waitForHydration();
    }
    if (cancelledRef.value) {
      return;
    }

    const handles = granted.map((d) => d.handle);
    const newRootIdByPath = new Map<string, string>(granted.map((d) => [d.handle.path, d.rootId]));

    // Focus: first handle whose path appears in folderAccessOrder; else first handle.
    // Accessed via ref to avoid making getFolderAccessOrder a reactive dep.
    const accessOrder = getFolderAccessOrderRef.current?.() ?? [];
    const focused =
      accessOrder.reduce<DirectoryHandle | null>((acc, p) => {
        if (acc) {
          return acc;
        }
        return handles.find((h) => h.path === p) ?? null;
      }, null) ??
      handles[0] ??
      null;

    dispatch({ type: 'setAllHandles', handles, rootIdByPath: newRootIdByPath, focused });

    if (focused) {
      const focusedPath = getCanonicalFolderId(focused);
      if (getPersistedCurrentFolderId?.() !== focusedPath) {
        updateCurrentFolderId(focusedPath);
      }
    }

    // Register persisted roots in the store. Accessed via ref to avoid reactive dep.
    const setActiveRootsCurrent = setActiveRootsRef.current;
    if (typeof setActiveRootsCurrent === 'function') {
      const storedDescriptors: StoredRootDescriptor[] = granted
        .filter((d) => d.persisted)
        .map((d) => ({ displayName: d.displayName, path: d.handle.path, rootId: d.rootId }));
      setActiveRootsCurrent(storedDescriptors);
    }
  } catch (error) {
    if (!cancelledRef.value) {
      logger.warn('Failed to restore roots', { error });
    }
  } finally {
    if (!cancelledRef.value) {
      hasAttemptedRestoreRef.current = true;
      dispatch({ type: 'setAccessLoading', loading: false });
    }
    isRestoringRef.current = false;
  }
}

export function useFileSystem({
  setCurrentFolderId,
  waitForHydration,
  getPersistedCurrentFolderId,
  getFolderAccessOrder,
  addActiveRoot,
  setActiveRoots,
}: UseFileSystemParams) {
  const { fileSystemAdapter } = useAdapters();

  const [{ rootDirectoryHandle, rootDirectoryHandles, isAccessLoading, rootIdByPath }, dispatch] =
    useReducer(reducer, {
      rootDirectoryHandle: null,
      rootDirectoryHandles: [],
      isAccessLoading: false,
      rootIdByPath: new Map<string, string>(),
    });

  const hasAttemptedRestoreRef = useRef(false);
  const isRestoringRef = useRef(false);
  // Stable refs for callbacks that must be fresh at call time but should not
  // trigger effect re-runs (avoids infinite loops from unstable inline fn refs).
  const getFolderAccessOrderRef = useRef(getFolderAccessOrder);
  getFolderAccessOrderRef.current = getFolderAccessOrder;
  const setActiveRootsRef = useRef(setActiveRoots);
  setActiveRootsRef.current = setActiveRoots;

  const updateCurrentFolderId = useCallback(
    (folderId: string | null) => {
      if (typeof setCurrentFolderId === 'function') {
        setCurrentFolderId(folderId);
      } else {
        logger.warn('setCurrentFolderId is unavailable; skipping folder id update', { folderId });
      }
    },
    [setCurrentFolderId]
  );

  const isFileSystemAccessSupported = useCallback((): { supported: boolean; reason: string } => {
    const hasWebAPI =
      typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
    const hasAdapterAPI = typeof fileSystemAdapter?.requestDirectoryAccess === 'function';
    if (hasWebAPI || hasAdapterAPI) {
      return { supported: true, reason: '' };
    }
    return { supported: false, reason: 'File system access not supported in this environment' };
  }, [fileSystemAdapter]);

  /**
   * Add a new root directory (multi-root aware).
   * Prefers adapter.addRoot() when available; falls back to requestDirectoryAccess().
   * On success: appends handle (dedupes by path), sets it as focused, calls store
   * actions (addActiveRoot when persisted=true), and updates currentFolderId.
   * Returns the new (or re-focused) handle, or null if the user cancelled.
   */
  const addRootDirectory = useCallback(async (): Promise<DirectoryHandle | null> => {
    const { supported, reason } = isFileSystemAccessSupported();
    if (!supported) {
      throw new Error(reason);
    }
    dispatch({ type: 'setAccessLoading', loading: true });
    try {
      if (
        typeof (fileSystemAdapter as { addRoot?: () => Promise<RootDescriptor> }).addRoot ===
        'function'
      ) {
        // Multi-root adapter API path
        const adapterWithAddRoot = fileSystemAdapter as { addRoot: () => Promise<RootDescriptor> };
        const descriptor = await adapterWithAddRoot.addRoot();
        const { handle, rootId, displayName, persisted } = descriptor;
        dispatch({ type: 'addOrFocusHandle', handle, rootId });
        updateCurrentFolderId(getCanonicalFolderId(handle));
        // Only register in the persistent store when the handle was actually persisted
        if (persisted && typeof addActiveRoot === 'function') {
          addActiveRoot({ displayName, path: getCanonicalFolderId(handle), rootId });
        }
        return handle;
      }
      // Legacy fallback: requestDirectoryAccess → synthetic descriptor
      const handle = await fileSystemAdapter.requestDirectoryAccess();
      const rootId = crypto.randomUUID();
      dispatch({ type: 'addOrFocusHandle', handle, rootId });
      updateCurrentFolderId(getCanonicalFolderId(handle));
      if (typeof addActiveRoot === 'function') {
        addActiveRoot({ displayName: handle.name, path: getCanonicalFolderId(handle), rootId });
      }
      return handle;
    } catch (error) {
      if (isUserCancellation(error)) {
        return null;
      }
      throw mapFileSystemError(error);
    } finally {
      dispatch({ type: 'setAccessLoading', loading: false });
    }
  }, [fileSystemAdapter, isFileSystemAccessSupported, updateCurrentFolderId, addActiveRoot]);

  /**
   * Legacy API: delegates to addRootDirectory for backward compatibility.
   * Existing consumers keep working unchanged; return type preserved.
   */
  const selectRootDirectory = useCallback(
    async (): Promise<DirectoryHandle | null> => addRootDirectory(),
    [addRootDirectory]
  );

  /**
   * Switch focus to an already-loaded root by path.
   * No-op if the path is not found in the current handles list.
   */
  const setFocusedRoot = useCallback(
    (path: string) => {
      const match = rootDirectoryHandles.find((h) => h.path === path);
      if (!match) {
        logger.debug('setFocusedRoot: unknown path, ignoring', { path });
        return;
      }
      dispatch({ type: 'addOrFocusHandle', handle: match });
      updateCurrentFolderId(path);
    },
    [rootDirectoryHandles, updateCurrentFolderId]
  );

  /**
   * Register handles restored via the restore-access flow (multi-root).
   * EVERY handle is appended to rootDirectoryHandles (deduped by path) and
   * registered in the store via addActiveRoot. RootId identity source: the
   * adapter's restoreRoots() descriptors (rootId+path, queryPermission-only
   * so safe to re-call), matched by handle path; synthetic uuid fallback when
   * no descriptor matches. handles[0] becomes the focused root.
   */
  const registerRestoredHandles = useCallback(
    async (handles: readonly DirectoryHandle[]): Promise<void> => {
      if (handles.length === 0) {
        return;
      }

      let adapterRootIdByPath = new Map<string, string>();
      const adapterWithRestoreRoots = fileSystemAdapter as {
        restoreRoots?: () => Promise<RootDescriptor[]>;
      };
      if (typeof adapterWithRestoreRoots.restoreRoots === 'function') {
        try {
          const descriptors = await adapterWithRestoreRoots.restoreRoots.call(fileSystemAdapter);
          adapterRootIdByPath = new Map(descriptors.map((d) => [d.handle.path, d.rootId]));
        } catch (error) {
          logger.warn('registerRestoredHandles: failed to read adapter root descriptors', {
            error,
          });
        }
      }

      for (const handle of handles) {
        const rootId = adapterRootIdByPath.get(handle.path) ?? crypto.randomUUID();
        dispatch({ type: 'addOrFocusHandle', handle, rootId });
        if (typeof addActiveRoot === 'function') {
          addActiveRoot({
            displayName: handle.name,
            path: getCanonicalFolderId(handle),
            rootId,
          });
        }
      }

      // The registration loop leaves the LAST handle focused; re-focus the first.
      const first = handles[0];
      if (first) {
        dispatch({ type: 'addOrFocusHandle', handle: first });
        updateCurrentFolderId(getCanonicalFolderId(first));
      }
    },
    [fileSystemAdapter, addActiveRoot, updateCurrentFolderId]
  );

  const clearRootDirectory = useCallback(() => {
    dispatch({ type: 'setRoot', handle: null });
    updateCurrentFolderId(null);
  }, [updateCurrentFolderId]);

  /**
   * Set root directory handle from external source (e.g., restore banner).
   * This allows the useRestoreAccess hook to update the root handle after
   * successful permission restoration.
   */
  const setRootDirectoryHandle = useCallback(
    (handle: DirectoryHandle | null) => {
      dispatch({ type: 'setRoot', handle });
      if (handle) {
        updateCurrentFolderId(getCanonicalFolderId(handle));
      } else {
        updateCurrentFolderId(null);
      }
    },
    [updateCurrentFolderId]
  );

  /**
   * Set the access loading state.
   * Used by restore flow to signal that a restore is in progress, which
   * prevents the stale state clearing effect from clearing expanded paths
   * while waiting for browser permission dialog.
   */
  const setAccessLoading = useCallback((loading: boolean) => {
    dispatch({ type: 'setAccessLoading', loading });
  }, []);

  const applyRestoredFolderState = useCallback(
    async (restored: DirectoryHandle, isCancelled: () => boolean) => {
      if (isCancelled()) {
        return;
      }
      // CRITICAL: Wait for store hydration before calling setCurrentFolderId.
      // Without this, the store may still have empty initial state, and
      // setCurrentFolderId would read from the empty folderStates, overwriting
      // the persisted selections that are about to be hydrated.
      if (waitForHydration) {
        await waitForHydration();
      }
      if (isCancelled()) {
        return;
      }
      dispatch({ type: 'setRoot', handle: restored });
      const restoredFolderId = getCanonicalFolderId(restored);

      // Check if the persisted currentFolderId already matches.
      // If so, skip calling setCurrentFolderId to avoid triggering the
      // folder-switching logic which would read from stale folderStates.
      const persistedFolderId = getPersistedCurrentFolderId?.();
      if (persistedFolderId === restoredFolderId) {
        logger.debug('Skipping setCurrentFolderId - folder already matches persisted state', {
          folderId: restoredFolderId,
        });
      } else {
        updateCurrentFolderId(restoredFolderId);
      }
    },
    [getPersistedCurrentFolderId, updateCurrentFolderId, waitForHydration]
  );

  // Auto-restore on startup. Runs once and never changes hook order.
  // Branch A: adapter has restoreRoots → restore ALL granted roots (multi-root).
  // Branch B: adapter has restoreLastFolder only → legacy single-root path.
  useEffect(() => {
    if (hasAttemptedRestoreRef.current || rootDirectoryHandle || isRestoringRef.current) {
      return;
    }

    const adapterWithRestoreRoots = fileSystemAdapter as {
      restoreRoots?: () => Promise<RootDescriptor[]>;
    };

    // --- Branch A: multi-root restore ---
    if (typeof adapterWithRestoreRoots.restoreRoots === 'function') {
      isRestoringRef.current = true;
      dispatch({ type: 'setAccessLoading', loading: true });
      // Use a mutable object so the cleanup closure can signal cancellation.
      const cancelledRef = { value: false };
      void runMultiRootRestore({
        cancelledRef,
        dispatch,
        getFolderAccessOrderRef,
        getPersistedCurrentFolderId,
        hasAttemptedRestoreRef,
        isRestoringRef,
        // BIND: the web adapter's restoreRoots reads this.handleCache — an
        // unbound reference would lose `this` and throw at call time.
        restoreRoots: adapterWithRestoreRoots.restoreRoots.bind(fileSystemAdapter),
        setActiveRootsRef,
        updateCurrentFolderId,
        waitForHydration,
      });
      return () => {
        cancelledRef.value = true;
        isRestoringRef.current = false;
      };
    }

    // --- Branch B: legacy single-root restore ---
    if (typeof fileSystemAdapter.restoreLastFolder !== 'function') {
      return;
    }

    // CRITICAL: Set loading state SYNCHRONOUSLY before starting async operation.
    // This prevents race conditions where other effects (like stale state clearing)
    // might see isAccessLoading=false and rootDirectoryHandle=null before the
    // restore completes, causing them to incorrectly clear persisted state.
    isRestoringRef.current = true;
    dispatch({ type: 'setAccessLoading', loading: true });

    let cancelled = false;

    const run = async () => {
      try {
        const restoreFn = (
          fileSystemAdapter as { restoreLastFolder?: () => Promise<DirectoryHandle | null> }
        ).restoreLastFolder;
        if (!restoreFn) {
          return;
        }
        // BIND: same unbound-method hazard as restoreRoots above.
        const restored = await restoreFn.call(fileSystemAdapter);
        if (!restored || cancelled) {
          return;
        }
        await applyRestoredFolderState(restored, () => cancelled);
      } catch (error) {
        if (!cancelled) {
          logger.warn('Failed to restore last folder', { error });
        }
      } finally {
        if (!cancelled) {
          // Mark as attempted only after a non-cancelled completion.
          // This allows retries when a run is cancelled (e.g. effect preflight cleanup).
          hasAttemptedRestoreRef.current = true;
          dispatch({ type: 'setAccessLoading', loading: false });
        }
        isRestoringRef.current = false;
      }
    };
    void run();
    return () => {
      cancelled = true;
      isRestoringRef.current = false;
    };
  }, [
    fileSystemAdapter,
    rootDirectoryHandle,
    updateCurrentFolderId,
    applyRestoredFolderState,
    waitForHydration,
    getPersistedCurrentFolderId,
    // NOTE: getFolderAccessOrder and setActiveRoots are intentionally omitted from
    // deps to avoid infinite re-runs from unstable inline function references.
    // They are accessed via refs (getFolderAccessOrderRef / setActiveRootsRef)
    // which are updated on every render but don't trigger effect re-execution.
  ]);

  return useMemo(
    () => ({
      rootDirectoryHandle,
      rootDirectoryHandles,
      rootIdByPath,
      isAccessLoading,
      addRootDirectory,
      registerRestoredHandles,
      selectRootDirectory,
      setFocusedRoot,
      isFileSystemAccessSupported,
      clearRootDirectory,
      setRootDirectoryHandle,
      setAccessLoading,
    }),
    [
      rootDirectoryHandle,
      rootDirectoryHandles,
      rootIdByPath,
      isAccessLoading,
      addRootDirectory,
      registerRestoredHandles,
      selectRootDirectory,
      setFocusedRoot,
      isFileSystemAccessSupported,
      clearRootDirectory,
      setRootDirectoryHandle,
      setAccessLoading,
    ]
  );
}
