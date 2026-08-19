import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * BST-1380: the hidden embedding host must observe the SAME canonical vector
 * preferences the visible UI writes. BST-1235 narrowed the hidden preload to a
 * capability manifest without `electronAPI.storage`, and the store silently
 * degraded to per-host browser storage — so an explicitly configured device
 * preference was ignored by the process that actually runs inference.
 */

const CANONICAL_RECORD = JSON.stringify({
  state: {
    devicePref: 'wasm',
    devicePrefConfigured: true,
    reinitEveryN: 200,
    verboseOrtLogs: false,
  },
  version: 3,
});

function defineElectronAPI(value: unknown): void {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value });
}

describe('vector-preferences-store hidden embedding host capability', () => {
  afterEach(() => {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'electronAPI');
    vi.resetModules();
  });

  it('hydrates the canonical record through the scoped hidden-host bridge', async () => {
    vi.resetModules();
    const read = vi.fn(async () => CANONICAL_RECORD);
    const write = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    defineElectronAPI({ db: {}, vectorPreferences: { clear, read, write } });

    const { ensureVectorPreferencesHydrated } = await import('../stores/vector-preferences-store');
    const state = await ensureVectorPreferencesHydrated({ forceReload: true });

    expect(read).toHaveBeenCalled();
    expect(state.devicePref).toBe('wasm');
    expect(state.devicePrefConfigured).toBe(true);
  });

  it('fails visibly when a desktop renderer exposes no vector-preferences capability', async () => {
    vi.resetModules();
    // The embedding-host capability manifest as shipped by BST-1235.
    defineElectronAPI({ db: { query: vi.fn() } });

    const { ensureVectorPreferencesHydrated } = await import('../stores/vector-preferences-store');

    await expect(ensureVectorPreferencesHydrated({ forceReload: true })).rejects.toThrow(
      /vector preferences/i
    );
  });

  it('still uses browser storage when no Electron bridge exists at all', async () => {
    vi.resetModules();

    const { ensureVectorPreferencesHydrated } = await import('../stores/vector-preferences-store');
    const state = await ensureVectorPreferencesHydrated({ forceReload: true });

    expect(state.devicePref).toBe('webgpu');
    expect(state.devicePrefConfigured).toBe(false);
  });

  it('surfaces a failed forced reload instead of returning stale preferences', async () => {
    vi.resetModules();
    // First read hydrates; a later forced reload fails (the scoped handler went
    // away, or the adapter broke). Zustand catches that rejection and resolves
    // `rehydrate()` anyway, and the store's own `hasHydrated` field keeps the
    // stale `true` from the first hydration — so nothing downstream can tell
    // the difference between fresh and stale preferences unless we surface it.
    const read = vi.fn<() => Promise<string | null>>(async () => CANONICAL_RECORD);
    defineElectronAPI({
      db: {},
      vectorPreferences: { clear: vi.fn(async () => {}), read, write: vi.fn(async () => {}) },
    });

    const { ensureVectorPreferencesHydrated } = await import('../stores/vector-preferences-store');

    // Settle a full, successful hydration first so both `hasHydrated` signals
    // are genuinely true before the reload starts failing.
    const first = await ensureVectorPreferencesHydrated({ forceReload: true });
    expect(first.devicePref).toBe('wasm');
    expect(first.hasHydrated).toBe(true);

    read.mockRejectedValue(new Error('vector-preferences:read handler is not registered'));

    await expect(ensureVectorPreferencesHydrated({ forceReload: true })).rejects.toThrow(
      /vector-preferences:read handler is not registered/
    );
  });
});
