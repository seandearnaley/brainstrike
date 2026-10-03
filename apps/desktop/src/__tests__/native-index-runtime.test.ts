// @vitest-environment node
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { createNativeIndexRuntime } from '../native-index-runtime';

function fixture() {
  const events: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('Unused fixture operation');
  };
  const port: IndexerPort & ScopedIndexerPort = {
    close: unused,
    commitFile: unused,
    commitScopedFile: unused,
    commitScopedTextFile: unused,
    commitTextFile: unused,
    configureVectorProfile: unused,
    coverage: unused,
    coverageScope: unused,
    destroy: unused,
    info: unused,
    prepareFile: unused,
    prepareScopedFile: unused,
    removeFile: unused,
    removeScopedFile: unused,
    replaceFileBindings: unused,
    search: unused,
    searchScopes: unused,
    verifyManifest: unused,
    verifyScopedManifest: unused,
  };
  const closeWriter = vi.fn(async () => {
    events.push('writer-close');
  });
  const closeQueries = vi.fn(async () => {
    events.push('readers-close');
  });
  const closeProfile = vi.fn(async () => {
    events.push('profile-close');
  });
  const createIndexOwner = vi.fn(async () => ({
    close: closeWriter,
    databasePath: '/owned/index.sqlite',
    start: async () => {
      events.push('writer-start');
      return port;
    },
  }));
  const runtime = createNativeIndexRuntime({
    closeQueries,
    createIndexOwner,
    createProfileOwner: () => ({
      acquire: async () => {
        events.push('profile-acquire');
      },
      close: closeProfile,
    }),
    getAuthority: async () => ({
      fileBindings: [],
      rootIds: ['root'],
      scopes: [{ kind: 'workspace', rootId: 'root' }],
    }),
    getFileInvalidator: () => () => {},
    installQueryTarget: () => {
      events.push('reader-install');
    },
  });
  return { closeProfile, closeQueries, closeWriter, createIndexOwner, events, runtime };
}

it('retains profile ownership until readers and writer have both exited', async () => {
  const f = fixture();
  await f.runtime.acquire();
  await f.runtime.closeIndex();
  expect(f.closeProfile).not.toHaveBeenCalled();
  await expect(f.runtime.acquire()).rejects.toThrow('admission is closed');
  await f.runtime.retireProfile();
  expect(f.events.slice(-3)).toEqual(['writer-close', 'readers-close', 'profile-close']);
  await f.runtime.resume();
  await f.runtime.acquire();
  expect(f.createIndexOwner).toHaveBeenCalledTimes(2);
});

it('retains the writer and lease when reader cleanup fails, then retries the same owner', async () => {
  const f = fixture();
  await f.runtime.acquire();
  const cause = new Error('reader utility did not exit');
  f.closeQueries.mockRejectedValueOnce(cause);
  await expect(f.runtime.retireProfile()).rejects.toBe(cause);
  expect(f.closeWriter).not.toHaveBeenCalled();
  expect(f.closeProfile).not.toHaveBeenCalled();
  await expect(f.runtime.resume()).rejects.toThrow('Previous native ownership');
  await f.runtime.retireProfile();
  expect(f.closeWriter).toHaveBeenCalledTimes(1);
  expect(f.closeProfile).toHaveBeenCalledTimes(1);
});

it('joins startup racing reset and never installs a query target for its late writer', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.createIndexOwner>>>();
  const owner = await f.createIndexOwner();
  f.createIndexOwner.mockReturnValueOnce(pending.promise);
  const acquiring = f.runtime.acquire();
  // The acquisition reaches the injected asynchronous owner factory.
  await vi.waitFor(() => expect(f.createIndexOwner).toHaveBeenCalledTimes(2));
  const closing = f.runtime.retireProfile();
  pending.resolve(owner);
  await expect(acquiring).rejects.toThrow('closed during writer acquisition');
  await closing;
  expect(f.events).not.toContain('reader-install');
  expect(f.closeWriter).toHaveBeenCalledTimes(1);
  expect(f.closeProfile).toHaveBeenCalledTimes(1);
});
