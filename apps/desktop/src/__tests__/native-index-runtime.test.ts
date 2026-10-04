// @vitest-environment node
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { createNativeIndexRuntime, type NativeIndexAuthority } from '../native-index-runtime';

function fixture() {
  const events: string[] = [];
  let authority: NativeIndexAuthority = {
    fileBindings: [],
    rootIds: ['root'],
    scopes: [{ kind: 'workspace', rootId: 'root' }],
  };
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
    replaceFileBindings: vi.fn(async () => {
      events.push('bindings-replace');
    }),
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
    getAuthority: async () => authority,
    getFileInvalidator: () => () => {},
    installQueryTarget: () => {
      events.push('reader-install');
    },
  });
  return {
    closeProfile,
    closeQueries,
    closeWriter,
    createIndexOwner,
    events,
    port,
    runtime,
    setBindings: () => {
      authority = {
        ...authority,
        fileBindings: [
          {
            embeddingSetId: null,
            fileId: 'file',
            profile: null,
            relativePath: 'file.txt',
            rootId: 'root',
            sourcePath: '/file.txt',
          },
        ],
      };
    },
  };
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

it('drains the captured read before replacing bindings and fences later readers', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reading = f.runtime.withRead(f.runtime.acquire, async (captured) => {
    entered.resolve();
    await release.promise;
    expect(captured.readAuthority().fileBindings).toEqual([]);
    f.events.push('read-settled');
  });
  await entered.promise;
  f.setBindings();
  const replacing = f.runtime.acquire();
  let laterEntered = false;
  const later = f.runtime.withRead(f.runtime.acquire, async (captured) => {
    laterEntered = true;
    expect(captured.readAuthority().fileBindings).toHaveLength(1);
  });
  await vi.waitFor(() => expect(f.closeQueries).toHaveBeenCalledTimes(1));
  expect(f.events).not.toContain('bindings-replace');
  expect(laterEntered).toBe(false);
  release.resolve();
  await Promise.all([reading, replacing, later]);
  expect(f.events.indexOf('bindings-replace')).toBeGreaterThan(f.events.indexOf('read-settled'));
  await f.runtime.retireProfile();
});

it.each(['error', 'cancel'] as const)(
  'releases a %s read before owned removal and retirement',
  async (kind) => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cause = new Error(kind);
    const controller = new AbortController();
    const reading = f.runtime.withRead(f.runtime.acquire, async () => {
      entered.resolve();
      await release.promise;
      if (kind === 'cancel') {
        controller.signal.throwIfAborted();
      }
      throw cause;
    });
    const observed = reading.catch((error: unknown) => error);
    await entered.promise;
    const removal = f.runtime.mutateAuthority(f.port, async () => {
      f.events.push('remove');
    });
    expect(f.events).not.toContain('remove');
    if (kind === 'cancel') {
      controller.abort(cause);
    }
    release.resolve();
    expect(await observed).toBe(cause);
    await removal;
    await f.runtime.retireProfile();
    expect(f.events.indexOf('remove')).toBeLessThan(f.events.indexOf('writer-close'));
  }
);

it('joins in-flight reads before terminal writer retirement and refuses late read capture', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reading = f.runtime.withRead(f.runtime.acquire, async (captured) => {
    entered.resolve();
    await release.promise;
    expect(() => captured.readAuthority()).toThrow('closed');
  });
  await entered.promise;
  const closing = f.runtime.retireProfile();
  await expect(f.runtime.withRead(f.runtime.acquire, async () => {})).rejects.toThrow('closed');
  expect(f.closeWriter).not.toHaveBeenCalled();
  release.resolve();
  await Promise.all([reading, closing]);
  expect(f.closeProfile).toHaveBeenCalledTimes(1);
});

it('retains failed query cleanup admission until the original owner is retired', async () => {
  const f = fixture();
  await f.runtime.acquire();
  const cause = new Error('reader cleanup failed');
  f.closeQueries.mockRejectedValueOnce(cause);
  const work = vi.fn(async () => {});
  await expect(f.runtime.mutateAuthority(f.port, work)).rejects.toBe(cause);
  await expect(f.runtime.withRead(f.runtime.acquire, async () => {})).rejects.toBe(cause);
  expect(work).not.toHaveBeenCalled();
  await f.runtime.retireProfile();
  expect(f.closeWriter).toHaveBeenCalledTimes(1);
});

it.each(['binding-first', 'removal-first'] as const)(
  'joins simultaneous authority intents without a promise cycle (%s)',
  async (order) => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reading = f.runtime.withRead(f.runtime.acquire, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    f.setBindings();
    const remove = () =>
      f.runtime.mutateAuthority(f.port, async () => {
        f.events.push('remove');
      });
    const operations =
      order === 'binding-first' ? [f.runtime.acquire(), remove()] : [remove(), f.runtime.acquire()];
    release.resolve();
    await Promise.all([reading, ...operations]);
    expect(f.events).toContain('remove');
    expect(f.events).toContain('bindings-replace');
    await f.runtime.retireProfile();
  }
);
