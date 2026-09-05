/**
 * Panel Layout Store
 *
 * Canonical source of truth for the app-wide agent shell layout and root tab state.
 * - sizes: [left, right, console] as percentages (0..100), normalized on write
 * - visibility flags: showLeftPanel/showRightPanel/showConsole
 * - activeTab: 'explorer' | 'settings' | 'git' | 'terminal'
 * - settingsOpen: session-only visibility for the modal settings surface
 *
 * Persistence: uses `@brainstrike/storage` adapters; persisted subset only.
 * Integration: use with `PanelLayoutProvider` in controlled mode (pass state + onChange).
 */

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

/**
 * Top-level shell routes selected from the left nav rail. `'changes'` is NOT
 * a member — the Changes surface (BST-1114 smoke-test feedback) lives as a
 * tab INSIDE the workspace panel on the `'explorer'` route instead of its own
 * nav-rail page; it is a workspace app tab (BST-1258, `useWorkspaceTabSelectionStore`).
 */
export type PanelTab = 'explorer' | 'settings' | 'git' | 'terminal' | 'notes' | 'browser';

/**
 * The subset of the store the visible-surface rule reads. Kept structural so
 * the selector can be called both as a zustand selector
 * (`usePanelLayoutStore(selectVisibleSurface)`) and as a plain function on
 * values a component has already subscribed to.
 */
export type VisibleSurfaceState = Pick<PanelLayoutStoreState, 'activeTab' | 'settingsOpen'>;

export interface PanelLayoutStoreState {
  // Root tabs
  activeTab: PanelTab;
  openSettings: () => void;
  setActiveTab: (tab: PanelTab) => void;
  setSettingsOpen: (open: boolean) => void;

  // Actions
  setSizes: (sizes: number[]) => void;
  setState: (next: Partial<PanelLayoutStoreState>) => void;
  settingsOpen: boolean;
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  // Layout
  sizes: PanelSizes;
  toggleConsole: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
}

/**
 * The surface the user is actually looking at, and the ONE definition of the
 * settings-overlay precedence rule (BST-1281).
 *
 * Settings is a modal dialog layered over whichever tab is underneath it, so an
 * open dialog wins. `activeTab === 'settings'` is the same surface reached from
 * the nav rail — `setActiveTab` sets `settingsOpen` alongside it — but it is
 * checked explicitly because `setState` can write `activeTab` on its own, and a
 * consumer that only looked at `settingsOpen` would then disagree with the
 * dialog on screen.
 *
 * Consumers: `RootLayoutContent` (settings dialog `open` prop + long-task
 * telemetry route) and `useDocumentTitle` (document title/description). Change
 * the rule here and every consumer moves with it.
 */
export function selectVisibleSurface(state: VisibleSurfaceState): PanelTab {
  return state.settingsOpen || state.activeTab === 'settings' ? 'settings' : state.activeTab;
}

/**
 * Default panel sizes: [leftPanel, rightPanel, consolePanel]
 * - leftPanel (agent workspace): 18% of horizontal space
 * - rightPanel (workspace surface): 40% of horizontal space
 * - consolePanel: 20% of vertical space (when visible)
 *
 * Note: The middle panel size is calculated dynamically as: 100 - left - right
 */
const DEFAULT_STATE: Omit<
  PanelLayoutStoreState,
  | 'setSizes'
  | 'toggleLeft'
  | 'toggleRight'
  | 'toggleConsole'
  | 'openSettings'
  | 'setActiveTab'
  | 'setSettingsOpen'
  | 'setState'
> = {
  activeTab: 'explorer',
  settingsOpen: false,
  showConsole: false,
  showLeftPanel: true,
  showRightPanel: true,
  sizes: [18, 40, 20],
};

const STORE_NAME = 'panel-layout-store.v1' as const;
const STORE_VERSION = 4 as const;

/**
 * Panels smaller than DEFAULT_MIN_PANEL_SIZE (but non-zero) are considered
 * corrupted and reset to defaults — enforced on write by `resolveNextSizes`
 * and on read by the persisted-layout parser.
 */
const SIZE_RULES: SizeRules = {
  defaultSizes: DEFAULT_STATE.sizes,
  minPanelSize: DEFAULT_MIN_PANEL_SIZE,
};

const creator: StateCreator<PanelLayoutStoreState, [['zustand/persist', unknown]], []> = (
  set,
  get
) => ({
  ...DEFAULT_STATE,

  openSettings: () => set({ settingsOpen: true }),

  setActiveTab: (tab: PanelTab) => set({ activeTab: tab, settingsOpen: tab === 'settings' }),

  setSettingsOpen: (open: boolean) => set({ settingsOpen: open }),

  setSizes: (sizes: number[]) => set({ sizes: resolveNextSizes(sizes, get().sizes, SIZE_RULES) }),

  setState: (next: Partial<PanelLayoutStoreState>) => set(next),
  toggleConsole: () => set({ showConsole: !get().showConsole }),

  toggleLeft: () => set({ showLeftPanel: !get().showLeftPanel }),
  toggleRight: () => set({ showRightPanel: !get().showRightPanel }),
});

type PersistedPanelState = Pick<
  PanelLayoutStoreState,
  'sizes' | 'showLeftPanel' | 'showRightPanel' | 'showConsole'
>;

// Root-tab selection is intentionally session-only. Whitelist the persisted
// layout fields so legacy snapshots containing activeTab: "prompts" cannot
// restore a route that now lives inside the agent sidebar.
const parsePersistedPanelState = createPersistedLayoutParser<PersistedPanelState>({
  defaultSizes: DEFAULT_STATE.sizes,
  loggerName: 'PanelLayoutStore',
  persistedKeys: ['showConsole', 'showLeftPanel', 'showRightPanel', 'sizes'],
});

function persistOptions(
  storage: PersistStorage<Partial<PersistedPanelState>>
): PersistOptions<PanelLayoutStoreState, Partial<PersistedPanelState>> {
  return {
    migrate: (persistedState, version) => {
      // The outer shell replaced the old three-pane geometry, so pre-v4 sizes do not map
      // safely. Intentionally hard-reset legacy panel layout state instead of attempting
      // a fragile migration that could strand users in a broken layout.
      if (version < STORE_VERSION) {
        return {
          ...DEFAULT_STATE,
        } as PersistedPanelState;
      }
      return persistedState as PersistedPanelState;
    },
    name: STORE_NAME,
    partialize: (state): PersistedPanelState => ({
      showConsole: state.showConsole,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
      sizes: state.sizes,
    }),
    storage,
    version: STORE_VERSION,
  };
}

export function createPanelLayoutStore(storage: StorageAdapter) {
  return createPanelLayoutStoreWithPersistStorage(
    createAdapterPersistStorage(storage, parsePersistedPanelState)
  );
}

function createPanelLayoutStoreWithPersistStorage(
  storage: PersistStorage<Partial<PersistedPanelState>>
) {
  return create<PanelLayoutStoreState>()(persist(creator, persistOptions(storage)));
}

// HMR-safe default instance
const GLOBAL_KEY = '__brainstrike_panel_layout_store__' as const;

type BoundStore = ReturnType<typeof createPanelLayoutStoreWithPersistStorage>;

export const usePanelLayoutStore: BoundStore = resolveGlobalStoreSingleton(GLOBAL_KEY, () =>
  createPanelLayoutStoreWithPersistStorage(resolveDefaultPersistStorage(parsePersistedPanelState))
);
