// @vitest-environment node
import {
  IndexerError,
  type IndexerPort,
  type IndexFileBinding,
  type IndexScope,
  type ScopedIndexerPort,
} from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createNativeIndexRuntime } from '../native-index-runtime';

interface Authority {
  readonly fileBindings: readonly IndexFileBinding[];
  readonly rootIds: readonly string[];
  readonly scopes: readonly IndexScope[];
}

const collection: IndexScope = { embeddingSetId: 'collection', kind: 'collection' };
const binding: IndexFileBinding = {
  embeddingSetId: 'collection',
  fileId: 'retained-file',
  profile: null,
  relativePath: null,
  rootId: null,
  sourcePath: null,
};

function fixture(initial: Authority) {
  let authority = initial;
  let stored: readonly IndexFileBinding[] = [];
  const events: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('Unused fixture operation');
  };
  // The writer's current bindings, as its ScopeAuthority holds them.
  let bound: readonly IndexFileBinding[] = [];
  const replaceFileBindings = vi.fn(async (bindings: readonly IndexFileBinding[]) => {
    bound = bindings;
    events.push('bindings-ack');
  });
  // An opened store holding no rows its bindings do not own (BST-1988 convergence).
  const verifyScopedManifest = vi.fn(
    async (request: { readonly files: readonly unknown[]; readonly scope: IndexScope }) => {
      const { scope } = request;
      const inScope = bound.filter((file) =>
        scope.kind === 'workspace'
          ? file.rootId === scope.rootId
          : file.embeddingSetId === scope.embeddingSetId
      );
      if (request.files.length !== inScope.length) {
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
        scope,
        storeId: 'store',
        unexpected: stored
          .filter((file) =>
            scope.kind === 'workspace'
              ? file.rootId === scope.rootId
              : file.embeddingSetId === scope.embeddingSetId
          )
          .map(({ profile: _profile, ...file }) => ({
            ...file,
            chunks: [],
            contentHash: 'c'.repeat(64),
          })),
      };
    }
  );
  const removeScopedFile = vi.fn(async (_request: unknown) => {
    events.push('native-removal-ack');
    return true;
  });
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
    readScopedFilePage: unused,
    removeFile: unused,
    removeScopedFile,
    replaceFileBindings,
    search: unused,
    searchScopes: unused,
    verifyManifest: unused,
    verifyScopedManifest:
      verifyScopedManifest as unknown as ScopedIndexerPort['verifyScopedManifest'],
  };
  const closeQueries = vi.fn(async () => {
    events.push('readers-exited');
  });
  const closeWriter = vi.fn(async () => {
    events.push('writer-exited');
  });
  const createIndexOwner = vi.fn(async (opened: Authority) => ({
    close: closeWriter,
    databasePath: '/owned/index.sqlite',
    start: async () => {
      bound = opened.fileBindings;
      events.push('writer-ready');
      return port;
    },
  }));
  const installQueryTarget = vi.fn(() => {
    events.push('reader-installed');
  });
  const dependencies = {
    closeQueries,
    createIndexOwner,
    getAuthority: async () => authority,
    getFileInvalidator: () => vi.fn(),
    getRootIds: async () => authority.rootIds,
    installQueryTarget,
    profile: createDesktopProfileRuntime(() => ({
      acquire: async () => undefined,
      close: async () => undefined,
    })),
  };
  const runtime = createNativeIndexRuntime(dependencies);
  return {
    closeQueries,
    closeWriter,
    createIndexOwner,
    events,
    installQueryTarget,
    port,
    removeScopedFile,
    replaceFileBindings,
    runtime,
    setAuthority: (next: Authority): void => {
      authority = next;
    },
    setStored: (files: readonly IndexFileBinding[]): void => {
      stored = files;
    },
  };
}

it('acquires an empty authority: Text search with no collection and no folder (BST-1988)', async () => {
  // The TEXT partition's only scopes are its folders, so its last folder's
  // removal leaves nothing to index; that is a ready, empty index, not a refusal.
  const f = fixture({ fileBindings: [], rootIds: [], scopes: [] });
  await expect(f.runtime.acquire()).resolves.toBe(f.port);
  expect(f.createIndexOwner).toHaveBeenCalledExactlyOnceWith({
    fileBindings: [],
    rootIds: [],
    scopes: [],
  });
});

