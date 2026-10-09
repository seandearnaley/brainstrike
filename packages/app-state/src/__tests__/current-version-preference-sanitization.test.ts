import { describe, expect, it } from 'vitest';
import { useBackgroundIndexingPreferencesStore } from '../stores/background-indexing-preferences-store';
import { useSubagentPersonasStore } from '../stores/subagent-personas-store';
import { useTokenPreferencesStore } from '../stores/token-preferences-store';
import { useVectorPreferencesStore } from '../stores/vector-preferences-store';
import { useWorkspaceInstructionsPreferencesStore } from '../stores/workspace-instructions-preferences-store';
import type { PersistApi } from './persist-api-test-helper';

function mergeCurrentVersion<TStore>(
  store: TStore,
  persistedState: unknown,
  currentState: unknown
): unknown {
  const merge = (store as PersistApi<TStore>).persist?.getOptions?.().merge;
  if (!merge) {
    throw new Error('persist merge unavailable for test');
  }
  return merge(persistedState, currentState);
}

describe('current-version preference sanitization siblings', () => {
  it('sanitizes background indexing data and preserves actions', () => {
    const current = useBackgroundIndexingPreferencesStore.getState();
    const merged = mergeCurrentVersion(
      useBackgroundIndexingPreferencesStore,
      {
        enabled: 'yes',
        indexingPolicyPreset: 'everything',
        managedCollectionId: 42,
        mode: 'legacy',
        paused: 1,
        setEnabled: 'injected',
      },
      current
    ) as typeof current;

    expect(merged.enabled).toBe(true);
    expect(merged.indexingPolicyPreset).toBe('balanced');
    expect(merged.managedCollectionId).toBeNull();
    expect(merged.mode).toBe('root-folder-cache');
    expect(merged.paused).toBe(false);
    expect(merged.setEnabled).toBe(current.setEnabled);
  });

  it('sanitizes subagent availability at the current version', () => {
    const current = useSubagentPersonasStore.getState();
    const merged = mergeCurrentVersion(
      useSubagentPersonasStore,
      { delegationEnabled: 'yes', disabledPersonaIds: ['explore', 42] },
      current
    ) as typeof current;

    expect(merged.delegationEnabled).toBe(true);
    expect(merged.disabledPersonaIds).toEqual(['explore']);
  });

  it('sanitizes token counting at the current version', () => {
    const current = useTokenPreferencesStore.getState();
    const merged = mergeCurrentVersion(
      useTokenPreferencesStore,
      { accurateCounting: 'yes' },
      current
    ) as typeof current;

    expect(merged.accurateCounting).toBe(true);
  });

  it('sanitizes vector runtime settings at the current version', () => {
    const current = useVectorPreferencesStore.getState();
    const merged = mergeCurrentVersion(
      useVectorPreferencesStore,
      {
        devicePref: 'unknown',
        devicePrefConfigured: 'yes',
        reinitEveryN: -5,
        verboseOrtLogs: 'yes',
      },
      current
    ) as typeof current;

    expect(merged.devicePref).toBe('webgpu');
    expect(merged.devicePrefConfigured).toBe(false);
    expect(merged.reinitEveryN).toBe(200);
    expect(merged.verboseOrtLogs).toBe(false);
  });

  it('sanitizes workspace instruction preferences at the current version', () => {
    const current = useWorkspaceInstructionsPreferencesStore.getState();
    const merged = mergeCurrentVersion(
      useWorkspaceInstructionsPreferencesStore,
      {
        masterEnabled: 'yes',
        oversizedOptInByRootId: { 'root-a': 'yes', 'root-b': true },
      },
      current
    ) as typeof current;

    expect(merged.masterEnabled).toBe(true);
    expect(merged.oversizedOptInByRootId).toEqual({ 'root-b': true });
  });
});
