// @vitest-environment node
import {
  IndexerError,
  type IndexerPort,
  type IndexFileBinding,
  type IndexScope,
  type ScopedIndexerPort,
  type ScopedManifestFile,
} from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createNativeIndexRuntime, type NativeIndexAuthority } from '../native-index-runtime';

const inScope = (
  file: { readonly embeddingSetId: string | null; readonly rootId: string | null },
  scope: IndexScope
): boolean =>
  scope.kind === 'workspace'
    ? file.rootId === scope.rootId
    : file.embeddingSetId === scope.embeddingSetId;

/** A writer opening on a store that already holds `stored`, as the native writer behaves. */
function fixture(authority: NativeIndexAuthority, stored: readonly ScopedManifestFile[]) {
  const events: string[] = [];
  let bound: readonly IndexFileBinding[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('Unused fixture operation');
  };
  const replaceFileBindings = vi.fn(async (bindings: readonly IndexFileBinding[]) => {
    bound = bindings;
    events.push('bindings-replace');
  });
  const removeScopedFile = vi.fn(async (_request: unknown) => {
    events.push('remove');
    return true;
  });
  const verifyScopedManifest = vi.fn(
    async (request: { readonly files: readonly unknown[]; readonly scope: IndexScope }) => {
      // As the writer does: a manifest declares every file bound in its scope.
      if (request.files.length !== bound.filter((file) => inScope(file, request.scope)).length) {
        throw new IndexerError(
          'incomplete-manifest',
          'A scoped manifest must declare the complete current canonical file inventory.'
        );
      }
      return {
        authorityEpoch: 'a'.repeat(64),
        authorityRevision: 1,
        changed: [],
        complete: false,
        missing: [],
        scope: request.scope,
        storeId: 'store',
        unexpected: stored.filter((row) => inScope(row, request.scope)),
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
    readScopedFileChunkBounds: unused,
    readScopedFilePage: unused,
    removeFile: unused,
    removeScopedFile,
    replaceFileBindings: replaceFileBindings as unknown as ScopedIndexerPort['replaceFileBindings'],
    search: unused,
    searchScopes: unused,
    verifyManifest: unused,
    verifyScopedManifest:
      verifyScopedManifest as unknown as ScopedIndexerPort['verifyScopedManifest'],
  };
  const runtime = createNativeIndexRuntime({
    closeQueries: async () => {},
    createIndexOwner: async (opened: NativeIndexAuthority) => ({
      close: async () => {},
      databasePath: '/owned/index.sqlite',
      start: async () => {
        bound = opened.fileBindings;
        events.push('writer-start');
        return port;
      },
    }),
    getAuthority: async () => authority,
    getFileInvalidator: () => () => {},
    installQueryTarget: () => {
      events.push('reader-install');
    },
    profile: createDesktopProfileRuntime(() => ({
      acquire: async () => undefined,
      close: async () => undefined,
    })),
  });
  return { events, removeScopedFile, replaceFileBindings, runtime };
}

function storedRow(fileId: string, embeddingSetId: string | null): ScopedManifestFile {
  return {
    chunks: [],
    contentHash: 'c'.repeat(64),
    embeddingSetId,
    fileId,
    relativePath: `${fileId}.txt`,
    rootId: 'root',
    sourcePath: `/${fileId}.txt`,
  };
}

const bound = {
  embeddingSetId: null,
  fileId: 'file',
  profile: null,
  relativePath: 'file.txt',
  rootId: 'root',
  sourcePath: '/file.txt',
};

it('removes the rows an opened writer finds in its folders that its bindings do not own', async () => {
  // BST-1988: semantic search chosen before its model and execution closed the
  // Text-only writer between saves, so the TEXT partition's rows sat beside the
  // collection's and the folder's manifest could never complete.
  const f = fixture(
    { fileBindings: [bound], rootIds: ['root'], scopes: [{ kind: 'workspace', rootId: 'root' }] },
    [
      storedRow('file', null),
      storedRow('text-partition', null),
      storedRow('earlier-collection', 'earlier'),
    ]
  );
  await f.runtime.acquire();
  const unowned = (fileId: string) => ({
    embeddingSetId: null,
    fileId,
    profile: null,
    relativePath: `${fileId}.txt`,
    rootId: 'root',
    sourcePath: `/${fileId}.txt`,
  });
  expect(f.replaceFileBindings.mock.calls).toEqual([
    [[]],
    [[bound, unowned('text-partition'), unowned('earlier-collection')]],
    [[bound]],
  ]);
  expect(f.removeScopedFile.mock.calls).toEqual([
    [{ fileId: 'text-partition', scope: { kind: 'workspace', rootId: 'root' } }],
    [{ fileId: 'earlier-collection', scope: { kind: 'workspace', rootId: 'root' } }],
  ]);
  // The reader sees only the converged store.
  expect(f.events).toEqual([
    'writer-start',
    'bindings-replace',
    'bindings-replace',
    'remove',
    'remove',
    'bindings-replace',
    'reader-install',
  ]);
});

it('removes a disconnected folder kept with its data from the collection it was indexed into', async () => {
  // BST-2011: a collection's manifest is every row of that collection, whatever
  // its folder. A folder disconnected with its data kept has no lease and no
  // bindings, so its rows kept the collection's manifest from ever completing.
  // They are derived rows: its Postgres records and its one id stay, and adding
  // the folder back indexes it again.
  const collection = { embeddingSetId: 'collection', kind: 'collection' } as const;
  const collected = { ...bound, embeddingSetId: 'collection' };
  const f = fixture(
    {
      fileBindings: [collected],
      rootIds: ['root'],
      scopes: [{ kind: 'workspace', rootId: 'root' }, collection],
    },
    [
      storedRow('file', 'collection'),
      { ...storedRow('kept-folder-file', 'collection'), rootId: 'kept' },
    ]
  );
  await f.runtime.acquire();
  expect(f.replaceFileBindings.mock.calls).toEqual([
    [[]],
    [
      [
        collected,
        {
          embeddingSetId: 'collection',
          fileId: 'kept-folder-file',
          profile: null,
          relativePath: null,
          rootId: null,
          sourcePath: '/kept-folder-file.txt',
        },
      ],
    ],
    [[collected]],
  ]);
  expect(f.removeScopedFile.mock.calls).toEqual([
    [{ fileId: 'kept-folder-file', scope: collection }],
  ]);
});

it('opens without touching bindings when no folder or collection holds a row it does not own', async () => {
  const f = fixture(
    { fileBindings: [], rootIds: ['root'], scopes: [{ kind: 'workspace', rootId: 'root' }] },
    []
  );
  await f.runtime.acquire();
  expect(f.replaceFileBindings).not.toHaveBeenCalled();
  expect(f.events).toEqual(['writer-start', 'reader-install']);
});