it('joins opening-writer convergence before closing a replacement writer', async () => {
  const rooted = {
    ...binding,
    fileId: 'workspace-file',
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/actual/root/file.txt',
  };
  const f = fixture({
    fileBindings: [binding],
    rootIds: ['root'],
    scopes: [collection, { kind: 'workspace', rootId: 'root' }],
  });
  f.setStored([rooted, binding]);
  const held = Promise.withResolvers<boolean>();
  f.removeScopedFile.mockReturnValueOnce(held.promise);
  const opening = f.runtime.acquire().catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(f.removeScopedFile).toHaveBeenCalledExactlyOnceWith({
      fileId: rooted.fileId,
      scope: { kind: 'workspace', rootId: 'root' },
    })
  );
  expect(f.installQueryTarget).not.toHaveBeenCalled();
  const closing = f.runtime.closeIndex();
  expect(f.closeWriter).not.toHaveBeenCalled();
  await expect(f.runtime.acquire()).rejects.toThrow('admission is closed');
  held.resolve(true);
  expect(await opening).toBeInstanceOf(Error);
  await closing;
  expect(f.removeScopedFile).toHaveBeenCalledTimes(1);
  expect(f.closeWriter).toHaveBeenCalledTimes(1);
});

it('retains failed opening convergence for explicit retry without erasing owned rootless rows', async () => {
  const rooted = {
    ...binding,
    fileId: 'workspace-file',
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/actual/root/file.txt',
  };
  const f = fixture({
    fileBindings: [binding],
    rootIds: ['root'],
    scopes: [collection, { kind: 'workspace', rootId: 'root' }],
  });
  f.setStored([rooted, binding]);
  const cause = new Error('Native opening removal did not settle.');
  f.removeScopedFile.mockRejectedValueOnce(cause);
  await expect(f.runtime.acquire()).rejects.toBe(cause);
  expect(f.installQueryTarget).not.toHaveBeenCalled();
  expect(f.closeWriter).not.toHaveBeenCalled();
  await expect(f.runtime.resume()).rejects.toThrow('Previous native ownership');
  await f.runtime.closeIndex();
  await f.runtime.resume();
  await f.runtime.acquire();
  expect(f.removeScopedFile).toHaveBeenCalledTimes(2);
  expect(f.removeScopedFile.mock.calls.map(([request]) => request)).toEqual([
    { fileId: rooted.fileId, scope: { kind: 'workspace', rootId: 'root' } },
    { fileId: rooted.fileId, scope: { kind: 'workspace', rootId: 'root' } },
  ]);
  expect(f.installQueryTarget).toHaveBeenCalledOnce();
  await f.runtime.closeIndex();
});

it('retains the actual replacement ACK inventory when live authority changes immediately afterward', async () => {
  const initial = {
    fileBindings: [],
    rootIds: ['root'],
    scopes: [collection, { kind: 'workspace', rootId: 'root' } as const],
  };
  const rooted = {
    ...binding,
    fileId: 'acknowledged-file',
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/actual/root/file.txt',
  };
  const f = fixture(initial);
  await f.runtime.acquire();
  f.replaceFileBindings.mockImplementationOnce(async () => {
    f.setAuthority(initial);
  });
  f.setAuthority({ ...initial, fileBindings: [rooted] });
  await expect(f.runtime.acquire()).rejects.toThrow('authority changed');
  expect(f.runtime.captureAcknowledgedAuthority().readAuthority().fileBindings).toEqual([rooted]);
  f.setStored([rooted]);
  await f.runtime.closeIndex();
  await f.runtime.resume();
  await f.runtime.acquire();
  expect(f.removeScopedFile).toHaveBeenCalledExactlyOnceWith({
    fileId: rooted.fileId,
    scope: { kind: 'workspace', rootId: 'root' },
  });
  await f.runtime.closeIndex();
});

