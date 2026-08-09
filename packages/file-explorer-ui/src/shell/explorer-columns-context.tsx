/**
 * Which Explorer tree-grid columns are actually rendered (BST-1208).
 *
 * Two inputs, one answer:
 *
 * 1. The persisted user preference (`explorer-column-visibility-store`).
 * 2. The panel's measured width. The Explorer is the narrowest surface in the
 *    app — its minimum is 180px — and a metadata column there costs the Name
 *    column the space it needs to be readable at all. Below
 *    `METADATA_COLUMNS_MIN_WIDTH` every metadata column is suppressed and the
 *    grid falls back to name-only.
 *
 * The threshold is the SAME number the toolbar uses to reveal the Columns
 * control (`@[300px]/explorer-toolbar`), and that is not a coincidence: below
 * it the right-hand toolbar track cannot host a fourth 28px control without
 * breaking the documented narrow-toolbar geometry
 * (docs/agents/explorer-search-tapestry.md). Tying them together means the
 * grid never shows a column the user has no way to turn off, and the control
 * never appears for columns the panel is too narrow to render.
 *
 * The resolved id array is CONTENT-stable — a resize that does not change the
 * answer keeps the same array identity, because that array keys the memo that
 * builds the `TreeTableColumn[]` flowing into `TreeTableRow`'s memo (the scroll
 * hot path).
 *
 * The context is optional: `OptimizedFileTree` renders in surfaces that never
 * mount this provider and shows the Name column alone there.
 */

import {
  EXPLORER_COLUMN_BOUNDS,
  type TreeTableColumnSizesStoreState,
  useExplorerColumnSizesStore,
} from '@brainstrike/app-state/stores/explorer-column-sizes-store';
import {
  type ExplorerMetadataColumnId,
  useExplorerColumnVisibilityStore,
} from '@brainstrike/app-state/stores/explorer-column-visibility-store';
import { createContext, type ReactNode, type RefObject, useContext, useMemo } from 'react';
import { useContainerWidth } from '../hooks/use-container-width';
import { EXPLORER_METADATA_COLUMN_CONFIGS } from '../tree/file-tree-columns';

/**
 * Below this container width the grid is name-only. At 300px the toolbar's
 * right track is ~136px — exactly four 28px controls with 4px gaps and the
 * 12px edge gutter — which is the narrowest width that can carry the Columns
 * control alongside Refresh, View Filters and Select All. Keep this in step
 * with the `@[300px]/explorer-toolbar` gate in `file-explorer-toolbar.tsx`.
 */
export const METADATA_COLUMNS_MIN_WIDTH = 300;

export interface ExplorerColumnsContextValue {
  /** True when the panel is too narrow for metadata columns, whatever the preference says. */
  areMetadataColumnsSuppressed: boolean;
  /**
   * RENDER widths for the metadata columns — the persisted widths shrunk to
   * fit the panel. Both the section tables and the panel-level forest header
   * read this one map, which is what keeps them in a single grid.
   */
  columnWidths: Record<string, number>;
  /** Rendered metadata columns, in canonical order. Content-stable identity. */
  visibleMetadataColumnIds: readonly ExplorerMetadataColumnId[];
}

const EMPTY_METADATA_COLUMN_IDS: readonly ExplorerMetadataColumnId[] = Object.freeze([]);
const EMPTY_COLUMN_WIDTHS: Record<string, number> = Object.freeze({});

const NAME_ONLY_COLUMNS: ExplorerColumnsContextValue = {
  areMetadataColumnsSuppressed: false,
  columnWidths: EMPTY_COLUMN_WIDTHS,
  visibleMetadataColumnIds: EMPTY_METADATA_COLUMN_IDS,
};

/**
 * Space the tree column keeps for itself. `table-fixed` gives Name whatever the
 * metadata columns leave over — including ZERO. At three columns dragged to
 * their 160px maximum inside a ~354px panel that is exactly what happened:
 * filenames vanished and the trailing column was clipped off-panel with no way
 * to scroll to it (the section wrapper is `overflow-hidden` by the TreeGrid
 * contract, so the overflow could not even become a scrollbar).
 */
const NAME_COLUMN_MIN_WIDTH = 120;

const ExplorerColumnsContext = createContext<ExplorerColumnsContextValue | null>(null);

/** Name-only when no provider is mounted — capability gating, not a fallback value. */
export function useExplorerColumns(): ExplorerColumnsContextValue {
  return useContext(ExplorerColumnsContext) ?? NAME_ONLY_COLUMNS;
}

export function resolveVisibleMetadataColumnIds(args: {
  isSuppressed: boolean;
  visibility: Record<ExplorerMetadataColumnId, boolean>;
}): readonly ExplorerMetadataColumnId[] {
  if (args.isSuppressed) {
    return EMPTY_METADATA_COLUMN_IDS;
  }
  const visible: ExplorerMetadataColumnId[] = [];
  for (const config of EXPLORER_METADATA_COLUMN_CONFIGS) {
    if (args.visibility[config.id]) {
      visible.push(config.id);
    }
  }
  return visible.length === 0 ? EMPTY_METADATA_COLUMN_IDS : visible;
}

/**
 * Retain the previous id array whenever the ANSWER is unchanged.
 *
 * This array is the memo key for the `TreeTableColumn[]` that flows into
 * `TreeTableRow`'s memo, so a fresh identity per call rebuilds every cell
 * closure and re-renders every visible row. `resolveVisibleMetadataColumnIds`
 * only returned a stable identity for the EMPTY case, which meant a panel-width
 * drag re-rendered the whole viewport once per pixel even though the visible
 * columns never changed.
 *
 * Keyed on CONTENT rather than identity, and rebuilt from the canonical config
 * list inside the memo — so the hook is pure. An earlier version cached the
 * previous array in a ref written during render; that is a render-phase
 * mutation React may replay or discard (`no-ref-current-in-render`), and it is
 * unnecessary here because the answer is a short, fully derivable list.
 */
