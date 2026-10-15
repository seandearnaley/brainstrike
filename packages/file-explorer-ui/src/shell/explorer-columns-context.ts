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

/**
 * Boundary note (BST-1220): the Provider component lives in
 * `explorer-columns-provider.tsx`. `react-refresh/only-export-components` fires
 * on any module exporting a component ALONGSIDE hooks or plain functions, and
 * this module is mostly the latter. The rule does not scan `.ts` at all, which
 * is why the non-component half keeps that extension — the same shape
 * `file-explorer-panel-toolbar-logic.ts` uses. The context object moves with
 * the hooks rather than staying beside the Provider: an exported
 * `createContext` binding is itself a non-component export.
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
import { createContext, type RefObject, useContext, useMemo } from 'react';
import { useContainerWidth } from '../hooks/use-container-width';
import { EXPLORER_METADATA_COLUMN_CONFIGS } from '../tree/file-tree-columns';
import { useOptionalExplorerThreadStatus } from './explorer-thread-status';

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

export const ExplorerColumnsContext = createContext<ExplorerColumnsContextValue | null>(null);

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
 * Content-address the render-width projection so a fresh source-map identity
 * cannot repaint consumers when every column still resolves to the same pixel.
 */
function serializeColumnWidths(widths: Record<string, number>): string {
  return Object.entries(widths)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([columnId, width]) => `${encodeURIComponent(columnId)}:${width}`)
    .join('|');
}

/** Rebuild an identity-stable width map from the validated internal key. */
function deserializeColumnWidths(contentKey: string): Record<string, number> {
  if (contentKey === '') {
    return EMPTY_COLUMN_WIDTHS;
  }
  const widths: Record<string, number> = {};
  for (const entry of contentKey.split('|')) {
    const separatorIndex = entry.lastIndexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(`Malformed Explorer column-width key: ${entry}`);
    }
    const columnId = decodeURIComponent(entry.slice(0, separatorIndex));
    const width = Number(entry.slice(separatorIndex + 1));
    if (!Number.isFinite(width)) {
      throw new Error(`Malformed Explorer column width for "${columnId}": ${width}`);
    }
    widths[columnId] = width;
  }
  return widths;
}

/**
 * Shrink the persisted widths so the grid always fits the panel.
 *
 * This is a RENDER-TIME projection, never a mutation: the store keeps the width
 * the user chose, so widening the panel restores it. Columns shrink in
 * proportion to how much each asked for and never below their own `minWidth`;
 * when even the minimums do not fit, the minimums are returned (unreachable
 * above the 300px threshold, where 120 + 28 + 48 + 52 + 52 = 300 always fits).
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
  // so a column already near its floor gives up proportionally less. Floor the
  // individual targets first, then hand the remaining whole pixels to the
  // largest fractional remainders. Independent Math.round calls can all round
  // upward and exceed the shared panel budget.
  const slackTotal = desiredTotal - minimumTotal;
  const overflow = desiredTotal - budget;
  const targets = desired.map((column, index) => {
    const slack = column.width - column.minWidth;
    const exactWidth = Math.max(column.minWidth, column.width - (overflow * slack) / slackTotal);
    const flooredWidth = Math.floor(exactWidth);
    next[column.columnId] = flooredWidth;
    return {
      columnId: column.columnId,
      fractionalRemainder: exactWidth - flooredWidth,
      index,
    };
  });
  const flooredTotal = targets.reduce((total, target) => total + (next[target.columnId] ?? 0), 0);
  const remainingPixels = Math.max(0, Math.floor(budget - flooredTotal));
  const largestRemainders = [...targets].sort(
    (a, b) => b.fractionalRemainder - a.fractionalRemainder || a.index - b.index
  );
  for (const target of largestRemainders.slice(0, remainingPixels)) {
    next[target.columnId] = (next[target.columnId] ?? 0) + 1;
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
  const thread = useExplorerColumnVisibilityStore((state) => state.thread);
  const tokens = useExplorerColumnVisibilityStore((state) => state.tokens);
  const type = useExplorerColumnVisibilityStore((state) => state.type);
  // "This thread" exists only where the active thread's context is published.
  const threadAvailable = useOptionalExplorerThreadStatus() !== null;
  const sizes = useExplorerColumnSizesStore((state: TreeTableColumnSizesStoreState) => state.sizes);
  const containerWidth = useContainerWidth(containerRef);
  // Width 0 means "not measured yet" (first paint, or a hidden panel), and the
  // narrow answer is the one to guess with (whole-branch review F10).
  //
  // Treating it as ROOMY flashed the metadata columns ON for one frame in every
  // panel too narrow to keep them: the grid painted three columns, the first
  // ResizeObserver callback took them away, and `table-fixed` re-laid the Name
  // column across the full width — a visible jolt on the app's most-used panel.
  // The opposite guess costs at most one frame of name-only in a WIDE panel,
  // where the columns then simply appear; nothing is re-laid out under the
  // pointer, because the Name column only ever gives space back.
  const areMetadataColumnsSuppressed = containerWidth < METADATA_COLUMNS_MIN_WIDTH;

  // TWO stages on purpose. The id array decides which cell renderers exist and
  // must not churn on width; the widths change per pixel during a panel drag
  // and must not drag the cell renderers with them. Collapsing these into one
  // memo is what made a resize re-render every visible row.
  const visibleMetadataColumnIds = useStableColumnIds(
    resolveVisibleMetadataColumnIds({
      isSuppressed: areMetadataColumnsSuppressed,
      visibility: { size, thread: thread && threadAvailable, tokens, type },
    })
  );
  const resolvedColumnWidths = useMemo(
    () =>
      resolveExplorerColumnWidths({
        availableWidth: containerWidth,
        sizes,
        visibleMetadataColumnIds,
      }),
    [containerWidth, sizes, visibleMetadataColumnIds]
  );
  // A sub-pixel ResizeObserver change can recompute the projection without
  // changing any rendered integer width. Retain the map (and therefore the
  // complete context value) when every observable answer is identical.
  const widthsContentKey = serializeColumnWidths(resolvedColumnWidths);
  const columnWidths = useMemo(() => deserializeColumnWidths(widthsContentKey), [widthsContentKey]);

  return useMemo(
    () => ({ areMetadataColumnsSuppressed, columnWidths, visibleMetadataColumnIds }),
    [areMetadataColumnsSuppressed, columnWidths, visibleMetadataColumnIds]
  );
}
