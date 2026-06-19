import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  type BackgroundIndexingPreferencesStore,
  ensureBackgroundIndexingPreferencesHydrated,
  useBackgroundIndexingPreferencesStore,
} from '../stores/background-indexing-preferences-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = useBackgroundIndexingPreferencesStore as PersistApi<
  typeof useBackgroundIndexingPreferencesStore
>;

describe('background-indexing-preferences-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(
      window as Window & {
        electronAPI?: unknown;
      },
      'electronAPI'
    );
    __resetBackgroundIndexingPreferencesStoreForTests();
  });

  it('initializes with workspace indexing enabled and no managed collection', () => {
    const state = useBackgroundIndexingPreferencesStore.getState();

    expect(state.enabled).toBe(true);
    expect(state.indexingPolicyPreset).toBe('balanced');
    expect(state.managedCollectionId).toBeNull();
    expect(state.mode).toBe('root-folder-cache');
    expect(state.paused).toBe(false);
    expect(state.hasHydrated).toBe(false);
  });

  it('migrates pre-workspace-index preferences without overriding an explicit disabled state', () => {
    const options = (
      useBackgroundIndexingPreferencesStore as PersistApi<
        typeof useBackgroundIndexingPreferencesStore
      >
    ).persist?.getOptions?.();
    if (!(options?.migrate && options.version !== undefined)) {
      throw new Error('persist options unavailable for background indexing preferences test');
    }

    expect(options.version).toBe(4);

    const migrated = options.migrate(
      {
        enabled: false,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: null,
        mode: 'root-folder-cache',
        paused: false,
      },
      3
    ) as BackgroundIndexingPreferencesStore;

    expect(migrated.enabled).toBe(false);
    expect(migrated.indexingPolicyPreset).toBe('full-root');
    expect(migrated.paused).toBe(false);
  });

  it('migrates incomplete pre-workspace-index preferences to the default enabled state', () => {
    const options = (
      useBackgroundIndexingPreferencesStore as PersistApi<
        typeof useBackgroundIndexingPreferencesStore
      >
    ).persist?.getOptions?.();
    if (!(options?.migrate && options.version !== undefined)) {
      throw new Error('persist options unavailable for background indexing preferences test');
    }

    expect(options.version).toBe(4);

    const migrated = options.migrate(
      {
        indexingPolicyPreset: 'balanced',
        managedCollectionId: null,
        mode: 'root-folder-cache',
        paused: false,
      },
      3
    ) as BackgroundIndexingPreferencesStore;

    expect(migrated.enabled).toBe(true);
  });

  it('updates enablement, policy, managed collection, and pause independently', () => {
    const store = useBackgroundIndexingPreferencesStore.getState();

    store.setEnabled(false);
    store.setIndexingPolicyPreset('full-root');
    store.setManagedCollectionId('collection-123');
    store.setPaused(true);

    expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
      enabled: false,
      indexingPolicyPreset: 'full-root',
      managedCollectionId: 'collection-123',
      mode: 'root-folder-cache',
      paused: true,
    });
  });

  it('clears managed collection when reset is called', () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      indexingPolicyPreset: 'full-root',
      managedCollectionId: 'collection-123',
      mode: 'root-folder-cache',
      paused: true,
      hasHydrated: true,
    });

    useBackgroundIndexingPreferencesStore.getState().reset();

    expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: false,
      hasHydrated: true,
    });
  });

  it('explicitly rehydrates through the exported helper', async () => {
    const persistApi = storeWithPersist.persist;
    if (!persistApi?.rehydrate) {
      throw new Error('persist rehydrate unavailable for test');
    }

    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: false,
      hasHydrated: false,
    });

    const rehydrateSpy = vi.spyOn(persistApi, 'rehydrate').mockImplementation(async () => {
      useBackgroundIndexingPreferencesStore.setState({
        enabled: true,
        indexingPolicyPreset: 'full-root',
        managedCollectionId: 'collection-1',
        mode: 'root-folder-cache',
        paused: false,
        hasHydrated: true,
      });
    });

    const state = await ensureBackgroundIndexingPreferencesHydrated();

    expect(rehydrateSpy).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      indexingPolicyPreset: 'full-root',
      managedCollectionId: 'collection-1',
      hasHydrated: true,
    });
  });

  it('repairs the store hydration marker when persist has completed', async () => {
    const persistApi = storeWithPersist.persist;
    if (!persistApi?.rehydrate) {
      throw new Error('persist rehydrate unavailable for test');
    }

    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: false,
      hasHydrated: false,
    });

    vi.spyOn(persistApi, 'hasHydrated').mockReturnValue(true);
    vi.spyOn(persistApi, 'rehydrate').mockResolvedValue(undefined);

    await expect(ensureBackgroundIndexingPreferencesHydrated()).resolves.toMatchObject({
      enabled: true,
      hasHydrated: true,
    });
  });

  it('hydrates from configured storage when persist rehydrate does not finish', async () => {
    const persistApi = storeWithPersist.persist;
    if (!(persistApi?.rehydrate && persistApi.hasHydrated && persistApi.getOptions)) {
      throw new Error('persist API unavailable for test');
    }

    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      paused: false,
      hasHydrated: false,
    });
    window.localStorage.setItem(
      'background-indexing-preferences.v1',
      JSON.stringify({
        state: {
          enabled: false,
          indexingPolicyPreset: 'full-root',
          managedCollectionId: 'persisted-workspace-index',
          mode: 'root-folder-cache',
          paused: true,
        },
        version: 4,
      })
    );

    vi.spyOn(persistApi, 'hasHydrated').mockReturnValue(false);
    vi.spyOn(persistApi, 'rehydrate').mockResolvedValue(undefined);

    await expect(ensureBackgroundIndexingPreferencesHydrated()).resolves.toMatchObject({
      enabled: false,
      hasHydrated: true,
      indexingPolicyPreset: 'full-root',
      managedCollectionId: 'persisted-workspace-index',
      paused: true,
    });
  });

  it('auto-hydrates on first module evaluation without manual rehydrate', async () => {
    Reflect.deleteProperty(
      globalThis as unknown as Record<string, unknown>,
      '__brainstrike_background_indexing_preferences_store__'
    );
    vi.resetModules();

    const module = await import('../stores/background-indexing-preferences-store');
    const freshStore = module.useBackgroundIndexingPreferencesStore as PersistApi<
      typeof module.useBackgroundIndexingPreferencesStore
    >;

    expect(freshStore.getState().hasHydrated).toBe(true);
    expect(freshStore.persist?.hasHydrated?.()).toBe(true);
  });

  it('replaces a branded global singleton that lacks the persist API', async () => {
    const staleStore = Object.assign(vi.fn(), {
      getState: vi.fn(() => ({
        ...useBackgroundIndexingPreferencesStore.getState(),
      })),
      setState: vi.fn(),
      __brainstrike_store_brand__: 1,
    });
    Reflect.set(
      globalThis as unknown as Record<string, unknown>,
      '__brainstrike_background_indexing_preferences_store__',
      staleStore
    );
    vi.resetModules();

    const module = await import('../stores/background-indexing-preferences-store');
    const freshStore = module.useBackgroundIndexingPreferencesStore as PersistApi<
      typeof module.useBackgroundIndexingPreferencesStore
    >;

    expect(freshStore).not.toBe(staleStore);
    expect(freshStore.persist?.rehydrate).toEqual(expect.any(Function));
    expect(freshStore.persist?.hasHydrated).toEqual(expect.any(Function));
  });
});
