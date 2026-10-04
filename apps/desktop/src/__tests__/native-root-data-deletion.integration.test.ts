// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deleteManagedRootData, migrate, wasmLoader } from '@brainstrike/db';
import type { IndexFileBinding, IndexScope } from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
// Exercise the actual built host entry rather than Vitest's source aliases.
import { openIndexer } from '../../../../packages/indexer/dist/index.js';
import { WorkspaceRootRegistry } from '../ipc-domains/workspace-root-registry';
import { createNativeIndexRuntime, type NativeIndexAuthority } from '../native-index-runtime';
import { createNativeRootDataDeletion } from '../native-root-data-deletion';
import { createStorage, rootHandle } from './ipc-domains/workspace-root-registry-test-helpers';

it('holds native acknowledgment ahead of real PG cascade and preserves remaining native/PG authority after reopen', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'brainstrike-root-delete-'));
  const database = await wasmLoader.createPGlite('memory://root-deletion');
  await migrate(database);
  const registry = new WorkspaceRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    evictLspServersForRoot: async () => undefined,
    getRootsDatabase: async () => ({
      query: <T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> =>
        database.query<T>(sql, params ? [...params] : undefined),
    }),
    pathExists: async () => true,
    storage: createStorage(),
  });
  const rootPath = path.join(directory, 'owned');
  const otherPath = path.join(directory, 'other');
  await mkdir(rootPath);
  await mkdir(otherPath);
  await writeFile(path.join(rootPath, 'owned.ts'), 'export const owned = 1;\n');
  await writeFile(path.join(otherPath, 'other.ts'), 'export const other = 1;\n');
  const root = await registry.addRoot(rootHandle(rootPath));
  const other = await registry.addRoot(rootHandle(otherPath));
  await database.query(
    `INSERT INTO roots (id, kind, display_name, path, status) VALUES ($1, 'path', 'owned', $2, 'live'), ($3, 'path', 'other', $4, 'live')`,
    [root.rootId, rootPath, other.rootId, otherPath]
  );
  await database.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions) VALUES ('actual-collection', 'actual-key', 'actual-model', 3), ('other-collection', 'other-key', 'other-model', 3)`
  );
  const bindings: IndexFileBinding[] = [
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
    createProfileOwner: () => ({ acquire: async () => undefined, close: async () => undefined }),
    getAuthority: async () => authority,
    getFileInvalidator: () => () => {},
    installQueryTarget: () => undefined,
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
      await deleteManagedRootData(database, {
        paths: [mounted.canonicalPath, mounted.presentationPath],
        rootId: mounted.rootId,
      });
      events.push('pg-cascade');
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
      await database.query(
        `INSERT INTO file_records (id, name, path, root_id, embedding_set_id, content, content_hash, size, token_count) VALUES ($1, $1, $2, $3, $4, 'actual source', 'actual hash', 13, 2)`,
        [
          binding.fileId,
          binding.relativePath ?? binding.fileId,
          binding.rootId,
          binding.embeddingSetId,
        ]
      );
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
      (await database.query('SELECT id FROM file_records WHERE root_id = $1', [root.rootId])).rows
    ).toEqual([{ id: 'owned-file' }]);
    sourceStopped.resolve();
    await nativeRemoved.promise;
    expect(
      (await database.query('SELECT id FROM file_records WHERE root_id = $1', [root.rootId])).rows
    ).toEqual([{ id: 'owned-file' }]);
    expect(events).toEqual(['sources-joined']);
    held.resolve();
    await deletion;
    expect(events).toEqual([
      'sources-joined',
      'native-ack',
      'writer-exited',
      'pg-cascade',
      'resume',
      'reopened',
    ]);
    expect((await database.query('SELECT id FROM file_records ORDER BY id')).rows).toEqual([
      { id: 'other-collection-file' },
      { id: 'other-file' },
      { id: 'rootless-file' },
    ]);
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
    await rm(directory, { force: true, recursive: true });
  }
});
