/**
 * Panel Layout Store
 *
 * Canonical source of truth for the app-wide agent shell layout and root tab state.
 * - sizes: [left, right, console] as percentages (0..100), normalized on write
 * - visibility flags: showLeftPanel/showRightPanel/showConsole
 * - activeTab: 'explorer' | 'settings' | 'prompts'
 *
 * Persistence: uses `@brainstrike/storage` adapters; persisted subset only.
 * Integration: use with `PanelLayoutProvider` in controlled mode (pass state + onChange).
 */
import type { StorageAdapter } from '@brainstrike/storage';
import { createBrowserStorageAdapter } from '@brainstrike/storage';
import { createLogger } from '@brainstrike/utils';
import type { StateCreator } from 'zustand';
import { type PersistOptions, type PersistStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export type PanelTab = 'agent-hub' | 'explorer' | 'prompts' | 'settings';

export interface PanelLayoutStoreState {
  // Root tabs
  activeTab: PanelTab;
  setActiveTab: (tab: PanelTab) => void;

  // Actions
  setSizes: (sizes: number[]) => void;
  setState: (next: Partial<PanelLayoutStoreState>) => void;
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  // Layout
  sizes: [number, number, number];
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
  'setSizes' | 'toggleLeft' | 'toggleRight' | 'toggleConsole' | 'setActiveTab' | 'setState'
> = {
  sizes: [18, 40, 20],
  showLeftPanel: true,
  showRightPanel: true,
  showConsole: false,
  activeTab: 'explorer',
};

const STORE_NAME = 'panel-layout-store.v1' as const;
const STORE_VERSION = 4 as const;

/**
 * Minimum panel sizes to prevent corrupted tiny values.
 * Panels smaller than this threshold are considered corrupted and reset to defaults.
 */
const MIN_PANEL_SIZE = 10;
const logger = createLogger('PanelLayoutStore');

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
interface PersistedPanelStorageValue {
  state: PersistedPanelState;
  version: number;
}

/**
 * Check if sizes array contains corrupted values (non-zero but below minimum).
 */
function hasCorruptedSizes(sizes: unknown): boolean {
  if (!Array.isArray(sizes) || sizes.length !== DEFAULT_STATE.sizes.length) {
    return true;
  }
  return sizes.some(
    (size) =>
      typeof size !== 'number' ||
      Number.isNaN(size) ||
      size < 0 ||
      (size > 0 && size < MIN_PANEL_SIZE)
  );
}

function parsePersistedPanelState(raw: string | null): PersistedPanelStorageValue | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      state?: PersistedPanelState;
      version?: number;
    };
    const state = parsed?.state;
    if (!state) {
      return null;
    }
    const version = typeof parsed.version === 'number' ? parsed.version : 0;
    if (state.sizes && hasCorruptedSizes(state.sizes)) {
      return {
        state: {
          ...state,
          sizes: [...DEFAULT_STATE.sizes] as [number, number, number],
        },
        version,
      };
    }
    return { state, version };
  } catch (error) {
    if (process.env['NODE_ENV'] !== 'production') {
      logger.warn('Ignoring invalid persisted panel layout state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

function createAdapterPersistStorage(storage: StorageAdapter): PersistStorage<PersistedPanelState> {
  return {
    // Adapter-backed storage remains async, so this hydration path resolves on a later microtask.
    // The fallback storage stays synchronous for direct localStorage environments.
    getItem: async (name: string) => parsePersistedPanelState(await storage.getItem(name)),
    setItem: async (name: string, value) => {
      await storage.setItem(name, JSON.stringify(value));
    },
    removeItem: async (name: string) => {
      await storage.removeItem(name);
    },
  };
}

function createFallbackPersistStorage(): PersistStorage<PersistedPanelState> {
  const memoryStorage = new Map<string, string>();

  const getBrowserStorage = (): Storage | null => {
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };

  const readRaw = (name: string): string | null => {
    const browserStorage = getBrowserStorage();
    if (browserStorage) {
      return browserStorage.getItem(name);
    }
    return memoryStorage.get(name) ?? null;
  };

  const writeRaw = (name: string, value: string): void => {
    const browserStorage = getBrowserStorage();
    if (browserStorage) {
      browserStorage.setItem(name, value);
      return;
    }
    memoryStorage.set(name, value);
  };

  const removeRaw = (name: string): void => {
    const browserStorage = getBrowserStorage();
    if (browserStorage) {
      browserStorage.removeItem(name);
      return;
    }
    memoryStorage.delete(name);
  };

  return {
    getItem: (name: string) => parsePersistedPanelState(readRaw(name)),
    setItem: (name: string, value) => {
      writeRaw(name, JSON.stringify(value));
    },
    removeItem: (name: string) => {
      removeRaw(name);
    },
  };
}

function persistOptions(
  storage: PersistStorage<PersistedPanelState>
): PersistOptions<PanelLayoutStoreState, PersistedPanelState> {
  return {
    name: STORE_NAME,
    version: STORE_VERSION,
    storage,
    partialize: (state): PersistedPanelState => ({
      sizes: state.sizes,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
      showConsole: state.showConsole,
    }),
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
  };
}

export function createPanelLayoutStore(storage: StorageAdapter) {
  return createPanelLayoutStoreWithPersistStorage(createAdapterPersistStorage(storage));
}

function createPanelLayoutStoreWithPersistStorage(storage: PersistStorage<PersistedPanelState>) {
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
  let storage: PersistStorage<PersistedPanelState>;
  try {
    storage = createAdapterPersistStorage(createBrowserStorageAdapter());
  } catch {
    storage = createFallbackPersistStorage();
  }

  singleton = createPanelLayoutStoreWithPersistStorage(storage);
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
