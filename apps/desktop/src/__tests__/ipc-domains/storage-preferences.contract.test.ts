import { describe, expect, expectTypeOf, it } from 'vitest';
import { storageContract } from '../../ipc-domains/storage-preferences.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import type { Bridge } from '../../platform/ipc-contract';

describe('storage IPC contract', () => {
  it('pins exact keys, manifest channels, and raw envelopes', () => {
    expect(Object.keys(storageContract).sort()).toEqual([
      'getAllKeys',
      'getItem',
      'removeItem',
      'setItem',
    ]);

    expect(storageContract.getItem.channel).toBe(DESKTOP_IPC_CHANNELS.storage.getItem);

    for (const spec of Object.values(storageContract)) {
      expect(spec).toMatchObject({ envelope: 'raw' });
    }
  });

  it('derives the shared storage bridge shape', () => {
    expectTypeOf<Bridge<typeof storageContract>>().toMatchTypeOf<{
      getAllKeys: () => Promise<string[]>;
      getItem: (key: string) => Promise<string | null>;
      removeItem: (key: string) => Promise<void>;
      setItem: (key: string, value: string) => Promise<void>;
    }>();
  });
});
