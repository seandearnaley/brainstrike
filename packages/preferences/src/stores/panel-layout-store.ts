/**
 * Panel Layout Store
 *
 * Canonical source of truth for IDE panel layout and root tab state.
 * - sizes: [left, right, console] as percentages (0..100), normalized on write
 * - visibility flags: showLeftPanel/showRightPanel/showConsole
 * - activeTab: 'explorer' | 'settings' | 'prompts'
 *
 * Persistence: uses `@brainstrike/storage` adapters; persisted subset only.
 * Integration: use with `PanelLayoutProvider` in controlled mode (pass state + onChange).
 */
import type { StorageAdapter } from '@brainstrike/storage';
import {
  createMemoryStorageAdapter,
  createStorageAdapter,
  detectPlatform,
} from '@brainstrike/storage';
import type { StateCreator } from 'zustand';
import { type PersistOptions, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type PanelTab = 'explorer' | 'settings' | 'prompts';

export interface PanelLayoutStoreState {
  // Layout
  sizes: [number, number, number];
  showLeftPanel: boolean;
  showRightPanel: boolean;
  showConsole: boolean;

  // Root tabs
  activeTab: PanelTab;

  // Actions
  setSizes: (sizes: number[]) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleConsole: () => void;
  setActiveTab: (tab: PanelTab) => void;
  setState: (next: Partial<PanelLayoutStoreState>) => void;
}

/**
 * Default panel sizes: [leftPanel, rightPanel, consolePanel]
 * - leftPanel (explorer): 25% of horizontal space
 * - rightPanel (tools): 20% of horizontal space
 * - consolePanel: 20% of vertical space (when visible)
 *
 * Note: The middle panel size is calculated dynamically as: 100 - left - right
 */
const DEFAULT_STATE: Omit<
  PanelLayoutStoreState,
  'setSizes' | 'toggleLeft' | 'toggleRight' | 'toggleConsole' | 'setActiveTab' | 'setState'
> = {
  sizes: [25, 20, 20],
  showLeftPanel: true,
  showRightPanel: false,
  showConsole: false,
  activeTab: 'explorer',
};

// Note: The '.v1' suffix is a storage key identifier, not a schema version.
// Schema versioning is handled by the persist middleware's `version` field.
const STORE_NAME = 'panel-layout-store.v1' as const;

/**
 * Minimum panel sizes to prevent corrupted tiny values.
 * Panels smaller than this threshold are considered corrupted and reset to defaults.
 */
const MIN_PANEL_SIZE = 10;

const creator: StateCreator<PanelLayoutStoreState, [['zustand/persist', unknown]], []> = (
  set,
  get
) => ({
  ...DEFAULT_STATE,

  setSizes: (sizes: number[]) => {
    const normalized = normalizeSizes(sizes);
    const next: Partial<PanelLayoutStoreState> = {
      sizes: [
        (normalized[0] as number | undefined) ?? get().sizes[0],
        (normalized[1] as number | undefined) ?? get().sizes[1],
        (normalized[2] as number | undefined) ?? get().sizes[2],
      ] as [number, number, number],
    };
    set(next);
  },

  toggleLeft: () => set({ showLeftPanel: !get().showLeftPanel }),
  toggleRight: () => set({ showRightPanel: !get().showRightPanel }),
  toggleConsole: () => set({ showConsole: !get().showConsole }),

  setActiveTab: (tab: PanelTab) => set({ activeTab: tab }),

  setState: (next: Partial<PanelLayoutStoreState>) => set(next),
});

type PersistedPanelState = Pick<
  PanelLayoutStoreState,
  'sizes' | 'showLeftPanel' | 'showRightPanel' | 'showConsole'
>;

/**
 * Check if sizes array contains corrupted values (non-zero but below minimum).
 */
function hasCorruptedSizes(sizes: unknown): boolean {
  if (!Array.isArray(sizes)) {
    return true;
  }
  return sizes.some((size) => typeof size === 'number' && size > 0 && size < MIN_PANEL_SIZE);
}

function persistOptions(
  storage: StorageAdapter
): PersistOptions<PanelLayoutStoreState, PersistedPanelState> {
  return {
    name: STORE_NAME,
    version: 2, // Bump version to trigger migration from v1 corrupted data
    storage: {
      getItem: async (name: string) => {
        const raw = await storage.getItem(name);
        if (!raw) {
          return null;
        }
        try {
          const parsed = JSON.parse(raw);
          // Validate and fix corrupted sizes on load
          if (parsed?.state?.sizes && hasCorruptedSizes(parsed.state.sizes)) {
            parsed.state.sizes = [...DEFAULT_STATE.sizes];
          }
          return parsed;
        } catch {
          // Corrupted storage - return null to use default state
          return null;
        }
      },
      setItem: async (name: string, value: unknown) => {
        await storage.setItem(name, JSON.stringify(value));
      },
      removeItem: async (name: string) => {
        await storage.removeItem(name);
      },
    },
    partialize: (state): PersistedPanelState => ({
      sizes: state.sizes,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
      showConsole: state.showConsole,
    }),
    migrate: (persistedState, version) => {
      // Migration from v1: Fix corrupted sizes format
      if (version < 2) {
        const state = persistedState as PersistedPanelState;
        if (state?.sizes && hasCorruptedSizes(state.sizes)) {
          state.sizes = [...DEFAULT_STATE.sizes] as [number, number, number];
        }
      }
      return persistedState as PersistedPanelState;
    },
  };
}

export function createPanelLayoutStore(storage: StorageAdapter) {
  return create<PanelLayoutStoreState>()(persist(creator, persistOptions(storage)));
}

// HMR-safe default instance
const GLOBAL_KEY = '__brainstrike_panel_layout_store__' as const;
const BRAND = '__brainstrike_store_brand__';
const BRAND_VERSION = 1 as const;
const g = globalThis as unknown as Record<string, unknown>;

type BoundStore = ReturnType<ReturnType<typeof create<PanelLayoutStoreState>>>;

function isValidStore(candidate: unknown): candidate is BoundStore & { [k: string]: unknown } {
  if (!candidate || typeof candidate !== 'function') {
    return false;
  }
  const fn = candidate as unknown as {
    getState?: unknown;
    setState?: unknown;
    [k: string]: unknown;
  };
  const ok = typeof fn.getState === 'function' && typeof fn.setState === 'function';
  return ok && fn[BRAND] === BRAND_VERSION;
}

let singleton = g[GLOBAL_KEY] as unknown;

if (!isValidStore(singleton)) {
  let adapter: StorageAdapter;
  try {
    const platform = detectPlatform();
    adapter = createStorageAdapter(platform);
  } catch {
    adapter = createMemoryStorageAdapter();
  }

  singleton = createPanelLayoutStore(adapter);
  (singleton as Record<string, unknown>)[BRAND] = BRAND_VERSION;
  g[GLOBAL_KEY] = singleton as unknown;
}

export const usePanelLayoutStore = singleton as BoundStore;

/**
 * Normalize panel sizes, enforcing minimum thresholds for visible panels.
 * Sizes below MIN_PANEL_SIZE are considered corrupted and trigger a reset to defaults.
 *
 * @param sizes - Array of panel sizes [left, right, console]
 * @returns Normalized sizes with valid values
 */
function normalizeSizes(sizes: number[]): number[] {
  if (!sizes || sizes.length === 0) {
    return [];
  }

  const clamped = sizes.map((size) => {
    const num = typeof size === 'number' && !Number.isNaN(size) ? size : 0;
    return Math.max(0, Math.min(100, num));
  });

  // Check for corrupted values (non-zero but below minimum threshold)
  // This catches cases like [4.488, 5.386, 0] from corrupted localStorage
  const hasCorruptedValues = clamped.some((size) => size > 0 && size < MIN_PANEL_SIZE);

  if (hasCorruptedValues) {
    // Return defaults for corrupted state
    return [DEFAULT_STATE.sizes[0], DEFAULT_STATE.sizes[1], DEFAULT_STATE.sizes[2]];
  }

  const total = clamped.reduce((sum, size) => sum + size, 0);
  if (total === 0) {
    return clamped.map(() => 100 / clamped.length);
  }
  if (total > 100) {
    return clamped.map((s) => (s / total) * 100);
  }
  return clamped;
}
