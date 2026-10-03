// @vitest-environment node
import type { CanonicalFileIdentity, CanonicalSourceScope } from '@brainstrike/canonical-ingestion';
import {
  type ScopedFilePlan,
  type ScopedIndexerPort,
  vectorProfileHash,
} from '@brainstrike/indexer';
import { describe, expect, it, vi } from 'vitest';
import { createNativeCanonicalPublication } from '../native-canonical-publication';

const scope = { embeddingSetId: 'collection', kind: 'collection' } as const;
const file: CanonicalFileIdentity = {
  embeddingSetId: 'collection',
  fileId: 'file',
  fileName: 'file.txt',
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
const storeId = 'store';
function requestedScope(input: unknown): CanonicalSourceScope {
  if (!input || typeof input !== 'object') {
    throw new Error('Expected a native scope request.');
  }
  const selected: unknown = Reflect.get(input, 'scope');
  if (!selected || typeof selected !== 'object') {
    throw new Error('Expected explicit native scope.');
  }
  const kind: unknown = Reflect.get(selected, 'kind');
  const rootId: unknown = Reflect.get(selected, 'rootId');
  const embeddingSetId: unknown = Reflect.get(selected, 'embeddingSetId');
  if (kind === 'workspace' && typeof rootId === 'string') {
    return { kind, rootId };
  }
  if (kind === 'collection' && typeof embeddingSetId === 'string') {
    return { embeddingSetId, kind };
  }
  throw new Error('Expected an authorized native scope.');
}
function fixture() {
  const port = {
    commitScopedFile: vi.fn(),
    commitScopedTextFile: vi.fn(),
    coverageScope: vi.fn(),
    info: vi.fn(async () => ({
      dbPath: '/owned/index.sqlite',
      embedding: { indexMode: 'text-only' as const },
      journalMode: 'wal',
      pid: 1,
      readerQueryOnly: 1,
      storeId,
      vecVersion: '0.1.9',
      writerThreadId: 1,
    })),
    prepareScopedFile: vi.fn(),
    removeScopedFile: vi.fn(async () => true),
    verifyScopedManifest: vi.fn(
      async (request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]) => ({
        authorityEpoch: 'epoch',
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: requestedScope(request),
        storeId,
        unexpected: [],
      })
    ),
  };
  const publication = createNativeCanonicalPublication(port, [scope]);
  return { port, publication };
}
const completion = { aborted: false, errors: [], files: [], full: true, truncatedDirectories: [] };

const localProfile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'transformers',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
function overlappingFixture() {
  const { port } = fixture();
  const workspace = { kind: 'workspace', rootId: 'root' } as const;
  const rooted = {
    ...file,
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/actual/root/file.txt',
  };
  const plan: ScopedFilePlan = {
    authorityEpoch: 'epoch',
    authorityRevision: 1,
    chunks: [
      {
        chunkId: 'a'.repeat(64),
        chunkIndex: 0,
        chunkSize: 384,
        chunkType: 'text',
        content: 'canonical',
        contentHash: 'c'.repeat(64),
        embeddingHash: 'd'.repeat(64),
        endLine: 1,
        endOffset: 9,
        startLine: 1,
        startOffset: 0,
        tokenCount: 2,
      },
    ],
    contentHash: 'c'.repeat(64),
    embeddingChunkIds: [],
    previousSnapshotHash: null,
    profile: localProfile,
    profileHash: vectorProfileHash(localProfile),
    snapshot: {
      ...rooted,
      content: 'canonical',
      providedChunks: [
        {
          chunkIndex: 0,
          chunkSize: 384,
          chunkType: 'text',
          content: 'canonical',
          contentHash: 'c'.repeat(64),
          endLine: 1,
          endOffset: 9,
          startLine: 1,
          startOffset: 0,
          tokenCount: 2,
        },
      ],
    },
    storeId,
  };
  port.prepareScopedFile.mockResolvedValue(plan);
  port.commitScopedFile.mockResolvedValue({});
  port.coverageScope.mockImplementation(async (request: unknown) => ({
    authorityEpoch: 'epoch',
    authorityRevision: 1,
    counts: { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 },
    profile: localProfile,
    profileHash: vectorProfileHash(localProfile),
    scope: requestedScope(request),
    storeId,
    vectorCoverageComplete: true,
  }));
  const publication = createNativeCanonicalPublication(port, [workspace, scope]);
  const scan = async (requested: typeof scope | typeof workspace): Promise<void> => {
    const ticket = await publication.beginScan({
      requestId: JSON.stringify(requested),
      scope: requested,
    });
    const prepared = await publication.prepareVectorFile({
      file: rooted,
      payload: {
        content: plan.snapshot.content,
        fileId: rooted.fileId,
        providedChunks: 'providedChunks' in plan.snapshot ? plan.snapshot.providedChunks : [],
      },
      profile: localProfile,
      ticket,
    });
    await publication.commitVectorFile({
      embeddings: [],
      file: rooted,
      plan: prepared,
      profile: localProfile,
      ticket,
    });
    expect(
      await publication.finishScan({
        ...completion,
        files: [{ ...rooted, contentHash: plan.contentHash }],
        ticket,
      })
    ).toMatchObject({ scanComplete: true });
  };
  return { port, publication, scan, scope, workspace };
}

