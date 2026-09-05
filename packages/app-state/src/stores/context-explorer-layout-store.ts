import type { StorageAdapter } from '@brainstrike/storage';
import type { StateCreator } from 'zustand';
import { type PersistOptions, type PersistStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import {
  createAdapterPersistStorage,
  createPersistedLayoutParser,
  DEFAULT_MIN_PANEL_SIZE,
  type PanelSizes,
  resolveDefaultPersistStorage,
  resolveGlobalStoreSingleton,
  resolveNextSizes,
  type SizeRules,
} from './persisted-layout-store';

export type ExplorerActiveTab = 'explorer' | 'search';

export interface ContextExplorerLayoutStoreState {
  /** Which surface the left workspace panel shows: the file tree or search. */
  explorerActiveTab: ExplorerActiveTab;
  setExplorerActiveTab: (tab: ExplorerActiveTab) => void;
  setSizes: (sizes: number[]) => void;
  setState: (next: Partial<ContextExplorerLayoutStoreState>) => void;
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  sizes: PanelSizes;
  toggleConsole: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
}

const DEFAULT_STATE: Omit<
  ContextExplorerLayoutStoreState,
  'setSizes' | 'toggleLeft' | 'toggleRight' | 'toggleConsole' | 'setState' | 'setExplorerActiveTab'
> = {
  explorerActiveTab: 'explorer',
  showConsole: false,
  showLeftPanel: false,
  showRightPanel: true,
  sizes: [25, 20, 20],
};

// Note: STORE_NAME is intentionally frozen at '.v1' to prevent orphaning persisted layout
// data for existing users. The active schema version is tracked separately by STORE_VERSION.
const STORE_NAME = 'context-explorer-layout-store.v1' as const;
const STORE_VERSION = 3 as const;
const SIZE_RULES: SizeRules = {
  defaultSizes: DEFAULT_STATE.sizes,
  minPanelSize: DEFAULT_MIN_PANEL_SIZE,
};

const creator: StateCreator<ContextExplorerLayoutStoreState, [['zustand/persist', unknown]], []> = (
  set,
  get
) => ({
  ...DEFAULT_STATE,
  setExplorerActiveTab: (explorerActiveTab: ExplorerActiveTab) => set({ explorerActiveTab }),

  setSizes: (sizes: number[]) => set({ sizes: resolveNextSizes(sizes, get().sizes, SIZE_RULES) }),
  setState: (next: Partial<ContextExplorerLayoutStoreState>) => set(next),
  toggleConsole: () => set({ showConsole: !get().showConsole }),

  toggleLeft: () => set({ showLeftPanel: !get().showLeftPanel }),
  toggleRight: () => set({ showRightPanel: !get().showRightPanel }),
});

type PersistedContextExplorerLayoutState = Pick<
  ContextExplorerLayoutStoreState,
  'sizes' | 'showLeftPanel' | 'showRightPanel' | 'showConsole' | 'explorerActiveTab'
>;

// The whole persisted subset restores here: explorerActiveTab is durable,
// unlike the outer shell's root tab.
const parsePersistedLayoutState = createPersistedLayoutParser<PersistedContextExplorerLayoutState>({
  defaultSizes: DEFAULT_STATE.sizes,
  loggerName: 'ContextExplorerLayoutStore',
  persistedKeys: ['explorerActiveTab', 'showConsole', 'showLeftPanel', 'showRightPanel', 'sizes'],
});

function persistOptions(
  storage: PersistStorage<Partial<PersistedContextExplorerLayoutState>>
): PersistOptions<ContextExplorerLayoutStoreState, Partial<PersistedContextExplorerLayoutState>> {
  return {
    migrate: (persistedState, version) => {
      let state = persistedState as Partial<PersistedContextExplorerLayoutState>;

      if (version < 2) {
        const sizes = state.sizes || [25, 20, 20];
        state = {
          ...state,
          // Missing v1 visibility flags are treated as a default layout, not as user intent.
          showLeftPanel: state.showRightPanel ?? false,
          showRightPanel: state.showLeftPanel ?? true,
          sizes: [sizes[1] ?? 20, sizes[0] ?? 25, sizes[2] ?? 20] as [number, number, number],
        };
      }

      if (version < 3) {
        // v3 adds the Explorer|Search tab strip. Pre-v3 payloads have no
        // persisted tab; default to the file tree (the prior sole surface).
        state = {
          ...state,
          explorerActiveTab: 'explorer',
        };
      }

      return state;
    },
    name: STORE_NAME,
    partialize: (state): PersistedContextExplorerLayoutState => ({
      explorerActiveTab: state.explorerActiveTab,
      showConsole: state.showConsole,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
      sizes: state.sizes,
    }),
    storage,
    version: STORE_VERSION,
  };
}

export function createContextExplorerLayoutStore(storage: StorageAdapter) {
  return createContextExplorerLayoutStoreWithPersistStorage(
    createAdapterPersistStorage(storage, parsePersistedLayoutState)
  );
}

function createContextExplorerLayoutStoreWithPersistStorage(
  storage: PersistStorage<Partial<PersistedContextExplorerLayoutState>>
) {
  return create<ContextExplorerLayoutStoreState>()(persist(creator, persistOptions(storage)));
}

const GLOBAL_KEY = '__brainstrike_context_explorer_layout_store__' as const;

type BoundStore = ReturnType<typeof createContextExplorerLayoutStoreWithPersistStorage>;

export const useContextExplorerLayoutStore: BoundStore = resolveGlobalStoreSingleton(
  GLOBAL_KEY,
  () =>
    createContextExplorerLayoutStoreWithPersistStorage(
      resolveDefaultPersistStorage(parsePersistedLayoutState)
    )
);
