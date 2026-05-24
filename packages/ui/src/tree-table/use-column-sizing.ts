/**
 * Column sizing state for TreeTable.
 *
 * Behaves like a classic controlled / uncontrolled component:
 *  - When `controlledSizes` is provided, the consumer owns the sizes and
 *    `onChange` callbacks emit the next full map.
 *  - When `controlledSizes` is undefined, internal state is seeded from each
 *    column's `defaultWidth` (falling back to `width` when numeric) and
 *    updated locally.
 *
 * Pixel widths are always clamped to each column's `[minWidth, maxWidth]`
 * window. Columns flagged non-resizable (or pinned via width=min=max) are
 * still present in the resolved sizes map for layout purposes; their width
 * is just immutable from this hook's perspective.
 */

import * as React from 'react';
import type { TreeTableColumn } from './types';

const DEFAULT_MIN_WIDTH = 48;
const DEFAULT_MAX_WIDTH = 2000;

export interface UseColumnSizingOptions<T> {
  columns: TreeTableColumn<T>[];
  controlledSizes?: Record<string, number> | undefined;
  onSizesChange?: ((next: Record<string, number>) => void) | undefined;
}

export interface UseColumnSizingResult {
  /** Resolved width in pixels for the given column. */
  getWidth: (columnId: string) => number | undefined;
  /** Whether the column can be resized by the user. */
  isResizable: (columnId: string) => boolean;
  /** Replace a single column width; clamps to `[min, max]`. */
  setWidth: (columnId: string, nextWidth: number) => void;
  /** Resolved sizes map for the current frame. */
  sizes: Record<string, number>;
}

interface ColumnBounds {
  defaultWidth: number | undefined;
  isPinned: boolean;
  maxWidth: number;
  minWidth: number;
  resizable: boolean;
}

function resolveNumericWidth(value: number | string | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function computeColumnBounds<T>(column: TreeTableColumn<T>): ColumnBounds {
  const explicitWidth = resolveNumericWidth(column.width);
  const defaultWidth = column.defaultWidth ?? explicitWidth;
  const minWidth = column.minWidth ?? DEFAULT_MIN_WIDTH;
  const maxWidth = column.maxWidth ?? DEFAULT_MAX_WIDTH;
  // A pinned column declares the same value for width/min/max — collection
  // browser's status icon column is the canonical example. These columns
  // never expose a resize handle even if `resizable` is left unset.
  const isPinned =
    explicitWidth !== undefined &&
    column.minWidth !== undefined &&
    column.maxWidth !== undefined &&
    explicitWidth === column.minWidth &&
    explicitWidth === column.maxWidth;
  const resizable = column.resizable !== false && !isPinned;
  return { defaultWidth, isPinned, maxWidth, minWidth, resizable };
}

function clampWidth(width: number, bounds: ColumnBounds): number {
  if (!Number.isFinite(width)) {
    return bounds.defaultWidth ?? bounds.minWidth;
  }
  return Math.max(bounds.minWidth, Math.min(bounds.maxWidth, Math.round(width)));
}

function buildInitialSizes<T>(
  columns: TreeTableColumn<T>[],
  overlay: Record<string, number> | undefined
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const column of columns) {
    const bounds = computeColumnBounds(column);
    const candidate = overlay?.[column.id] ?? bounds.defaultWidth;
    if (candidate !== undefined) {
      next[column.id] = clampWidth(candidate, bounds);
    }
  }
  return next;
}

