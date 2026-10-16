// @vitest-environment node

import {
  type ScopedFilePlan,
  type ScopedIndexerPort,
  vectorProfileHash,
} from '@brainstrike/indexer';
import { describe, expect, it, vi } from 'vitest';
import type { CanonicalFileIdentity, CanonicalSourceScope } from '../src/ports.js';
import { createNativeCanonicalPublication } from '../src/scoped-publication.js';

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
    coverageBatch: vi.fn(),
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
  return {
    contentHash: plan.contentHash,
    file: rooted,
    plan,
    port,
    publication,
    scan,
    scope,
    workspace,
  };
}

it('projects distinct matching native plans only after commit acknowledgement', async () => {
  const f = overlappingFixture();
  const ticket = await f.publication.beginScan({ requestId: 'ack-progress', scope: f.workspace });
  let acknowledge = (): void => {
    throw new Error('Commit was not admitted');
  };
  f.port.commitScopedFile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      })
  );
  const commit = () =>
    f.publication.commitVectorFile({
      embeddings: [],
      file: f.file,
      plan: f.plan,
      profile: localProfile,
      ticket,
    });
  const pending = commit();
  await vi.waitFor(() => expect(f.port.commitScopedFile).toHaveBeenCalledOnce());
  expect(f.publication.getReadiness()[0]?.publication).toBeUndefined();
  acknowledge();
  await pending;
  expect(f.publication.getReadiness()[0]).toMatchObject({
    publication: {
      acknowledgedFiles: 1,
      authorityEpoch: 'epoch',
      authorityRevision: 1,
      generation: ticket.generation,
      mutationRevision: 1,
      profileHash: vectorProfileHash(localProfile),
      requestId: ticket.requestId,
      storeId,
    },
    scanComplete: false,
  });
  expect(f.publication.getReadiness()[1]?.publication).toBeUndefined();
  await commit();
  expect(f.publication.getReadiness()[0]?.publication?.acknowledgedFiles).toBe(1);
  await f.publication.finishScan({
    ...completion,
    files: [{ ...f.file, contentHash: f.plan.contentHash }],
    ticket,
  });
  expect(f.publication.getReadiness()[0]?.publication?.acknowledgedFiles).toBe(1);
  const replacement = await f.publication.beginScan({
    requestId: 'replacement',
    scope: f.workspace,
  });
  expect(replacement.generation).toBe(ticket.generation + 1);
  expect(f.publication.getReadiness()[0]?.publication).toBeUndefined();
  await expect(commit()).rejects.toThrow(/stale/);
});

it.each(['aborted', 'failed', 'invalidated'] as const)(
  'does not project %s native commit work as publication progress',
  async (mode) => {
    const f = overlappingFixture();
    const ticket = await f.publication.beginScan({ requestId: mode, scope: f.workspace });
    let settle = (): void => {
      throw new Error('Commit was not admitted');
    };
    f.port.commitScopedFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = () =>
            mode === 'failed' ? reject(new Error('native commit failed')) : resolve();
        })
    );
    const pending = f.publication.commitVectorFile({
      embeddings: [],
      file: f.file,
      plan: f.plan,
      profile: localProfile,
      ticket,
    });
    const outcome = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.port.commitScopedFile).toHaveBeenCalledOnce());
    const abort = mode === 'aborted' ? f.publication.abortScan(ticket) : undefined;
    if (mode === 'invalidated') {
      f.publication.invalidateFile(f.file);
    }
    settle();
    await outcome;
    await abort;
    expect(f.publication.getReadiness()[0]?.publication).toBeUndefined();
  }
);

