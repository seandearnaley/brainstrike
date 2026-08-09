/**
 * Pin contract for the Explorer's selection action bar.
 *
 * Split out of `file-explorer-selection-actions.tsx` for the Fast Refresh
 * boundary (BST-1220): `react-refresh/only-export-components` fires on a module
 * exporting a component alongside a hook, and the rule does not scan `.ts` at
 * all — the same shape `file-explorer-panel-toolbar-logic.ts` uses. The context
 * lives here rather than beside the component because an exported
 * `createContext` binding is itself a non-component export.
 */
import { createContext, useContext, useEffect } from 'react';

export const SelectionActionBarPinContext = createContext<((pinned: boolean) => void) | null>(null);

/**
 * Holds the selection bar open while an injected action has work in flight,
 * even after the selection itself drops to zero.
 *
 * This is a LIFETIME contract, not a cosmetic one. Injected actions are
 * children of the bar, so hiding the bar unmounts them — and an action that
 * owns a long-running service (the collection import) would tear that service
 * down mid-run, taking its progress UI and its share of app-wide activity
 * state with it. Pinning keeps the subtree mounted until the work is done.
 *
 * Single-consumer by design: the explorer bar hosts exactly one injected
 * action. A second consumer would race this boolean.
 */
export function useSelectionActionBarPin(shouldPin: boolean): void {
  const setPinned = useContext(SelectionActionBarPinContext);

  if (!setPinned) {
    throw new Error(
      'useSelectionActionBarPin must be used within FileExplorerSelectionActions. ' +
        'A silent no-op here would let a long-running action be unmounted mid-flight.'
    );
  }

  useEffect(() => {
    if (!shouldPin) {
      return;
    }

    setPinned(true);
    return () => setPinned(false);
  }, [setPinned, shouldPin]);
}