export function useColumnSizing<T>({
  columns,
  controlledSizes,
  onSizesChange,
}: UseColumnSizingOptions<T>): UseColumnSizingResult {
  const isControlled = controlledSizes !== undefined;

  const boundsById = React.useMemo(() => {
    const map = new Map<string, ColumnBounds>();
    for (const column of columns) {
      map.set(column.id, computeColumnBounds(column));
    }
    return map;
  }, [columns]);

  const [internalSizes, setInternalSizes] = React.useState<Record<string, number>>(() =>
    buildInitialSizes(columns, undefined)
  );

  // Keep internal sizes in sync when new columns appear/disappear. We never
  // overwrite existing values during the same instance; resize-controlled
  // values come from the controlled prop path.
  const lastColumnsRef = React.useRef(columns);
  React.useEffect(() => {
    const previousColumnIds = new Set(lastColumnsRef.current.map((c) => c.id));
    const nextColumnIds = new Set(columns.map((c) => c.id));
    const addedIds = [...nextColumnIds].filter((id) => !previousColumnIds.has(id));
    const removedIds = [...previousColumnIds].filter((id) => !nextColumnIds.has(id));
    if (addedIds.length === 0 && removedIds.length === 0) {
      lastColumnsRef.current = columns;
      return;
    }
    setInternalSizes((current) => {
      const next: Record<string, number> = { ...current };
      for (const id of removedIds) {
        delete next[id];
      }
      for (const id of addedIds) {
        const bounds = boundsById.get(id);
        if (bounds?.defaultWidth !== undefined) {
          next[id] = clampWidth(bounds.defaultWidth, bounds);
        }
      }
      return next;
    });
    lastColumnsRef.current = columns;
  }, [columns, boundsById]);

  const resolvedSizes = React.useMemo<Record<string, number>>(() => {
    if (!isControlled) {
      return internalSizes;
    }
    return buildInitialSizes(columns, controlledSizes);
  }, [columns, controlledSizes, internalSizes, isControlled]);

  // ColumnResizeHandle captures `onResize` at pointer-down time and keeps
  // calling it for every pointermove during a single drag. That means the
  // closure below — and `resolvedSizes` in particular — is frozen at the
  // drag-start snapshot for the lifetime of one gesture. This is safe today
  // because (a) the delta math uses the ref-stored `startWidth`, not the
  // closure, and (b) only one column is dragged at a time. If concurrent
  // resizes or external mid-drag mutations are added later, this `setWidth`
  // needs to read latest sizes via a ref to avoid silently reverting the
  // other change.
  const setWidth = React.useCallback(
    (columnId: string, nextWidth: number) => {
      const bounds = boundsById.get(columnId);
      if (!bounds?.resizable) {
        return;
      }
      const clamped = clampWidth(nextWidth, bounds);
      const current = resolvedSizes[columnId];
      if (current === clamped) {
        return;
      }
      // Preserve persisted widths for columns that are not currently rendered
      // (e.g., the optional `score` column in collection-browser, or columns
      // hidden by visibility toggles in preview-table). Starting from
      // `controlledSizes` rather than `resolvedSizes` keeps those entries
      // intact so the downstream persistence store doesn't wipe them when it
      // sanitizes the next map back into storage. Uncontrolled mode falls
      // back to the resolved snapshot since there is no consumer-owned map.
      const baseMap = isControlled
        ? { ...(controlledSizes ?? {}), ...resolvedSizes }
        : resolvedSizes;
      const nextMap: Record<string, number> = { ...baseMap, [columnId]: clamped };
      if (!isControlled) {
        setInternalSizes(nextMap);
      }
      onSizesChange?.(nextMap);
    },
    [boundsById, controlledSizes, isControlled, onSizesChange, resolvedSizes]
  );

  const getWidth = React.useCallback(
    (columnId: string) => resolvedSizes[columnId],
    [resolvedSizes]
  );

  const isResizable = React.useCallback(
    (columnId: string) => boundsById.get(columnId)?.resizable ?? false,
    [boundsById]
  );

  return { getWidth, isResizable, setWidth, sizes: resolvedSizes };
}

export type { ColumnBounds };
/** Exposed for tests and the resize-handle component. */
export { clampWidth, computeColumnBounds, DEFAULT_MAX_WIDTH, DEFAULT_MIN_WIDTH };
