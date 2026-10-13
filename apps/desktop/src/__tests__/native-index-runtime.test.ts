// @vitest-environment node
import { IndexerError, type IndexerPort, type ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthority } from '@brainstrike/indexer/coverage-reader';
import { expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { isolateNativeCoverage } from '../native-coverage-reader';
import { createNativeIndexRuntime, type NativeIndexAuthority } from '../native-index-runtime';
import {
  createNativeScopedSearchCapability,
  type NativeSearchAuthority,
} from '../native-scoped-search';

function fixture() {
  const events: string[] = [];
  let queryTargetInstalled = false;
  let authority: NativeIndexAuthority = {
    fileBindings: [],
    rootIds: ['root'],
    scopes: [{ kind: 'workspace', rootId: 'root' }],
  };
  const unused = async (): Promise<never> => {
    throw new Error('Unused fixture operation');
  };
  // The writer's current bindings, as its ScopeAuthority holds them.
  let boundFiles: readonly {
    readonly embeddingSetId: string | null;
    readonly rootId: string | null;
  }[] = [];
  const inScope = (
    file: { readonly embeddingSetId: string | null; readonly rootId: string | null },
    scope: { readonly embeddingSetId?: string; readonly kind: string; readonly rootId?: string }
  ): boolean =>
    scope.kind === 'workspace'
      ? file.rootId === scope.rootId
      : file.embeddingSetId === scope.embeddingSetId;
  const verifyScopedManifest = vi.fn(
    async (request: {
      readonly files: readonly unknown[];
      readonly scope: {
        readonly embeddingSetId?: string;
        readonly kind: string;
        readonly rootId?: string;
      };
    }) => {
      // As the writer does: a manifest declares every file bound in its scope.
      if (
        request.files.length !== boundFiles.filter((file) => inScope(file, request.scope)).length
      ) {
        throw new IndexerError(
          'incomplete-manifest',
          'A scoped manifest must declare the complete current canonical file inventory.'
        );
      }
      return {
        authorityEpoch: 'a'.repeat(64),
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: request.scope,
        storeId: 'store',
        unexpected: [],
      };
    }
  );
  const port: IndexerPort & ScopedIndexerPort = {
    close: unused,
    commitFile: unused,
    commitScopedFile: unused,
    commitScopedTextFile: unused,
    commitTextFile: unused,
    configureVectorProfile: unused,
    coverage: unused,
    coverageBatch: unused,
    coverageScope: unused,
    destroy: unused,
    info: unused,
    prepareFile: unused,
    prepareScopedFile: unused,
    removeFile: unused,
    removeScopedFile: unused,
    replaceFileBindings: vi.fn(async (bindings: unknown) => {
      boundFiles = bindings as typeof boundFiles;
      events.push('bindings-replace');
    }),
    search: unused,
    searchScopes: unused,
    verifyManifest: unused,
    verifyScopedManifest:
      verifyScopedManifest as unknown as ScopedIndexerPort['verifyScopedManifest'],
  };
  const closeWriter = vi.fn(async () => {
    events.push('writer-close');
  });
  const closeQueries = vi.fn(async () => {
    queryTargetInstalled = false;
    events.push('readers-close');
  });
  const closeProfile = vi.fn(async () => {
    events.push('profile-close');
  });
  const profileAttachment = { closed: Promise.withResolvers<void>().promise };
  const acquireProfile = vi.fn(async () => {
    events.push('profile-acquire');
    return profileAttachment;
  });
  const createIndexOwner = vi.fn(async (opened: NativeIndexAuthority) => ({
    close: closeWriter,
    databasePath: '/owned/index.sqlite',
    start: async () => {
      boundFiles = opened.fileBindings;
      events.push('writer-start');
      return port;
    },
  }));
  const getAuthority = vi.fn(async () => authority);
  const installQueryTarget = vi.fn(() => {
    queryTargetInstalled = true;
    events.push('reader-install');
  });
  const runtime = createNativeIndexRuntime({
    closeQueries,
    createIndexOwner,
    getAuthority,
    getFileInvalidator: () => () => {},
    installQueryTarget,
    profile: createDesktopProfileRuntime(() => ({
      acquire: acquireProfile,
      close: closeProfile,
    })),
  });
  return {
    acquireProfile,
    closeProfile,
    closeQueries,
    closeWriter,
    createIndexOwner,
    events,
    getAuthority,
    installQueryTarget,
    port,
    profileAttachment,
    queryTargetInstalled: () => queryTargetInstalled,
    resetBindings: () => {
      authority = { ...authority, fileBindings: [] };
    },
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
    verifyScopedManifest,
  };
}

it('shares the existing profile attachment between clients and index acquisition', async () => {
  const f = fixture();
  const [first, index, second] = await Promise.all([
    f.runtime.acquireProfile(),
    f.runtime.acquire(),
    f.runtime.acquireProfile(),
  ]);
  expect(first).toBe(f.profileAttachment);
  expect(second).toBe(first);
  expect(index).toBe(f.port);
  expect(f.acquireProfile).toHaveBeenCalledOnce();
  await f.runtime.closeIndex();
  expect(f.closeProfile).not.toHaveBeenCalled();
  await expect(f.runtime.acquireProfile()).rejects.toThrow('admission is closed');
  await f.runtime.retireProfile();
  expect(f.closeProfile).toHaveBeenCalledOnce();
});

it('closes and joins a profile whose startup still awaits Main capability binding', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<typeof f.profileAttachment>();
  const exited = Promise.withResolvers<void>();
  f.acquireProfile.mockImplementationOnce(() => pending.promise);
  f.closeProfile.mockImplementationOnce(async () => {
    pending.reject(new Error('Main bootstrap aborted'));
    await exited.promise;
  });
  const starting = f.runtime.acquireProfile();
  const outcome = starting.catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.acquireProfile).toHaveBeenCalledOnce());
  let retired = false;
  const closing = f.runtime.retireProfile().then(() => {
    retired = true;
  });
  try {
    await vi.waitFor(() => expect(f.closeProfile).toHaveBeenCalledOnce());
    expect(retired).toBe(false);
  } finally {
    pending.reject(new Error('Main bootstrap aborted'));
    exited.resolve();
    await closing;
  }
  expect(await outcome).toEqual(new Error('Main bootstrap aborted'));
  expect(retired).toBe(true);
});

