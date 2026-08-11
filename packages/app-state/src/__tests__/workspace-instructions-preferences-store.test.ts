import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWorkspaceInstructionsPreferencesStoreForTests,
  useWorkspaceInstructionsPreferencesStore,
} from '../stores/workspace-instructions-preferences-store';
import type { PersistApi } from './persist-api-test-helper';

const storeWithPersist = useWorkspaceInstructionsPreferencesStore as PersistApi<
  typeof useWorkspaceInstructionsPreferencesStore
>;

describe('workspace-instructions-preferences-store', () => {
  beforeEach(() => {
    __resetWorkspaceInstructionsPreferencesStoreForTests();
  });

  it('defaults the master toggle ON', () => {
    expect(useWorkspaceInstructionsPreferencesStore.getState().masterEnabled).toBe(true);
  });

  it('defaults the oversized opt-in map empty', () => {
    expect(useWorkspaceInstructionsPreferencesStore.getState().oversizedOptInByRootId).toEqual({});
  });

  it('turns the master toggle on and off', () => {
    const store = useWorkspaceInstructionsPreferencesStore.getState();
    store.setMasterEnabled(false);
    expect(useWorkspaceInstructionsPreferencesStore.getState().masterEnabled).toBe(false);
    store.setMasterEnabled(true);
    expect(useWorkspaceInstructionsPreferencesStore.getState().masterEnabled).toBe(true);
  });

  it('records an oversized opt-in keyed by rootId', () => {
    const store = useWorkspaceInstructionsPreferencesStore.getState();
    store.setOversizedOptIn('root-a', true);
    expect(useWorkspaceInstructionsPreferencesStore.getState().oversizedOptInByRootId).toEqual({
      'root-a': true,
    });
  });

  it('drops the entry when an opt-in is turned off (no stale false residue)', () => {
    const store = useWorkspaceInstructionsPreferencesStore.getState();
    store.setOversizedOptIn('root-a', true);
    store.setOversizedOptIn('root-b', true);
    store.setOversizedOptIn('root-a', false);
    expect(useWorkspaceInstructionsPreferencesStore.getState().oversizedOptInByRootId).toEqual({
      'root-b': true,
    });
  });

  it('persists the master toggle and opt-in map under the expected storage key', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!(options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    useWorkspaceInstructionsPreferencesStore.getState().setMasterEnabled(false);
    useWorkspaceInstructionsPreferencesStore.getState().setOversizedOptIn('root-a', true);

    const stored = options.storage.getItem(options.name) as unknown as {
      state?: { masterEnabled?: boolean; oversizedOptInByRootId?: Record<string, boolean> };
    } | null;
    expect(stored).not.toBeNull();
    expect(stored?.state?.masterEnabled).toBe(false);
    expect(stored?.state?.oversizedOptInByRootId).toEqual({ 'root-a': true });
  });

  it('migrates malformed persisted data back to safe defaults', () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (!options?.migrate) {
      throw new Error('persist migrate unavailable for test');
    }

    const migrated = options.migrate(
      { masterEnabled: 'yes', oversizedOptInByRootId: { 'root-a': 'nope', 'root-b': true } },
      0
    ) as { masterEnabled: boolean; oversizedOptInByRootId: Record<string, boolean> };

    // A malformed master flag falls back to the ON default (feature enabled).
    expect(migrated.masterEnabled).toBe(true);
    // Only well-typed `true` opt-ins survive; malformed entries are dropped.
    expect(migrated.oversizedOptInByRootId).toEqual({ 'root-b': true });
  });

  it('resets to defaults', () => {
    const store = useWorkspaceInstructionsPreferencesStore.getState();
    store.setMasterEnabled(false);
    store.setOversizedOptIn('root-a', true);

    store.resetToDefaults();

    const state = useWorkspaceInstructionsPreferencesStore.getState();
    expect(state.masterEnabled).toBe(true);
    expect(state.oversizedOptInByRootId).toEqual({});
  });
});