function useStableColumnIds(
  next: readonly ExplorerMetadataColumnId[]
): readonly ExplorerMetadataColumnId[] {
  const contentKey = next.join('|');
  return useMemo(() => {
    if (contentKey === '') {
      return EMPTY_METADATA_COLUMN_IDS;
    }
    const included = new Set(contentKey.split('|'));
    // Config order IS the resolved order (`resolveVisibleMetadataColumnIds`
    // iterates the same list), so rebuilding here cannot reorder the grid.
    const rebuilt: ExplorerMetadataColumnId[] = [];
    for (const config of EXPLORER_METADATA_COLUMN_CONFIGS) {
      if (included.has(config.id)) {
        rebuilt.push(config.id);
      }
    }
    return rebuilt;
  }, [contentKey]);
}

/**
 * Shrink the persisted widths so the grid always fits the panel.
 *
 * This is a RENDER-TIME projection, never a mutation: the store keeps the width
 * the user chose, so widening the panel restores it. Columns shrink in
 * proportion to how much each asked for and never below their own `minWidth`;
 * when even the minimums do not fit, the minimums are returned (unreachable
 * above the 300px threshold, where 120 + 48 + 52 + 52 = 272 always fits).
 *
 * `availableWidth <= 0` means "not measured yet" and passes the widths through
 * untouched rather than guessing a layout for a panel we cannot see.
 */
export function resolveExplorerColumnWidths(args: {
  availableWidth: number;
  sizes: Record<string, number>;
  visibleMetadataColumnIds: readonly ExplorerMetadataColumnId[];
}): Record<string, number> {
  const { availableWidth, sizes, visibleMetadataColumnIds } = args;
  // A non-finite or non-positive width means "not measured yet"; laying the
  // grid out from a number we do not have would be a guess.
  if (
    visibleMetadataColumnIds.length === 0 ||
    !Number.isFinite(availableWidth) ||
    availableWidth <= 0
  ) {
    return sizes;
  }

  const desired = visibleMetadataColumnIds.map((columnId) => ({
    columnId,
    minWidth: EXPLORER_COLUMN_BOUNDS[columnId].minWidth,
    width: sizes[columnId] ?? EXPLORER_COLUMN_BOUNDS[columnId].defaultWidth,
  }));
  const budget = availableWidth - NAME_COLUMN_MIN_WIDTH;
  const desiredTotal = desired.reduce((total, column) => total + column.width, 0);
  if (desiredTotal <= budget) {
    return sizes;
  }

  const minimumTotal = desired.reduce((total, column) => total + column.minWidth, 0);
  // Preserve every entry the store holds (including hidden columns) so a later
  // persist cannot lose a width just because it was not on screen.
  const next: Record<string, number> = { ...sizes };
  if (minimumTotal >= budget) {
    for (const column of desired) {
      next[column.columnId] = column.minWidth;
    }
    return next;
  }

  // Distribute the shrink across the slack each column has above its minimum,
  // so a column already near its floor gives up proportionally less.
  const slackTotal = desiredTotal - minimumTotal;
  const overflow = desiredTotal - budget;
  for (const column of desired) {
    const slack = column.width - column.minWidth;
    next[column.columnId] = Math.max(
      column.minWidth,
      Math.round(column.width - (overflow * slack) / slackTotal)
    );
  }
  return next;
}

/**
 * @param containerRef - The element whose width decides the responsive step;
 *   the panel passes its tree area.
 */
export function useExplorerColumnsValue(
  containerRef: RefObject<HTMLElement | null>
): ExplorerColumnsContextValue {
  const size = useExplorerColumnVisibilityStore((state) => state.size);
  const tokens = useExplorerColumnVisibilityStore((state) => state.tokens);
  const type = useExplorerColumnVisibilityStore((state) => state.type);
  const sizes = useExplorerColumnSizesStore((state: TreeTableColumnSizesStoreState) => state.sizes);
  const containerWidth = useContainerWidth(containerRef);
  // Width 0 means "not measured yet" (first paint, or a hidden panel). Treat it
  // as roomy so the grid does not flash name-only before layout settles.
  const areMetadataColumnsSuppressed =
    containerWidth > 0 && containerWidth < METADATA_COLUMNS_MIN_WIDTH;

  // TWO stages on purpose. The id array decides which cell renderers exist and
  // must not churn on width; the widths change per pixel during a panel drag
  // and must not drag the cell renderers with them. Collapsing these into one
  // memo is what made a resize re-render every visible row.
  const visibleMetadataColumnIds = useStableColumnIds(
    resolveVisibleMetadataColumnIds({
      isSuppressed: areMetadataColumnsSuppressed,
      visibility: { size, tokens, type },
    })
  );
  const columnWidths = useMemo(
    () =>
      resolveExplorerColumnWidths({
        availableWidth: containerWidth,
        sizes,
        visibleMetadataColumnIds,
      }),
    [containerWidth, sizes, visibleMetadataColumnIds]
  );

  return useMemo(
    () => ({ areMetadataColumnsSuppressed, columnWidths, visibleMetadataColumnIds }),
    [areMetadataColumnsSuppressed, columnWidths, visibleMetadataColumnIds]
  );
}

export function ExplorerColumnsProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ExplorerColumnsContextValue;
}) {
  return (
    <ExplorerColumnsContext.Provider value={value}>{children}</ExplorerColumnsContext.Provider>
  );
}
