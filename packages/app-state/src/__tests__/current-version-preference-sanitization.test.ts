import { describe, expect, it } from 'vitest';
import { useSubagentPersonasStore } from '../stores/subagent-personas-store.ts';
import { useTokenPreferencesStore } from '../stores/token-preferences-store.ts';
import { useWorkspaceInstructionsPreferencesStore } from '../stores/workspace-instructions-preferences-store.ts';
import type { PersistApi } from './persist-api-test-helper.ts';

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
