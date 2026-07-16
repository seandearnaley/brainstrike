import { createLogger } from '@brainstrike/utils';
import { createStore } from 'zustand/vanilla';
import type { StoredVaultRoot, VaultHandleStore } from '../core/handle-store';
import { queryVaultPermission, requestVaultPermission } from '../core/permissions';
import type { VaultRootState } from '../core/rows';
import { scanVaultDirectory } from '../core/scan';
import type { VaultDirectoryHandleLike, VaultRootId, VaultSortMode } from '../core/types';
import type { VaultWatcher } from '../core/watch';

const logger = createLogger('NotesVault');

export interface NotesVaultServices {
  /** onError fires when a watcher that attached successfully later fails to
   * observe — the store downgrades to the manual-refresh affordance. */
  createWatcher: (
    handle: VaultDirectoryHandleLike,
    onChange: () => void,
    onError?: (error: unknown) => void
  ) => VaultWatcher | null;
  /** Provisions the app's built-in vault (e.g. OPFS "My Notes" on web,
   * ~/Documents/Brainstrike Notes on desktop). Absent = no default vault. */
  getDefaultVault?: () => Promise<{ handle: VaultDirectoryHandleLike; name: string } | null>;
  handleStore: VaultHandleStore;
  newRootId: () => VaultRootId;
  now: () => number;
  /** showDirectoryPicker wrapper; rejects with AbortError on user cancel. */
  pickDirectory: () => Promise<VaultDirectoryHandleLike>;
  /** Watcher change batches are coalesced for this long before rescanning. */
  rescanDebounceMs?: number;
}

export interface NotesVaultState {
  addDroppedDirectories: (handles: readonly VaultDirectoryHandleLike[]) => Promise<void>;
  addVaultFromPicker: () => Promise<void>;
  clearEditRequest: () => void;
  clearGlobalError: () => void;
  /** One-shot: the viewer enters edit mode for this note once ready, then clears. */
  editRequestNoteId: string | null;
  expandedIds: Set<string>;
  /** Picker/persistence failures; the panel surfaces this as a toast/banner. */
  globalError: string | null;

  initialize: () => Promise<void>;
  initialized: boolean;
  reconnectRoot: (rootId: VaultRootId) => Promise<void>;
  refreshRoot: (rootId: VaultRootId) => Promise<void>;
  removeRoot: (rootId: VaultRootId) => Promise<void>;
  /** Surfaces a panel-level failure in the alert banner (user-initiated actions). */
  reportGlobalError: (message: string) => void;
  reset: () => void;
  roots: VaultRootState[];
  selectedNoteId: string | null;
  selectNote: (noteId: string | null) => void;
  /** Select a note AND arm the one-shot edit request (e.g. right after New Note). */
  selectNoteForEditing: (noteId: string) => void;
  setSortMode: (mode: VaultSortMode) => void;
  sortMode: VaultSortMode;
  toggleExpanded: (nodeId: string) => void;
  /** False once any mounted root lacked FileSystemObserver support. */
  watchSupported: boolean;
}

