import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type { FileExplorerState, RootDescriptor, StoredRootDescriptor } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useAdapters } from './adapters-context.js';
import { isUserCancellation, mapFileSystemError } from './file-system-error-helpers.js';

const logger = createLogger('FileSystemHook');

interface UseFileSystemParams {
  /**
   * Store action to append a single root (deduped by rootId).
   * Called by addRootDirectory on success (only when descriptor.persisted is true).
   * REQUIRED: a missing action would silently desync the reducer's handle list
   * from the store's descriptors (ghost root on reload) — no silent no-ops.
   */
  addActiveRoot: FileExplorerState['addActiveRoot'];
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
   * Store action to atomically purge a disconnected root from
   * activeRootIds/rootDescriptors/folderStates/folderAccessOrder.
   * Called by removeRootDirectory AFTER the focus shift (setCurrentFolderId
   * snapshots the outgoing folder's state back into folderStates, so the
   * purge must come last). REQUIRED — see addActiveRoot.
   */
  removeActiveRoot: FileExplorerState['removeActiveRoot'];
  /**
   * Store action to replace all active roots atomically.
   * Called during restoreRoots boot. REQUIRED — see addActiveRoot.
   */
  setActiveRoots: FileExplorerState['setActiveRoots'];
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
  /** Monotonic signal that a supported flow may have mutated Recents. */
  recentRootsRevision: number;
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
  | { type: 'removeHandle'; rootId: string }
  | { type: 'recordRecentRootMutation' }
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

/**
 * True only in development/test builds (Vite's DEV flag, which Vitest also sets).
 * Gates the fail-loud throw on an unstamped root handle so dev/CI surface the bug
 * immediately while production degrades safely. Guarded so a non-Vite context
 * (where import.meta.env is absent) can never throw here.
 */
function isDevBuild(): boolean {
  try {
    // Record cast (matching @brainstrike/utils isDevEnv) avoids a named-property
    // type literal so the linter's naming-convention rule doesn't flag Vite's DEV.
    return (import.meta as { env?: Record<string, unknown> }).env?.['DEV'] === true;
  } catch {
    return false;
  }
}

/**
 * Canonical identity for a root handle: the durable RootId, full stop. The forest
 * is keyed by rootId alone so two same-named web roots (identical `path` = bare
 * directory name) stay distinct. Every root source stamps a rootId at its boundary
 * and `ensureStamped` guards the reducer entry, so an unstamped handle here is an
 * invariant violation — throw in dev to surface it; in production log loudly and
 * degrade to the path so a rare edge never crashes the explorer (loud, never silent).
 */
function rootKeyOf(handle: DirectoryHandle): string {
  if (handle.rootId !== undefined) {
    return handle.rootId;
  }
  if (isDevBuild()) {
    throw new Error(
      `rootKeyOf: root handle has no rootId (path=${handle.path}); stamp it at the source`
    );
  }
  logger.error('rootKeyOf received an unstamped handle; degrading to path', {
    path: handle.path,
  });
  return handle.path;
}

/**
 * Stamp the durable RootId onto a handle so it self-identifies downstream
 * (getRootFolderId, section keys, focus/remove). Returns the handle unchanged
 * when no rootId is supplied.
 */
function stampRootId(handle: DirectoryHandle, rootId: string | undefined): DirectoryHandle {
  return rootId ? { ...handle, rootId } : handle;
}

/**
 * Guarantee a root handle carries a durable rootId before it enters the reducer.
 * Every root source (web adapter/picker, restore descriptors, the inline fixture,
 * the restore modal) stamps at its boundary; this is the last line of defense.
 * Dev throws so a missed source is caught immediately; production logs a loud
 * error and recovers by minting a rootId so the user keeps working — never silent,
 * never a crash.
 */
function ensureStamped(handle: DirectoryHandle, source: string): DirectoryHandle {
  if (handle.rootId !== undefined) {
    return handle;
  }
  const detail = `unstamped root handle reached the reducer via ${source} (path=${handle.path}); every root source must stamp a rootId`;
  if (isDevBuild()) {
    throw new Error(`[useFileSystem] ${detail}`);
  }
  const mintedRootId = crypto.randomUUID();
  logger.error('Recovered an unstamped root handle with a minted rootId', {
    mintedRootId,
    path: handle.path,
    source,
  });
  return stampRootId(handle, mintedRootId);
}

/** Find a stored handle by its canonical rootId identity. No path fallback. */
function findHandleByIdentity(
  handles: readonly DirectoryHandle[],
  key: string
): DirectoryHandle | undefined {
  return handles.find((handle) => rootKeyOf(handle) === key);
}

/** Complete the authoritative adapter transition before changing renderer state. */
async function forgetRootInAdapter(adapter: unknown, rootId: string): Promise<void> {
  const adapterWithRemoveRoot = adapter as {
    removeRoot?: (rootId: string) => Promise<void>;
  };
  if (typeof adapterWithRemoveRoot.removeRoot !== 'function') {
    return;
  }
  await adapterWithRemoveRoot.removeRoot.call(adapter, rootId);
}

function reducer(state: FileSystemState, action: FileSystemAction): FileSystemState {
  switch (action.type) {
    case 'recordRecentRootMutation':
      return { ...state, recentRootsRevision: state.recentRootsRevision + 1 };
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
      // rootDirectoryHandles. Non-null setRoot therefore uses addOrFocusHandle
      // semantics: append when missing, focus always. The handle is stamped at
      // its source (the setRootDirectoryHandle funnel calls ensureStamped), so
      // identity is rootId-only — match the stored handle by its rootKey and
      // focus it so its identity is preserved.
      const handle = ensureStamped(action.handle, 'setRoot');
      const existing = findHandleByIdentity(state.rootDirectoryHandles, rootKeyOf(handle));
      return {
        ...state,
        rootDirectoryHandle: existing ?? handle,
        rootDirectoryHandles: existing
          ? state.rootDirectoryHandles
          : [...state.rootDirectoryHandles, handle],
      };
    }
    case 'setAccessLoading':
      return { ...state, isAccessLoading: action.loading };
    case 'addOrFocusHandle': {
      // Stamp the rootId so the stored handle self-identifies — keying by path
      // would collapse two same-named web roots into one entry. ensureStamped is
      // the fail-loud backstop: every caller must supply a rootId (on the handle
      // or via action.rootId). Identity is rootId-only — no path reconciliation,
      // because no unstamped handle can reach the reducer (every source stamps).
      const stamped = ensureStamped(stampRootId(action.handle, action.rootId), 'addOrFocusHandle');
      const key = rootKeyOf(stamped);
      const matchIndex = state.rootDirectoryHandles.findIndex((h) => rootKeyOf(h) === key);
      const newHandles =
        matchIndex >= 0
          ? // Replace in place so the matched entry picks up the stamped identity.
            state.rootDirectoryHandles.map((h, i) => (i === matchIndex ? stamped : h))
          : [...state.rootDirectoryHandles, stamped];
      const newRootIdByPath = action.rootId
        ? new Map([...state.rootIdByPath, [action.handle.path, action.rootId]])
        : state.rootIdByPath;
      return {
        ...state,
        rootDirectoryHandle: stamped,
        rootDirectoryHandles: newHandles,
        rootIdByPath: newRootIdByPath,
      };
    }
    case 'removeHandle': {
      // Match by canonical identity (rootId), never by path — same-named roots
      // share a path, so a path filter would remove the wrong one.
      const remaining = state.rootDirectoryHandles.filter((h) => rootKeyOf(h) !== action.rootId);
      const newRootIdByPath = new Map(state.rootIdByPath);
      for (const [path, mappedRootId] of state.rootIdByPath) {
        if (mappedRootId === action.rootId) {
          newRootIdByPath.delete(path);
        }
      }
      const wasFocused =
        state.rootDirectoryHandle !== null &&
        rootKeyOf(state.rootDirectoryHandle) === action.rootId;
      return {
        ...state,
        // Focus shift: when the removed root was focused, focus the first
        // remaining handle (or null when no roots remain).
        rootDirectoryHandle: wasFocused ? (remaining[0] ?? null) : state.rootDirectoryHandle,
        rootDirectoryHandles: remaining,
        rootIdByPath: newRootIdByPath,
      };
    }
    case 'setAllHandles':
      return {
        ...state,
        rootDirectoryHandle: action.focused,
        rootDirectoryHandles: action.handles,
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
  setActiveRootsRef: { current: FileExplorerState['setActiveRoots'] };
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
    // Desktop restoreRoots backfills the canonical Recents ledger before it
    // resolves. Publish only while this hook instance is still live and only
    // when at least one granted descriptor could have been recorded.
    if (granted.length > 0) {
      dispatch({ type: 'recordRecentRootMutation' });
    }

    if (waitForHydration) {
      await waitForHydration();
    }
    if (cancelledRef.value) {
      return;
    }

    // Stamp each handle with its durable RootId so it self-identifies (two
    // same-named web roots otherwise share a path and collapse into one).
    // ensureStamped is the fail-loud backstop: setAllHandles (below) stores
    // handles verbatim with no guard of its own, and stampRootId is a no-op on a
    // falsy/empty rootId — so a corrupt descriptor (rootId === '') would otherwise
    // land an unstamped handle silently. Catch it here at the boundary instead.
    const handles = granted.map((d) =>
      ensureStamped(stampRootId(d.handle, d.rootId), 'runMultiRootRestore')
    );
    const newRootIdByPath = new Map<string, string>(granted.map((d) => [d.handle.path, d.rootId]));

    // Focus: first handle whose identity appears in folderAccessOrder; else
    // first handle. folderAccessOrder stores currentFolderId — the RootId in v5,
    // so match by rootKey first. The `h.path === id` arm here is NOT the removed
    // handle-identity path fallback: it matches a legacy (pre-v5) folderAccessOrder
    // STRING entry that stored a path against the handle's path. Those predate
    // same-named-root support, so they can't collide. Retained intentionally;
    // `handles` are already stamped (line above), so rootKey matching is primary.
    const accessOrder = getFolderAccessOrderRef.current?.() ?? [];
    const focused =
      accessOrder.reduce<DirectoryHandle | null>((acc, id) => {
        if (acc) {
          return acc;
        }
        return handles.find((h) => rootKeyOf(h) === id || h.path === id) ?? null;
      }, null) ??
      handles[0] ??
      null;

    dispatch({ focused, handles, rootIdByPath: newRootIdByPath, type: 'setAllHandles' });

    // An authoritative empty restore must retire the persisted active view too.
    // Otherwise an unavailable folder remains the next chat's proposed root and
    // selection scope. The normal focus action retains its saved folder state.
    const focusedRootId = focused ? rootKeyOf(focused) : null;
    if (getPersistedCurrentFolderId?.() !== focusedRootId) {
      updateCurrentFolderId(focusedRootId);
    }

    // Register persisted roots in the store. Accessed via ref to avoid reactive dep.
    const storedDescriptors: StoredRootDescriptor[] = granted
      .filter((d) => d.persisted)
      .map((d) => ({ displayName: d.displayName, path: d.handle.path, rootId: d.rootId }));
    setActiveRootsRef.current(storedDescriptors);
  } catch (error) {
    if (!cancelledRef.value) {
      logger.warn('Failed to restore roots', { error });
    }
  } finally {
    if (!cancelledRef.value) {
      hasAttemptedRestoreRef.current = true;
      dispatch({ loading: false, type: 'setAccessLoading' });
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
  removeActiveRoot,
  setActiveRoots,
}: UseFileSystemParams) {
  const { fileSystemAdapter } = useAdapters();

  const [
    {
      rootDirectoryHandle,
      rootDirectoryHandles,
      isAccessLoading,
      recentRootsRevision,
      rootIdByPath,
    },
    dispatch,
  ] = useReducer(reducer, {
    isAccessLoading: false,
    recentRootsRevision: 0,
    rootDirectoryHandle: null,
    rootDirectoryHandles: [],
    rootIdByPath: new Map<string, string>(),
  });

  const hasAttemptedRestoreRef = useRef(false);
  const isRestoringRef = useRef(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  // Stable refs for callbacks that must be fresh at call time but should not
  // trigger effect re-runs (avoids infinite loops from unstable inline fn refs).
  const getFolderAccessOrderRef = useRef(getFolderAccessOrder);
  getFolderAccessOrderRef.current = getFolderAccessOrder;
  const setActiveRootsRef = useRef(setActiveRoots);
  setActiveRootsRef.current = setActiveRoots;

  const updateCurrentFolderId = useCallback(
    (folderId: string | null) => {
      setCurrentFolderId(folderId);
    },
    [setCurrentFolderId]
  );

  const isFileSystemAccessSupported = useCallback((): { supported: boolean; reason: string } => {
    const hasWebAPI =
      typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
    const hasAdapterAPI = typeof fileSystemAdapter?.requestDirectoryAccess === 'function';
    if (hasWebAPI || hasAdapterAPI) {
      return { reason: '', supported: true };
    }
    return { reason: 'File system access not supported in this environment', supported: false };
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
    dispatch({ loading: true, type: 'setAccessLoading' });
    try {
      if (
        typeof (fileSystemAdapter as { addRoot?: () => Promise<RootDescriptor> }).addRoot ===
        'function'
      ) {
        // Multi-root adapter API path
        const adapterWithAddRoot = fileSystemAdapter as { addRoot: () => Promise<RootDescriptor> };
        const descriptor = await adapterWithAddRoot.addRoot();
        const { handle, rootId, displayName, persisted } = descriptor;
        dispatch({ handle, rootId, type: 'addOrFocusHandle' });
        // Write rootId (not path) to the store so folderStates keys by RootId (storage v5).
        updateCurrentFolderId(rootId);
        // Only register in the persistent store when the handle was actually persisted
        if (persisted) {
          addActiveRoot({ displayName, path: getCanonicalFolderId(handle), rootId });
        }
        dispatch({ type: 'recordRecentRootMutation' });
        return handle;
      }
      // Legacy fallback: requestDirectoryAccess → synthetic descriptor
      const handle = await fileSystemAdapter.requestDirectoryAccess();
      const rootId = crypto.randomUUID();
      dispatch({ handle, rootId, type: 'addOrFocusHandle' });
      // Write rootId (not path) to the store so folderStates keys by RootId (storage v5).
      updateCurrentFolderId(rootId);
      addActiveRoot({ displayName: handle.name, path: getCanonicalFolderId(handle), rootId });
      dispatch({ type: 'recordRecentRootMutation' });
      return handle;
    } catch (error) {
      if (isUserCancellation(error)) {
        return null;
      }
      throw mapFileSystemError(error);
    } finally {
      dispatch({ loading: false, type: 'setAccessLoading' });
    }
  }, [fileSystemAdapter, isFileSystemAccessSupported, updateCurrentFolderId, addActiveRoot]);

  const adapterAddRootByPath = fileSystemAdapter.addRootByPath;
  const adapterListRecentRoots = fileSystemAdapter.listRecentRoots;

  /**
   * Desktop-only: re-mount a PREVIOUSLY GRANTED folder by path. Main's
   * recent-roots ledger is what authorizes it, so an unknown path rejects
   * visibly rather than resolving to null (unlike a picker cancellation, there
   * is no user to have cancelled). Post-add registration mirrors
   * addRootDirectory. `undefined` when the adapter lacks the capability — the
   * capability check IS the platform gate (web omits it, never stubs it).
   */
  const addRootDirectoryByPath = useMemo(() => {
    if (typeof adapterAddRootByPath !== 'function') {
      return;
    }
    return async (rootPath: string): Promise<DirectoryHandle | null> => {
      dispatch({ loading: true, type: 'setAccessLoading' });
      try {
        const { handle, rootId, displayName, persisted } = await adapterAddRootByPath.call(
          fileSystemAdapter,
          rootPath
        );
        dispatch({ handle, rootId, type: 'addOrFocusHandle' });
        updateCurrentFolderId(rootId);
        if (persisted) {
          addActiveRoot({ displayName, path: getCanonicalFolderId(handle), rootId });
        }
        dispatch({ type: 'recordRecentRootMutation' });
        return handle;
      } catch (error) {
        throw mapFileSystemError(error);
      } finally {
        dispatch({ loading: false, type: 'setAccessLoading' });
      }
    };
  }, [adapterAddRootByPath, addActiveRoot, fileSystemAdapter, updateCurrentFolderId]);

  /** Desktop-only companion to addRootDirectoryByPath; see its note. */
  const listRecentRoots = useMemo(() => {
    if (typeof adapterListRecentRoots !== 'function') {
      return;
    }
    return () =>
      adapterListRecentRoots.call(fileSystemAdapter).catch((error: unknown) => {
        throw mapFileSystemError(error);
      });
  }, [adapterListRecentRoots, fileSystemAdapter]);

  /**
   * Disconnect a root (multi-root). Forgets the platform persistence
   * (authoritatively), removes the handle + path→rootId entry, shifts focus when
   * the removed root was focused, and purges the store entries for the root.
   *
   * Disconnect ≠ delete: the adapter never touches the DB — indexed rows are
   * deliberately KEPT so re-adding the same folder resumes without
   * re-indexing.
   *
   * Returns the new focused handle (unchanged when the removed root was not
   * focused; null when no roots remain).
   */
  const removeRootDirectory = useCallback(
    async (rootId: string): Promise<DirectoryHandle | null> => {
      // 1) Platform authority first. If it rejects, renderer state is unchanged
      //    and the surfaced error lets the user retry one coherent transition.
      await forgetRootInAdapter(fileSystemAdapter, rootId);

      // 2) Remove the handle by canonical identity (rootId), never by path —
      //    two same-named roots share a path, so a path match removes the wrong
      //    one. The reducer shifts handle focus to the first remaining root.
      const remaining = rootDirectoryHandles.filter((h) => rootKeyOf(h) !== rootId);
      const wasFocused = rootDirectoryHandle !== null && rootKeyOf(rootDirectoryHandle) === rootId;
      dispatch({ rootId, type: 'removeHandle' });

      const nextFocused = wasFocused ? (remaining[0] ?? null) : rootDirectoryHandle;

      // 3) Focus shift BEFORE the store purge: setCurrentFolderId snapshots
      //    the OUTGOING folder's live state back into folderStates[rootId];
      //    removeActiveRoot below then purges that snapshot. The reverse order
      //    would resurrect the removed root's folder state.
      if (wasFocused) {
        updateCurrentFolderId(nextFocused ? rootKeyOf(nextFocused) : null);
      }

      // 4) Atomic store purge.
      removeActiveRoot(rootId);

      return nextFocused;
    },
    [
      fileSystemAdapter,
      rootDirectoryHandles,
      rootDirectoryHandle,
      updateCurrentFolderId,
      removeActiveRoot,
    ]
  );

  /**
   * Legacy API: delegates to addRootDirectory for backward compatibility.
   * Existing consumers keep working unchanged; return type preserved.
   */
  const selectRootDirectory = useCallback(
    async (): Promise<DirectoryHandle | null> => addRootDirectory(),
    [addRootDirectory]
  );

  /**
   * Append (or focus) an externally-built handle as an ADDITIONAL workspace
   * root without any picker or persistence — the multi-root fixture-harness
   * path (dev/e2e). Mirrors addRootDirectory's non-persisted branch: the
   * handle joins rootDirectoryHandles, becomes focused, and currentFolderId
   * moves to its RootId; addActiveRoot is deliberately NOT called, so a
   * fixture root never leaks into the persistent restore flow.
   */
  const addExternalRootHandle = useCallback(
    (handle: DirectoryHandle): void => {
      const rootId = handle.rootId ?? crypto.randomUUID();
      dispatch({ handle, rootId, type: 'addOrFocusHandle' });
      // Write rootId (not path) to the store so folderStates keys by RootId (storage v5).
      updateCurrentFolderId(rootId);
    },
    [updateCurrentFolderId]
  );

  /**
   * Switch focus to an already-loaded root by its canonical identity.
   * Resolves by rootKey (the durable RootId stamped onto the handle) so
   * same-named roots are disambiguated. Callers MUST pass the RootId, not the
   * (colliding) path. No-op if unknown.
   */
  const setFocusedRoot = useCallback(
    (identity: string) => {
      const match = findHandleByIdentity(rootDirectoryHandles, identity);
      if (!match) {
        logger.debug('setFocusedRoot: unknown root identity, ignoring', { identity });
        return;
      }
      dispatch({ handle: match, type: 'addOrFocusHandle' });
      // Write rootId (not path) to the store — folderStates keys by RootId (storage v5).
      updateCurrentFolderId(rootKeyOf(match));
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
          if (!isMountedRef.current) {
            return;
          }
          adapterRootIdByPath = new Map(descriptors.map((d) => [d.handle.path, d.rootId]));
          if (descriptors.some((descriptor) => descriptor.permissionState === 'granted')) {
            dispatch({ type: 'recordRecentRootMutation' });
          }
        } catch (error) {
          logger.warn('registerRestoredHandles: failed to read adapter root descriptors', {
            error,
          });
        }
      }

      // Remember the rootId assigned to the FIRST handle so the re-focus below
      // reuses it. The loop mints a fresh crypto.randomUUID() for handles the
      // adapter map doesn't cover; recomputing the first id from the path would
      // diverge from that random id, so the re-focus would miss the stamped
      // entry and append an unstamped duplicate.
      let firstRootId: string | null = null;
      for (const handle of handles) {
        // Prefer a rootId the handle already carries (the inline fixture stamps at
        // its source), then the adapter descriptor by path, then mint. Reusing the
        // existing stamp is what lets an injected fixture handle and its
        // auto-restore reconcile to ONE root now that identity is rootId-only.
        const rootId = handle.rootId ?? adapterRootIdByPath.get(handle.path) ?? crypto.randomUUID();
        firstRootId ??= rootId;
        dispatch({ handle, rootId, type: 'addOrFocusHandle' });
        addActiveRoot({
          displayName: handle.name,
          path: getCanonicalFolderId(handle),
          rootId,
        });
      }

      // The registration loop leaves the LAST handle focused; re-focus the first
      // by its already-assigned rootId so the dedupe matches the stamped entry.
      const first = handles[0];
      if (first && firstRootId !== null) {
        dispatch({ handle: first, rootId: firstRootId, type: 'addOrFocusHandle' });
        // Write rootId (not path) to the store — folderStates keys by RootId (storage v5).
        updateCurrentFolderId(firstRootId);
      }
    },
    [fileSystemAdapter, addActiveRoot, updateCurrentFolderId]
  );

  const clearRootDirectory = useCallback(() => {
    dispatch({ handle: null, type: 'setRoot' });
    updateCurrentFolderId(null);
  }, [updateCurrentFolderId]);

  /**
   * Set root directory handle from external source (e.g., restore banner).
   * This allows the useRestoreAccess hook to update the root handle after
   * successful permission restoration.
   */
  const setRootDirectoryHandle = useCallback(
    (handle: DirectoryHandle | null) => {
      if (handle === null) {
        dispatch({ handle: null, type: 'setRoot' });
        updateCurrentFolderId(null);
        return;
      }
      // Stamp once at this funnel (the sole non-null setRoot dispatcher) so the
      // stored handle and currentFolderId share one identity. Every caller (the
      // inline fixture, the restore modal) now supplies a rootId; ensureStamped is
      // the fail-loud backstop. Storage v5 keys folderStates by RootId.
      const stamped = ensureStamped(handle, 'setRootDirectoryHandle');
      dispatch({ handle: stamped, type: 'setRoot' });
      updateCurrentFolderId(rootKeyOf(stamped));
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
    dispatch({ loading, type: 'setAccessLoading' });
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
      // Legacy single-root (Branch B): REUSE the persisted currentFolderId as
      // this root's RootId. For the single restored root, the persisted id IS
      // the prior session's identity — reusing it keeps the storage v5
      // contract (currentFolderId = RootId) and preserves the keyed
      // folderStates entry. A per-boot crypto.randomUUID() could never match
      // any persisted id. Only mint a fresh UUID when nothing was persisted
      // (true first run).
      const persistedFolderId = getPersistedCurrentFolderId?.() ?? null;
      const rootId = persistedFolderId ?? crypto.randomUUID();
      dispatch({ handle: restored, rootId, type: 'addOrFocusHandle' });

      if (persistedFolderId === null) {
        updateCurrentFolderId(rootId);
      } else {
        // currentFolderId already equals rootId in the persisted store; skip
        // the redundant write so the folder-switching logic doesn't re-run
        // against freshly-hydrated state.
        logger.debug('Skipping setCurrentFolderId - reusing persisted folder id as rootId', {
          folderId: rootId,
        });
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
      dispatch({ loading: true, type: 'setAccessLoading' });
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
    dispatch({ loading: true, type: 'setAccessLoading' });

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
          dispatch({ loading: false, type: 'setAccessLoading' });
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
      addExternalRootHandle,
      addRootDirectory,
      addRootDirectoryByPath,
      clearRootDirectory,
      isAccessLoading,
      isFileSystemAccessSupported,
      listRecentRoots,
      recentRootsRevision,
      registerRestoredHandles,
      removeRootDirectory,
      rootDirectoryHandle,
      rootDirectoryHandles,
      rootIdByPath,
      selectRootDirectory,
      setAccessLoading,
      setFocusedRoot,
      setRootDirectoryHandle,
    }),
    [
      rootDirectoryHandle,
      rootDirectoryHandles,
      rootIdByPath,
      isAccessLoading,
      addExternalRootHandle,
      addRootDirectory,
      addRootDirectoryByPath,
      listRecentRoots,
      recentRootsRevision,
      registerRestoredHandles,
      removeRootDirectory,
      selectRootDirectory,
      setFocusedRoot,
      isFileSystemAccessSupported,
      clearRootDirectory,
      setRootDirectoryHandle,
      setAccessLoading,
    ]
  );
}
