// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openHostStateIndex } from '@brainstrike/agent-host/test-fixtures/host-state-index';
import type { IndexFileBinding, IndexScope } from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import { expect, it, vi } from 'vitest';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { WorkspaceRootRegistry } from '../ipc-domains/workspace-root-registry';
import { createNativeIndexRuntime, type NativeIndexAuthority } from '../native-index-runtime';
import { createNativeRootDataDeletion } from '../native-root-data-deletion';
import { createStorage, rootHandle } from './ipc-domains/workspace-root-registry-test-helpers';

// Node resolves the emitted process entry; a Vite source alias cannot spawn emitted JS.
const { openIndexer }: typeof import('@brainstrike/indexer') = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('@brainstrike/indexer')).href
);

it('holds native acknowledgment ahead of real catalog deletion and preserves remaining native/catalog authority after reopen', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'brainstrike-root-delete-'));
  const stateRoot = path.join(directory, 'state');
  await mkdir(stateRoot);
  const stateIndex = await openHostStateIndex(stateRoot);
  const database = await StateStore.open(stateRoot, { indexer: stateIndex.indexer });
  const registry = new WorkspaceRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    evictLspServersForRoot: async () => undefined,
    getRootsCatalog: async () => database,
    pathExists: async () => true,
    storage: createStorage(),
  });
  const rootPath = path.join(directory, 'owned');
  const otherPath = path.join(directory, 'other');
  await mkdir(rootPath);
  await mkdir(otherPath);
  await writeFile(path.join(rootPath, 'owned.ts'), 'export const owned = 1;\n');
  await writeFile(path.join(otherPath, 'other.ts'), 'export const other = 1;\n');
  // Main's registry records each mount in `roots` itself (BST-1990).
  const root = await registry.addRoot(rootHandle(rootPath));
  const other = await registry.addRoot(rootHandle(otherPath));
  for (const id of ['actual-collection', 'other-collection']) {
    await database.collections({
      collection: {
        createdAt: '2026-10-13T00:00:00.000Z',
        dimensions: 3,
        distance: 'cosine',
        id,
        modelId: id,
        modelKey: `local::${id}`,
      },
      operation: 'create',
    });
  }
  const sourceBindings: IndexFileBinding[] = [
    {
      embeddingSetId: 'actual-collection',
      fileId: 'owned-file',
      profile: null,
      relativePath: 'owned.ts',
      rootId: root.rootId,
      sourcePath: path.join(rootPath, 'owned.ts'),
    },
    {
      embeddingSetId: 'actual-collection',
      fileId: 'other-file',
      profile: null,
      relativePath: 'other.ts',
      rootId: other.rootId,
      sourcePath: path.join(otherPath, 'other.ts'),
    },
    {
      embeddingSetId: 'actual-collection',
      fileId: 'rootless-file',
      profile: null,
      relativePath: null,
      rootId: null,
      sourcePath: null,
    },
    {
      embeddingSetId: 'other-collection',
      fileId: 'other-collection-file',
      profile: null,
      relativePath: null,
      rootId: null,
      sourcePath: null,
    },
  ];
  const bindings: IndexFileBinding[] = [];
  for (const binding of sourceBindings) {
    const content = 'actual source\n';
    const files = [
      {
        content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        fileName: binding.fileId,
        path: binding.relativePath ?? binding.fileId,
        stat: { mtimeMs: null, size: Buffer.byteLength(content) },
      },
    ];
    const reply = await database.sourceCatalog(
      binding.rootId
        ? {
            embeddingSetId: binding.embeddingSetId,
            files,
            operation: 'prepare',
            rootId: binding.rootId,
          }
        : { embeddingSetId: binding.embeddingSetId, files, operation: 'import' }
    );
    const recorded = reply.files[0];
    if (!recorded) {
      throw new Error('Canonical source admission omitted its identity');
    }
    bindings.push({ ...binding, fileId: recorded.fileId });
  }
  const ownedFileId = bindings[0]!.fileId;
  const remainingFileIds = bindings
    .slice(1)
    .map((binding) => binding.fileId)
    .sort();
  const canonicalFiles = async () => (await database.sourceCatalog({ operation: 'list' })).files;
  const scopes: IndexScope[] = [
    { kind: 'workspace', rootId: root.rootId },
    { kind: 'workspace', rootId: other.rootId },
    { embeddingSetId: 'actual-collection', kind: 'collection' },
    { embeddingSetId: 'other-collection', kind: 'collection' },
  ];
  const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    fileBindings: bindings,
    rootIds: [root.rootId, other.rootId],
    scopes,
  };
  let authority: NativeIndexAuthority = {
    fileBindings: bindings,
    rootIds: options.rootIds,
    scopes,
  };
  const runtime = createNativeIndexRuntime({
    closeQueries: async () => undefined,
    createIndexOwner: async (requested) => {
      let owned: Awaited<ReturnType<typeof openIndexer>> | undefined;
      return {
        close: async () => {
          if (!owned) {
            throw new Error('Fixture writer has not started');
          }
          await owned.close();
        },
        databasePath: options.dbPath,
        start: async () => {
          owned = await openIndexer({ ...options, ...requested }, deadlines);
          return owned;
        },
      };
    },
    getAuthority: async () => authority,
    getFileInvalidator: () => () => {},
    installQueryTarget: () => undefined,
    profile: createDesktopProfileRuntime(() => ({
      acquire: async () => undefined,
      close: async () => undefined,
    })),
  });
  let port = await runtime.acquire();
  const captured = runtime.captureAcknowledgedAuthority();
  const held = Promise.withResolvers<void>();
  const nativeRemoved = Promise.withResolvers<void>();
  const remove = port.removeScopedFile.bind(port);
  const events: string[] = [];
  port.removeScopedFile = async (identity) => {
    const removed = await remove(identity);
    nativeRemoved.resolve();
    await held.promise;
    events.push('native-ack');
    return removed;
  };
  const sourceStopped = Promise.withResolvers<void>();
  const service = createNativeRootDataDeletion({
    acquire: async () => {
      port = await runtime.acquire();
      events.push('reopened');
    },
    captureOwner: async () => ({ generation: 1, ...runtime.captureAcknowledgedAuthority() }),
    closeOwner: async () => {
      await runtime.retireProfile();
      events.push('writer-exited');
    },
    deleteCanonicalRoot: async (mounted) => {
      expect(() => captured.readAuthority()).toThrow('retired or replaced');
      await database.workspaceRoots({
        operation: 'delete',
        paths: [mounted.canonicalPath, mounted.presentationPath],
        rootId: mounted.rootId,
      });
      events.push('catalog-delete');
    },
    reserveRoot: (rootId) => registry.reserveRootDataDeletion(rootId),
    resume: async () => {
      authority = {
        fileBindings: bindings.filter((binding) => binding.rootId !== root.rootId),
        rootIds: [other.rootId],
        scopes: scopes.filter(
          (scope) => scope.kind !== 'workspace' || scope.rootId !== root.rootId
        ),
      };
      await runtime.resume();
      events.push('resume');
    },
    stopSources: async () => {
      await sourceStopped.promise;
      events.push('sources-joined');
    },
  });
  try {
    for (const binding of bindings) {
      const { profile: _profile, ...file } = binding;
      await port.commitScopedTextFile({
        plan: await port.prepareScopedFile({
          snapshot: { ...file, chunkLines: 1, content: 'actual source\n' },
        }),
      });
    }
    const deletion = service.deleteRootData(root.rootId);
    await vi.waitFor(() =>
      expect(service.transition(async () => undefined)).rejects.toThrow('deletion owns')
    );
    expect(
      (await canonicalFiles())
        .filter((file) => file.rootId === root.rootId)
        .map((file) => ({ id: file.fileId }))
    ).toEqual([{ id: ownedFileId }]);
    sourceStopped.resolve();
    await nativeRemoved.promise;
    expect(
      (await canonicalFiles())
        .filter((file) => file.rootId === root.rootId)
        .map((file) => ({ id: file.fileId }))
    ).toEqual([{ id: ownedFileId }]);
    expect(events).toEqual(['sources-joined']);
    held.resolve();
    await deletion;
    expect(events).toEqual([
      'sources-joined',
      'native-ack',
      'writer-exited',
      'catalog-delete',
      'resume',
      'reopened',
    ]);
    expect((await canonicalFiles()).map((file) => file.fileId).sort()).toEqual(remainingFileIds);
    expect(
      await port.coverageScope({
        scope: { embeddingSetId: 'actual-collection', kind: 'collection' },
      })
    ).toMatchObject({ counts: { indexedFiles: 2 } });
    expect(
      await port.coverageScope({
        scope: { embeddingSetId: 'other-collection', kind: 'collection' },
      })
    ).toMatchObject({ counts: { indexedFiles: 1 } });
  } finally {
    sourceStopped.resolve();
    held.resolve();
    await runtime.retireProfile();
    await registry.dispose();
    await database.close();
    await stateIndex.close();
    await rm(directory, { force: true, recursive: true });
  }
});
