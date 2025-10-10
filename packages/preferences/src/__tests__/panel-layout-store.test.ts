import { createMemoryStorageAdapter } from '@brainstrike/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPanelLayoutStore } from '../stores/panel-layout-store';

describe('panel-layout-store', () => {
  let store: ReturnType<typeof createPanelLayoutStore>;

  beforeEach(() => {
    store = createPanelLayoutStore(createMemoryStorageAdapter());
  });

  it('initializes with default state', () => {
    const s = store.getState();
    expect(s.sizes).toEqual([25, 55, 20]);
    expect(s.showLeftPanel).toBe(true);
    expect(s.showRightPanel).toBe(false);
    expect(s.showConsole).toBe(false);
    expect(s.activeTab).toBe('explorer');
  });

  it('toggles panel visibility flags', () => {
    const before = store.getState();
    expect(before.showLeftPanel).toBe(true);
    expect(before.showRightPanel).toBe(false);
    expect(before.showConsole).toBe(false);

    store.getState().toggleLeft();
    store.getState().toggleRight();
    store.getState().toggleConsole();

    const after = store.getState();
    expect(after.showLeftPanel).toBe(false);
    expect(after.showRightPanel).toBe(true);
    expect(after.showConsole).toBe(true);
  });

  it('sets active tab', () => {
    expect(store.getState().activeTab).toBe('explorer');
    store.getState().setActiveTab('settings');
    expect(store.getState().activeTab).toBe('settings');
  });

  it('normalizes sizes and preserves tuple shape', () => {
    store.getState().setSizes([200, -10, Number.NaN]);
    const s = store.getState();
    // validateAndNormalizeSizes clamps into [0..100] and prevents NaN; preserves existing slots where undefined
    expect(s.sizes.length).toBe(3);
    expect(s.sizes[0]).toBe(100); // 200 -> 100
    expect(s.sizes[1]).toBe(0); // -10 -> 0
    expect(typeof s.sizes[2]).toBe('number');
  });

  it('setState merges partial updates', () => {
    store.getState().setState({ showRightPanel: true, activeTab: 'settings' });
    const s = store.getState();
    expect(s.showRightPanel).toBe(true);
    expect(s.activeTab).toBe('settings');
    // unchanged remain
    expect(s.showLeftPanel).toBe(true);
  });
});
