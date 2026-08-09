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
  /** Rendered metadata columns, in canonical order. Content-stable identity. */
  visibleMetadataColumnIds: readonly ExplorerMetadataColumnId[];
}

const EMPTY_METADATA_COLUMN_IDS: readonly ExplorerMetadataColumnId[] = Object.freeze([]);

const NAME_ONLY_COLUMNS: ExplorerColumnsContextValue = {
  areMetadataColumnsSuppressed: false,
  visibleMetadataColumnIds: EMPTY_METADATA_COLUMN_IDS,
};

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
  const visible = EXPLORER_METADATA_COLUMN_CONFIGS.filter(
    (config) => args.visibility[config.id as ExplorerMetadataColumnId]
  ).map((config) => config.id as ExplorerMetadataColumnId);
  return visible.length === 0 ? EMPTY_METADATA_COLUMN_IDS : visible;
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
  const containerWidth = useContainerWidth(containerRef);
  // Width 0 means "not measured yet" (first paint, or a hidden panel). Treat it
  // as roomy so the grid does not flash name-only before layout settles.
  const areMetadataColumnsSuppressed =
    containerWidth > 0 && containerWidth < METADATA_COLUMNS_MIN_WIDTH;

  return useMemo(() => {
    const visibleMetadataColumnIds = resolveVisibleMetadataColumnIds({
      isSuppressed: areMetadataColumnsSuppressed,
      visibility: { size, tokens, type },
    });
    return { areMetadataColumnsSuppressed, visibleMetadataColumnIds };
  }, [areMetadataColumnsSuppressed, size, tokens, type]);
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
