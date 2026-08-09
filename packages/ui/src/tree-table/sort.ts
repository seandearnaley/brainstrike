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
