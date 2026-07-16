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
  createWatcher: (handle: VaultDirectoryHandleLike, onChange: () => void) => VaultWatcher | null;
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
  clearGlobalError: () => void;
  expandedIds: Set<string>;
  /** Picker/persistence failures; the panel surfaces this as a toast/banner. */
  globalError: string | null;

  initialize: () => Promise<void>;
  initialized: boolean;
  reconnectRoot: (rootId: VaultRootId) => Promise<void>;
  refreshRoot: (rootId: VaultRootId) => Promise<void>;
  removeRoot: (rootId: VaultRootId) => Promise<void>;
  reset: () => void;
  roots: VaultRootState[];
  selectedNoteId: string | null;
  selectNote: (noteId: string | null) => void;
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
      const watcher = services.createWatcher(handle, () => scheduleRescan(rootId, handle));
      if (watcher) {
        watchers.set(rootId, watcher);
      } else {
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
      options: { expand: boolean }
    ): Promise<void> {
      set((state) => ({
        expandedIds: options.expand ? new Set([...state.expandedIds, rootId]) : state.expandedIds,
        roots: [
          ...state.roots,
          {
            handle,
            name: handle.name,
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

    async function restoreStoredRoot(stored: StoredVaultRoot): Promise<void> {
      try {
        const permission = await queryVaultPermission(stored.handle);
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

    return {
      addDroppedDirectories: async (handles) => {
        for (const handle of handles) {
          try {
            await addDirectory(handle);
          } catch (error) {
            logger.error('Mounting dropped vault failed', { error, name: handle.name });
            set({ globalError: errorMessage(error) });
          }
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

      clearGlobalError: () => set({ globalError: null }),

      expandedIds: new Set<string>(),

      globalError: null,

      // Idempotent: only stored roots that are not already mounted get
      // restored, so calling again later picks up newly persisted roots
      // without disturbing live ones. Concurrent calls coalesce onto the
      // in-flight pass.
      initialize: () => {
        initializeInFlight ??= (async () => {
          try {
            set({ initialized: true });
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
              if (!mounted.has(root.rootId)) {
                await restoreStoredRoot(root);
              }
            }
          } finally {
            initializeInFlight = null;
          }
        })();
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
        disposeWatchers(rootId);
        scanGenerations.set(rootId, (scanGenerations.get(rootId) ?? 0) + 1);
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

      reset: () => {
        disposeWatchers();
        scanGenerations.clear();
        set({
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
