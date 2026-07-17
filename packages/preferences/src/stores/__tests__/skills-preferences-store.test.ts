/**
 * Skills preferences store tests: durable-key disable map hygiene (only `true`
 * entries persist), master toggle default ON, wire-shape derivation, migration
 * sanitization, and the factory-reset contract.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetSkillsPreferencesStoreForTests,
  buildSkillsContextRequest,
  resetSkillsPreferencesStoreToDefaults,
  useSkillsPreferencesStore,
} from '../skills-preferences-store';

afterEach(() => {
  __resetSkillsPreferencesStoreForTests();
});

describe('skills preferences store', () => {
  it('defaults to master enabled with nothing disabled', () => {
    const state = useSkillsPreferencesStore.getState();
    expect(state.masterEnabled).toBe(true);
    expect(state.disabledSkillKeys).toEqual({});
  });

  it('records disables keyed durably and deletes the key on re-enable (no false residue)', () => {
    const { setSkillDisabled } = useSkillsPreferencesStore.getState();
    setSkillDisabled('root:root-a:pdf-processing', true);
    setSkillDisabled('global:code-review', true);
    expect(useSkillsPreferencesStore.getState().disabledSkillKeys).toEqual({
      'global:code-review': true,
      'root:root-a:pdf-processing': true,
    });

    setSkillDisabled('global:code-review', false);
    expect(useSkillsPreferencesStore.getState().disabledSkillKeys).toEqual({
      'root:root-a:pdf-processing': true,
    });
  });

  it('ignores empty keys', () => {
    useSkillsPreferencesStore.getState().setSkillDisabled('', true);
    expect(useSkillsPreferencesStore.getState().disabledSkillKeys).toEqual({});
  });

  it('derives the serializable wire request', () => {
    const { setMasterEnabled, setSkillDisabled } = useSkillsPreferencesStore.getState();
    setSkillDisabled('global:x', true);
    setMasterEnabled(false);
    expect(buildSkillsContextRequest(useSkillsPreferencesStore.getState())).toEqual({
      disabledSkillKeys: ['global:x'],
      masterEnabled: false,
    });
  });

  it('factory reset restores defaults', () => {
    const { setMasterEnabled, setSkillDisabled } = useSkillsPreferencesStore.getState();
    setSkillDisabled('global:x', true);
    setMasterEnabled(false);
    resetSkillsPreferencesStoreToDefaults();
    const state = useSkillsPreferencesStore.getState();
    expect(state.masterEnabled).toBe(true);
    expect(state.disabledSkillKeys).toEqual({});
  });
});