it('reverifies full workspace manifest and selected-profile coverage after zero-missing VECTOR overlap', async () => {
  const f = overlappingFixture();
  await f.scan(f.workspace);
  await f.scan(f.scope);
  expect(f.publication.getReadiness()).toContainEqual({ scanComplete: false, scope: f.workspace });
  expect(await f.publication.reverifyScope(f.workspace, localProfile)).toBe(true);
  expect(f.publication.getReadiness()).toEqual([
    { scanComplete: true, scope: f.workspace },
    { scanComplete: true, scope: f.scope },
  ]);
  expect(f.port.verifyScopedManifest).toHaveBeenCalledTimes(3);
  expect(f.port.coverageScope).toHaveBeenCalledExactlyOnceWith({
    profile: localProfile,
    scope: f.workspace,
  });
  expect(f.port.prepareScopedFile).toHaveBeenCalledTimes(2);
  expect(f.port.commitScopedFile).toHaveBeenCalledTimes(2);
});

it('cannot reuse a complete source proof after explicit source invalidation', async () => {
  const f = overlappingFixture();
  await f.scan(f.workspace);
  f.publication.invalidateScope(f.workspace);
  expect(await f.publication.reverifyScope(f.workspace, localProfile)).toBe(false);
  expect(f.port.verifyScopedManifest).toHaveBeenCalledTimes(1);
  expect(f.publication.getReadiness()).toContainEqual({ scanComplete: false, scope: f.workspace });
});

it('refuses stale full-scope revalidation when a later mutation races its held native proof', async () => {
  const f = overlappingFixture();
  await f.scan(f.workspace);
  await f.scan(f.scope);
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.port.verifyScopedManifest>>>();
  f.port.verifyScopedManifest.mockReturnValueOnce(held.promise);
  const rechecking = f.publication.reverifyScope(f.workspace, localProfile);
  await vi.waitFor(() => expect(f.port.verifyScopedManifest).toHaveBeenCalledTimes(3));
  await f.scan(f.scope);
  held.resolve({
    authorityEpoch: 'epoch',
    authorityRevision: 1,
    changed: [],
    complete: true,
    missing: [],
    scope: f.workspace,
    storeId,
    unexpected: [],
  });
  expect(await rechecking).toBe(false);
  expect(f.publication.getReadiness()).toContainEqual({ scanComplete: false, scope: f.workspace });
});

