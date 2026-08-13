import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetExperimentAssignmentPreferencesStoreForTests,
  selectExperimentAssignmentRequest,
  useExperimentAssignmentPreferencesStore,
} from '../stores/experiment-assignment-preferences-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = useExperimentAssignmentPreferencesStore as PersistApi<
  typeof useExperimentAssignmentPreferencesStore
>;

describe('experiment-assignment-preferences-store', () => {
  beforeEach(() => {
    __resetExperimentAssignmentPreferencesStoreForTests();
  });

  it('defaults to un-enrolled (both fields null)', () => {
    const state = useExperimentAssignmentPreferencesStore.getState();
    expect(state.experimentId).toBeNull();
    expect(state.variant).toBeNull();
  });

  it('stores trimmed values and treats blank input as null', () => {
    const store = useExperimentAssignmentPreferencesStore.getState();
    store.setExperimentId('  search-policy-v1  ');
    store.setVariant('   ');
    const state = useExperimentAssignmentPreferencesStore.getState();
    expect(state.experimentId).toBe('search-policy-v1');
    expect(state.variant).toBeNull();
  });

  it('emits a wire request only when BOTH fields are set (atomic pair)', () => {
    const store = useExperimentAssignmentPreferencesStore.getState();
    expect(
      selectExperimentAssignmentRequest(useExperimentAssignmentPreferencesStore.getState())
    ).toBeUndefined();

    store.setExperimentId('search-policy-v1');
    expect(
      selectExperimentAssignmentRequest(useExperimentAssignmentPreferencesStore.getState())
    ).toBeUndefined();

    store.setVariant('control');
    expect(
      selectExperimentAssignmentRequest(useExperimentAssignmentPreferencesStore.getState())
    ).toEqual({
      experimentId: 'search-policy-v1',
      variant: 'control',
    });
  });

  it('persists both fields under the expected storage key', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const store = useExperimentAssignmentPreferencesStore.getState();
    store.setExperimentId('search-policy-v1');
    store.setVariant('injection');

    const stored = options.storage.getItem(options.name) as unknown as {
      state?: { experimentId?: string | null; variant?: string | null };
    } | null;
    expect(stored).not.toBeNull();
    expect(stored?.state?.experimentId).toBe('search-policy-v1');
    expect(stored?.state?.variant).toBe('injection');
  });

  it('migrates malformed persisted data back to safe defaults', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }

    const migrated = options.migrate({ experimentId: 42, variant: '  control ' }, 0) as {
      experimentId: string | null;
      variant: string | null;
    };

    expect(migrated.experimentId).toBeNull();
    expect(migrated.variant).toBe('control');
  });

  it('resets to defaults', () => {
    const store = useExperimentAssignmentPreferencesStore.getState();
    store.setExperimentId('search-policy-v1');
    store.setVariant('control');

    store.resetToDefaults();

    const state = useExperimentAssignmentPreferencesStore.getState();
    expect(state.experimentId).toBeNull();
    expect(state.variant).toBeNull();
  });
});
