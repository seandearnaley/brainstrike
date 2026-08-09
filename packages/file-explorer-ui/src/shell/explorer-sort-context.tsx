/** Explorer-only bridge from the persisted global sort store to every tree section. */
import {
  type ExplorerSortState,
  useExplorerSortStateStore,
} from '@brainstrike/app-state/stores/explorer-sort-state-store';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

export interface ExplorerSortContextValue {
  setSortState: (sortState: ExplorerSortState | null) => void;
  sortState: ExplorerSortState | null;
}

const ExplorerSortContext = createContext<ExplorerSortContextValue | null>(null);

/** Null outside the Explorer panel: those TreeTable consumers do not own this capability. */
export function useOptionalExplorerSort(): ExplorerSortContextValue | null {
  return useContext(ExplorerSortContext);
}

export function ExplorerSortProvider({ children }: { children: ReactNode }) {
  const sortState = useExplorerSortStateStore((state) => state.sortState);
  const setSortState = useExplorerSortStateStore((state) => state.setSortState);
  const value = useMemo(() => ({ setSortState, sortState }), [setSortState, sortState]);
  return <ExplorerSortContext.Provider value={value}>{children}</ExplorerSortContext.Provider>;
}