describe('main canonical publication ownership', () => {
  it('joins an admitted rootless removal before abort and refuses late writes', async () => {
    const { port, publication } = fixture();
    const held = Promise.withResolvers<boolean>();
    port.removeScopedFile.mockReturnValueOnce(held.promise);
    const ticket = await publication.beginScan({ requestId: 'scan', scope });
    const write = publication.removeFile({ file, ticket });
    await vi.waitFor(() => expect(port.removeScopedFile).toHaveBeenCalledOnce());
    let settled = false;
    const abort = publication.abortScan(ticket).then(() => {
      settled = true;
    });
    await expect(publication.removeFile({ file, ticket })).rejects.toThrow('closed');
    await Promise.resolve();
    expect(settled).toBe(false);
    held.resolve(true);
    await write;
    await abort;
    expect(await publication.finishScan({ ...completion, ticket })).toMatchObject({
      reason: 'aborted',
      scanComplete: false,
    });
    expect(port.removeScopedFile).toHaveBeenCalledWith({ fileId: 'file', scope });
    expect(port.verifyScopedManifest).not.toHaveBeenCalled();
  });

  it('retains a failed write in its receipt even when its caller observed the rejection', async () => {
    const { port, publication } = fixture();
    const cause = new Error('native removal failed');
    port.removeScopedFile.mockRejectedValueOnce(cause);
    const ticket = await publication.beginScan({ requestId: 'scan', scope });
    await expect(publication.removeFile({ file, ticket })).rejects.toBe(cause);
    expect(await publication.finishScan({ ...completion, ticket })).toMatchObject({
      reason: 'write-failed',
      scanComplete: false,
    });
    expect(port.verifyScopedManifest).not.toHaveBeenCalled();
  });

  it('refuses overlapping and consumed tickets and verifies the actual empty collection', async () => {
    const { port, publication } = fixture();
    const ticket = await publication.beginScan({ requestId: 'scan', scope });
    await expect(publication.beginScan({ requestId: 'overlap', scope })).rejects.toThrow('owned');
    expect(await publication.finishScan({ ...completion, ticket })).toMatchObject({
      reason: 'complete',
      scanComplete: true,
    });
    expect(port.verifyScopedManifest).toHaveBeenCalledWith({ files: [], scope });
    await expect(publication.finishScan({ ...completion, ticket })).rejects.toThrow('stale');
    await expect(publication.removeFile({ file, ticket })).rejects.toThrow('stale');
  });

  it('keeps readiness false when cancellation arrives during physical manifest verification', async () => {
    const { port, publication } = fixture();
    const held = Promise.withResolvers<Awaited<ReturnType<typeof port.verifyScopedManifest>>>();
    port.verifyScopedManifest.mockReturnValueOnce(held.promise);
    const ticket = await publication.beginScan({ requestId: 'scan', scope });
    const finish = publication.finishScan({ ...completion, ticket });
    await vi.waitFor(() => expect(port.verifyScopedManifest).toHaveBeenCalledOnce());
    let aborted = false;
    const abort = publication.abortScan(ticket).then(() => {
      aborted = true;
    });
    await Promise.resolve();
    expect(aborted).toBe(false);
    held.resolve({
      authorityEpoch: 'epoch',
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope,
      storeId,
      unexpected: [],
    });
    expect(await finish).toMatchObject({ reason: 'aborted', scanComplete: false });
    await abort;
    expect(publication.getReadiness()).toEqual([{ scanComplete: false, scope }]);
  });
});

it('invalidates an overlapping collection receipt when a workspace mutation is admitted', async () => {
  const { port } = fixture();
  const workspace = { kind: 'workspace', rootId: 'root' } as const;
  const publication = createNativeCanonicalPublication(port, [scope, workspace]);
  const collectionTicket = await publication.beginScan({ requestId: 'collection-complete', scope });
  await publication.finishScan({ ...completion, ticket: collectionTicket });
  expect(publication.getReadiness()[0]?.scanComplete).toBe(true);
  const ticket = await publication.beginScan({ requestId: 'workspace-change', scope: workspace });
  const held = Promise.withResolvers<boolean>();
  port.removeScopedFile.mockReturnValueOnce(held.promise);
  const removing = publication.removeFile({
    file: { ...file, relativePath: 'file.txt', rootId: 'root' },
    ticket,
  });
  expect(publication.getReadiness()[0]?.scanComplete).toBe(false);
  held.resolve(true);
  await removing;
  await publication.abortScan(ticket);
  await publication.finishScan({ ...completion, ticket });
});
