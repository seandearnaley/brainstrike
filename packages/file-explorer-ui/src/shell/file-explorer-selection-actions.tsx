import {
  type SelectionAction,
  SelectionActionBar,
  SelectionActionBarOverlay,
} from '@brainstrike/ui';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';

/**
 * The explorer bar is composition-only: every concrete action is injected by
 * the host (see `FileExplorerPanel`'s `selectionActions` prop), so the
 * declarative action list is always empty and can be a module constant.
 */
const NO_DECLARATIVE_ACTIONS: SelectionAction[] = [];

const SelectionActionBarPinContext = createContext<((pinned: boolean) => void) | null>(null);

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

  useEffect(() => {
    if (!(setPinned && shouldPin)) {
      return;
    }

    setPinned(true);
    return () => setPinned(false);
  }, [setPinned, shouldPin]);
}

export interface FileExplorerSelectionActionsProps {
  /** Drops the whole selection. */
  readonly onClear: () => void;
  /** Whole-forest selected file count. */
  readonly selectedCount: number;
  /**
   * Host-injected controls (and their transient panels). Rendered inside the
   * bar; absolutely positioned children anchor against the bar's wrapper.
   */
  readonly trailingContent?: ReactNode | undefined;
}

/**
 * The file explorer's ephemeral selection toolbar.
 *
 * It floats over the tree through `SelectionActionBarOverlay` so appearing and
 * disappearing never shifts a tree row — the scroll owner keeps the matching
 * bottom padding instead (see `FileExplorerPanel`).
 */
export function FileExplorerSelectionActions({
  onClear,
  selectedCount,
  trailingContent,
}: FileExplorerSelectionActionsProps): ReactElement | null {
  // Deliberately held HERE and not in FileExplorerPanel: the panel is the
  // tree's render hot path, and adding state to it makes an injected action's
  // pin re-render the whole tree (and re-fire its effects). This component
  // renders unconditionally, so it can own the latch cheaply.
  const [pinned, setPinned] = useState(false);

  // The provider must sit OUTSIDE the visibility branch so a pinned action can
  // keep asking to stay open; the branch below is what actually unmounts it.
  return (
    <SelectionActionBarPinContext.Provider value={setPinned}>
      {selectedCount > 0 || pinned ? (
        <SelectionActionBarOverlay className="flex justify-center px-3">
          {/* Positioned ancestor for transient panels raised by injected actions
              (e.g. the import progress bar), and the explicit available width the
              compact toolbar's container queries need. */}
          <div className="relative w-full max-w-3xl" data-testid="explorer-selection-actions">
            <SelectionActionBar
              actions={NO_DECLARATIVE_ACTIONS}
              ariaLabel="File selection actions"
              className="pointer-events-auto w-full"
              clearButtonAriaLabel="Clear file selection"
              compact
              onClear={onClear}
              summary={`${selectedCount.toLocaleString()} ${selectedCount === 1 ? 'file' : 'files'} selected`}
              trailingContent={trailingContent}
            />
          </div>
        </SelectionActionBarOverlay>
      ) : null}
    </SelectionActionBarPinContext.Provider>
  );
}

FileExplorerSelectionActions.displayName = 'FileExplorerSelectionActions';
