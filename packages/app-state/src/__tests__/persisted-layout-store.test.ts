import { createMemoryStorageAdapter } from '@brainstrike/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContextExplorerLayoutStore } from '../stores/context-explorer-layout-store';
import { createPanelLayoutStore } from '../stores/panel-layout-store';
import {
  createAdapterPersistStorage,
  createFallbackPersistStorage,
  createPersistedLayoutParser,
  hasCorruptedSizes,
  normalizeSizes,
  resolveNextSizes,
} from '../stores/persisted-layout-store';

interface LayoutState {
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  sizes: [number, number, number];
}

const DEFAULT_SIZES: readonly [number, number, number] = [18, 40, 20];
const parse = createPersistedLayoutParser<LayoutState>({
  defaultSizes: DEFAULT_SIZES,
  loggerName: 'LayoutStoreTest',
  persistedKeys: ['showConsole', 'showLeftPanel', 'showRightPanel', 'sizes'],
});

/**
 * BST-516: both layout stores used to carry private copies of this plumbing,
 * so a recovery fix could land in one and miss the other. The helper is now
 * the single owner and both stores must consume it.
 */
describe('persisted-layout-store helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe('hasCorruptedSizes', () => {
    it.each([
      { label: 'wrong length', sizes: [25, 20] },
      { label: 'negative', sizes: [-5, 25, 20] },
      { label: 'non-numeric', sizes: ['25', 20, 20] },
      { label: 'NaN', sizes: [Number.NaN, 20, 20] },
      { label: 'below minimum but non-zero', sizes: [4.488, 5.386, 0] },
      { label: 'not an array', sizes: 'nope' },
    ])('flags $label', ({ sizes }) => {
      expect(hasCorruptedSizes(sizes, { expectedLength: 3, minPanelSize: 10 })).toBe(true);
    });

    it('accepts zero (collapsed) and valid panel sizes', () => {
      expect(hasCorruptedSizes([30, 25, 0], { expectedLength: 3, minPanelSize: 10 })).toBe(false);
    });
  });

  describe('parser', () => {
    it('returns null for empty, invalid JSON, or a missing / non-object state', () => {
      expect(parse(null)).toBeNull();
      expect(parse('')).toBeNull();
      expect(parse('{invalid json')).toBeNull();
      expect(parse(JSON.stringify({ version: 2 }))).toBeNull();
      expect(parse(JSON.stringify({ state: 'nope', version: 2 }))).toBeNull();
      expect(parse(JSON.stringify(null))).toBeNull();
    });

    it('repairs a snapshot that has state but no sizes, instead of merging undefined', () => {
      const parsed = parse(JSON.stringify({ state: { showConsole: true }, version: 4 }));
      expect(parsed).toEqual({
        state: { showConsole: true, sizes: [...DEFAULT_SIZES] },
        version: 4,
      });
    });

    it('whitelists by persistedKeys so stray persisted keys never reach the store', () => {
      const parsed = parse(
        JSON.stringify({
          state: {
            activeTab: 'prompts',
            showConsole: true,
            showLeftPanel: false,
            showRightPanel: true,
            sizes: [30, 25, 15],
          },
          version: 4,
        })
      );
      expect(parsed).toEqual({
        state: {
          showConsole: true,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [30, 25, 15],
        },
        version: 4,
      });
    });

    it('repairs corrupted sizes to the configured defaults and keeps the version', () => {
      const parsed = parse(
        JSON.stringify({
          state: {
            showConsole: true,
            showLeftPanel: false,
            showRightPanel: true,
            sizes: [4, 5, 0],
          },
          version: 7,
        })
      );
      expect(parsed?.state.sizes).toEqual([...DEFAULT_SIZES]);
      expect(parsed?.state.showConsole).toBe(true);
      expect(parsed?.version).toBe(7);
    });

    it('treats a missing version as 0', () => {
      const parsed = parse(JSON.stringify({ state: { sizes: [30, 25, 15] } }));
      expect(parsed?.version).toBe(0);
    });
  });

  describe('adapter-backed storage', () => {
    it('round-trips through the adapter and parses on read', async () => {
      const adapter = createMemoryStorageAdapter();
      const storage = createAdapterPersistStorage<LayoutState>(adapter, parse);
      await storage.setItem('k', {
        state: { showConsole: false, showLeftPanel: true, showRightPanel: true, sizes: [4, 5, 0] },
        version: 4,
      });
      expect(JSON.parse((await adapter.getItem('k')) ?? '')).toMatchObject({ version: 4 });
      // Recovery happens on READ, so a corrupt snapshot written by an older
      // build is repaired the moment it is loaded.
      expect((await storage.getItem('k'))?.state.sizes).toEqual([...DEFAULT_SIZES]);
      await storage.removeItem('k');
      expect(await storage.getItem('k')).toBeNull();
    });
  });

  describe('fallback storage', () => {
    it('uses window.localStorage when present', () => {
      const storage = createFallbackPersistStorage<LayoutState>(parse);
      storage.setItem('k', {
        state: {
          showConsole: true,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [30, 25, 15],
        },
        version: 4,
      });
      expect(localStorage.getItem('k')).not.toBeNull();
      expect(storage.getItem('k')).toMatchObject({ version: 4 });
      storage.removeItem('k');
      expect(localStorage.getItem('k')).toBeNull();
    });

    it('falls back to memory when window is unavailable', () => {
      vi.stubGlobal('window', undefined);
      const storage = createFallbackPersistStorage<LayoutState>(parse);
      storage.setItem('k', {
        state: {
          showConsole: true,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [30, 25, 15],
        },
        version: 4,
      });
      expect(storage.getItem('k')).toMatchObject({ version: 4 });
      storage.removeItem('k');
      expect(storage.getItem('k')).toBeNull();
    });
  });

  describe('normalizeSizes / resolveNextSizes', () => {
    const options = { defaultSizes: DEFAULT_SIZES, minPanelSize: 10 };

    it('clamps, repairs corruption, redistributes zeros, and rescales oversized totals', () => {
      expect(normalizeSizes([200, -10, Number.NaN], options)).toEqual([100, 0, 0]);
      expect(normalizeSizes([4.488, 5.386, 0], options)).toEqual([...DEFAULT_SIZES]);
      expect(normalizeSizes([0, 0, 0], options)).toEqual([100 / 3, 100 / 3, 100 / 3]);
      expect(normalizeSizes([60, 60, 60], options).map((n) => Math.round(n))).toEqual([33, 33, 33]);
      expect(normalizeSizes([], options)).toEqual([]);
    });

    it('fills omitted slots from the current tuple', () => {
      expect(resolveNextSizes([42], [18, 40, 20], options)).toEqual([42, 40, 20]);
      expect(resolveNextSizes([], [18, 40, 20], options)).toEqual([18, 40, 20]);
    });
  });

  describe('both layout stores share the recovery path', () => {
    const PANEL_DEFAULTS = [18, 40, 20];
    const EXPLORER_DEFAULTS = [25, 20, 20];

    async function hydrate<TStore extends { getState: () => { sizes: number[] } }>(
      name: string,
      create: (adapter: ReturnType<typeof createMemoryStorageAdapter>) => TStore,
      snapshot: unknown
    ): Promise<number[]> {
      const adapter = createMemoryStorageAdapter();
      await adapter.setItem(name, JSON.stringify(snapshot));
      const store = create(adapter);
      const persistApi = (store as unknown as { persist?: { rehydrate?: () => Promise<void> } })
        .persist;
      if (!persistApi?.rehydrate) {
        throw new Error(`expected persist API on ${name}`);
      }
      await persistApi.rehydrate();
      return store.getState().sizes;
    }

    it.each([
      { label: 'corrupted sizes', state: { showConsole: true, sizes: [4.488, 5.386, 0] } },
      { label: 'missing sizes', state: { showConsole: true } },
    ])('both stores hydrate $label to their own defaults', async ({ state }) => {
      await expect(
        hydrate('panel-layout-store.v1', createPanelLayoutStore, { state, version: 4 })
      ).resolves.toEqual(PANEL_DEFAULTS);
      await expect(
        hydrate('context-explorer-layout-store.v1', createContextExplorerLayoutStore, {
          state,
          version: 3,
        })
      ).resolves.toEqual(EXPLORER_DEFAULTS);
    });
  });
});
