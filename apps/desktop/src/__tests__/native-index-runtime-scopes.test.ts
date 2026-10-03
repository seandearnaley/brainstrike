// @vitest-environment node
import type {
  IndexerPort,
  IndexFileBinding,
  IndexScope,
  ScopedIndexerPort,
} from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
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
  const events: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('Unused fixture operation');
  };
  const replaceFileBindings = vi.fn(async (_bindings: readonly IndexFileBinding[]) => {
    events.push('bindings-ack');
  });
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
    coverageScope: unused,
    destroy: unused,
    info: unused,
    prepareFile: unused,
    prepareScopedFile: unused,
    removeFile: unused,
    removeScopedFile,
    replaceFileBindings,
    search: unused,
    searchScopes: unused,
    verifyManifest: unused,
    verifyScopedManifest: unused,
  };
  const closeQueries = vi.fn(async () => {
    events.push('readers-exited');
  });
  const closeWriter = vi.fn(async () => {
    events.push('writer-exited');
  });
  const createIndexOwner = vi.fn(async (_authority: Authority) => ({
    close: closeWriter,
    databasePath: '/owned/index.sqlite',
    start: async () => {
      events.push('writer-ready');
      return port;
    },
  }));
  const dependencies = {
    closeQueries,
    createIndexOwner,
    createProfileOwner: () => ({ acquire: async () => undefined, close: async () => undefined }),
    getAuthority: async () => authority,
    getRootIds: async () => authority.rootIds,
    installQueryTarget: () => {
      events.push('reader-installed');
    },
  };
  const runtime = createNativeIndexRuntime(dependencies);
  return {
    closeQueries,
    closeWriter,
    createIndexOwner,
    events,
    port,
    removeScopedFile,
    replaceFileBindings,
    runtime,
    setAuthority: (next: Authority): void => {
      authority = next;
    },
  };
}

it('joins original-authority rooted collection removal before closing the writer', async () => {
  const rooted = {
    ...binding,
    fileId: 'workspace-file',
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/actual/root/file.txt',
  };
  const f = fixture({
    fileBindings: [rooted, binding],
    rootIds: ['root'],
    scopes: [collection, { kind: 'workspace', rootId: 'root' }],
  });
  await f.runtime.acquire();
  const held = Promise.withResolvers<boolean>();
  f.removeScopedFile.mockReturnValueOnce(held.promise);
  // New live choices cannot replace the old native ACK's cleanup authority.
  f.setAuthority({
    fileBindings: [],
    rootIds: [],
    scopes: [{ embeddingSetId: 'other', kind: 'collection' }],
  });
  const retiring = f.runtime.retireWorkspaceCollectionFiles('collection');
  await vi.waitFor(() =>
    expect(f.removeScopedFile).toHaveBeenCalledExactlyOnceWith({
      fileId: rooted.fileId,
      scope: { kind: 'workspace', rootId: 'root' },
    })
  );
  const closing = f.runtime.closeIndex();
  expect(f.closeWriter).not.toHaveBeenCalled();
  await expect(f.runtime.acquire()).rejects.toThrow('admission is closed');
  held.resolve(true);
  await Promise.all([retiring, closing]);
  expect(f.removeScopedFile).toHaveBeenCalledTimes(1);
  expect(f.closeWriter).toHaveBeenCalledTimes(1);
});

it('retains failed outgoing native removal for explicit retry without erasing rootless rows', async () => {
  const rooted = {
    ...binding,
    fileId: 'workspace-file',
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/actual/root/file.txt',
  };
  const f = fixture({
    fileBindings: [rooted, binding],
    rootIds: ['root'],
    scopes: [collection, { kind: 'workspace', rootId: 'root' }],
  });
  await f.runtime.acquire();
  const cause = new Error('Native outgoing removal did not settle.');
  f.removeScopedFile.mockRejectedValueOnce(cause);
  await expect(f.runtime.retireWorkspaceCollectionFiles('collection')).rejects.toBe(cause);
  expect(f.closeWriter).not.toHaveBeenCalled();
  await expect(f.runtime.resume()).rejects.toThrow('Previous native ownership');
  await f.runtime.retireWorkspaceCollectionFiles('collection');
  await f.runtime.closeIndex();
  expect(f.removeScopedFile).toHaveBeenCalledTimes(2);
  expect(
    f.removeScopedFile.mock.calls.every(([request]) =>
      JSON.stringify(request).includes('workspace-file')
    )
  ).toBe(true);
  expect(f.closeWriter).toHaveBeenCalledTimes(1);
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
  await f.runtime.retireWorkspaceCollectionFiles('collection');
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

it('preserves the previous cache and ACK when binding replacement itself fails', async () => {
  const initial = { fileBindings: [], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
  const captured = f.runtime.captureAcknowledgedAuthority();
  const failure = new Error('Independent binding replacement failure.');
  f.replaceFileBindings.mockRejectedValueOnce(failure);
  f.setAuthority({ ...initial, fileBindings: [binding] });
  await expect(f.runtime.acquire()).rejects.toBe(failure);
  expect(captured.readAuthority().fileBindings).toEqual([]);
  f.setAuthority(initial);
  await f.runtime.acquire();
  expect(f.replaceFileBindings).toHaveBeenCalledOnce();
  f.setAuthority({ ...initial, fileBindings: [binding] });
  await f.runtime.acquire();
  expect(f.replaceFileBindings).toHaveBeenCalledTimes(2);
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
  const retiring = f.runtime.retireWorkspaceCollectionFiles('collection');
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
  expect(f.events).toEqual(['readers-exited', 'writer-ready', 'reader-installed']);
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
  expect(f.events).toEqual(['bindings-ack', 'reader-installed']);
  expect(f.createIndexOwner).toHaveBeenCalledTimes(1);
});

it('keeps failed same-scope reader retirement retryable before replacing bindings', async () => {
  const f = fixture({ fileBindings: [binding], rootIds: ['root'], scopes: [collection] });
  await f.runtime.acquire();
  f.events.length = 0;
  const failure = new Error('old membership reader has not exited');
  f.closeQueries.mockRejectedValueOnce(failure);
  f.setAuthority({ fileBindings: [], rootIds: ['root'], scopes: [collection] });
  await expect(f.runtime.acquire()).rejects.toBe(failure);
  expect(f.replaceFileBindings).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
  await f.runtime.acquire();
  expect(f.replaceFileBindings).toHaveBeenCalledExactlyOnceWith([]);
  expect(f.events).toEqual(['readers-exited', 'bindings-ack', 'reader-installed']);
  expect(f.createIndexOwner).toHaveBeenCalledTimes(1);
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
  await f.runtime.acquire();
  expect(f.closeWriter).toHaveBeenCalledTimes(1);
  expect(f.createIndexOwner).toHaveBeenCalledTimes(2);
});

it('refuses authority changed during reader retirement before replacing bindings', async () => {
  const initial = { fileBindings: [binding], rootIds: ['root'], scopes: [collection] };
  const f = fixture(initial);
  await f.runtime.acquire();
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
