/**
 * Skills preferences store tests: durable-key disable map hygiene (only `true`
 * entries persist), master toggle default ON, wire-shape derivation, migration
 * sanitization, and the factory-reset contract.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { PersistApi } from '../../__tests__/persist-api-test-helper.ts';
import {
  __resetSkillsPreferencesStoreForTests,
  buildSkillsContextRequest,
  useSkillsPreferencesStore,
} from '../skills-preferences-store.ts';

const storeWithPersist = useSkillsPreferencesStore as PersistApi<typeof useSkillsPreferencesStore>;

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

  it('derives defensively from corrupted persisted state (never throws in a render path)', () => {
    expect(
      buildSkillsContextRequest({
        disabledSkillKeys: null as unknown as Record<string, boolean>,
        masterEnabled: 'yes' as unknown as boolean,
      })
    ).toEqual({ disabledSkillKeys: [], masterEnabled: false });
  });

  it('sanitizes malformed persisted data at the current version during rehydration', async () => {
    const options = storeWithPersist.persist?.getOptions?.();
    if (
      !(
        options?.storage &&
        options.name &&
        options.version !== undefined &&
        storeWithPersist.persist?.rehydrate
      )
    ) {
      throw new Error('persist storage unavailable for test');
    }

    await options.storage.setItem(options.name, {
      state: {
        disabledSkillKeys: {
          'global:disabled': true,
          'global:false-residue': false,
          'global:malformed': 'yes',
        },
        masterEnabled: 'yes',
      },
      version: options.version,
    });

    await storeWithPersist.persist.rehydrate();

    expect(useSkillsPreferencesStore.getState().disabledSkillKeys).toEqual({
      'global:disabled': true,
    });
    expect(useSkillsPreferencesStore.getState().masterEnabled).toBe(true);
  });
});
