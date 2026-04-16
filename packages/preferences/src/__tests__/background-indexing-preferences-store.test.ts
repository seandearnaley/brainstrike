import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '../stores/background-indexing-preferences-store';

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

  it('initializes with background indexing disabled and no managed collection', () => {
    const state = useBackgroundIndexingPreferencesStore.getState();

    expect(state.enabled).toBe(false);
    expect(state.indexingPolicyPreset).toBe('balanced');
    expect(state.managedCollectionId).toBeNull();
    expect(state.mode).toBe('root-folder-cache');
    expect(state.hasHydrated).toBe(false);
  });

  it('updates enablement, policy, and managed collection independently', () => {
    const store = useBackgroundIndexingPreferencesStore.getState();

    store.setEnabled(true);
    store.setIndexingPolicyPreset('full-root');
    store.setManagedCollectionId('collection-123');

    expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
      enabled: true,
      indexingPolicyPreset: 'full-root',
      managedCollectionId: 'collection-123',
      mode: 'root-folder-cache',
    });
  });

  it('clears managed collection when reset is called', () => {
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      indexingPolicyPreset: 'full-root',
      managedCollectionId: 'collection-123',
      mode: 'root-folder-cache',
      hasHydrated: true,
    });

    useBackgroundIndexingPreferencesStore.getState().reset();

    expect(useBackgroundIndexingPreferencesStore.getState()).toMatchObject({
      enabled: false,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: null,
      mode: 'root-folder-cache',
      hasHydrated: true,
    });
  });
});
