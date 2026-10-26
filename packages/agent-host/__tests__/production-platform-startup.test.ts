// ADR-0031: one failed acquisition fails the production host's startup at once; it never waits
// for the other acquisition, which stays owned through its startup registration.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { expect, it } from 'vitest';
import { createProductionHostPlatform } from '../src/production-platform.js';

it('rejects when the state index fails while the configuration is still settling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-production-startup-'));
  const store = await StateStore.open(root);
  try {
    let registrations = 0;
    const configuring = Promise.withResolvers<never>();
    const startup = {
      register: async () => {
        registrations += 1;
        // The first is the platform's own close; the second is the state index's.
        if (registrations === 2) {
          throw new Error('state index registration refused');
        }
      },
      signal: new AbortController().signal,
      store,
    };
    await expect(
      createProductionHostPlatform({
        configure: () => configuring.promise,
        memoryResourceIds: [],
        startup,
      })
    ).rejects.toThrow('state index registration refused');
    configuring.reject(new Error('configuration abandoned'));
  } finally {
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
});
