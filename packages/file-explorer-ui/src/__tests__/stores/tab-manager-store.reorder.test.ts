import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return { ...actual, createLogger: () => loggerMock };
});

import { __resetTabManagerStoreForTests, useTabManagerStore } from '../../stores/tab-manager-store';

const STORE_KEY = 'tab-manager.v1';

function openThreeTabs(): void {
  const store = useTabManagerStore.getState();
  store.openTab('src/a.ts', 'file-a', 'file-a');
  store.openTab('src/b.ts', 'file-b', 'file-b');
  store.openTab('src/c.ts', 'file-c', 'file-c');
}

function tabIds(): readonly string[] {
  return useTabManagerStore.getState().tabs.map((tab) => tab.id);
}

async function rehydrate(): Promise<void> {
  const persistApi = (
    useTabManagerStore as unknown as { persist?: { rehydrate?: () => Promise<void> } }
  ).persist;
  await persistApi?.rehydrate?.();
}

describe('tab-manager-store reorderTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTabManagerStoreForTests();
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {}
  });

  it('applies a permutation in ONE store transition and keeps the active tab', () => {
    openThreeTabs();
    useTabManagerStore.getState().setActiveTab('file-b');
    const before = new Map(useTabManagerStore.getState().tabs.map((tab) => [tab.id, tab]));
    const listener = vi.fn();
    const unsubscribe = useTabManagerStore.subscribe(listener);

    try {
      useTabManagerStore.getState().reorderTabs(['file-c', 'file-a', 'file-b']);
    } finally {
      unsubscribe();
    }

    expect(tabIds()).toEqual(['file-c', 'file-a', 'file-b']);
    expect(useTabManagerStore.getState().activeTabId).toBe('file-b');
    expect(listener).toHaveBeenCalledTimes(1);
    // Tab records move, they are not rebuilt (content/loading state survives).
    for (const tab of useTabManagerStore.getState().tabs) {
      expect(tab).toBe(before.get(tab.id));
    }
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing id', ['file-c', 'file-a']],
    ['an unknown id', ['file-c', 'file-a', 'file-b', 'file-z']],
    ['an unknown id in place of an open one', ['file-c', 'file-a', 'file-z']],
    ['a duplicate id', ['file-a', 'file-a', 'file-b']],
  ])('rejects a list with %s: no-op plus a warning', (_case, orderedTabIds) => {
    openThreeTabs();
    const listener = vi.fn();
    const unsubscribe = useTabManagerStore.subscribe(listener);

    try {
      useTabManagerStore.getState().reorderTabs(orderedTabIds);
    } finally {
      unsubscribe();
    }

    expect(tabIds()).toEqual(['file-a', 'file-b', 'file-c']);
    expect(listener).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Rejected a tab reorder that is not a permutation of the open tabs',
      { openTabCount: 3, orderedTabCount: orderedTabIds.length }
    );
  });

  it('treats the current order as a no-op without publishing', () => {
    openThreeTabs();
    const listener = vi.fn();
    const unsubscribe = useTabManagerStore.subscribe(listener);

    try {
      useTabManagerStore.getState().reorderTabs(['file-a', 'file-b', 'file-c']);
    } finally {
      unsubscribe();
    }

    expect(listener).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('persists the new order in the unchanged tab-manager.v1 shape', async () => {
    openThreeTabs();
    useTabManagerStore.getState().reorderTabs(['file-b', 'file-c', 'file-a']);

    const raw = localStorage.getItem(STORE_KEY) ?? 'null';
    const persisted: unknown = JSON.parse(raw);
    expect(persisted).toEqual({
      state: {
        activeTabId: 'file-c',
        tabs: [
          { compositeKey: 'file-b', id: 'file-b', path: 'src/b.ts' },
          { compositeKey: 'file-c', id: 'file-c', path: 'src/c.ts' },
          { compositeKey: 'file-a', id: 'file-a', path: 'src/a.ts' },
        ],
      },
      version: 2,
    });

    // A reload: the in-memory store is gone, only the persisted payload remains.
    useTabManagerStore.setState({ activeTabId: null, tabs: [] });
    localStorage.setItem(STORE_KEY, raw);
    await rehydrate();
    expect(tabIds()).toEqual(['file-b', 'file-c', 'file-a']);
  });
});
