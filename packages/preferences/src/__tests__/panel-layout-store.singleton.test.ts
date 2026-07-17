import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORE_NAME = 'panel-layout-store.v1';
const GLOBAL_KEY = '__brainstrike_panel_layout_store__';

function clearSingleton(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}

describe('usePanelLayoutStore singleton fallback', () => {
  const DEFAULT_SIZES = [18, 40, 20] as const;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    clearSingleton();
    localStorage.clear();
  });

  afterEach(() => {
    vi.doUnmock('@brainstrike/storage');
    vi.unstubAllGlobals();
    clearSingleton();
    localStorage.clear();
  });

  it('falls back to localStorage when browser storage adapter creation throws', async () => {
    localStorage.setItem(
      STORE_NAME,
      JSON.stringify({
        state: {
          showConsole: true,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [4.488, 5.386, 0],
        },
        version: 2,
      })
    );

    vi.doMock('@brainstrike/storage', async () => {
      const actual =
        await vi.importActual<typeof import('@brainstrike/storage')>('@brainstrike/storage');
      return {
        ...actual,
        createBrowserStorageAdapter: vi.fn(() => {
          throw new Error('adapter unavailable');
        }),
      };
    });

    const module = await import('../stores/panel-layout-store');
    const persistApi = (
      module.usePanelLayoutStore as unknown as {
        persist?: { rehydrate?: () => Promise<void> };
      }
    ).persist;
    if (!persistApi?.rehydrate) {
      throw new Error('expected singleton persist API');
    }

    await persistApi.rehydrate();

    expect(module.usePanelLayoutStore.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(module.usePanelLayoutStore.getState().showLeftPanel).toBe(true);
    expect(module.usePanelLayoutStore.getState().showRightPanel).toBe(true);
    expect(module.usePanelLayoutStore.getState().showConsole).toBe(false);
  });

  it('uses in-memory fallback storage when window is unavailable', async () => {
    vi.doMock('@brainstrike/storage', async () => {
      const actual =
        await vi.importActual<typeof import('@brainstrike/storage')>('@brainstrike/storage');
      return {
        ...actual,
        createBrowserStorageAdapter: vi.fn(() => {
          throw new Error('adapter unavailable');
        }),
      };
    });

    vi.stubGlobal('window', undefined);

    const module = await import('../stores/panel-layout-store');
    const store = module.usePanelLayoutStore;
    const persistApi = (
      store as unknown as {
        persist?: { rehydrate?: () => Promise<void> };
      }
    ).persist;
    if (!persistApi?.rehydrate) {
      throw new Error('expected singleton persist API');
    }

    store.getState().setState({
      showConsole: true,
      showLeftPanel: false,
      showRightPanel: true,
      sizes: [30, 25, 15],
    });

    await persistApi.rehydrate();

    expect(store.getState().sizes).toEqual([30, 25, 15]);
    expect(store.getState().showLeftPanel).toBe(false);
    expect(store.getState().showRightPanel).toBe(true);
    expect(store.getState().showConsole).toBe(true);
  });
});