it('reuses the app profile attachment after physical index reconfiguration', async () => {
  const f = fixture();
  const original = await f.runtime.acquireProfile({ indexIndependent: true });
  await f.runtime.acquire();
  await f.runtime.closeIndex();
  await f.runtime.resume();
  expect(await f.runtime.acquireProfile({ indexIndependent: true })).toBe(original);
  await f.runtime.acquire();
  expect(f.acquireProfile).toHaveBeenCalledOnce();
  expect(f.closeProfile).not.toHaveBeenCalled();
  expect(f.closeWriter).toHaveBeenCalledOnce();
  expect(f.createIndexOwner).toHaveBeenCalledTimes(2);
  await f.runtime.retireProfile();
  expect(f.closeProfile).toHaveBeenCalledOnce();
});

it('admits an assistant profile while setup keeps index and read admission closed', async () => {
  const f = fixture();
  await f.runtime.closeIndex();
  const attachment = await f.runtime.acquireProfile({ indexIndependent: true });
  expect(attachment).toBe(f.profileAttachment);
  expect(f.acquireProfile).toHaveBeenCalledOnce();
  expect(f.createIndexOwner).not.toHaveBeenCalled();
  await expect(f.runtime.acquire()).rejects.toThrow('admission is closed');
  await f.runtime.retireProfile();
  expect(f.closeProfile).toHaveBeenCalledOnce();
});

it('keeps failed physical profile retirement visible to assistant admission', async () => {
  const f = fixture();
  await f.runtime.acquireProfile({ indexIndependent: true });
  const failure = new Error('owned profile has not physically retired');
  f.closeProfile.mockRejectedValueOnce(failure);
  await expect(f.runtime.retireProfile()).rejects.toBe(failure);
  await expect(f.runtime.acquireProfile({ indexIndependent: true })).rejects.toBe(failure);
  expect(f.acquireProfile).toHaveBeenCalledOnce();
});

