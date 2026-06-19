import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureVectorPreferencesHydrated,
  useVectorPreferencesStore,
} from '../stores/vector-preferences-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = useVectorPreferencesStore as PersistApi<typeof useVectorPreferencesStore>;

describe('vector-preferences-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const store = useVectorPreferencesStore;
    store.setState({
      hasHydrated: false,
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 200,
      verboseOrtLogs: false,
    });
    storeWithPersist.persist?.clearStorage?.();
  });

  it('initializes with defaults and updates device preference', () => {
    expect(useVectorPreferencesStore.getState().devicePref).toBe('webgpu');
    expect(useVectorPreferencesStore.getState().devicePrefConfigured).toBe(false);
    expect(useVectorPreferencesStore.getState().hasHydrated).toBe(false);
    useVectorPreferencesStore.getState().setDevicePref('wasm');
    expect(useVectorPreferencesStore.getState().devicePref).toBe('wasm');
    expect(useVectorPreferencesStore.getState().devicePrefConfigured).toBe(true);
  });

  it('updates detected WebGPU preference without marking it as user-configured', () => {
    useVectorPreferencesStore.setState({
      devicePref: 'wasm',
      devicePrefConfigured: true,
    });

    useVectorPreferencesStore.getState().setDetectedDevicePref('webgpu');

    expect(useVectorPreferencesStore.getState().devicePref).toBe('webgpu');
    expect(useVectorPreferencesStore.getState().devicePrefConfigured).toBe(false);
  });

  it('rejects automatic WASM detection instead of persisting a slow backend', () => {
    expect(() => useVectorPreferencesStore.getState().setDetectedDevicePref('wasm')).toThrow(
      'Automatic vector device detection cannot persist WASM.'
    );

    expect(useVectorPreferencesStore.getState().devicePref).toBe('webgpu');
    expect(useVectorPreferencesStore.getState().devicePrefConfigured).toBe(false);
  });

  it('clamps numeric preferences to safe ranges', () => {
    const store = useVectorPreferencesStore.getState();
    store.setReinitEveryN(0.2);
    store.setVerboseOrtLogs('yes' as unknown as boolean);

    const next = useVectorPreferencesStore.getState();
    expect(next.reinitEveryN).toBe(1);
    expect(next.verboseOrtLogs).toBe(true);
  });

  it('persists through fallback storage when localStorage fails', () => {
    const persistApi = storeWithPersist.persist;
    expect(persistApi).toBeDefined();
    const options = persistApi?.getOptions?.();
    expect(options?.storage).toBeDefined();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const storage = options.storage;
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    const store = useVectorPreferencesStore.getState();
    store.setDevicePref('wasm');
    store.setReinitEveryN(16);

    const persistedValue = storage.getItem(options.name)!;
    expect(persistedValue).not.toBeNull();

    if (
      !persistedValue ||
      typeof (persistedValue as { state?: unknown }) !== 'object' ||
      Array.isArray(persistedValue)
    ) {
      throw new Error('unexpected persisted snapshot');
    }

    const snapshot = persistedValue as {
      state?: {
        devicePrefConfigured?: boolean;
        devicePref: string;
        reinitEveryN: number;
      };
    };

    expect(snapshot.state?.devicePref).toBe('wasm');
    expect(snapshot.state?.devicePrefConfigured).toBe(true);
    expect(snapshot.state?.reinitEveryN).toBe(16);

    persistApi.clearStorage?.();
    const afterClear = storage.getItem(options.name)!;
    expect(afterClear).toBeNull();
  });

  it('migrates legacy snapshots strictly and repairs unconfigured WASM snapshots', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }

    // When persistedState is falsy, the migration returns explicit defaults
    // so devicePref is never undefined during Zustand hydration.
    expect(options.migrate(undefined, 1)).toEqual({
      devicePref: 'webgpu',
      devicePrefConfigured: false,
      reinitEveryN: 200,
      verboseOrtLogs: false,
    });
    expect(options.migrate({ devicePref: 'wasm', reinitEveryN: 8 }, 1)).toEqual({
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 8,
      verboseOrtLogs: false,
    });
    expect(options.migrate({ devicePref: 'invalid', verboseOrtLogs: true }, 1)).toEqual({
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 200,
      verboseOrtLogs: true,
    });

    const v2Snapshot = { devicePref: 'wasm' as const, reinitEveryN: 32, verboseOrtLogs: true };
    expect(options.migrate(v2Snapshot, 2)).toEqual({
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 32,
      verboseOrtLogs: true,
    });

    const configuredV3Snapshot = {
      devicePrefConfigured: true,
      devicePref: 'wasm' as const,
      reinitEveryN: 32,
      verboseOrtLogs: true,
    };
    expect(options.migrate(configuredV3Snapshot, 3)).toEqual(configuredV3Snapshot);

    const unconfiguredV3Snapshot = {
      devicePrefConfigured: false,
      devicePref: 'wasm' as const,
      reinitEveryN: 32,
      verboseOrtLogs: true,
    };
    expect(options.migrate(unconfiguredV3Snapshot, 3)).toEqual({
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 32,
      verboseOrtLogs: true,
    });
  });

  it('marks the store as hydrated after successful rehydration', async () => {
    const persistApi = storeWithPersist.persist;
    if (!persistApi?.rehydrate) {
      throw new Error('persist rehydrate unavailable for test');
    }

    expect(useVectorPreferencesStore.getState().hasHydrated).toBe(false);
    await persistApi.rehydrate();

    expect(useVectorPreferencesStore.getState().hasHydrated).toBe(true);
  });

  it('explicitly rehydrates through the exported helper', async () => {
    const persistApi = storeWithPersist.persist;
    if (!persistApi?.rehydrate) {
      throw new Error('persist rehydrate unavailable for test');
    }

    useVectorPreferencesStore.setState({
      hasHydrated: false,
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 200,
      verboseOrtLogs: false,
    });

    const rehydrateSpy = vi.spyOn(persistApi, 'rehydrate').mockImplementation(async () => {
      useVectorPreferencesStore.setState({
        hasHydrated: true,
        devicePrefConfigured: true,
        devicePref: 'wasm',
        reinitEveryN: 16,
        verboseOrtLogs: true,
      });
    });

    const state = await ensureVectorPreferencesHydrated();

    expect(rehydrateSpy).toHaveBeenCalledOnce();
    expect(state.devicePref).toBe('wasm');
    expect(state.devicePrefConfigured).toBe(true);
    expect(state.reinitEveryN).toBe(16);
    expect(state.verboseOrtLogs).toBe(true);
  });

  it('forces a fresh reload when explicitly requested', async () => {
    const persistApi = storeWithPersist.persist;
    if (!persistApi?.rehydrate) {
      throw new Error('persist rehydrate unavailable for test');
    }

    useVectorPreferencesStore.setState({
      hasHydrated: true,
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 200,
      verboseOrtLogs: false,
    });

    const rehydrateSpy = vi.spyOn(persistApi, 'rehydrate').mockImplementation(async () => {
      useVectorPreferencesStore.setState({
        hasHydrated: true,
        devicePrefConfigured: true,
        devicePref: 'wasm',
        reinitEveryN: 32,
        verboseOrtLogs: true,
      });
    });

    const state = await ensureVectorPreferencesHydrated({ forceReload: true });

    expect(rehydrateSpy).toHaveBeenCalledOnce();
    expect(state.devicePref).toBe('wasm');
    expect(state.devicePrefConfigured).toBe(true);
  });

  it('accepts the explicit store hydration marker after rehydrate completes', async () => {
    const persistApi = storeWithPersist.persist;

    useVectorPreferencesStore.setState({
      hasHydrated: false,
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 200,
      verboseOrtLogs: false,
    });

    vi.spyOn(persistApi, 'hasHydrated').mockReturnValue(false);
    vi.spyOn(persistApi, 'rehydrate').mockImplementation(async () => {
      useVectorPreferencesStore.setState({
        hasHydrated: true,
        devicePrefConfigured: false,
        devicePref: 'webgpu',
        reinitEveryN: 200,
        verboseOrtLogs: false,
      });
    });

    await expect(ensureVectorPreferencesHydrated({ forceReload: true })).resolves.toMatchObject({
      devicePref: 'webgpu',
      hasHydrated: true,
    });
  });

  it('repairs the store hydration marker when persist has completed', async () => {
    const persistApi = storeWithPersist.persist;

    useVectorPreferencesStore.setState({
      hasHydrated: false,
      devicePrefConfigured: false,
      devicePref: 'webgpu',
      reinitEveryN: 200,
      verboseOrtLogs: false,
    });

    vi.spyOn(persistApi, 'hasHydrated').mockReturnValue(true);
    vi.spyOn(persistApi, 'rehydrate').mockResolvedValue(undefined);

    await expect(ensureVectorPreferencesHydrated()).resolves.toMatchObject({
      devicePref: 'webgpu',
      hasHydrated: true,
    });
  });

  it('auto-hydrates on first module evaluation without manual rehydrate', async () => {
    vi.resetModules();

    const module = await import('../stores/vector-preferences-store');
    const freshStore = module.useVectorPreferencesStore as PersistApi<
      typeof module.useVectorPreferencesStore
    >;

    expect(freshStore.getState().hasHydrated).toBe(true);
    expect(freshStore.persist?.hasHydrated?.()).toBe(true);
  });
});
