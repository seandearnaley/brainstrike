// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type HostStateIndex,
  openHostStateIndex,
} from '@brainstrike/agent-host/test-fixtures/host-state-index';
import type {
  CanonicalFileIdentity,
  CanonicalOperationContext,
} from '@brainstrike/canonical-ingestion';
import { createNativeCanonicalCatalog } from '@brainstrike/canonical-ingestion';
import {
  type SourceCatalogPort,
  type SourceCatalogRecord,
  StateStore,
} from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let store: StateStore;
let stateIndex: HostStateIndex;
let directory: string;
const workspace = { kind: 'workspace', rootId: 'real-root' } as const;
const collection = { embeddingSetId: 'real-set', kind: 'collection' } as const;
const original = 'export const preserved = "original retained source";\n';
const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
const context = (): CanonicalOperationContext => ({
  requestId: 'integration-scan',
  signal: new AbortController().signal,
});
const identity = (record: SourceCatalogRecord): CanonicalFileIdentity => ({
  embeddingSetId: record.embeddingSetId,
  fileId: record.fileId,
  fileName: record.fileName,
  relativePath: record.rootId === null ? null : record.path,
  rootId: record.rootId,
  sourcePath: record.rootId === null ? null : `/granted/${record.path}`,
});
const input = (path: string, content = original) => ({
  content,
  contentHash: hash(content),
  fileName: path.split('/').at(-1)!,
  path,
  stat: { mtimeMs: 42, size: Buffer.byteLength(content) },
});
const discovery = (path: string) => ({
  ...input(path),
  relativePath: path,
  rootId: 'real-root',
  sourcePath: `/granted/${path}`,
});
async function read(fileId: string): Promise<SourceCatalogRecord | undefined> {
  return (
    await store.sourceCatalog({ fileIds: [fileId], maxContentBytes: 4096, operation: 'read' })
  ).files[0];
}
async function find(path: string): Promise<SourceCatalogRecord | undefined> {
  const record = (await store.sourceCatalog({ operation: 'list' })).files.find(
    (file) => file.path === path
  );
  return record ? read(record.fileId) : undefined;
}
async function seed(
  path: string,
  rootless = false,
  content = original
): Promise<CanonicalFileIdentity> {
  const request = rootless
    ? { embeddingSetId: 'real-set', files: [input(path, content)], operation: 'import' as const }
    : {
        embeddingSetId: 'real-set',
        files: [input(path, content)],
        operation: 'prepare' as const,
        rootId: 'real-root',
      };
  const [record] = (await store.sourceCatalog(request)).files;
  if (!record) {
    throw new Error('Source preparation returned no identity');
  }
  await store.sourceCatalog({
    files: [{ chunkCount: 3, expected: record }],
    operation: 'complete',
  });
  return identity(record);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function adapter(port: SourceCatalogPort = store, assertCurrent = () => undefined) {
  const joinNativeRemoval = vi.fn(async () => undefined);
  const replaceTrustedBindings = vi.fn(async () => undefined);
  const catalog = createNativeCanonicalCatalog({
    catalog: port,
    joinNativeRemoval,
    replaceTrustedBindings,
    resolveProfile: async () => ({
      dimensions: 1536,
      distance: 'cosine',
      modelId: 'actual-model',
      modelKey: 'openai::actual-model',
    }),
    resolveScope: async () => ({
      assertCurrent,
      assertDiscoveredSource: (file) => {
        if (file.rootId !== 'real-root' || file.sourcePath !== `/granted/${file.relativePath}`) {
          throw new Error('foreign discovered source');
        }
      },
      embeddingSetId: 'real-set',
      resolveIdentity: (record) => ({
        embeddingSetId: record.embeddingSetId,
        fileId: record.fileId,
        fileName: record.fileName,
        relativePath: record.rootId === null ? null : record.path,
        rootId: record.rootId,
        sourcePath: record.rootId === null ? null : `/granted/${record.path}`,
      }),
    }),
  });
  return { catalog, joinNativeRemoval, replaceTrustedBindings };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'native-canonical-catalog-'));
  stateIndex = await openHostStateIndex(directory);
  store = await StateStore.open(directory, { indexer: stateIndex.indexer });
  await store.workspaceRoots({
    operation: 'register',
    root: { displayName: 'Granted root', path: '/granted', preferredId: 'real-root' },
  });
  await store.collections({
    collection: {
      createdAt: '2026-10-13T00:00:00.000Z',
      dimensions: 1536,
      distance: 'cosine',
      id: 'real-set',
      modelId: 'actual-model',
      modelKey: 'openai::actual-model',
    },
    operation: 'create',
  });
});
afterEach(async () => {
  await store?.close();
  await stateIndex?.close();
  await rm(directory, { force: true, recursive: true });
});