it('joins a late profile attachment during retirement without returning it to a client', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<typeof f.profileAttachment>();
  f.acquireProfile.mockReturnValueOnce(pending.promise);
  const acquiring = f.runtime.acquireProfile();
  const observed = acquiring.catch((cause: unknown) => cause);
  const retiring = f.runtime.retireProfile();
  expect(f.closeProfile).not.toHaveBeenCalled();
  pending.resolve(f.profileAttachment);
  expect(await observed).toMatchObject({
    message: 'Native profile ownership closed during startup.',
  });
  await retiring;
  expect(f.closeProfile).toHaveBeenCalledOnce();
});

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
  const owner = await f.createIndexOwner({
    fileBindings: [],
    rootIds: ['root'],
    scopes: [{ kind: 'workspace', rootId: 'root' }],
  });
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

it('replaces bindings when only the profile pooling changes, never reusing mean authority (BST-1993)', async () => {
  const f = fixture();
  const binding = (pooling?: 'cls') => ({
    embeddingSetId: 'collection',
    fileId: 'file',
    profile: {
      dimensions: 384,
      distance: 'cosine' as const,
      dtype: 'fp16' as const,
      modelId: 'onnx-community/granite-embedding-small-english-r2-ONNX',
      provider: 'local' as const,
      revision: '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8',
      ...(pooling ? { pooling } : {}),
    },
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/file.txt',
  });
  const authority = (pooling?: 'cls'): NativeIndexAuthority => ({
    fileBindings: [binding(pooling)],
    rootIds: ['root'],
    scopes: [{ kind: 'workspace', rootId: 'root' }],
  });
  f.getAuthority.mockResolvedValue(authority());
  await f.runtime.acquire();
  await f.runtime.acquire();
  const replacements = f.events.filter((event) => event === 'bindings-replace').length;
  f.getAuthority.mockResolvedValue(authority('cls'));
  await f.runtime.acquire();
  expect(f.events.filter((event) => event === 'bindings-replace')).toHaveLength(replacements + 1);
  await f.runtime.retireProfile();
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
    expect(() => captured.readAuthority()).toThrow(NativeAuthorityTransitionError);
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

it.each(['invalidated', 'native-error', 'cleanup-error'] as const)(
  'joins a retired admitted isolated coverage read while preserving %s',
  async (mode) => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closingReader = Promise.withResolvers<void>();
    const exitedReader = Promise.withResolvers<void>();
    const cause = new Error(
      mode === 'native-error'
        ? 'Native read admission is closed.'
        : 'Independent reader cleanup failed.'
    );
    const nativeAuthority: CoverageAuthority = {
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      dbPath: '/owned/index.sqlite',
      fileBindings: [],
      rootIds: ['root'],
      scopes: [{ kind: 'workspace', rootId: 'root' }],
      storeId: 'a'.repeat(64),
    };
    let generation = 1;
    let opened = 0;
    f.port.info = async () => ({
      dbPath: nativeAuthority.dbPath,
      embedding: { indexMode: 'text-only' },
      journalMode: 'wal',
      pid: 1,
      readerQueryOnly: 1,
      storeId: nativeAuthority.storeId,
      vecVersion: '0.1.9',
      writerThreadId: 1,
    });
    const isolated = isolateNativeCoverage(
      { ...f.port, coverageAuthority: async () => nativeAuthority },
      async (authority) => {
        expect(authority).toEqual(nativeAuthority);
        opened += 1;
        const first = opened === 1;
        return {
          close: async () => {
            if (first) {
              closingReader.resolve();
              await exitedReader.promise;
            }
            f.events.push('isolated-reader-exit');
            if (first && mode === 'cleanup-error') {
              throw cause;
            }
          },
          nativeCoverage: async (requests) => {
            const result = requests.map((request) => ({
              authorityEpoch: authority.authorityEpoch,
              authorityRevision: authority.authorityRevision,
              counts: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
              profile: null,
              profileHash: null,
              scope: request.scope,
              storeId: authority.storeId,
              vectorCoverageComplete: false,
            }));
            if (first) {
              entered.resolve();
              await release.promise;
              if (mode === 'native-error') {
                throw cause;
              }
            }
            return result;
          },
        };
      }
    );
    f.port.coverageBatch = isolated.coverageBatch;
    const capability = createNativeScopedSearchCapability({
      openQuery: async () => {
        throw new Error('Unexpected generic query');
      },
      rebuild: async () => {},
      withRead: (work) =>
        f.runtime.withRead(f.runtime.acquire, (captured) =>
          work({
            getAuthority: async (): Promise<NativeSearchAuthority> => {
              const acknowledged = captured.readAuthority();
              return {
                bindings: acknowledged.fileBindings,
                collectionId: 'selected',
                generation,
                profile: null,
                queryPlan: undefined,
                readiness: [
                  {
                    generation,
                    mutationRevision: 0,
                    scanComplete: true,
                    scope: { kind: 'workspace', rootId: 'root' },
                  },
                ],
                rootIds: acknowledged.rootIds,
              };
            },
            port: captured.port,
          })
        ),
    });
    let settled = false;
    const pending = capability
      .coverageBatch([{ rootIds: ['root'] }])
      .catch((error: unknown) => error)
      .then((result) => {
        settled = true;
        f.events.push('coverage-settled');
        return result;
      });
    let retiring: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      retiring = f.runtime.retireReads();
      closing = f.runtime.retireProfile();
      await expect(capability.coverageBatch([{ rootIds: ['root'] }])).resolves.toEqual({
        cause: { kind: 'transitioning' },
        code: 'native-coverage-observation-invalidated',
        kind: 'invalidated',
      });
      await expect(f.runtime.withRead(f.runtime.acquire, async () => undefined)).rejects.toThrow(
        'Native read admission is closed.'
      );
      await expect(capability.coverage({ rootIds: ['root'] })).rejects.toThrow();
      await expect(capability.status()).resolves.toMatchObject({ kind: 'unavailable' });
      expect(opened).toBe(1);
      expect(f.closeWriter).not.toHaveBeenCalled();
      expect(f.closeProfile).not.toHaveBeenCalled();
      release.resolve();
      await closingReader.promise;
      expect(settled).toBe(false);
      expect(f.closeWriter).not.toHaveBeenCalled();
      expect(f.closeProfile).not.toHaveBeenCalled();
      exitedReader.resolve();
      const observation = await pending;
      if (mode === 'invalidated') {
        expect(observation).toEqual({
          cause: { kind: 'transitioning' },
          code: 'native-coverage-observation-invalidated',
          kind: 'invalidated',
        });
      } else {
        expect(observation).toBe(cause);
      }
      await Promise.all([retiring, closing]);
      expect(f.events.indexOf('isolated-reader-exit')).toBeLessThan(
        f.events.indexOf('coverage-settled')
      );
      expect(f.events.indexOf('coverage-settled')).toBeLessThan(f.events.indexOf('writer-close'));
      expect(f.events.indexOf('writer-close')).toBeLessThan(f.events.indexOf('profile-close'));
      await f.runtime.resume();
      generation += 1;
      const fresh = await capability.coverageBatch([{ rootIds: ['root'] }]);
      expect(fresh).toMatchObject({
        coverage: [
          {
            storeId: nativeAuthority.storeId,
            totals: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
          },
        ],
        kind: 'current',
        status: { kind: 'ready', rootReadiness: [{ rootId: 'root', scanComplete: true }] },
      });
      expect(opened).toBe(2);
      expect(f.createIndexOwner).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      exitedReader.resolve();
      await Promise.allSettled([pending, retiring, closing]);
      await f.runtime.retireProfile();
    }
  }
);

