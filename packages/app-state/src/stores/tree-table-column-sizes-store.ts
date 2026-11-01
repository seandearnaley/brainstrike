/**
 * TreeTable column sizes store factory.
 *
 * Each call to `createTreeTableColumnSizesStore` returns a per-surface store that
 * persists `Record<columnId, pixelWidth>` with `persistDurable`. Only `sizes` is
 * saved; every saved value is clamped to `[minWidth, maxWidth]` per column, and a
 * missing or malformed column falls back to its `defaultWidth`.
 */

import { type DurableKey, persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';

export interface ColumnSizeBounds {
  defaultWidth?: number;
  maxWidth?: number;
  minWidth?: number;
}

export interface TreeTableColumnSizesStoreState {
  /** Reset all sizes back to the column defaults. */
  reset: () => void;
  /** Bulk set; replaces the current map. Values are sanitized. */
  setAll: (next: Record<string, number>) => void;
  /** Update a single column. Sanitized against the column bounds. */
  setColumn: (columnId: string, width: number) => void;
  /** Current size map (sanitized). */
  sizes: Record<string, number>;
}

export interface CreateTreeTableColumnSizesStoreOptions {
  /** Bounds per column id used for sanitization. Defaults fill missing keys. */
  columnBounds: Record<string, ColumnSizeBounds>;
  /** Unique durable key. */
  storeName: DurableKey;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampToBounds(width: number, bounds: ColumnSizeBounds | undefined): number {
  const min = bounds?.minWidth ?? 0;
  const max = bounds?.maxWidth ?? Number.POSITIVE_INFINITY;
  return Math.max(min, Math.min(max, Math.round(width)));
}

/**
 * Drop non-finite / negative entries, clamp surviving values to per-column
 * bounds, and substitute `defaultWidth` for any column whose persisted value
 * is missing or malformed.
 */
export function sanitizeColumnSizes(
  raw: unknown,
  columnBounds: Record<string, ColumnSizeBounds>
): Record<string, number> {
  const next: Record<string, number> = {};
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  for (const [columnId, bounds] of Object.entries(columnBounds)) {
    const candidate = source[columnId];
    // Distinguish garbage (NaN / Infinity / non-numeric) from finite-but-OOB
    // values: garbage falls back to defaultWidth, finite values (including
    // negatives and zero) are clamped into [minWidth, maxWidth].
    if (isFiniteNumber(candidate)) {
      next[columnId] = clampToBounds(candidate, bounds);
      continue;
    }
    if (bounds.defaultWidth !== undefined) {
      next[columnId] = clampToBounds(bounds.defaultWidth, bounds);
    }
  }

  return next;
}

export function createTreeTableColumnSizesStore({
  columnBounds,
  storeName,
}: CreateTreeTableColumnSizesStoreOptions) {
  return create<TreeTableColumnSizesStoreState>()(
    persistDurable(
      storeName,
      (set) => ({
        reset: () => {
          set({ sizes: sanitizeColumnSizes({}, columnBounds) });
        },
        setAll: (next) => {
          set({ sizes: sanitizeColumnSizes(next, columnBounds) });
        },
        setColumn: (columnId, width) => {
          const bounds = columnBounds[columnId];
          if (!(bounds && isFiniteNumber(width))) {
            return;
          }
          set((state) => ({
            sizes: { ...state.sizes, [columnId]: clampToBounds(width, bounds) },
          }));
        },
        sizes: sanitizeColumnSizes({}, columnBounds),
      }),
      {
        merge: (persisted, current) => ({
          ...current,
          sizes: sanitizeColumnSizes(
            (persisted as { sizes?: unknown } | undefined)?.sizes,
            columnBounds
          ),
        }),
        partialize: (state) => ({ sizes: state.sizes }),
        version: 1,
      }
    )
  );
}
