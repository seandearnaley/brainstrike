/**
 * Explorer-only bridge from the persisted global sort store to every tree section.
 *
 * Context + hook live in this `.ts`; the Provider component lives in
 * `explorer-sort-provider.tsx`. That split is the Fast Refresh boundary rule
 * (BST-1220): `react-refresh/only-export-components` fires on any module that
 * exports a component ALONGSIDE a hook or plain function, and re-evaluating the
 * module gives every exported function a fresh identity, costing the panel a
 * full reload on each edit. Keeping the non-component half in a `.ts` is the
 * same shape `file-explorer-panel-toolbar-logic.ts` and
 * `use-forest-expand-confirm.ts` already use. The context object has to move
 * with the hook rather than stay beside the Provider: an exported
 * `createContext` binding is itself a non-component export and would keep the
 * provider module flagged.
 */
import type { ExplorerSortState } from '@brainstrike/app-state/stores/explorer-sort-state-store';
import { createContext, useContext } from 'react';

export interface ExplorerSortContextValue {
  setSortState: (sortState: ExplorerSortState | null) => void;
  sortState: ExplorerSortState | null;
}

export const ExplorerSortContext = createContext<ExplorerSortContextValue | null>(null);

/** Null outside the Explorer panel: those TreeTable consumers do not own this capability. */
export function useOptionalExplorerSort(): ExplorerSortContextValue | null {
  return useContext(ExplorerSortContext);
}
