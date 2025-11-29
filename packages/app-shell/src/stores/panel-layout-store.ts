/**
 * Panel Layout Store
 *
 * Canonical source of truth for IDE panel layout and root tab state.
 * - sizes: [left, right, console] as percentages (0..100), normalized on write
 * - visibility flags: showLeftPanel/showRightPanel/showConsole
 * - activeTab: 'explorer' | 'settings'
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

const DEFAULT_STATE: Omit<
  PanelLayoutStoreState,
  'setSizes' | 'toggleLeft' | 'toggleRight' | 'toggleConsole' | 'setActiveTab' | 'setState'
> = {
  sizes: [25, 55, 20],
  showLeftPanel: true,
  showRightPanel: false,
  showConsole: false,
  activeTab: 'explorer',
};

const STORE_NAME = 'panel-layout-store.v1' as const;

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

function persistOptions(
  storage: StorageAdapter
): PersistOptions<PanelLayoutStoreState, PersistedPanelState> {
  return {
    name: STORE_NAME,
    version: 1,
    storage: {
      getItem: async (name: string) => {
        const raw = await storage.getItem(name);
        return raw ? JSON.parse(raw) : null;
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
  if (!candidate || typeof candidate !== 'function') return false;
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

// Local helper (duplicated from UI package to avoid private imports)
function normalizeSizes(sizes: number[]): number[] {
  if (!sizes || sizes.length === 0) return [];

  const clamped = sizes.map((size) => {
    const num = typeof size === 'number' && !Number.isNaN(size) ? size : 0;
    return Math.max(0, Math.min(100, num));
  });

  const total = clamped.reduce((sum, size) => sum + size, 0);
  if (total === 0) return clamped.map(() => 100 / clamped.length);
  if (total > 100) return clamped.map((s) => (s / total) * 100);
  return clamped;
}