it('keeps foreign native coverage store evidence fatal after physical reader disposal', async () => {
  const f = fixture();
  let calls = 0;
  const authority: CoverageAuthority = {
    authorityEpoch: 'b'.repeat(64),
    authorityRevision: 1,
    dbPath: '/owned/index.sqlite',
    fileBindings: [],
    rootIds: ['root'],
    scopes: [{ kind: 'workspace', rootId: 'root' }],
    storeId: 'a'.repeat(64),
  };
  const failure = new IndexerError('coverage-authority-changed', 'Different native store.');
  const close = vi.fn(async () => {});
  const isolated = isolateNativeCoverage(
    {
      ...f.port,
      coverageAuthority: async () => ({
        ...authority,
        storeId: ++calls === 1 ? authority.storeId : 'c'.repeat(64),
      }),
    },
    async () => ({
      close,
      nativeCoverage: async () => {
        throw failure;
      },
    })
  );
  await expect(
    isolated.coverageBatch([{ scope: { kind: 'workspace', rootId: 'root' } }])
  ).rejects.toBe(failure);
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  { cleanupFails: false, mismatch: 'foreign-store' },
  { cleanupFails: false, mismatch: 'epoch' },
  { cleanupFails: false, mismatch: 'revision' },
  { cleanupFails: true, mismatch: 'foreign-store' },
  { cleanupFails: true, mismatch: 'revision' },
] as const)(
  'preserves failed reader $mismatch identity despite writer drift after exit, cleanup failure $cleanupFails',
  async ({ mismatch, cleanupFails }) => {
    const f = fixture();
    const closing = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const authority: CoverageAuthority = {
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      dbPath: '/owned/index.sqlite',
      fileBindings: [],
      rootIds: ['root'],
      scopes: [{ kind: 'workspace', rootId: 'root' }],
      storeId: 'a'.repeat(64),
    };
    let writerRevision = 1;
    f.port.info = async () => ({
      dbPath: authority.dbPath,
      embedding: { indexMode: 'text-only' },
      journalMode: 'wal',
      pid: 1,
      readerQueryOnly: 1,
      storeId: authority.storeId,
      vecVersion: '0.1.9',
      writerThreadId: 1,
    });
    const cleanupFailure = new Error('Independent coverage reader close failure.');
    const close = vi.fn(async () => {
      closing.resolve();
      await exited.promise;
      if (cleanupFails) {
        throw cleanupFailure;
      }
    });
    const isolated = isolateNativeCoverage(
      {
        ...f.port,
        coverageAuthority: async () => ({ ...authority, authorityRevision: writerRevision }),
      },
      async () => ({
        close,
        nativeCoverage: async () => {
          writerRevision = 2;
          return [
            {
              authorityEpoch: mismatch === 'epoch' ? 'd'.repeat(64) : authority.authorityEpoch,
              authorityRevision: mismatch === 'revision' ? 2 : 1,
              counts: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
              profile: null,
              profileHash: null,
              scope: authority.scopes[0]!,
              storeId: mismatch === 'foreign-store' ? 'c'.repeat(64) : authority.storeId,
              vectorCoverageComplete: false,
            },
          ];
        },
      })
    );
    f.port.coverageBatch = isolated.coverageBatch;
    const capability = createNativeScopedSearchCapability({
      openQuery: async () => {
        throw new Error('Unexpected query.');
      },
      rebuild: async () => {},
      withRead: (work) =>
        f.runtime.withRead(f.runtime.acquire, (captured) =>
          work({
            getAuthority: async () => {
              captured.readAuthority();
              return {
                bindings: [],
                collectionId: 'selected',
                generation: 1,
                profile: null,
                queryPlan: undefined,
                readiness: [],
                rootIds: ['root'],
              };
            },
            port: captured.port,
          })
        ),
    });
    let settled = false;
    const result = capability.coverageBatch([{ rootIds: ['root'] }]).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      }
    );
    try {
      await closing.promise;
      expect(settled).toBe(false);
      expect(f.closeWriter).not.toHaveBeenCalled();
      exited.resolve();
      if (cleanupFails) {
        const outcome = await result;
        expect(outcome).toMatchObject({
          error: {
            errors: [
              expect.objectContaining({
                code:
                  mismatch === 'foreign-store'
                    ? 'coverage-store-mismatch'
                    : 'coverage-authority-changed',
              }),
              cleanupFailure,
            ],
            name: 'AggregateError',
          },
        });
      } else if (mismatch === 'foreign-store') {
        expect(await result).toMatchObject({
          error: { code: 'coverage-store-mismatch', name: 'IndexerError' },
        });
      } else {
        expect(await result).toEqual({
          value: {
            cause: { kind: 'transitioning' },
            code: 'native-coverage-observation-invalidated',
            kind: 'invalidated',
          },
        });
      }
      expect(close).toHaveBeenCalledOnce();
    } finally {
      exited.resolve();
      await result;
      await f.runtime.retireProfile();
    }
  }
);