it('restores the prior live inventory before reuse after a replacement ACK and authority drift', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  const captured = f.runtime.captureAcknowledgedAuthority();
  let nativeBindings: readonly IndexFileBinding[] = [];
  f.replaceFileBindings.mockImplementationOnce(async (next) => {
    nativeBindings = next;
    f.setAuthority(initial);
  });
  f.setAuthority({ ...initial, fileBindings: [binding] });
  await expect(f.runtime.acquire()).rejects.toThrow('authority changed');
  expect(nativeBindings).toEqual([binding]);
  expect(captured.readAuthority().fileBindings).toEqual([binding]);
  f.replaceFileBindings.mockImplementation(async (next) => {
    nativeBindings = next;
  });
  await expect(f.runtime.acquire()).resolves.toBe(f.port);
  expect(f.replaceFileBindings).toHaveBeenCalledTimes(2);
  expect(f.replaceFileBindings).toHaveBeenLastCalledWith([]);
  expect(nativeBindings).toEqual([]);
  expect(captured.readAuthority().fileBindings).toEqual([]);
  await f.runtime.acquire();
  expect(f.replaceFileBindings).toHaveBeenCalledTimes(2);
  expect(f.createIndexOwner).toHaveBeenCalledOnce();
  await f.runtime.closeIndex();
});

it('preserves the previous ACK but revalidates retired reader readiness after failed binding replacement', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  const captured = f.runtime.captureAcknowledgedAuthority();
  const failure = new Error('Independent binding replacement failure.');
  f.replaceFileBindings.mockRejectedValueOnce(failure);
  f.setAuthority({ ...initial, fileBindings: [binding] });
  await expect(f.runtime.acquire()).rejects.toBe(failure);
  expect(captured.readAuthority().fileBindings).toEqual([]);
  expect(f.installQueryTarget).toHaveBeenCalledOnce();
  f.setAuthority(initial);
  const restored = Promise.withResolvers<void>();
  f.replaceFileBindings.mockReturnValueOnce(restored.promise);
  let admitted = false;
  const restoring = f.runtime.acquire().then(() => {
    admitted = true;
  });
  await vi.waitFor(() => expect(f.replaceFileBindings).toHaveBeenLastCalledWith([]));
  expect(admitted).toBe(false);
  expect(f.installQueryTarget).toHaveBeenCalledOnce();
  restored.resolve();
  await restoring;
  expect(f.replaceFileBindings).toHaveBeenCalledTimes(2);
  expect(f.installQueryTarget).toHaveBeenCalledTimes(2);
  await f.runtime.acquire();
  expect(f.replaceFileBindings).toHaveBeenCalledTimes(2);
  f.setAuthority({ ...initial, fileBindings: [binding] });
  await f.runtime.acquire();
  expect(f.replaceFileBindings).toHaveBeenCalledTimes(3);
  expect(f.replaceFileBindings).toHaveBeenLastCalledWith([binding]);
  expect(captured.readAuthority().fileBindings).toEqual([binding]);
  await f.runtime.closeIndex();
});