it('keeps ticket identity while acknowledged authority advances from workspace to collection publication', async () => {
  const f = overlappingFixture();
  const workspaceTicket = await f.publication.beginScan({
    requestId: 'workspace',
    scope: f.workspace,
  });
  await f.publication.commitVectorFile({
    embeddings: [],
    file: f.file,
    plan: f.plan,
    profile: localProfile,
    ticket: workspaceTicket,
  });
  const second = { ...f.file, fileId: 'second' };
  const secondPlan = {
    ...f.plan,
    authorityEpoch: 'later-authority',
    authorityRevision: 9,
    chunks: f.plan.chunks.map((chunk) => ({ ...chunk, chunkId: '2'.repeat(64) })),
    snapshot: { ...f.plan.snapshot, fileId: second.fileId },
  };
  await f.publication.commitVectorFile({
    embeddings: [],
    file: second,
    plan: secondPlan,
    profile: localProfile,
    ticket: workspaceTicket,
  });
  const acknowledged = f.publication.getReadiness()[0]?.publication;
  expect(acknowledged).toMatchObject({
    acknowledgedFiles: 2,
    authorityEpoch: 'later-authority',
    authorityRevision: 9,
    generation: workspaceTicket.generation,
    requestId: workspaceTicket.requestId,
  });
  await f.publication.finishScan({
    ...completion,
    files: [
      { ...f.file, contentHash: f.plan.contentHash },
      { ...second, contentHash: secondPlan.contentHash },
    ],
    ticket: workspaceTicket,
  });
  const collectionTicket = await f.publication.beginScan({
    requestId: 'collection',
    scope: f.scope,
  });
  await f.publication.commitVectorFile({
    embeddings: [],
    file: f.file,
    plan: { ...f.plan, authorityEpoch: 'collection-authority', authorityRevision: 10 },
    profile: localProfile,
    ticket: collectionTicket,
  });
  expect(f.publication.getReadiness()[0]?.publication).toEqual(acknowledged);
  expect(f.publication.getReadiness()[0]?.mutationRevision).toBeGreaterThan(
    acknowledged!.mutationRevision
  );
  expect(f.publication.getReadiness()[1]?.publication).toMatchObject({
    acknowledgedFiles: 1,
    authorityEpoch: 'collection-authority',
    authorityRevision: 10,
    generation: collectionTicket.generation,
    requestId: collectionTicket.requestId,
  });
  expect(f.publication.getReadiness().every((entry) => !entry.scanComplete)).toBe(true);
});

it.each(['store', 'profile', 'scope'] as const)(
  'refuses a mismatched %s plan before it can earn progress',
  async (mode) => {
    const f = overlappingFixture();
    const ticket = await f.publication.beginScan({ requestId: mode, scope: f.workspace });
    const plan =
      mode === 'store'
        ? { ...f.plan, storeId: 'foreign' }
        : mode === 'profile'
          ? { ...f.plan, profileHash: 'foreign' }
          : { ...f.plan, snapshot: { ...f.plan.snapshot, rootId: 'foreign' } };
    await expect(
      f.publication.commitVectorFile({
        embeddings: [],
        file: f.file,
        plan,
        profile: localProfile,
        ticket,
      })
    ).rejects.toThrow(/plan|identity|scope/);
    expect(f.port.commitScopedFile).not.toHaveBeenCalled();
    expect(f.publication.getReadiness()[0]?.publication).toBeUndefined();
  }
);

it('discards the removed file plan and overlapping proofs so a returned identity cannot reuse a stat skip', async () => {
  const f = overlappingFixture();
  await f.scan(f.workspace);
  await f.scan(f.scope);
  expect(await f.publication.reverifyScope(f.workspace, localProfile)).toBe(true);
  f.publication.invalidateFile(f.file);
  expect(f.publication.getReadiness().every((scope) => !scope.scanComplete)).toBe(true);
  const file = { ...f.file, contentHash: f.contentHash };
  expect(await f.publication.verifyManifest({ files: [file], scope: f.scope })).toMatchObject({
    complete: false,
    missing: [file],
  });
  expect(await f.publication.reverifyScope(f.workspace, localProfile)).toBe(false);
  expect(await f.publication.reverifyScope(f.scope, localProfile)).toBe(false);
});

it('preserves surviving complete proofs when an already-retired binding is acknowledged again', async () => {
  const f = overlappingFixture();
  await f.scan(f.workspace);
  await f.scan(f.scope);
  expect(await f.publication.reverifyScope(f.workspace, localProfile)).toBe(true);
  f.publication.invalidateFile({ ...f.file, fileId: 'already-retired' });
  expect(f.publication.getReadiness().every((scope) => scope.scanComplete)).toBe(true);
});

