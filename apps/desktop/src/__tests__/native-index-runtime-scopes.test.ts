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
    readScopedFileChunkBounds: unused,
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
  const getAuthority = vi.fn(async () => authority);
  const dependencies = {
    closeQueries,
    createIndexOwner,
    getAuthority,
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
    getAuthority,
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

it('removes a file it acknowledged when the authority drops it again during the same acquisition (BST-2055)', async () => {
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
  await expect(f.runtime.acquire()).resolves.toBe(f.port);
  // The writer acknowledged the file, so the next attempt retires it before rebinding.
  expect(f.removeScopedFile).toHaveBeenCalledExactlyOnceWith({
    fileId: rooted.fileId,
    scope: { kind: 'workspace', rootId: 'root' },
  });
  expect(f.replaceFileBindings).toHaveBeenLastCalledWith([]);
  expect(f.runtime.captureAcknowledgedAuthority().readAuthority().fileBindings).toEqual([]);
  await f.runtime.closeIndex();
});

it('restores the live inventory after a replacement ACK and authority drift, then reuses it', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  const captured = f.runtime.captureAcknowledgedAuthority();
  let nativeBindings: readonly IndexFileBinding[] = [];
  f.replaceFileBindings.mockImplementationOnce(async (next) => {
    nativeBindings = next;
    f.setAuthority(initial);
  });
  f.replaceFileBindings.mockImplementation(async (next) => {
    nativeBindings = next;
  });
  f.setAuthority({ ...initial, fileBindings: [binding] });
  await expect(f.runtime.acquire()).resolves.toBe(f.port);
  expect(f.replaceFileBindings.mock.calls).toEqual([[[binding]], [[]]]);
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

it('rebinds a file whose authority returns during its absent-file removal', async () => {
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
  await expect(f.runtime.acquire()).resolves.toBe(f.port);
  // The drifted snapshot never reached the writer; the returned file did.
  expect(f.replaceFileBindings).toHaveBeenCalledExactlyOnceWith([binding]);
  expect(captured.readAuthority().fileBindings).toEqual([binding]);
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

it('installs the authority that moved during reader retirement, never the drifted snapshot (BST-2055)', async () => {
  const initial = { fileBindings: [binding], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  // The open lists its stored rows with no binding held (BST-1988); count from here.
  f.replaceFileBindings.mockClear();
  f.events.length = 0;
  const readerExit = Promise.withResolvers<void>();
  f.closeQueries.mockReturnValueOnce(readerExit.promise);
  f.setAuthority({ ...initial, fileBindings: [] });
  const acquired = f.runtime.acquire();
  await vi.waitFor(() => expect(f.closeQueries).toHaveBeenCalledTimes(2));
  f.setAuthority({ ...initial, fileBindings: [{ ...binding, fileId: 'new-file' }] });
  readerExit.resolve();
  await expect(acquired).resolves.toBe(f.port);
  expect(f.replaceFileBindings).toHaveBeenCalledExactlyOnceWith([
    { ...binding, fileId: 'new-file' },
  ]);
  expect(f.events.filter((event) => event === 'reader-installed')).toHaveLength(1);
  expect(f.events.at(-1)).toBe('reader-installed');
});

it('exposes a query target only for the authority that moved during binding acknowledgment', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  f.events.length = 0;
  const acknowledgment = Promise.withResolvers<void>();
  f.replaceFileBindings.mockReturnValueOnce(acknowledgment.promise);
  f.setAuthority({ ...initial, fileBindings: [binding] });
  const acquired = f.runtime.acquire();
  await vi.waitFor(() => expect(f.replaceFileBindings).toHaveBeenCalledWith([binding]));
  f.setAuthority({ ...initial, fileBindings: [{ ...binding, fileId: 'new-file' }] });
  acknowledgment.resolve();
  await expect(acquired).resolves.toBe(f.port);
  // The writer acknowledged the drifted file, so it is removed before the moved authority binds.
  expect(f.removeScopedFile).toHaveBeenCalledExactlyOnceWith({
    fileId: binding.fileId,
    scope: collection,
  });
  expect(f.replaceFileBindings).toHaveBeenLastCalledWith([{ ...binding, fileId: 'new-file' }]);
  expect(f.events.filter((event) => event === 'reader-installed')).toHaveLength(1);
  expect(f.events.at(-1)).toBe('reader-installed');
});

it('closes a started owner whose authority moved during startup before opening its replacement', async () => {
  const initial = { fileBindings: [binding], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  const started = Promise.withResolvers<IndexerPort & ScopedIndexerPort>();
  f.createIndexOwner.mockResolvedValueOnce({
    close: f.closeWriter,
    databasePath: '/owned/index.sqlite',
    start: () => started.promise,
  });
  const acquired = f.runtime.acquire();
  await vi.waitFor(() => expect(f.createIndexOwner).toHaveBeenCalledTimes(1));
  f.setAuthority({ ...initial, fileBindings: [] });
  started.resolve(f.port);
  await expect(acquired).resolves.toBe(f.port);
  expect(f.createIndexOwner).toHaveBeenCalledTimes(2);
  expect(f.createIndexOwner).toHaveBeenLastCalledWith({ ...initial, fileBindings: [] });
  expect(f.events.indexOf('writer-exited')).toBeLessThan(f.events.indexOf('writer-ready'));
  expect(f.events.filter((event) => event === 'reader-installed')).toHaveLength(1);
  await f.runtime.closeIndex();
  expect(f.closeWriter).toHaveBeenCalledTimes(2);
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

it("joins a scan's writer read before another root's bindings retire its reader (BST-2055)", async () => {
  // A finishing root's coverage read lost its query client to a sibling root's
  // first binding replacement, and the whole index stayed blocked.
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  f.events.length = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reading = f.runtime.withWriterRead(f.port, async () => {
    entered.resolve();
    await release.promise;
    f.events.push('coverage-read');
  });
  await entered.promise;
  f.setAuthority({ ...initial, fileBindings: [binding] });
  const acquired = f.runtime.acquire();
  await settle();
  expect(f.events).toEqual([]);
  release.resolve();
  await Promise.all([reading, acquired]);
  expect(f.events).toEqual(['coverage-read', 'readers-exited', 'bindings-ack', 'reader-installed']);
  await f.runtime.closeIndex();
});

it('starts a writer read only after an acquisition in flight installs its reader', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  f.events.length = 0;
  const acknowledgment = Promise.withResolvers<void>();
  f.replaceFileBindings.mockReturnValueOnce(acknowledgment.promise);
  f.setAuthority({ ...initial, fileBindings: [binding] });
  const acquired = f.runtime.acquire();
  await vi.waitFor(() => expect(f.replaceFileBindings).toHaveBeenCalledWith([binding]));
  const reading = f.runtime.withWriterRead(f.port, async () => {
    f.events.push('coverage-read');
  });
  await settle();
  expect(f.events).toEqual(['readers-exited']);
  acknowledgment.resolve();
  await Promise.all([acquired, reading]);
  expect(f.events).toEqual(['readers-exited', 'reader-installed', 'coverage-read']);
  await f.runtime.closeIndex();
});

it('starts a writer read after a source removal settles and its readers are reinstalled', async () => {
  const f = fixture({ fileBindings: [], rootIds: ['root'], scopes: [collection] });
  await f.runtime.acquire();
  f.events.length = 0;
  const removed = Promise.withResolvers<void>();
  const removal = f.runtime.mutateAuthority(f.port, async () => {
    await removed.promise;
    f.events.push('removed');
  });
  await vi.waitFor(() => expect(f.events).toEqual(['readers-exited']));
  const reading = f.runtime.withWriterRead(f.port, async () => {
    f.events.push('coverage-read');
  });
  await settle();
  expect(f.events).toEqual(['readers-exited']);
  removed.resolve();
  await Promise.all([removal, reading]);
  // The removal leaves its readers retired; the proof acquires before it reads.
  expect(f.events).toEqual([
    'readers-exited',
    'removed',
    'readers-exited',
    'bindings-ack',
    'reader-installed',
    'coverage-read',
  ]);
  await f.runtime.closeIndex();
});

it('reinstalls retired readers before a writer read that follows a settled source removal', async () => {
  const f = fixture({ fileBindings: [], rootIds: ['root'], scopes: [collection] });
  await f.runtime.acquire();
  await f.runtime.mutateAuthority(f.port, async () => undefined);
  expect(f.installQueryTarget).toHaveBeenCalledOnce();
  await f.runtime.withWriterRead(f.port, async () => {
    expect(f.installQueryTarget).toHaveBeenCalledTimes(2);
  });
  await f.runtime.closeIndex();
});

it('runs a writer read beside an acquisition that finds its bindings current (BST-2055)', async () => {
  // Readers validate the writer on every poll; a proof waiting for no acquisition
  // at all never ran, and the scans hung with every vector committed.
  const initial = { fileBindings: [binding], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  const validation = Promise.withResolvers<Authority>();
  f.getAuthority.mockReturnValueOnce(validation.promise);
  const authorityReads = f.getAuthority.mock.calls.length;
  const validating = f.runtime.acquire();
  await vi.waitFor(() => expect(f.getAuthority).toHaveBeenCalledTimes(authorityReads + 1));
  const read = f.runtime.withWriterRead(f.port, async () => 'proof');
  await expect(read).resolves.toBe('proof');
  validation.resolve(initial);
  await expect(validating).resolves.toBe(f.port);
  await f.runtime.closeIndex();
});

it('refuses a writer read for a replaced writer or once admission closes', async () => {
  const f = fixture({ fileBindings: [], rootIds: ['root'], scopes: [collection] });
  await f.runtime.acquire();
  const work = vi.fn(async () => undefined);
  await expect(f.runtime.withWriterRead({ ...f.port }, work)).rejects.toThrow(
    'retired or replaced'
  );
  await f.runtime.closeIndex();
  await expect(f.runtime.withWriterRead(f.port, work)).rejects.toThrow('read admission is closed');
  expect(work).not.toHaveBeenCalled();
});

it('reads the authority again for a caller that joins after the acquisition last read it (BST-2055)', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const second = { ...binding, fileId: 'second-file' };
  const f = fixture(initial);
  await f.runtime.acquire();
  const finalRead = Promise.withResolvers<Authority>();
  f.replaceFileBindings.mockImplementationOnce(async () => {
    // The acquisition's final authority read begins before the late caller's records exist.
    f.getAuthority.mockReturnValueOnce(finalRead.promise);
  });
  const snapshot = { ...initial, fileBindings: [binding] };
  f.setAuthority(snapshot);
  const first = f.runtime.acquire();
  await vi.waitFor(() => expect(f.replaceFileBindings).toHaveBeenCalledWith([binding]));
  await settle();
  f.setAuthority({ ...initial, fileBindings: [binding, second] });
  const late = f.runtime.acquire();
  finalRead.resolve(snapshot);
  await expect(first).resolves.toBe(f.port);
  await expect(late).resolves.toBe(f.port);
  expect(f.replaceFileBindings).toHaveBeenLastCalledWith([binding, second]);
  await f.runtime.closeIndex();
});

it('settles readers that validate in turn instead of re-acquiring for each other (BST-2055)', async () => {
  // A reader's own catalog refresh runs before it acquires, so each poll joined
  // the other's validation late; a fresh acquisition per late joiner spun forever.
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  // The catalog read takes longer than a reader's own refresh before it acquires.
  f.getAuthority.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return initial;
  });
  const authorityReads = f.getAuthority.mock.calls.length;
  const acquireRead = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return f.runtime.acquire();
  };
  const read = () => f.runtime.withRead(acquireRead, async () => undefined);
  const first = read();
  await vi.waitFor(() => expect(f.getAuthority.mock.calls.length).toBeGreaterThan(authorityReads));
  await Promise.all([first, read(), read()]);
  expect(f.getAuthority.mock.calls.length - authorityReads).toBeLessThan(20);
  await f.runtime.closeIndex();
});

it('fails only the caller still unobserved after the last acquisition attempt', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  // Every authority read admits another caller just after it begins.
  const joiners: Promise<unknown>[] = [];
  f.getAuthority.mockImplementation(async () => {
    if (joiners.length < 10) {
      joiners.push(f.runtime.acquire().catch((error: unknown) => error));
    }
    return initial;
  });
  await expect(f.runtime.acquire()).resolves.toBe(f.port);
  const outcomes = await Promise.all(joiners);
  expect(outcomes.slice(0, 9)).toEqual(Array.from({ length: 9 }, () => f.port));
  expect(outcomes[9]).toMatchObject({ message: expect.stringContaining('authority changed') });
  await f.runtime.closeIndex();
});

it('fails visibly when the authority moves during every acquisition attempt', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  f.events.length = 0;
  let moves = 0;
  f.replaceFileBindings.mockImplementation(async () => {
    moves += 1;
    f.setAuthority({ ...initial, fileBindings: [{ ...binding, fileId: `moved-${moves}` }] });
  });
  f.setAuthority({ ...initial, fileBindings: [binding] });
  await expect(f.runtime.acquire()).rejects.toThrow('authority changed during acquisition');
  expect(moves).toBe(10);
  expect(f.events).not.toContain('reader-installed');
  await f.runtime.closeIndex();
});
