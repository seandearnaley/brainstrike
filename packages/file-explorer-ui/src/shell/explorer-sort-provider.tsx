/**
 * Provider half of the Explorer sort context.
 *
 * Component-only by contract — see the boundary note in
 * `explorer-sort-context.ts`. Anything non-component added here breaks the Fast
 * Refresh boundary and trips `react-refresh/only-export-components`.
 */
import { useExplorerSortStateStore } from '@brainstrike/app-state/stores/explorer-sort-state-store';
import type { ReactNode } from 'react';
import { ExplorerSortContext } from './explorer-sort-context';

export function ExplorerSortProvider({ children }: { children: ReactNode }) {
  const sortState = useExplorerSortStateStore((state) => state.sortState);
  const setSortState = useExplorerSortStateStore((state) => state.setSortState);
  const value = { setSortState, sortState };
  return <ExplorerSortContext.Provider value={value}>{children}</ExplorerSortContext.Provider>;
}