describe('authoritative catalog with real SQLite writer and derived state owner', () => {
  it('preserves rootless source and saved collection choices through completion and reopen', async () => {
    const retained = await seed('actual-retained-import-path', true);
    const { catalog } = adapter();
    const choices = await store.collections({ operation: 'list' });
    expect(await catalog.readRetainedSource(retained, 1024, collection, context())).toEqual({
      content: original,
      stat: { mtimeMs: 42, size: Buffer.byteLength(original) },
    });
    expect(
      await catalog.loadAuthorizedBatch({ files: [retained], scope: collection }, context())
    ).toEqual([
      {
        ...retained,
        chunksProcessed: true,
        contentHash: hash(original),
        stat: { mtimeMs: 42, size: Buffer.byteLength(original) },
      },
    ]);
    await catalog.applyManagedCacheBatch(
      {
        files: [
          {
            ...retained,
            content: original,
            contentHash: hash(original),
            stat: { mtimeMs: null, size: Buffer.byteLength(original) },
          },
        ],
        scope: collection,
      },
      context()
    );
    await catalog.completeFiles(
      {
        files: [{ chunkCount: 9, contentHash: hash(original), fileId: retained.fileId }],
        scope: collection,
      },
      context()
    );
    await store.close();
    store = await StateStore.open(directory, { indexer: stateIndex.indexer });
    expect(await read(retained.fileId)).toMatchObject({
      chunksCount: 9,
      chunksProcessed: true,
      content: original,
      embeddingSetId: 'real-set',
      fileId: retained.fileId,
      path: 'actual-retained-import-path',
    });
    expect(await store.collections({ operation: 'list' })).toEqual(choices);
  });
  it('replaces managed cache, invalidates completion and preserves fractional native mtime', async () => {
    const managed = await seed('src/managed.ts');
    const { catalog, replaceTrustedBindings } = adapter();
    const next = `${original}// changed original source\n`;
    await catalog.applyManagedCacheBatch(
      {
        files: [
          {
            ...managed,
            content: next,
            contentHash: hash(next),
            stat: { mtimeMs: 123.75, size: Buffer.byteLength(next) },
          },
        ],
        scope: workspace,
      },
      context()
    );
    expect(replaceTrustedBindings).toHaveBeenCalledOnce();
    expect(await read(managed.fileId)).toMatchObject({
      chunksCount: null,
      content: next,
      contentHash: hash(next),
      fileId: managed.fileId,
    });
    expect(
      await catalog.loadAuthorizedBatch({ files: [managed], scope: workspace }, context())
    ).toEqual([
      {
        ...managed,
        chunksProcessed: false,
        contentHash: hash(next),
        stat: { mtimeMs: 123.75, size: Buffer.byteLength(next) },
      },
    ]);
    await expect(
      catalog.completeFiles(
        {
          files: [{ chunkCount: 999, contentHash: hash(original), fileId: managed.fileId }],
          scope: workspace,
        },
        context()
      )
    ).rejects.toThrow('hash');
    expect(await read(managed.fileId)).toMatchObject({ chunksCount: null, content: next });
  });
  it.each([false, true])(
    'joins owned native removal before deleting exact membership (rootless=%s)',
    async (rootless) => {
      const removed = await seed('src/removed.ts', rootless);
      const untouched = await seed(
        'src/untouched.ts',
        rootless,
        `${original}// independent source`
      );
      const { catalog, joinNativeRemoval } = adapter();
      const entered = deferred(),
        release = deferred();
      joinNativeRemoval.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const removal = catalog.removeFiles(
        { files: [removed], scope: rootless ? collection : workspace },
        context()
      );
      await entered.promise;
      try {
        expect(await read(removed.fileId)).toMatchObject({
          chunksProcessed: true,
          fileId: removed.fileId,
        });
      } finally {
        release.resolve();
        await removal;
      }
      await expect(read(removed.fileId)).rejects.toThrow('identity is missing');
      expect(await read(untouched.fileId)).toMatchObject({
        chunksProcessed: true,
        fileId: untouched.fileId,
      });
      // Retired canonical identity cannot complete or be rebound by a late native receipt.
      await expect(
        catalog.completeFiles(
          {
            files: [{ chunkCount: 4, contentHash: hash(original), fileId: removed.fileId }],
            scope: rootless ? collection : workspace,
          },
          context()
        )
      ).rejects.toThrow();
      await expect(
        catalog.loadAuthorizedBatch(
          { files: [removed], scope: rootless ? collection : workspace },
          context()
        )
      ).rejects.toThrow();
    }
  );
  it('reuses root/path identity and retains committed content before binding acknowledgment', async () => {
    const { catalog, replaceTrustedBindings } = adapter();
    const source = discovery('src/discovered.ts');
    const entered = deferred(),
      release = deferred();
    replaceTrustedBindings.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const operation = catalog.prepareManagedSourcesBatch(
      { files: [source], scope: workspace },
      context()
    );
    await entered.promise;
    const committed = await find(source.relativePath);
    expect(committed).toMatchObject({
      content: original,
      contentHash: hash(original),
      fileName: source.fileName,
    });
    expect(committed?.fileId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    let settled = false;
    const result = operation.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    const prepared = await result;
    expect(prepared).toEqual([{ ...identity(committed!), contentHash: hash(original) }]);
    const changed = `${original}// real replacement\n`;
    const repeated = await catalog.prepareManagedSourcesBatch(
      {
        files: [
          {
            ...source,
            content: changed,
            contentHash: hash(changed),
            stat: { mtimeMs: 999.1, size: Buffer.byteLength(changed) },
          },
        ],
        scope: workspace,
      },
      context()
    );
    expect(repeated[0]?.fileId).toBe(prepared[0]?.fileId);
    expect(await find(source.relativePath)).toMatchObject({
      content: changed,
      fileId: prepared[0]?.fileId,
    });
    expect(
      (await store.sourceCatalog({ operation: 'list' })).files.filter(
        (file) => file.rootId === source.rootId && file.path === source.relativePath
      )
    ).toHaveLength(1);
  });
  it('joins admitted preparation ACK after cancellation, retaining committed source but refusing returned identities', async () => {
    const { catalog, replaceTrustedBindings } = adapter();
    const source = discovery('src/cancelled.ts');
    const controller = new AbortController(),
      entered = deferred(),
      release = deferred();
    replaceTrustedBindings.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const operation = catalog.prepareManagedSourcesBatch(
      { files: [source], scope: workspace },
      { ...context(), signal: controller.signal }
    );
    await entered.promise;
    let settled = false;
    const result = operation.finally(() => {
      settled = true;
    });
    const refused = expect(result).rejects.toThrow('cancelled discovery');
    controller.abort(new Error('cancelled discovery'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    await refused;
    expect(await find(source.relativePath)).toMatchObject({
      content: original,
      contentHash: hash(original),
    });
  });
  it('refuses a prepared source changed during full binding replacement', async () => {
    const { catalog, replaceTrustedBindings } = adapter();
    const source = discovery('src/stale.ts');
    replaceTrustedBindings.mockImplementationOnce(async () => {
      const expected = await find(source.relativePath);
      if (!expected) {
        throw new Error('Prepared source missing');
      }
      await store.sourceCatalog({
        files: [{ expected, source: input(source.relativePath, 'newer source') }],
        operation: 'replace',
      });
    });
    await expect(
      catalog.prepareManagedSourcesBatch({ files: [source], scope: workspace }, context())
    ).rejects.toThrow('stale after binding');
  });
  it('refuses an absent live root before allocating a source identity', async () => {
    const { catalog } = adapter();
    const source = discovery('src/revoked.ts');
    await store.workspaceRoots({ mountedPaths: [], operation: 'disconnect-except' });
    await expect(
      catalog.prepareManagedSourcesBatch({ files: [source], scope: workspace }, context())
    ).rejects.toThrow();
    expect(await find(source.relativePath)).toBeUndefined();
  });
  it('bounds retained bytes and preserves current-format source hash and identity', async () => {
    const retained = await seed('bounded-retained.ts', true);
    const { catalog } = adapter();
    await expect(catalog.readRetainedSource(retained, 1, collection, context())).rejects.toThrow(
      'bound'
    );
    const source = await catalog.readRetainedSource(retained, 1024, collection, context());
    expect(source.content).toBe(original);
    await catalog.applyManagedCacheBatch(
      { files: [{ ...retained, ...source, contentHash: hash(source.content) }], scope: collection },
      context()
    );
    await catalog.completeFiles(
      {
        files: [{ chunkCount: 1, contentHash: hash(original), fileId: retained.fileId }],
        scope: collection,
      },
      context()
    );
    expect(await read(retained.fileId)).toMatchObject({
      chunksCount: 1,
      content: original,
      contentHash: hash(original),
      fileId: retained.fileId,
      path: 'bounded-retained.ts',
    });
  });
  it('retains an acknowledged completion when scope revokes after commit and refuses subsequent work', async () => {
    const retained = await seed('committed-retained.ts', true);
    let current = true;
    const { catalog, replaceTrustedBindings } = adapter(
      {
        sourceCatalog: async (request) => {
          const result = await store.sourceCatalog(request);
          if (request.operation === 'complete') {
            current = false;
          }
          return result;
        },
      },
      () => {
        if (!current) {
          throw new Error('stale generation');
        }
      }
    );
    const completion = {
      files: [{ chunkCount: 999, contentHash: hash(original), fileId: retained.fileId }],
      scope: collection,
    };
    await expect(catalog.completeFiles(completion, context())).rejects.toThrow('stale generation');
    expect(await read(retained.fileId)).toMatchObject({ chunksCount: 999, content: original });
    await expect(
      catalog.completeFiles(
        { ...completion, files: [{ ...completion.files[0]!, chunkCount: 111 }] },
        context()
      )
    ).rejects.toThrow('stale generation');
    expect(await read(retained.fileId)).toMatchObject({ chunksCount: 999 });
    expect(replaceTrustedBindings).not.toHaveBeenCalled();
  });
  it('revocation before writer admission prevents mutation', async () => {
    const retained = await seed('not-admitted.ts', true);
    const sourceCatalog = vi.fn(store.sourceCatalog.bind(store));
    const { catalog } = adapter({ sourceCatalog }, () => {
      throw new Error('revoked before write');
    });
    await expect(
      catalog.completeFiles(
        {
          files: [{ chunkCount: 999, contentHash: hash(original), fileId: retained.fileId }],
          scope: collection,
        },
        context()
      )
    ).rejects.toThrow('revoked before write');
    expect(sourceCatalog).not.toHaveBeenCalled();
    expect(await read(retained.fileId)).toMatchObject({ chunksCount: 3, content: original });
  });
});
