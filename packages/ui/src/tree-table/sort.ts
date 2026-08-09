import type { SortDirection, SortState } from './types';

/** Shared TreeTable aria-sort projection for built-in and external headers. */
export function getTreeTableAriaSortValue(
  columnId: string,
  sortState?: SortState
): 'ascending' | 'descending' | 'none' | undefined {
  if (!sortState || sortState.columnId !== columnId) {
    return;
  }
  if (sortState.direction === 'asc') {
    return 'ascending';
  }
  if (sortState.direction === 'desc') {
    return 'descending';
  }
  return 'none';
}

/**
 * Accessible label for a sort control, announcing the current state and the
 * action a press performs. Shared by TreeTable's built-in header and external
 * panel-level headers (the Explorer forest header) so both surfaces announce
 * the same contract.
 */
export function getTreeTableSortButtonLabel(
  label: string,
  columnId: string,
  sortState?: SortState
): string {
  if (!sortState || sortState.columnId !== columnId || sortState.direction === null) {
    return `${label}: sort ascending`;
  }
  return sortState.direction === 'asc'
    ? `${label}: sorted ascending; sort descending`
    : `${label}: sorted descending; restore default order`;
}

/** TreeTable's canonical asc -> desc -> default cycle. */
export function getNextTreeTableSortDirection(current: SortDirection): SortDirection {
  if (current === 'asc') {
    return 'desc';
  }
  if (current === 'desc') {
    return null;
  }
  return 'asc';
}
