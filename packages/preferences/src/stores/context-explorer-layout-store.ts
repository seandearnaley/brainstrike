import type { StorageAdapter } from '@brainstrike/storage';
import { createBrowserStorageAdapter } from '@brainstrike/storage';
import { createLogger } from '@brainstrike/utils';
import type { StateCreator } from 'zustand';
import { type PersistOptions, type PersistStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export interface ContextExplorerLayoutStoreState {
  setSizes: (sizes: number[]) => void;
  setState: (next: Partial<ContextExplorerLayoutStoreState>) => void;
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  sizes: [number, number, number];
  toggleConsole: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
}

const DEFAULT_STATE: Omit<
  ContextExplorerLayoutStoreState,
  'setSizes' | 'toggleLeft' | 'toggleRight' | 'toggleConsole' | 'setState'
> = {
  sizes: [25, 20, 20],
  showLeftPanel: true,
  showRightPanel: false,
  showConsole: false,
};

const STORE_NAME = 'context-explorer-layout-store.v1' as const;
const STORE_VERSION = 1 as const;
const MIN_PANEL_SIZE = 10;
const logger = createLogger('ContextExplorerLayoutStore');

const creator: StateCreator<ContextExplorerLayoutStoreState, [['zustand/persist', unknown]], []> = (
  set,
  get
) => ({
  ...DEFAULT_STATE,

  setSizes: (sizes: number[]) => {
    const normalized = normalizeSizes(sizes);
    const next: Partial<ContextExplorerLayoutStoreState> = {
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
  setState: (next: Partial<ContextExplorerLayoutStoreState>) => set(next),
});

type PersistedContextExplorerLayoutState = Pick<
  ContextExplorerLayoutStoreState,
  'sizes' | 'showLeftPanel' | 'showRightPanel' | 'showConsole'
>;
interface PersistedContextExplorerStorageValue {
  state: PersistedContextExplorerLayoutState;
  version: number;
}

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

function parsePersistedPanelState(raw: string | null): PersistedContextExplorerStorageValue | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      state?: PersistedContextExplorerLayoutState;
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
      logger.warn('Ignoring invalid persisted context explorer layout state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

function createAdapterPersistStorage(
  storage: StorageAdapter
): PersistStorage<PersistedContextExplorerLayoutState> {
  return {
    getItem: async (name: string) => parsePersistedPanelState(await storage.getItem(name)),
    setItem: async (name: string, value) => {
      await storage.setItem(name, JSON.stringify(value));
    },
    removeItem: async (name: string) => {
      await storage.removeItem(name);
    },
  };
}

function createFallbackPersistStorage(): PersistStorage<PersistedContextExplorerLayoutState> {
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
  storage: PersistStorage<PersistedContextExplorerLayoutState>
): PersistOptions<ContextExplorerLayoutStoreState, PersistedContextExplorerLayoutState> {
  return {
    name: STORE_NAME,
    version: STORE_VERSION,
    storage,
    partialize: (state): PersistedContextExplorerLayoutState => ({
      sizes: state.sizes,
      showLeftPanel: state.showLeftPanel,
      showRightPanel: state.showRightPanel,
      showConsole: state.showConsole,
    }),
    migrate: (persistedState) => persistedState as PersistedContextExplorerLayoutState,
  };
}

export function createContextExplorerLayoutStore(storage: StorageAdapter) {
  return createContextExplorerLayoutStoreWithPersistStorage(createAdapterPersistStorage(storage));
}

function createContextExplorerLayoutStoreWithPersistStorage(
  storage: PersistStorage<PersistedContextExplorerLayoutState>
) {
  return create<ContextExplorerLayoutStoreState>()(persist(creator, persistOptions(storage)));
}

const GLOBAL_KEY = '__brainstrike_context_explorer_layout_store__' as const;
const BRAND = '__brainstrike_store_brand__';
const BRAND_VERSION = 1 as const;
const g = globalThis as unknown as Record<string, unknown>;

type BoundStore = ReturnType<ReturnType<typeof create<ContextExplorerLayoutStoreState>>>;

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
  let storage: PersistStorage<PersistedContextExplorerLayoutState>;
  try {
    storage = createAdapterPersistStorage(createBrowserStorageAdapter());
  } catch {
    storage = createFallbackPersistStorage();
  }

  singleton = createContextExplorerLayoutStoreWithPersistStorage(storage);
  (singleton as Record<string, unknown>)[BRAND] = BRAND_VERSION;
  g[GLOBAL_KEY] = singleton as unknown;
}

export const useContextExplorerLayoutStore = singleton as BoundStore;

function normalizeSizes(sizes: number[]): number[] {
  if (!sizes || sizes.length === 0) {
    return [];
  }

  const clamped = sizes.map((size) => {
    const num = typeof size === 'number' && !Number.isNaN(size) ? size : 0;
    return Math.max(0, Math.min(100, num));
  });

  const hasCorruptedValues = clamped.some((size) => size > 0 && size < MIN_PANEL_SIZE);
  if (hasCorruptedValues) {
    return [DEFAULT_STATE.sizes[0], DEFAULT_STATE.sizes[1], DEFAULT_STATE.sizes[2]];
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