it('joins absent retained files under the original ACK before revoking their native binding', async () => {
  const preserved = { ...binding, fileId: 'preserved-retained' };
  const initial = { fileBindings: [binding, preserved], rootIds: [], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  // The open lists its stored rows with no binding held (BST-1988); count from here.
  f.replaceFileBindings.mockClear();
  const captured = f.runtime.captureAcknowledgedAuthority();
  const held = Promise.withResolvers<boolean>();
  f.removeScopedFile.mockReturnValueOnce(held.promise);
  f.setAuthority({ ...initial, fileBindings: [preserved] });
  const updating = f.runtime.acquire();
  await vi.waitFor(() =>
    expect(f.removeScopedFile).toHaveBeenCalledExactlyOnceWith({
      fileId: binding.fileId,
      scope: collection,
    })
  );
  expect(f.replaceFileBindings).not.toHaveBeenCalled();
  expect(captured.readAuthority().fileBindings).toEqual(initial.fileBindings);
  held.resolve(true);
  await updating;
  expect(captured.readAuthority().fileBindings).toEqual([preserved]);
  expect(f.events.slice(-3)).toEqual(['readers-exited', 'bindings-ack', 'reader-installed']);
  await f.runtime.closeIndex();
});

it('retains failed absent-file removal and its ACK for explicit retry before binding replacement', async () => {
  const initial = { fileBindings: [binding], rootIds: [], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  // The open lists its stored rows with no binding held (BST-1988); count from here.
  f.replaceFileBindings.mockClear();
  const captured = f.runtime.captureAcknowledgedAuthority();
  const failure = new Error('Deleted canonical data did not retire.');
  f.removeScopedFile.mockRejectedValueOnce(failure);
  f.setAuthority({ ...initial, fileBindings: [] });
  await expect(f.runtime.acquire()).rejects.toBe(failure);
  expect(f.replaceFileBindings).not.toHaveBeenCalled();
  expect(captured.readAuthority().fileBindings).toEqual([binding]);
  await f.runtime.acquire();
  expect(f.removeScopedFile).toHaveBeenCalledTimes(2);
  expect(f.replaceFileBindings).toHaveBeenCalledExactlyOnceWith([]);
  expect(captured.readAuthority().fileBindings).toEqual([]);
  await f.runtime.closeIndex();
});

it('refuses authority drift during absent-file removal and revalidates before reusing the original inventory', async () => {
  const initial = { fileBindings: [binding], rootIds: [], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  // The open lists its stored rows with no binding held (BST-1988); count from here.
  f.replaceFileBindings.mockClear();
  const captured = f.runtime.captureAcknowledgedAuthority();
  f.removeScopedFile.mockImplementationOnce(async () => {
    f.setAuthority(initial);
    return true;
  });
  f.setAuthority({ ...initial, fileBindings: [] });
  await expect(f.runtime.acquire()).rejects.toThrow('authority changed');
  expect(f.replaceFileBindings).not.toHaveBeenCalled();
  expect(captured.readAuthority().fileBindings).toEqual([binding]);
  await f.runtime.acquire();
  expect(f.replaceFileBindings).toHaveBeenCalledExactlyOnceWith([binding]);
  await f.runtime.closeIndex();
});

it('captures one actual writer and reads its complete latest acknowledged inventory after admitted work joins', async () => {
  const initial = {
    fileBindings: [],
    rootIds: ['root'],
    scopes: [collection, { kind: 'workspace', rootId: 'root' } as const],
  };
  const rooted = {
    ...binding,
    fileId: 'late-admitted-file',
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/actual/root/file.txt',
  };
  const f = fixture(initial);
  await f.runtime.acquire();
  const captured = f.runtime.captureAcknowledgedAuthority();
  const acknowledgment = Promise.withResolvers<void>();
  f.replaceFileBindings.mockReturnValueOnce(acknowledgment.promise);
  f.setAuthority({ ...initial, fileBindings: [rooted] });
  const admitted = f.runtime.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.replaceFileBindings).toHaveBeenCalledOnce());
  expect(captured.readAuthority().fileBindings).toEqual([]);
  const retiring = f.runtime.retireReads();
  acknowledgment.resolve();
  await Promise.all([admitted, retiring]);
  expect(captured.readAuthority().fileBindings).toEqual([rooted]);
  expect(captured.port).toBe(f.port);
  await f.runtime.closeIndex();
  expect(() => captured.readAuthority()).toThrow('retired or replaced');
});

it('opens a retained rootless collection using its real scope and binding', async () => {
  const authority = { fileBindings: [binding], rootIds: [], scopes: [collection] };
  const f = fixture(authority);
  await expect(f.runtime.acquire()).resolves.toBe(f.port);
  expect(f.createIndexOwner).toHaveBeenCalledWith(authority);
  // The open lists its collection's stored rows with no binding held, then restores it.
  expect(f.events).toEqual([
    'readers-exited',
    'writer-ready',
    'bindings-ack',
    'bindings-ack',
    'reader-installed',
  ]);
});

it('waits for full binding replacement acknowledgment before returning the owner', async () => {
  const f = fixture({ fileBindings: [], rootIds: ['root'], scopes: [collection] });
  await f.runtime.acquire();
  f.events.length = 0;
  const acknowledgment = Promise.withResolvers<void>();
  f.replaceFileBindings.mockReturnValueOnce(acknowledgment.promise);
  f.setAuthority({ fileBindings: [binding], rootIds: ['root'], scopes: [collection] });
  let returned = false;
  const updating = f.runtime.acquire().then(() => {
    returned = true;
  });
  await vi.waitFor(() => expect(f.replaceFileBindings).toHaveBeenCalledWith([binding]));
  expect(returned).toBe(false);
  expect(f.createIndexOwner).toHaveBeenCalledTimes(1);
  acknowledgment.resolve();
  await updating;
  expect(returned).toBe(true);
  expect(f.events).toEqual(['readers-exited', 'reader-installed']);
});

it('joins an admitted reader before acknowledging same-scope membership revocation', async () => {
  const f = fixture({ fileBindings: [binding], rootIds: ['root'], scopes: [collection] });
  await f.runtime.acquire();
  // The open lists its stored rows with no binding held (BST-1988); count from here.
  f.replaceFileBindings.mockClear();
  f.events.length = 0;
  const readerExit = Promise.withResolvers<void>();
  f.closeQueries.mockReturnValueOnce(readerExit.promise);
  f.setAuthority({ fileBindings: [], rootIds: ['root'], scopes: [collection] });
  const first = f.runtime.acquire();
  const second = f.runtime.acquire();
  await vi.waitFor(() => expect(f.closeQueries).toHaveBeenCalledTimes(2));
  expect(f.replaceFileBindings).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
  readerExit.resolve();
  await Promise.all([first, second]);
  expect(f.replaceFileBindings).toHaveBeenCalledExactlyOnceWith([]);
  expect(f.events).toEqual(['native-removal-ack', 'bindings-ack', 'reader-installed']);
  expect(f.createIndexOwner).toHaveBeenCalledTimes(1);
});

it('keeps failed same-scope reader retirement retryable before replacing bindings', async () => {
  const f = fixture({ fileBindings: [binding], rootIds: ['root'], scopes: [collection] });
  await f.runtime.acquire();
  // The open lists its stored rows with no binding held (BST-1988); count from here.
  f.replaceFileBindings.mockClear();
  f.events.length = 0;
  const failure = new Error('old membership reader has not exited');
  f.closeQueries.mockRejectedValueOnce(failure);
  f.setAuthority({ fileBindings: [], rootIds: ['root'], scopes: [collection] });
  await expect(f.runtime.acquire()).rejects.toBe(failure);
  expect(f.replaceFileBindings).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
  await expect(f.runtime.acquire()).rejects.toBe(failure);
  expect(f.closeQueries).toHaveBeenCalledTimes(2);
  expect(f.closeWriter).not.toHaveBeenCalled();
  expect(f.installQueryTarget).toHaveBeenCalledOnce();
  expect(f.createIndexOwner).toHaveBeenCalledTimes(1);
  const exit = Promise.withResolvers<void>();
  f.closeQueries.mockImplementationOnce(async () => {
    await exit.promise;
    f.events.push('readers-exited');
  });
  const closing = f.runtime.closeIndex();
  await vi.waitFor(() => expect(f.closeQueries).toHaveBeenCalledTimes(3));
  await expect(f.runtime.resume()).rejects.toThrow('Previous native ownership');
  await expect(f.runtime.acquire()).rejects.toThrow('admission is closed');
  expect(f.closeWriter).not.toHaveBeenCalled();
  exit.resolve();
  await closing;
  expect(f.closeWriter).toHaveBeenCalledOnce();
  await f.runtime.resume();
  await f.runtime.acquire();
  expect(f.createIndexOwner).toHaveBeenCalledTimes(2);
  expect(f.createIndexOwner).toHaveBeenLastCalledWith({
    fileBindings: [],
    rootIds: ['root'],
    scopes: [collection],
  });
  expect(f.installQueryTarget).toHaveBeenCalledTimes(2);
  expect(f.events).toEqual([
    'readers-exited',
    'writer-exited',
    'readers-exited',
    'writer-ready',
    'reader-installed',
  ]);
  await f.runtime.closeIndex();
});

it('joins the old query reader and writer before changing collection authority', async () => {
  const f = fixture({ fileBindings: [], rootIds: ['root'], scopes: [collection] });
  await f.runtime.acquire();
  f.events.length = 0;
  const next = {
    fileBindings: [],
    rootIds: ['root'],
    scopes: [{ embeddingSetId: 'other-collection', kind: 'collection' } as const],
  };
  f.setAuthority(next);
  await f.runtime.acquire();
  expect(f.createIndexOwner).toHaveBeenCalledTimes(2);
  expect(f.createIndexOwner).toHaveBeenLastCalledWith(next);
  expect(f.events).toEqual(['readers-exited', 'writer-exited', 'writer-ready', 'reader-installed']);
});

it('retains the old owner after failed retirement and retries it before replacement', async () => {
  const f = fixture({ fileBindings: [], rootIds: ['root'], scopes: [collection] });
  await f.runtime.acquire();
  const failure = new Error('reader still owns a snapshot');
  f.closeQueries.mockRejectedValueOnce(failure);
  f.setAuthority({
    fileBindings: [],
    rootIds: ['root'],
    scopes: [{ embeddingSetId: 'other-collection', kind: 'collection' }],
  });
  await expect(f.runtime.acquire()).rejects.toBe(failure);
  expect(f.closeWriter).not.toHaveBeenCalled();
  expect(f.createIndexOwner).toHaveBeenCalledTimes(1);
  await expect(f.runtime.acquire()).rejects.toBe(failure);
  expect(f.closeQueries).toHaveBeenCalledTimes(2);
  expect(f.installQueryTarget).toHaveBeenCalledOnce();
  const exit = Promise.withResolvers<void>();
  f.closeQueries.mockReturnValueOnce(exit.promise);
  const closing = f.runtime.closeIndex();
  await vi.waitFor(() => expect(f.closeQueries).toHaveBeenCalledTimes(3));
  await expect(f.runtime.resume()).rejects.toThrow('Previous native ownership');
  expect(f.closeWriter).not.toHaveBeenCalled();
  expect(f.createIndexOwner).toHaveBeenCalledTimes(1);
  exit.resolve();
  await closing;
  expect(f.closeWriter).toHaveBeenCalledTimes(1);
  await f.runtime.resume();
  await f.runtime.acquire();
  expect(f.createIndexOwner).toHaveBeenCalledTimes(2);
  expect(f.createIndexOwner).toHaveBeenLastCalledWith({
    fileBindings: [],
    rootIds: ['root'],
    scopes: [{ embeddingSetId: 'other-collection', kind: 'collection' }],
  });
  expect(f.installQueryTarget).toHaveBeenCalledTimes(2);
  await f.runtime.closeIndex();
});

it('refuses authority changed during reader retirement before replacing bindings', async () => {
  const initial = { fileBindings: [binding], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  // The open lists its stored rows with no binding held (BST-1988); count from here.
  f.replaceFileBindings.mockClear();
  f.events.length = 0;
  const readerExit = Promise.withResolvers<void>();
  f.closeQueries.mockReturnValueOnce(readerExit.promise);
  f.setAuthority({ ...initial, fileBindings: [] });
  const outcome = f.runtime.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.closeQueries).toHaveBeenCalledTimes(2));
  f.setAuthority({ ...initial, fileBindings: [{ ...binding, fileId: 'new-file' }] });
  readerExit.resolve();
  expect(await outcome).toMatchObject({ message: expect.stringContaining('authority changed') });
  expect(f.replaceFileBindings).not.toHaveBeenCalled();
  expect(f.events).not.toContain('reader-installed');
  await f.runtime.acquire();
  expect(f.replaceFileBindings).toHaveBeenCalledExactlyOnceWith([
    { ...binding, fileId: 'new-file' },
  ]);
});

