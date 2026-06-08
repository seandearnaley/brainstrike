import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  type BackgroundIndexingPreferencesStore,
  useBackgroundIndexingPreferencesStore,
} from '../stores/background-indexing-preferences-store';
import type { PersistApi } from './persist-api-test-helper';

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
});
