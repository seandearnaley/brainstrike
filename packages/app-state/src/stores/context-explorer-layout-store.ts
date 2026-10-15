import { createLogger } from '@brainstrike/logging';
import type { StorageAdapter } from '@brainstrike/storage';
import type { StateCreator } from 'zustand';
import { type PersistOptions, type PersistStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import {
  createAdapterPersistStorage,
  type PersistedLayoutStorageValue,
  resolveDefaultPersistStorage,
  resolveGlobalStoreSingleton,
} from './persisted-layout-store';

export type ExplorerActiveTab = 'explorer' | 'search';

/**
 * The Files app's Explorer|Search choice. The Files app is the explorer
 * (ADR-0021), so this is the only layout it persists.
 */
export interface ContextExplorerLayoutStoreState {
  /** Which surface the Files app shows: the file tree or search. */
  explorerActiveTab: ExplorerActiveTab;
  setExplorerActiveTab: (tab: ExplorerActiveTab) => void;
}

type PersistedContextExplorerLayoutState = Pick<
  ContextExplorerLayoutStoreState,
  'explorerActiveTab'
>;

// Note: STORE_NAME is intentionally frozen at '.v1' to prevent orphaning persisted layout
// data for existing users. The active schema version is tracked separately by STORE_VERSION.
const STORE_NAME = 'context-explorer-layout-store.v1' as const;
const STORE_VERSION = 3 as const;

const logger = createLogger('ContextExplorerLayoutStore');

/**
 * Only a known tab restores. A snapshot without one, including one written
 * before the tab existed, reads as the file tree; its panel fields are ignored.
 */
function parsePersistedLayoutState(
  raw: string | null
): PersistedLayoutStorageValue<PersistedContextExplorerLayoutState> | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (process.env['NODE_ENV'] !== 'production') {
      logger.warn('Ignoring invalid persisted layout state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
  const state =
    typeof parsed === 'object' && parsed !== null ? (parsed as { state?: unknown }).state : null;
  if (typeof state !== 'object' || state === null) {
    return null;
  }
  const tab = (state as { explorerActiveTab?: unknown }).explorerActiveTab;
  return {
    state: { explorerActiveTab: tab === 'search' ? 'search' : 'explorer' },
    version: STORE_VERSION,
  };
}

const creator: StateCreator<ContextExplorerLayoutStoreState, [['zustand/persist', unknown]], []> = (
  set
) => ({
  explorerActiveTab: 'explorer',
  setExplorerActiveTab: (explorerActiveTab: ExplorerActiveTab) => set({ explorerActiveTab }),
});

function persistOptions(
  storage: PersistStorage<Partial<PersistedContextExplorerLayoutState>>
): PersistOptions<ContextExplorerLayoutStoreState, Partial<PersistedContextExplorerLayoutState>> {
  return {
    name: STORE_NAME,
    partialize: (state): PersistedContextExplorerLayoutState => ({
      explorerActiveTab: state.explorerActiveTab,
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
