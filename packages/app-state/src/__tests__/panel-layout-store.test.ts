import { describe, expect, it } from 'vitest';
import { usePanelLayoutStore } from '../stores/panel-layout-store.ts';

const STORE_NAME = 'brainstrike:panel-layout-store.v1';

/** Hydrates the store from a saved snapshot, as the next document does. */
async function hydrateFrom(saved: string): Promise<void> {
  localStorage.setItem(STORE_NAME, saved);
  await usePanelLayoutStore.persist.rehydrate();
}

describe('panel-layout-store', () => {
  const DEFAULT_SIZES = [18, 40, 20] as const;
  const store = usePanelLayoutStore;

  it('initializes with default state', () => {
    const s = store.getState();
    expect(s.sizes).toEqual(DEFAULT_SIZES);
    expect(s.showLeftPanel).toBe(true);
    expect(s.showRightPanel).toBe(true);
    expect(s.showConsole).toBe(false);
    expect(s.activeTab).toBe('explorer');
  });

  it('toggles panel visibility flags', () => {
    const before = store.getState();
    expect(before.showLeftPanel).toBe(true);
    expect(before.showRightPanel).toBe(true);
    expect(before.showConsole).toBe(false);

    store.getState().toggleLeft();
    store.getState().toggleRight();
    store.getState().toggleConsole();

    const after = store.getState();
    expect(after.showLeftPanel).toBe(false);
    expect(after.showRightPanel).toBe(false);
    expect(after.showConsole).toBe(true);
  });

  it('sets active tab', () => {
    expect(store.getState().activeTab).toBe('explorer');
    store.getState().setActiveTab('settings');
    expect(store.getState().activeTab).toBe('settings');

    store.getState().setActiveTab('artifacts');
    expect(store.getState().activeTab).toBe('artifacts');
  });

  it('routes openSettings to the settings tab like any other shell route (BST-1668)', () => {
    // Settings is a full shell tab again, not an overlay: the ONLY state it
    // needs is `activeTab`, so opening it replaces the current surface and
    // navigating elsewhere leaves it the same way every other tab does.
    store.getState().setActiveTab('artifacts');
    store.getState().openSettings();

    expect(store.getState().activeTab).toBe('settings');
    expect('settingsOpen' in store.getState()).toBe(false);

    store.getState().setActiveTab('artifacts');
    expect(store.getState().activeTab).toBe('artifacts');
  });

  it('normalizes sizes and preserves tuple shape', () => {
    store.getState().setSizes([200, -10, Number.NaN]);
    const s = store.getState();
    // normalizeSizes clamps into [0..100] and prevents NaN; preserves existing slots where undefined
    expect(s.sizes.length).toBe(3);
    expect(s.sizes[0]).toBe(100); // 200 -> 100
    expect(s.sizes[1]).toBe(0); // -10 -> 0
    expect(typeof s.sizes[2]).toBe('number');
  });

  it('setState merges partial updates', () => {
    store.getState().setState({ activeTab: 'settings', showRightPanel: true });
    const s = store.getState();
    expect(s.showRightPanel).toBe(true);
    expect(s.activeTab).toBe('settings');
    // unchanged remain
    expect(s.showLeftPanel).toBe(true);
  });

  it('supports terminal tab', () => {
    store.getState().setActiveTab('terminal');
    expect(store.getState().activeTab).toBe('terminal');
  });

  it('resets corrupted sizes below minimum threshold to defaults', () => {
    // Sizes like [4.488, 5.386, 0] represent corrupted localStorage values
    store.getState().setSizes([4.488, 5.386, 0]);
    const s = store.getState();
    expect(s.sizes).toEqual(DEFAULT_SIZES);
  });

  it('preserves valid sizes above minimum threshold', () => {
    store.getState().setSizes([30, 25, 15]);
    const s = store.getState();
    expect(s.sizes).toEqual([30, 25, 15]);
  });

  it('leaves sizes unchanged when setSizes receives an empty array', () => {
    store.getState().setSizes([]);
    expect(store.getState().sizes).toEqual(DEFAULT_SIZES);
  });

  it('redistributes all-zero sizes evenly', () => {
    store.getState().setSizes([0, 0, 0]);
    expect(store.getState().sizes).toEqual([100 / 3, 100 / 3, 100 / 3]);
  });

  it('scales oversized size totals back to 100%', () => {
    store.getState().setSizes([60, 60, 60]);
    const sizes = store.getState().sizes;
    expect(sizes[0]).toBeCloseTo(100 / 3);
    expect(sizes[1]).toBeCloseTo(100 / 3);
    expect(sizes[2]).toBeCloseTo(100 / 3);
  });

  it('restores the saved layout but not the root tab', async () => {
    store.getState().setSizes([30, 25, 15]);
    store.getState().toggleConsole();
    store.getState().setActiveTab('settings');
    const saved = localStorage.getItem(STORE_NAME) ?? '';
    store.setState(store.getInitialState(), true);

    await hydrateFrom(saved);

    expect(store.getState()).toMatchObject({
      activeTab: 'explorer',
      showConsole: true,
      sizes: [30, 25, 15],
    });
  });

  it('keeps defaults when the saved value is not JSON', async () => {
    await hydrateFrom('{invalid json');

    expect(store.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(store.getState().showLeftPanel).toBe(true);
  });

  it.each([
    { label: 'corrupted sizes', state: { showConsole: true, sizes: [4.488, 5.386, 0] } },
    { label: 'missing sizes', state: { showConsole: true } },
    { label: 'sizes of the wrong length', state: { showConsole: true, sizes: [25, 20] } },
  ])('repairs $label to the defaults and keeps the other fields', async ({ state }) => {
    await hydrateFrom(JSON.stringify({ state, version: 1 }));

    expect(store.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(store.getState().showConsole).toBe(true);
  });

  it('ignores saved fields of the wrong type and a saved root tab', async () => {
    await hydrateFrom(
      JSON.stringify({ state: { activeTab: 'prompts', showLeftPanel: 'no' }, version: 1 })
    );

    expect(store.getState().activeTab).toBe('explorer');
    expect(store.getState().showLeftPanel).toBe(true);
  });
});