export type NotesVaultStore = ReturnType<typeof createNotesVaultStore>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function createNotesVaultStore(services: NotesVaultServices) {
  const watchers = new Map<VaultRootId, VaultWatcher>();
  const scanGenerations = new Map<VaultRootId, number>();
  const rescanTimers = new Map<VaultRootId, ReturnType<typeof setTimeout>>();
  // Coalesces concurrent initialize() calls (React StrictMode double-effects):
  // both callers share one restore pass instead of double-mounting every root.
  let initializeInFlight: Promise<void> | null = null;
  // Bumped by reset(): an initialize() continuation that resumes after a
  // factory reset must not resurrect roots or watchers (FACTORY RESET
  // CONTRACT — vault access may not survive a reset).
  let sessionEpoch = 0;

  // Vanilla store (not the `create` hook): components subscribe via
  // `useStore(store, selector)` so the injected store is never called as a
  // dynamic hook — a React Compiler bailout — and headless tests need no React.
  return createStore<NotesVaultState>()((set, get) => {
    function patchRoot(rootId: VaultRootId, patch: Partial<VaultRootState>): void {
      set((state) => ({
        roots: state.roots.map((root) => (root.rootId === rootId ? { ...root, ...patch } : root)),
      }));
    }

    async function scanRoot(rootId: VaultRootId, handle: VaultDirectoryHandleLike): Promise<void> {
      const generation = (scanGenerations.get(rootId) ?? 0) + 1;
      scanGenerations.set(rootId, generation);
      patchRoot(rootId, { error: undefined, status: 'scanning' });
      try {
        const result = await scanVaultDirectory(handle, rootId);
        if (scanGenerations.get(rootId) !== generation) {
          return;
        }
        patchRoot(rootId, {
          nodes: result.nodes,
          noteCount: result.noteCount,
          status: 'ready',
        });
      } catch (error) {
        if (scanGenerations.get(rootId) !== generation) {
          return;
        }
        logger.error('Vault scan failed', { error, rootId });
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          // Permission was revoked, not a broken disk: keep the Reconnect
          // affordance instead of dead-ending in a generic error state.
          patchRoot(rootId, {
            error: 'Folder permission was revoked by the browser',
            status: 'permission-required',
          });
          return;
        }
        patchRoot(rootId, { error: errorMessage(error), status: 'error' });
      }
    }

    function scheduleRescan(rootId: VaultRootId, handle: VaultDirectoryHandleLike): void {
      const delay = services.rescanDebounceMs ?? 250;
      const existing = rescanTimers.get(rootId);
      if (existing !== undefined) {
        clearTimeout(existing);
      }
      if (delay <= 0) {
        void scanRoot(rootId, handle);
        return;
      }
      rescanTimers.set(
        rootId,
        setTimeout(() => {
          rescanTimers.delete(rootId);
          void scanRoot(rootId, handle);
        }, delay)
      );
    }

    function startWatching(rootId: VaultRootId, handle: VaultDirectoryHandleLike): void {
      // Re-entry safe (e.g. double-clicked Reconnect): the previous watcher
      // must be disconnected or it leaks and keeps firing rescans forever.
      disposeWatchers(rootId);
      try {
        const watcher = services.createWatcher(
          handle,
          () => scheduleRescan(rootId, handle),
          (error) => {
            logger.error('Vault watcher failed after attach', { error, rootId });
            disposeWatchers(rootId);
            set({ watchSupported: false });
          }
        );
        if (watcher) {
          watchers.set(rootId, watcher);
        } else {
          set({ watchSupported: false });
        }
      } catch (error) {
        // A watcher failure must not strand the root mid-mount — downgrade
        // to manual refresh visibly.
        logger.error('Vault watcher construction failed', { error, rootId });
        set({ watchSupported: false });
      }
    }

    function disposeWatchers(rootId?: VaultRootId): void {
      for (const [id, watcher] of watchers) {
        if (rootId === undefined || id === rootId) {
          watcher.disconnect();
          watchers.delete(id);
        }
      }
      for (const [id, timer] of rescanTimers) {
        if (rootId === undefined || id === rootId) {
          clearTimeout(timer);
          rescanTimers.delete(id);
        }
      }
    }

    async function mountRoot(
      rootId: VaultRootId,
      handle: VaultDirectoryHandleLike,
      options: { expand: boolean; builtIn?: boolean; name?: string }
    ): Promise<void> {
      set((state) => ({
        expandedIds: options.expand ? new Set([...state.expandedIds, rootId]) : state.expandedIds,
        roots: [
          ...state.roots,
          {
            builtIn: options.builtIn ?? false,
            handle,
            name: options.name ?? handle.name,
            nodes: [],
            noteCount: 0,
            rootId,
            status: 'scanning',
          },
        ],
      }));
      startWatching(rootId, handle);
      await scanRoot(rootId, handle);
    }

    async function addDirectory(handle: VaultDirectoryHandleLike): Promise<boolean> {
      for (const root of get().roots) {
        if (await root.handle.isSameEntry(handle)) {
          set((state) => ({ expandedIds: new Set([...state.expandedIds, root.rootId]) }));
          return false;
        }
      }
      const rootId = services.newRootId();
      await services.handleStore.put({
        addedAt: services.now(),
        handle,
        name: handle.name,
        rootId,
      });
      await mountRoot(rootId, handle, { expand: true });
      return true;
    }

    async function restoreStoredRoot(
      stored: StoredVaultRoot,
      isCurrentEpoch: () => boolean
    ): Promise<void> {
      try {
        const permission = await queryVaultPermission(stored.handle);
        // A factory reset can land while the permission query is pending;
        // mounting afterwards would resurrect vault access post-reset.
        if (!isCurrentEpoch()) {
          return;
        }
        if (permission === 'granted') {
          await mountRoot(stored.rootId, stored.handle, { expand: true });
          return;
        }
        set((state) => ({
          roots: [
            ...state.roots,
            {
              handle: stored.handle,
              name: stored.name,
              nodes: [],
              noteCount: 0,
              rootId: stored.rootId,
              status: 'permission-required',
            },
          ],
        }));
      } catch (error) {
        logger.error('Vault root restore failed', { error, rootId: stored.rootId });
        if (!isCurrentEpoch()) {
          return;
        }
        set((state) => ({
          roots: [
            ...state.roots,
            {
              error: errorMessage(error),
              handle: stored.handle,
              name: stored.name,
              nodes: [],
              noteCount: 0,
              rootId: stored.rootId,
              status: 'error',
            },
          ],
        }));
      }
    }

    const DefaultVaultRootId = 'built-in-default-vault';

    async function mountDefaultVault(epoch: number): Promise<void> {
      if (!services.getDefaultVault) {
        return;
      }
      if (get().roots.some((root) => root.rootId === DefaultVaultRootId)) {
        return;
      }
      try {
        const defaultVault = await services.getDefaultVault();
        if (!defaultVault || epoch !== sessionEpoch) {
          return;
        }
        await mountRoot(DefaultVaultRootId, defaultVault.handle, {
          builtIn: true,
          expand: true,
          name: defaultVault.name,
        });
      } catch (error) {
        logger.error('Provisioning the default vault failed', { error });
        set({ globalError: errorMessage(error) });
      }
    }

    async function runInitialize(): Promise<void> {
      const epoch = sessionEpoch;
      try {
        await mountDefaultVault(epoch);
        let stored: StoredVaultRoot[];
        try {
          stored = await services.handleStore.list();
        } catch (error) {
          logger.error('Listing persisted vault roots failed', { error });
          set({ globalError: errorMessage(error) });
          return;
        }
        const mounted = new Set(get().roots.map((root) => root.rootId));
        for (const root of stored) {
          // A factory reset that raced this restore invalidates the pass:
          // resuming would resurrect roots and watchers post-reset.
          if (epoch !== sessionEpoch) {
            return;
          }
          if (!mounted.has(root.rootId)) {
            await restoreStoredRoot(root, () => epoch === sessionEpoch);
          }
        }
      } finally {
        initializeInFlight = null;
        if (epoch === sessionEpoch) {
          // Marked AFTER restore completes so the onboarding empty state
          // never flashes while persisted vaults are still loading.
          set({ initialized: true });
        }
      }
    }

    return {
      addDroppedDirectories: async (handles) => {
        const failures: string[] = [];
        for (const handle of handles) {
          try {
            await addDirectory(handle);
          } catch (error) {
            logger.error('Mounting dropped vault failed', { error, name: handle.name });
            failures.push(`${handle.name}: ${errorMessage(error)}`);
          }
        }
        if (failures.length > 0) {
          set({
            globalError: `${failures.length} of ${handles.length} dropped folders could not be mounted — ${failures.join('; ')}`,
          });
        }
      },

      addVaultFromPicker: async () => {
        let handle: VaultDirectoryHandleLike;
        try {
          handle = await services.pickDirectory();
        } catch (error) {
          if (isAbortError(error)) {
            return;
          }
          logger.error('Vault directory picker failed', { error });
          set({ globalError: errorMessage(error) });
          return;
        }
        try {
          await addDirectory(handle);
        } catch (error) {
          logger.error('Mounting picked vault failed', { error, name: handle.name });
          set({ globalError: errorMessage(error) });
        }
      },

      clearEditRequest: () => set({ editRequestNoteId: null }),

      clearGlobalError: () => set({ globalError: null }),

      editRequestNoteId: null,

      expandedIds: new Set<string>(),

      globalError: null,

      // Idempotent: only stored roots that are not already mounted get
      // restored, so calling again later picks up newly persisted roots
      // without disturbing live ones. Concurrent calls coalesce onto the
      // in-flight pass.
      initialize: () => {
        initializeInFlight ??= runInitialize();
        return initializeInFlight;
      },

      initialized: false,

      reconnectRoot: async (rootId) => {
        const root = get().roots.find((candidate) => candidate.rootId === rootId);
        if (!root) {
          return;
        }
        try {
          const permission = await requestVaultPermission(root.handle);
          if (permission === 'granted') {
            set((state) => ({ expandedIds: new Set([...state.expandedIds, rootId]) }));
            startWatching(rootId, root.handle);
            await scanRoot(rootId, root.handle);
            return;
          }
          patchRoot(rootId, {
            error: `Access ${permission === 'denied' ? 'denied' : 'not granted'} by the browser`,
            status: 'permission-required',
          });
        } catch (error) {
          logger.error('Vault reconnect failed', { error, rootId });
          patchRoot(rootId, { error: errorMessage(error), status: 'error' });
        }
      },

      refreshRoot: async (rootId) => {
        const root = get().roots.find((candidate) => candidate.rootId === rootId);
        if (root) {
          await scanRoot(rootId, root.handle);
        }
      },

      removeRoot: async (rootId) => {
        const target = get().roots.find((root) => root.rootId === rootId);
        if (target?.builtIn) {
          // The UI never offers this; guard the store API so a stray caller
          // cannot strand the session without its default vault.
          logger.warn('Ignoring removeRoot for the built-in default vault', { rootId });
          return;
        }
        disposeWatchers(rootId);
        // Invalidate any in-flight scan; the entry itself can go (rootIds are
        // fresh UUIDs, and patchRoot no-ops for filtered-out roots anyway).
        scanGenerations.delete(rootId);
        try {
          await services.handleStore.remove(rootId);
        } catch (error) {
          logger.error('Forgetting vault root failed', { error, rootId });
          set({ globalError: errorMessage(error) });
        }
        set((state) => ({
          expandedIds: new Set(
            [...state.expandedIds].filter((id) => id !== rootId && !id.startsWith(`${rootId}:`))
          ),
          roots: state.roots.filter((root) => root.rootId !== rootId),
          selectedNoteId:
            state.selectedNoteId !== null &&
            (state.selectedNoteId === rootId || state.selectedNoteId.startsWith(`${rootId}:`))
              ? null
              : state.selectedNoteId,
        }));
      },

      reportGlobalError: (message) => set({ globalError: message }),

      reset: () => {
        sessionEpoch += 1;
        disposeWatchers();
        scanGenerations.clear();
        set({
          editRequestNoteId: null,
          expandedIds: new Set<string>(),
          globalError: null,
          initialized: false,
          roots: [],
          selectedNoteId: null,
          sortMode: 'name-asc',
          watchSupported: true,
        });
      },

      roots: [],

      selectedNoteId: null,

      selectNote: (noteId) => set({ selectedNoteId: noteId }),

      selectNoteForEditing: (noteId) => set({ editRequestNoteId: noteId, selectedNoteId: noteId }),

      setSortMode: (mode) => set({ sortMode: mode }),

      sortMode: 'name-asc',

      toggleExpanded: (nodeId) =>
        set((state) => {
          const expandedIds = new Set(state.expandedIds);
          if (expandedIds.has(nodeId)) {
            expandedIds.delete(nodeId);
          } else {
            expandedIds.add(nodeId);
          }
          return { expandedIds };
        }),

      watchSupported: true,
    };
  });
}