it('admits coverage only with an installed query target after a successful source removal', async () => {
  const f = fixture();
  await f.runtime.acquire();
  expect(f.queryTargetInstalled()).toBe(true);
  await f.runtime.mutateAuthority(f.port, async () => {
    f.events.push('remove');
  });
  await f.runtime.withRead(f.runtime.acquire, async () => {
    expect(f.queryTargetInstalled()).toBe(true);
  });
  await f.runtime.retireProfile();
});

it('does not admit coverage through a cached port after catalog change interrupts query retirement', async () => {
  const f = fixture();
  await f.runtime.acquire();
  f.setBindings();
  const closeQueries = f.closeQueries.getMockImplementation();
  if (!closeQueries) {
    throw new Error('Fixture has no original query retirement.');
  }
  f.closeQueries.mockImplementationOnce(async () => {
    await closeQueries();
    f.resetBindings();
  });
  await expect(f.runtime.acquire()).rejects.toThrow('authority changed during acquisition');
  await f.runtime.withRead(f.runtime.acquire, async () => {
    expect(f.queryTargetInstalled()).toBe(true);
  });
  await f.runtime.retireProfile();
});

it('retains failed physical query retirement across acquisitions until terminal cleanup', async () => {
  const f = fixture();
  await f.runtime.acquire();
  f.setBindings();
  const cause = new Error('Reader process did not exit.');
  f.closeQueries.mockRejectedValueOnce(cause);
  await expect(f.runtime.acquire()).rejects.toBe(cause);
  await expect(f.runtime.withRead(f.runtime.acquire, async () => {})).rejects.toBe(cause);
  expect(f.installQueryTarget).toHaveBeenCalledOnce();
  await f.runtime.retireProfile();
});

