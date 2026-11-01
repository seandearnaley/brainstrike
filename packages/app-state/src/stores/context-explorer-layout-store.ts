import { persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';

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

export const useContextExplorerLayoutStore = create<ContextExplorerLayoutStoreState>()(
  persistDurable(
    'brainstrike:context-explorer-layout-store.v1',
    (set) => ({
      explorerActiveTab: 'explorer',
      setExplorerActiveTab: (explorerActiveTab: ExplorerActiveTab) => set({ explorerActiveTab }),
    }),
    {
      // Only a known tab restores; anything else reads as the file tree.
      merge: (persisted, current) => ({
        ...current,
        explorerActiveTab:
          (persisted as { explorerActiveTab?: unknown } | undefined)?.explorerActiveTab === 'search'
            ? 'search'
            : 'explorer',
      }),
      partialize: (state) => ({ explorerActiveTab: state.explorerActiveTab }),
      version: 1,
    }
  )
);
