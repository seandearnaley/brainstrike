import { describe, expect, it } from 'vitest';
import { useContextExplorerLayoutStore as store } from '../stores/context-explorer-layout-store.ts';

const STORE_NAME = 'brainstrike:context-explorer-layout-store.v1';

async function rehydrateFrom(raw: string): Promise<void> {
  localStorage.setItem(STORE_NAME, raw);
  await store.persist.rehydrate();
}

describe('context-explorer-layout-store', () => {
  it('starts on the file tree and holds only the tab choice', () => {
    const state = store.getState();
    expect(state.explorerActiveTab).toBe('explorer');
    expect(Object.keys(state).sort()).toEqual(['explorerActiveTab', 'setExplorerActiveTab']);
  });

  it('saves the tab choice and restores it in the next document', async () => {
    store.getState().setExplorerActiveTab('search');
    const saved = localStorage.getItem(STORE_NAME) ?? '';
    store.setState(store.getInitialState(), true);

    await rehydrateFrom(saved);

    expect(store.getState().explorerActiveTab).toBe('search');
  });

  it.each([
    { label: 'a snapshot without the tab', raw: JSON.stringify({ state: {}, version: 1 }) },
    {
      label: 'an unknown tab',
      raw: JSON.stringify({ state: { explorerActiveTab: 'preview' }, version: 1 }),
    },
    { label: 'malformed JSON', raw: '{not-json' },
  ])('reads $label as the file tree', async ({ raw }) => {
    await rehydrateFrom(raw);
    expect(store.getState().explorerActiveTab).toBe('explorer');
  });
});
