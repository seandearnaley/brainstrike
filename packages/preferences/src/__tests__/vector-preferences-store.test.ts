import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVectorPreferencesStore } from '../stores/vector-preferences-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = useVectorPreferencesStore as PersistApi<typeof useVectorPreferencesStore>;

describe('vector-preferences-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const store = useVectorPreferencesStore;
    store.setState({
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
    useVectorPreferencesStore.getState().setDevicePref('wasm');
    expect(useVectorPreferencesStore.getState().devicePref).toBe('wasm');
    expect(useVectorPreferencesStore.getState().devicePrefConfigured).toBe(true);
  });

  it('updates detected device preference without marking it as user-configured', () => {
    useVectorPreferencesStore.getState().setDetectedDevicePref('wasm');

    expect(useVectorPreferencesStore.getState().devicePref).toBe('wasm');
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

  it('migrates legacy snapshots strictly and passes through v2 snapshots', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }

    expect(options.migrate(undefined, 1)).toBeUndefined();
    expect(options.migrate({ devicePref: 'wasm', reinitEveryN: 8 }, 1)).toEqual({
      devicePrefConfigured: false,
      devicePref: 'wasm',
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
      devicePref: 'wasm',
      reinitEveryN: 32,
      verboseOrtLogs: true,
    });

    const v3Snapshot = {
      devicePrefConfigured: true,
      devicePref: 'wasm' as const,
      reinitEveryN: 32,
      verboseOrtLogs: true,
    };
    expect(options.migrate(v3Snapshot, 3)).toEqual(v3Snapshot);
  });
});
