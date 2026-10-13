// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { expect, test, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createNativeIndexRuntime } from '../native-index-runtime';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
test('inactive persisted collection cleanup removes only its native rows without a saved search configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-collection-cleanup-'));
  const dbPath = join(directory, 'index.sqlite');
  const scopes = [
    { embeddingSetId: 'deleted', kind: 'collection' },
    { embeddingSetId: 'kept', kind: 'collection' },
  ] as const;
  const bindings = [
    ...scopes.map((scope) => ({
      embeddingSetId: scope.embeddingSetId,
      fileId: `file-${scope.embeddingSetId}`,
      profile: null,
      relativePath: null,
      rootId: null,
      sourcePath: null,
    })),
    {
      embeddingSetId: 'deleted',
      fileId: 'rooted-deleted',
      profile: null,
      relativePath: 'owned.txt',
      rootId: 'mounted',
      sourcePath: '/disposable/owned.txt',
    },
  ];
  const options = {
    dbPath,
    embedding: { indexMode: 'text-only' },
    fileBindings: bindings,
    rootIds: ['mounted'],
    scopes: [{ kind: 'workspace', rootId: 'mounted' }, ...scopes],
  };
  const original = await openIndexer(options, deadlines);
  try {
    for (const { profile: _profile, ...binding } of bindings) {
      const plan = await original.prepareScopedFile({
        snapshot: { ...binding, chunkLines: 1, content: 'canonical retained marker' },
      });
      await original.commitScopedTextFile({ plan });
    }
  } finally {
    await original.close();
  }
  const getAuthority = vi.fn(async (): Promise<never> => {
    throw new Error('No current saved search configuration');
  });
  const installQueryTarget = vi.fn();
  const runtime = createNativeIndexRuntime({
    closeQueries: async () => {},
    createIndexOwner: async (authority) => {
      const opening = openIndexer(
        { ...authority, dbPath, embedding: { indexMode: 'text-only' } },
        deadlines
      );
      opening.catch(() => undefined);
      return {
        close: async () => {
          await (await opening).close();
        },
        databasePath: dbPath,
        start: () => opening,
      };
    },
    getAuthority,
    getFileInvalidator: () => undefined,
    installQueryTarget,
    profile: createDesktopProfileRuntime(() => ({
      acquire: async () => {},
      close: async () => {},
    })),
  });
  try {
    await runtime.closeIndex();
    await runtime.cleanupCollection('deleted');
    await runtime.closeIndex();
    expect(getAuthority).not.toHaveBeenCalled();
    expect(installQueryTarget).not.toHaveBeenCalled();
    const reopened = await openIndexer({ ...options, fileBindings: [] }, deadlines);
    try {
      const deleted = await reopened.verifyScopedManifest({ files: [], scope: scopes[0] });
      const kept = await reopened.verifyScopedManifest({ files: [], scope: scopes[1] });
      expect(deleted.unexpected).toEqual([]);
      expect(kept.unexpected.map((file) => file.fileId)).toEqual(['file-kept']);
    } finally {
      await reopened.close();
    }
  } finally {
    await runtime.closeIndex();
    await runtime.retireProfile();
    await rm(directory, { force: true, recursive: true });
  }
});
