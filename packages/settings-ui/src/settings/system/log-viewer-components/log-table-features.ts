/**
 * TanStack Table v9 feature registration for the log viewer, defined ONCE at
 * module scope (per upstream guidance) so every log-viewer component can name
 * the same `TFeatures` type. v9 makes every non-core capability an explicit
 * opt-in plugin and moves row-model factories into feature slots — the core
 * row model itself is automatic. The sortable timestamp column is numeric, so
 * the `'auto'` sort resolution falls through to the built-in `sortFn_basic`
 * and no `sortFns` registry is needed.
 */
import {
  columnSizingFeature,
  columnVisibilityFeature,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
} from '@tanstack/react-table';

// columnSizingFeature: v9 gates the per-column `size` option and
// `column.getSize()` (the header-width source in log-list.tsx) behind it.
export const logTableFeatures = tableFeatures({
  columnSizingFeature,
  columnVisibilityFeature,
  paginatedRowModel: createPaginatedRowModel(),
  rowPaginationFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

export type LogTableFeatures = typeof logTableFeatures;
