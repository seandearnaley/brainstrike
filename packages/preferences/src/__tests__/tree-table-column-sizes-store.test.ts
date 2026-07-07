import { createMemoryStorageAdapter } from '@brainstrike/storage';
import { describe, expect, it } from 'vitest';
import {
  createSingletonColumnSizesStore,
  createTreeTableColumnSizesStore,
  sanitizeColumnSizes,
} from '../stores/tree-table-column-sizes-store';

const BOUNDS = {
  name: { defaultWidth: 200, maxWidth: 400, minWidth: 80 },
  size: { defaultWidth: 120, maxWidth: 300, minWidth: 60 },
  status: { defaultWidth: 44, maxWidth: 44, minWidth: 44 },
} as const;

function getPersistApi(store: ReturnType<typeof createTreeTableColumnSizesStore>): {
  rehydrate: () => Promise<void>;
} {
  const persistApi = (store as unknown as { persist?: { rehydrate?: () => Promise<void> } })
    .persist;
  if (!persistApi?.rehydrate) {
    throw new Error('expected tree table column sizes store persist API');
  }
  return { rehydrate: persistApi.rehydrate };
}

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
      storeName: 'tree-table-test-defaults.v1',
      version: 1,
    });
    expect(store.getState().sizes).toEqual({ name: 200, size: 120, status: 44 });
  });

  it('clamps setColumn updates to the per-column bounds', () => {
    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'tree-table-test-clamp.v1',
      version: 1,
    });
    store.getState().setColumn('name', 9999);
    expect(store.getState().sizes['name']).toBe(400);
    store.getState().setColumn('name', 1);
    expect(store.getState().sizes['name']).toBe(80);
  });

  it('ignores setColumn calls for unknown column ids and non-finite widths', () => {
    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'tree-table-test-unknown.v1',
      version: 1,
    });
    store.getState().setColumn('unknown', 200);
    store.getState().setColumn('name', Number.NaN);
    expect(store.getState().sizes).toEqual({ name: 200, size: 120, status: 44 });
  });

  it('replaces the full map via setAll and sanitizes input', () => {
    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storeName: 'tree-table-test-set-all.v1',
      version: 1,
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
      storeName: 'tree-table-test-reset.v1',
      version: 1,
    });
    store.getState().setColumn('name', 240);
    store.getState().reset();
    expect(store.getState().sizes).toEqual({ name: 200, size: 120, status: 44 });
  });

  it('rehydrates persisted sizes through sanitization', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      'tree-table-test-persist.v1',
      JSON.stringify({
        state: { sizes: { name: 375.4, size: Number.NaN, status: 1 } },
        version: 1,
      })
    );

    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storage,
      storeName: 'tree-table-test-persist.v1',
      version: 1,
    });
    await getPersistApi(store).rehydrate();

    expect(store.getState().sizes).toEqual({ name: 375, size: 120, status: 44 });
  });

  it('runs consumer migrations before sanitizing restored sizes', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      'tree-table-test-migrate.v2',
      JSON.stringify({
        state: { oldName: 120, size: 999 },
        version: 1,
      })
    );

    const store = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      migrate: (raw, version) => {
        expect(version).toBe(1);
        const previous = raw as { oldName?: number; size?: number };
        return { name: previous.oldName ?? 200, size: previous.size ?? 120 };
      },
      storage,
      storeName: 'tree-table-test-migrate.v2',
      version: 2,
    });
    await getPersistApi(store).rehydrate();

    expect(store.getState().sizes).toEqual({ name: 120, size: 300, status: 44 });
  });

  it('discards migrated null values and malformed persisted JSON', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      'tree-table-test-null-migrate.v2',
      JSON.stringify({
        state: { sizes: { name: 180 } },
        version: 1,
      })
    );
    await storage.setItem('tree-table-test-malformed.v1', '{bad-json');

    const nullMigrationStore = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      migrate: () => null,
      storage,
      storeName: 'tree-table-test-null-migrate.v2',
      version: 2,
    });
    await getPersistApi(nullMigrationStore).rehydrate();
    expect(nullMigrationStore.getState().sizes).toEqual({ name: 200, size: 120, status: 44 });

    const malformedStore = createTreeTableColumnSizesStore({
      columnBounds: BOUNDS,
      storage,
      storeName: 'tree-table-test-malformed.v1',
      version: 1,
    });
    await getPersistApi(malformedStore).rehydrate();
    expect(malformedStore.getState().sizes).toEqual({ name: 200, size: 120, status: 44 });
  });
});

describe('createSingletonColumnSizesStore', () => {
  it('reuses a branded singleton and replaces invalid globals', () => {
    const globalKey = '__brainstrike_test_column_sizes_store__';
    Reflect.deleteProperty(globalThis, globalKey);

    const first = createSingletonColumnSizesStore(globalKey, {
      columnBounds: BOUNDS,
      storeName: 'tree-table-singleton.v1',
      version: 1,
    });
    first.getState().setColumn('name', 260);

    const second = createSingletonColumnSizesStore(globalKey, {
      columnBounds: BOUNDS,
      storeName: 'tree-table-singleton.v1',
      version: 1,
    });
    expect(second).toBe(first);
    expect(second.getState().sizes['name']).toBe(260);

    (globalThis as unknown as Record<string, unknown>)[globalKey] = () => undefined;
    const replacement = createSingletonColumnSizesStore(globalKey, {
      columnBounds: BOUNDS,
      storeName: 'tree-table-singleton.v1',
      version: 1,
    });
    expect(replacement).not.toBe(first);

    Reflect.deleteProperty(globalThis, globalKey);
  });
});
