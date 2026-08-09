import {
  type SelectionAction,
  SelectionActionBar,
  SelectionActionBarOverlay,
} from '@brainstrike/ui';
import type { ReactElement, ReactNode } from 'react';

/**
 * The explorer bar is composition-only: every concrete action is injected by
 * the host (see `FileExplorerPanel`'s `selectionActions` prop), so the
 * declarative action list is always empty and can be a module constant.
 */
const NO_DECLARATIVE_ACTIONS: SelectionAction[] = [];

export interface FileExplorerSelectionActionsProps {
  /** Drops the whole selection. */
  readonly onClear: () => void;
  /** Whole-forest selected file count. The bar is absent at zero. */
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
  if (selectedCount === 0) {
    return null;
  }

  return (
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
  );
}

FileExplorerSelectionActions.displayName = 'FileExplorerSelectionActions';