it('refuses authority changed during binding acknowledgment before exposing a query target', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  f.events.length = 0;
  const acknowledgment = Promise.withResolvers<void>();
  f.replaceFileBindings.mockReturnValueOnce(acknowledgment.promise);
  f.setAuthority({ ...initial, fileBindings: [binding] });
  const outcome = f.runtime.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.replaceFileBindings).toHaveBeenCalledWith([binding]));
  f.setAuthority({ ...initial, fileBindings: [{ ...binding, fileId: 'new-file' }] });
  acknowledgment.resolve();
  expect(await outcome).toMatchObject({ message: expect.stringContaining('authority changed') });
  expect(f.events).not.toContain('reader-installed');
  await f.runtime.acquire();
  expect(f.replaceFileBindings).toHaveBeenLastCalledWith([{ ...binding, fileId: 'new-file' }]);
});

it('retains a started owner for joined cleanup when its authority changed during startup', async () => {
  const initial = { fileBindings: [binding], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  const started = Promise.withResolvers<IndexerPort & ScopedIndexerPort>();
  f.createIndexOwner.mockResolvedValueOnce({
    close: f.closeWriter,
    databasePath: '/owned/index.sqlite',
    start: () => started.promise,
  });
  const outcome = f.runtime.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.createIndexOwner).toHaveBeenCalledTimes(1));
  f.setAuthority({ ...initial, fileBindings: [] });
  started.resolve(f.port);
  expect(await outcome).toMatchObject({ message: expect.stringContaining('authority changed') });
  expect(f.events).not.toContain('reader-installed');
  await f.runtime.closeIndex();
  expect(f.closeWriter).toHaveBeenCalledTimes(1);
});
