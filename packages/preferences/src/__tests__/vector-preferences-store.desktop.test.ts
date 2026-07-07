import { describe, expect, it, vi } from 'vitest';

describe('vector-preferences-store desktop storage bridge', () => {
  it('persists through the Electron storage bridge when available', async () => {
    vi.resetModules();

    const values = new Map<string, string>();
    const getItemMock = vi.fn(async (key: string) => values.get(key) ?? null);
    const setItemMock = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    });
    const removeItemMock = vi.fn(async (key: string) => {
      values.delete(key);
    });

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        storage: {
          getItem: getItemMock,
          removeItem: removeItemMock,
          setItem: setItemMock,
        },
      },
    });

    const { useVectorPreferencesStore } = await import('../stores/vector-preferences-store');

    useVectorPreferencesStore.getState().setDevicePref('wasm');

    await vi.waitFor(() => {
      expect(setItemMock).toHaveBeenCalled();
    });

    const persisted = values.get('vector-preferences.v1');
    expect(persisted).toContain('"devicePref":"wasm"');
    expect(getItemMock).toHaveBeenCalled();
    expect(removeItemMock).not.toHaveBeenCalled();
  });
});
