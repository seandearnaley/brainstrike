/**
 * Panel Layout Store
 *
 * Canonical source of truth for the app-wide agent shell layout and root tab state.
 * - sizes: [left, right, console] as percentages (0..100), normalized on write
 * - visibility flags: showLeftPanel/showRightPanel/showConsole
 * - activeTab: 'explorer' | 'settings' | 'artifacts'
 *
 * Persistence: `persistDurable`; the layout subset only (the root tab is per session).
 * Integration: use with `PanelLayoutProvider` in controlled mode (pass state + onChange).
 */

import { persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type PanelSizes = [number, number, number];

/**
 * Top-level shell routes selected from the left nav rail. `'changes'` is NOT
 * a member — the Changes surface (BST-1114 smoke-test feedback) lives as a
 * tab INSIDE the workspace panel on the `'explorer'` route instead of its own
 * nav-rail page; it is a workspace app tab (BST-1258, `useWorkspaceTabSelectionStore`).
 */
export type PanelTab = 'artifacts' | 'explorer' | 'settings' | 'terminal';

export interface PanelLayoutStoreState {
  // Root tabs
  activeTab: PanelTab;
  /**
   * Navigate to the Settings shell route. Settings is a full nav-rail tab
   * like Artifacts (BST-1668 — the #1626 modal is gone), so this is
   * `setActiveTab('settings')` under a name every entry point (profile menu,
   * ⌘K, status items, tool menus) can share without knowing the tab id.
   */
  openSettings: () => void;
  setActiveTab: (tab: PanelTab) => void;

  // Actions
  setSizes: (sizes: number[]) => void;
  setState: (next: Partial<PanelLayoutStoreState>) => void;
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
  | 'setState'
> = {
  activeTab: 'explorer',
  showConsole: false,
  showLeftPanel: true,
  showRightPanel: true,
  sizes: [18, 40, 20],
};

const STORE_NAME = 'brainstrike:panel-layout-store.v1' as const;
const STORE_VERSION = 1 as const;

/** Panels smaller than this (but non-zero) are corrupted and reset to the defaults. */
const MIN_PANEL_SIZE = 10;

/**
 * Clamp into [0, 100], repair corrupted (non-zero below minimum) values to the
 * defaults, spread an all-zero tuple evenly, and rescale totals above 100%.
 * An empty input stays empty so callers can keep the current tuple.
 */
function normalizeSizes(sizes: readonly unknown[]): number[] {
  if (sizes.length === 0) {
    return [];
  }
  const clamped = sizes.map((size) => {
    const num = typeof size === 'number' && !Number.isNaN(size) ? size : 0;
    return Math.max(0, Math.min(100, num));
  });
  if (clamped.some((size) => size > 0 && size < MIN_PANEL_SIZE)) {
    return [...DEFAULT_STATE.sizes];
  }
  const total = clamped.reduce((sum, size) => sum + size, 0);
  if (total === 0) {
    return clamped.map(() => 100 / clamped.length);
  }
  if (total > 100) {
    return clamped.map((size) => (size / total) * 100);
  }
  return clamped;
}

/** Normalizes `sizes` and fills any omitted slot from `current`. */
function resolveNextSizes(sizes: readonly unknown[], current: PanelSizes): PanelSizes {
  const normalized = normalizeSizes(sizes);
  return [normalized[0] ?? current[0], normalized[1] ?? current[1], normalized[2] ?? current[2]];
}

type PersistedPanelState = Pick<
  PanelLayoutStoreState,
  'sizes' | 'showLeftPanel' | 'showRightPanel' | 'showConsole'
>;

/** Only the layout fields restore, each only when it has the right type; sizes are normalized. */
function mergePersistedLayout(
  persisted: unknown,
  current: PanelLayoutStoreState
): PanelLayoutStoreState {
  if (typeof persisted !== 'object' || persisted === null) {
    return current;
  }
  const saved = persisted as Partial<Record<keyof PersistedPanelState, unknown>>;
  const flag = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;
  return {
    ...current,
    showConsole: flag(saved.showConsole, current.showConsole),
    showLeftPanel: flag(saved.showLeftPanel, current.showLeftPanel),
    showRightPanel: flag(saved.showRightPanel, current.showRightPanel),
    sizes:
      Array.isArray(saved.sizes) && saved.sizes.length === current.sizes.length
        ? resolveNextSizes(saved.sizes, current.sizes)
        : current.sizes,
  };
}

export const usePanelLayoutStore = create<PanelLayoutStoreState>()(
  persistDurable(
    STORE_NAME,
    (set, get) => ({
      ...DEFAULT_STATE,
      openSettings: () => set({ activeTab: 'settings' }),
      setActiveTab: (tab: PanelTab) => set({ activeTab: tab }),
      setSizes: (sizes: number[]) => set({ sizes: resolveNextSizes(sizes, get().sizes) }),
      setState: (next: Partial<PanelLayoutStoreState>) => set(next),
      toggleConsole: () => set({ showConsole: !get().showConsole }),
      toggleLeft: () => set({ showLeftPanel: !get().showLeftPanel }),
      toggleRight: () => set({ showRightPanel: !get().showRightPanel }),
    }),
    {
      merge: mergePersistedLayout,
      partialize: (state): PersistedPanelState => ({
        showConsole: state.showConsole,
        showLeftPanel: state.showLeftPanel,
        showRightPanel: state.showRightPanel,
        sizes: state.sizes,
      }),
      version: STORE_VERSION,
    }
  )
);