it.each(['TEXT', 'VECTOR'] as const)(
  'fences a late %s commit ACK after file invalidation until a new scan republishes',
  async (mode) => {
    const f = overlappingFixture();
    const ticket = await f.publication.beginScan({ requestId: 'before-delete', scope: f.scope });
    const plan = await f.port.prepareScopedFile({});
    if (mode === 'TEXT') {
      f.port.prepareScopedFile.mockResolvedValue({ ...plan, profile: null, profileHash: null });
    }
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const commit = async (): Promise<void> => {
      entered.resolve();
      await held.promise;
    };
    f.port.commitScopedTextFile.mockImplementation(commit);
    f.port.commitScopedFile.mockImplementation(commit);
    const publishing =
      mode === 'TEXT'
        ? f.publication.commitTextFile({
            file: f.file,
            payload: { content: 'canonical', fileId: f.file.fileId, providedChunks: [] },
            ticket,
          })
        : f.publication.commitVectorFile({
            embeddings: [],
            file: f.file,
            plan,
            profile: localProfile,
            ticket,
          });
    const outcome = publishing.catch((error: unknown) => error);
    await entered.promise;
    f.publication.invalidateFile(f.file);
    held.resolve();
    expect(await outcome).toMatchObject({ message: expect.stringContaining('invalidated') });
    const declared = { ...f.file, contentHash: f.contentHash };
    expect(await f.publication.verifyManifest({ files: [declared], scope: f.scope })).toMatchObject(
      { complete: false, missing: [declared] }
    );
    await expect(
      f.publication.commitTextFile({
        file: f.file,
        payload: { content: 'canonical', fileId: f.file.fileId, providedChunks: [] },
        ticket,
      })
    ).rejects.toThrow('invalidated');
    await f.publication.abortScan(ticket);
    await f.publication.finishScan({ ...completion, aborted: true, ticket });
    const next = await f.publication.beginScan({ requestId: 'returned-id', scope: f.scope });
    if (mode === 'TEXT') {
      await f.publication.commitTextFile({
        file: f.file,
        payload: { content: 'canonical', fileId: f.file.fileId, providedChunks: [] },
        ticket: next,
      });
    } else {
      await f.publication.commitVectorFile({
        embeddings: [],
        file: f.file,
        plan,
        profile: localProfile,
        ticket: next,
      });
    }
    expect(await f.publication.verifyManifest({ files: [declared], scope: f.scope })).toMatchObject(
      { complete: true, missing: [] }
    );
  }
);

it('reverifies full workspace manifest and selected-profile coverage after zero-missing VECTOR overlap', async () => {
  const f = overlappingFixture();
  await f.scan(f.workspace);
  await f.scan(f.scope);
  expect(f.publication.getReadiness()).toContainEqual(
    expect.objectContaining({ scanComplete: false, scope: f.workspace })
  );
  expect(await f.publication.reverifyScope(f.workspace, localProfile)).toBe(true);
  expect(f.publication.getReadiness()).toMatchObject([
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
  expect(f.publication.getReadiness()).toContainEqual(
    expect.objectContaining({ scanComplete: false, scope: f.workspace })
  );
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
  expect(f.publication.getReadiness()).toContainEqual(
    expect.objectContaining({ scanComplete: false, scope: f.workspace })
  );
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
    expect(publication.getReadiness()).toMatchObject([{ scanComplete: false, scope }]);
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

it('retains monotonic scan and mutation stamps when readiness returns to the same complete value', async () => {
  const f = overlappingFixture();
  await f.scan(f.workspace);
  const before = f.publication.getReadiness().find((entry) => entry.scope.kind === 'workspace')!;
  await f.scan(f.workspace);
  const after = f.publication.getReadiness().find((entry) => entry.scope.kind === 'workspace')!;
  expect(before.scanComplete).toBe(true);
  expect(after.scanComplete).toBe(true);
  expect(after.generation).toBeGreaterThan(before.generation);
  f.publication.invalidateScope(f.workspace);
  const invalid = f.publication.getReadiness().find((entry) => entry.scope.kind === 'workspace')!;
  expect(invalid.mutationRevision).toBeGreaterThan(after.mutationRevision);
  expect(invalid.scanComplete).toBe(false);
});
