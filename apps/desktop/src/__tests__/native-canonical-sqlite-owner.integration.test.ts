// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHostStateIndex } from '@brainstrike/agent-host/test-fixtures/host-state-index';
import { createNativeCanonicalCatalog } from '@brainstrike/canonical-ingestion';
import { StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';

// Actual scanner payload fields; native identity remains resolved from Main's admitted grant.
test('canonical discovery, completion and physical removal use the host writer with PG unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bs-canonical-sqlite-owner-'));
  const stateIndex = await openHostStateIndex(directory);
  const store = await StateStore.open(directory, { indexer: stateIndex.indexer });
  const unavailablePg = vi.fn(async (): Promise<never> => {
    throw new Error('PG catalog unavailable');
  });
  const removalEntered = Promise.withResolvers<void>();
  const removalJoined = Promise.withResolvers<void>();
  const dependencies = {
    catalog: store,
    database: { query: unavailablePg, transaction: unavailablePg },
    joinNativeRemoval: async () => {
      removalEntered.resolve();
      await removalJoined.promise;
    },
    replaceTrustedBindings: vi.fn(async () => undefined),
    resolveProfile: async () => ({ dimensions: 384, modelId: 'test-model' }),
    resolveScope: async () => ({
      assertCurrent: () => undefined,
      assertDiscoveredSource: (file: {
        rootId: string;
        relativePath: string;
        sourcePath: string;
      }) => {
        if (
          file.rootId !== 'root-alpha' ||
          file.sourcePath !== `/disposable/Alpha/${file.relativePath}`
        ) {
          throw new Error('Discovered source is outside the Main grant');
        }
      },
      embeddingSetId: null,
      resolveIdentity: (record: {
        embeddingSetId: string | null;
        fileId: string;
        fileName: string;
        path: string | null;
        rootId: string | null;
      }) => ({
        embeddingSetId: record.embeddingSetId,
        fileId: record.fileId,
        fileName: record.fileName,
        relativePath: record.path,
        rootId: record.rootId,
        sourcePath: `/disposable/Alpha/${record.path}`,
      }),
    }),
  };
  const catalog = createNativeCanonicalCatalog(dependencies);
  const context = { requestId: 'real-scan-receipt', signal: new AbortController().signal };
  const scope = { kind: 'workspace', rootId: 'root-alpha' } as const;
  const content = 'The checked file persists through the authoritative catalog.\n';
  const discovered = {
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    fileName: 'acceptance.txt',
    relativePath: 'acceptance.txt',
    rootId: 'root-alpha',
    sourcePath: '/disposable/Alpha/acceptance.txt',
    stat: { mtimeMs: 1_728_810_000_000, size: Buffer.byteLength(content) },
  };
  try {
    await store.workspaceRoots({
      operation: 'register',
      root: { displayName: 'Alpha', path: '/disposable/Alpha', preferredId: 'root-alpha' },
    });
    const prepared = await catalog.prepareManagedSourcesBatch(
      { files: [discovered], scope },
      context
    );
    const file = prepared[0];
    if (!file) {
      throw new Error('Discovery did not commit a source');
    }
    expect(
      (await catalog.prepareManagedSourcesBatch({ files: [discovered], scope }, context))[0]?.fileId
    ).toBe(file.fileId);
    await catalog.completeFiles(
      {
        files: [{ chunkCount: 1, contentHash: discovered.contentHash, fileId: file.fileId }],
        scope,
      },
      context
    );
    expect(
      (await catalog.loadAuthorizedBatch({ files: [file], scope }, context))[0]?.chunksProcessed
    ).toBe(true);
    expect(await catalog.readRetainedSource(file, discovered.stat.size, scope, context)).toEqual({
      content,
      stat: discovered.stat,
    });
    const removing = catalog.removeFiles({ files: [file], scope }, context);
    await removalEntered.promise;
    expect(
      (await store.sourceCatalog({ embeddingSetId: null, operation: 'inventory' })).files
    ).toHaveLength(1);
    removalJoined.resolve();
    await removing;
    expect(
      (await store.sourceCatalog({ embeddingSetId: null, operation: 'inventory' })).files
    ).toEqual([]);
    expect(unavailablePg).not.toHaveBeenCalled();
  } finally {
    removalJoined.resolve();
    await store.close();
    await stateIndex.close();
    await rm(directory, { force: true, recursive: true });
  }
});
