import { describe, expect, it } from 'vitest';
import {
  createTreeTableColumnSizesStore,
  sanitizeColumnSizes,
} from '../stores/tree-table-column-sizes-store.ts';

const BOUNDS = {
  name: { defaultWidth: 200, maxWidth: 400, minWidth: 80 },
  size: { defaultWidth: 120, maxWidth: 300, minWidth: 60 },
  status: { defaultWidth: 44, maxWidth: 44, minWidth: 44 },
} as const;

describe('sanitizeColumnSizes', () => {
  it('substitutes defaultWidth when a column has no persisted value', () => {
    const result = sanitizeColumnSizes({ name: 240 }, BOUNDS);
    expect(result).toEqual({ name: 240, size: 120, status: 44 });
  });

  it('drops NaN, non-finite, and negative entries before clamping', () => {
    const result = sanitizeColumnSizes(
      { name: Number.NaN, size: Number.POSITIVE_INFINITY, status: -10 },
      BOUNDS
    );
    // All three malformed values fall back to defaults.
    expect(result).toEqual({ name: 200, size: 120, status: 44 });
  });

  it('clamps oversized values to the per-column maxWidth', () => {
    const result = sanitizeColumnSizes({ name: 99_999 }, BOUNDS);
    expect(result['name']).toBe(400);
  });

  it('clamps undersized values to the per-column minWidth', () => {
    const result = sanitizeColumnSizes({ name: 4 }, BOUNDS);
    expect(result['name']).toBe(80);
  });

  it('ignores keys that are not declared in columnBounds', () => {
    const result = sanitizeColumnSizes({ mystery: 999, name: 200 }, BOUNDS);
    expect(result).not.toHaveProperty('mystery');
  });

  it('returns defaults when input is null/undefined/garbage', () => {
    expect(sanitizeColumnSizes(null, BOUNDS)).toEqual({ name: 200, size: 120, status: 44 });
    expect(sanitizeColumnSizes(undefined, BOUNDS)).toEqual({ name: 200, size: 120, status: 44 });
    expect(sanitizeColumnSizes('not-an-object', BOUNDS)).toEqual({
      name: 200,
      size: 120,
      status: 44,
    });
  });
});

describe('createTreeTableColumnSizesStore', () => {
  it('initializes sizes with the defaultWidth from each column bound', () => {
    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'brainstrike:tree-table-test-defaults.v1',
    });
    expect(store.getState().sizes).toEqual({ name: 200, size: 120, status: 44 });
  });

  it('clamps setColumn updates to the per-column bounds', () => {
    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'brainstrike:tree-table-test-clamp.v1',
    });
    store.getState().setColumn('name', 9999);
    expect(store.getState().sizes['name']).toBe(400);
    store.getState().setColumn('name', 1);
    expect(store.getState().sizes['name']).toBe(80);
  });

  it('ignores setColumn calls for unknown column ids and non-finite widths', () => {
    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'brainstrike:tree-table-test-unknown.v1',
    });
    store.getState().setColumn('unknown', 200);
    store.getState().setColumn('name', Number.NaN);
    expect(store.getState().sizes).toEqual({ name: 200, size: 120, status: 44 });
  });

  it('replaces the full map via setAll and sanitizes input', () => {
    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'brainstrike:tree-table-test-set-all.v1',
    });
    store
      .getState()
      .setAll({ mystery: 999, name: -1, size: 240, status: 44 } as Record<string, number>);
    expect(store.getState().sizes).toEqual({
      name: 80, // clamped to min
      size: 240,
      status: 44,
    });
  });

  it('reset() restores defaults', () => {
    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'brainstrike:tree-table-test-reset.v1',
    });
    store.getState().setColumn('name', 240);
    store.getState().reset();
    expect(store.getState().sizes).toEqual({ name: 200, size: 120, status: 44 });
  });

  it('rehydrates persisted sizes through sanitization', async () => {
    localStorage.setItem(
      'brainstrike:tree-table-test-persist.v1',
      JSON.stringify({
        state: { sizes: { name: 375.4, size: Number.NaN, status: 1 } },
        version: 1,
      })
    );

    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'brainstrike:tree-table-test-persist.v1',
    });

    expect(store.getState().sizes).toEqual({ name: 375, size: 120, status: 44 });
  });

  it('keeps defaults when the saved value is not JSON', () => {
    localStorage.setItem('brainstrike:tree-table-test-malformed.v1', '{bad-json');

    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'brainstrike:tree-table-test-malformed.v1',
    });

    expect(store.getState().sizes).toEqual({ name: 200, size: 120, status: 44 });
  });
});
