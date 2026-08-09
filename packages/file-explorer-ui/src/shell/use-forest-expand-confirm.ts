import { useCallback, useMemo, useState } from 'react';
import type { ForestTreeActionsValue } from './forest-tree-actions-context';

/**
 * Staged forest expand-all: sweeping every root's full subtree is I/O-heavy
 * and easy to trigger by accident, so the toolbar click only opens a confirm
 * dialog; the sweep starts on confirm. Single-root expand stays immediate.
 *
 * Lives in its own `use-*.ts` module rather than beside the toolbar components:
 * a hook export would keep file-explorer-panel-toolbar-helpers.tsx off the Fast
 * Refresh boundary, and its only consumer is the panel, not those components.
 */
export function useForestExpandConfirm(forestActions: ForestTreeActionsValue | null): {
  confirm: () => void;
  dismiss: () => void;
  isOpen: boolean;
  stage: () => void;
} {
  const [isOpen, setIsOpen] = useState(false);
  const stage = useCallback(() => setIsOpen(true), []);
  const dismiss = useCallback(() => setIsOpen(false), []);
  const confirm = useCallback(() => {
    setIsOpen(false);
    void forestActions?.runExpandAll();
  }, [forestActions]);
  // Memoized: this object feeds the toolbar's memoized expand-all callback.
  return useMemo(() => ({ confirm, dismiss, isOpen, stage }), [confirm, dismiss, isOpen, stage]);
}