it('keeps a failed source removal closed to reads without reinstalling a query target', async () => {
  const f = fixture();
  await f.runtime.acquire();
  const cause = new Error('Source removal failed.');
  await expect(
    f.runtime.mutateAuthority(f.port, async () => {
      throw cause;
    })
  ).rejects.toBe(cause);
  await expect(f.runtime.withRead(f.runtime.acquire, async () => {})).rejects.toBe(cause);
  expect(f.queryTargetInstalled()).toBe(false);
  expect(f.installQueryTarget).toHaveBeenCalledOnce();
  await f.runtime.retireProfile();
});

it('requires successful query installation before caching newly acknowledged bindings', async () => {
  const f = fixture();
  await f.runtime.acquire();
  f.setBindings();
  const cause = new Error('Query target registration failed.');
  f.installQueryTarget.mockImplementationOnce(() => {
    throw cause;
  });
  await expect(f.runtime.acquire()).rejects.toBe(cause);
  await f.runtime.withRead(f.runtime.acquire, async () => {
    expect(f.queryTargetInstalled()).toBe(true);
  });
  await f.runtime.retireProfile();
});

it('does not reinstall a target after shutdown begins during an owned source removal', async () => {
  const f = fixture();
  await f.runtime.acquire();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const removal = f.runtime.mutateAuthority(f.port, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const closing = f.runtime.retireProfile();
  release.resolve();
  await Promise.all([removal, closing]);
  await expect(f.runtime.acquire()).rejects.toThrow('admission is closed');
  expect(f.queryTargetInstalled()).toBe(false);
  expect(f.installQueryTarget).toHaveBeenCalledOnce();
});

it('does not cache new bindings before their final authority validation succeeds', async () => {
  const f = fixture();
  await f.runtime.acquire();
  f.setBindings();
  const cause = new Error('Final catalog validation failed.');
  f.port.replaceFileBindings = vi
    .fn(async () => {})
    .mockImplementationOnce(async () => {
      f.getAuthority.mockRejectedValueOnce(cause);
    });
  await expect(f.runtime.acquire()).rejects.toBe(cause);
  await f.runtime.withRead(f.runtime.acquire, async () => {
    expect(f.queryTargetInstalled()).toBe(true);
  });
  await f.runtime.retireProfile();
});
