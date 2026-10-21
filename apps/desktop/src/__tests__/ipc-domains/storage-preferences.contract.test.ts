import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  settingsContract,
  storageContract,
  vectorPreferencesContract,
} from '../../ipc-domains/storage-preferences.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import type { Bridge } from '../../platform/ipc-contract';

describe('storage and preferences IPC contracts', () => {
  it('pins exact keys, manifest channels, raw envelopes, and roles', () => {
    expect(Object.keys(storageContract).sort()).toEqual([
      'clear',
      'getAllKeys',
      'getItem',
      'removeItem',
      'setItem',
    ]);
    expect(Object.keys(settingsContract)).toEqual(['clearAll']);
    expect(Object.keys(vectorPreferencesContract).sort()).toEqual(['clear', 'read', 'write']);

    expect(storageContract.getItem.channel).toBe(DESKTOP_IPC_CHANNELS.storage.getItem);
    expect(settingsContract.clearAll.channel).toBe(
      DESKTOP_IPC_CHANNELS.preferences.settingsClearAll
    );
    expect(vectorPreferencesContract.write.channel).toBe(
      DESKTOP_IPC_CHANNELS.vectorPreferences.write
    );

    for (const spec of [...Object.values(storageContract), ...Object.values(settingsContract)]) {
      expect(spec).toMatchObject({ envelope: 'raw', roles: ['visible-ui'] });
    }
    for (const spec of Object.values(vectorPreferencesContract)) {
      expect(spec).toMatchObject({ envelope: 'raw', roles: ['embedding-host'] });
    }
  });

  it('derives the shared storage bridge shape', () => {
    expectTypeOf<Bridge<typeof storageContract>>().toMatchTypeOf<{
      clear: () => Promise<void>;
      getAllKeys: () => Promise<string[]>;
      getItem: (key: string) => Promise<string | null>;
      removeItem: (key: string) => Promise<void>;
      setItem: (key: string, value: string) => Promise<void>;
    }>();
  });

  it('parses storage and vector string tuples without coercion', () => {
    expect(storageContract.getItem.parseArgs(['alpha'])).toEqual(['alpha']);
    expect(storageContract.setItem.parseArgs(['alpha', 'beta'])).toEqual(['alpha', 'beta']);
    expect(vectorPreferencesContract.write.parseArgs(['json'])).toEqual(['json']);

    for (const raw of [[], [42], ['a', 'b']]) {
      expect(() => storageContract.getItem.parseArgs(raw)).toThrow();
      expect(() => vectorPreferencesContract.write.parseArgs(raw)).toThrow();
    }
    for (const raw of [[], ['a'], ['a', 42], ['a', 'b', 'c']]) {
      expect(() => storageContract.setItem.parseArgs(raw)).toThrow();
    }
  });

  it('parses no-argument methods and rejects extra input', () => {
    for (const spec of [
      storageContract.clear,
      storageContract.getAllKeys,
      settingsContract.clearAll,
      vectorPreferencesContract.clear,
      vectorPreferencesContract.read,
    ]) {
      expect(spec.parseArgs([])).toEqual([]);
      expect(() => spec.parseArgs(['unexpected'])).toThrow();
    }
  });
});
