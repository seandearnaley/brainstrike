import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { NodeChunkerOptions } from '@brainstrike/chunking-worker/node';
import type { CanonicalIndexPayload } from '@brainstrike/file-import/canonical-index-publication';
import { type ScopedFilePlan, type VectorProfile, vectorProfileHash } from '@brainstrike/indexer';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalIngestionHost } from '../src/host.js';
import type {
  CanonicalCatalogPort,
  CanonicalInferencePort,
  CanonicalScanRequest,
  CanonicalSourceFile,
  CanonicalSourcePort,
  CanonicalSourceScope,
  CanonicalVectorPublicationPort,
} from '../src/ports.js';

const profile: VectorProfile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'local',
  revision: 'a'.repeat(40),
  tokenCap: 256,
};
const parser: NodeChunkerOptions = { parser: 'oxc' as const, treeSitterLanguages: ['python'] };
const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
function deferred() {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(scope: CanonicalSourceScope = { kind: 'workspace', rootId: 'root' }) {
  const recorded = JSON.parse(
    await readFile(
      new URL('../../indexer/__tests__/fixtures/canonical-provided-chunks.json', import.meta.url),
      'utf8'
    )
  ) as { content: string; fileId: string; relativePath: string; sourceHash: string };
  const file: CanonicalSourceFile = {
    embeddingSetId: scope.kind === 'collection' ? scope.embeddingSetId : 'managed-set',
    fileId: recorded.fileId,
    fileName: 'artifact-reader-model-projection.ts',
    relativePath: scope.kind === 'workspace' ? recorded.relativePath : null,
    rootId: scope.kind === 'workspace' ? scope.rootId : null,
    sourcePath: null,
    stat: { mtimeMs: 123, size: Buffer.byteLength(recorded.content) },
  };
  const request: CanonicalScanRequest = {
    batchSize: 64,
    chunkingOptions: { maxTokens: 256, strategy: 'auto', tokenTrueSizing: true },
    maxFileBytes: 100_000,
    requestId: 'scan',
    scope,
  };
  const ticket = { generation: 1, requestId: request.requestId, scope, storeId: hash('store') };
  const source: CanonicalSourcePort = {
    close: vi.fn(async () => {}),
    async *discover() {
      yield { files: [file], removed: [] };
      return { errors: [], full: true, truncatedDirectories: [] };
    },
    read: vi.fn(async () => ({ content: recorded.content, stat: file.stat })),
  };
  const catalog: CanonicalCatalogPort<VectorProfile> = {
    applyManagedCacheBatch: vi.fn(async () => {}),
    completeFiles: vi.fn(async () => {}),
    loadAuthorizedBatch: vi.fn(async () => [
      { ...file, chunksProcessed: true, contentHash: recorded.sourceHash },
    ]),
    prepareManagedSourcesBatch: vi.fn(async () => []),
    removeFiles: vi.fn(async () => {}),
    resolveProfile: vi.fn(async () => profile),
  };
  const makePlan = (payload: CanonicalIndexPayload): ScopedFilePlan => {
    const { fileName: _name, stat: _stat, ...binding } = file;
    const chunks = payload.providedChunks.map((chunk) => ({
      ...chunk,
      chunkId: hash(`${file.fileId}:${chunk.chunkIndex}`),
      embeddingHash: hash(`${vectorProfileHash(profile)}:${chunk.contentHash}`),
    }));
    return {
      authorityEpoch: hash('epoch'),
      authorityRevision: 1,
      chunks,
      contentHash: hash(payload.content),
      embeddingChunkIds: chunks.map((chunk) => chunk.chunkId),
      previousSnapshotHash: null,
      profile,
      profileHash: vectorProfileHash(profile),
      snapshot: { ...binding, content: payload.content, providedChunks: payload.providedChunks },
      storeId: ticket.storeId,
    };
  };
  const inference: CanonicalInferencePort<VectorProfile> = {
    cancel: vi.fn(async () => {}),
    generate: vi.fn<CanonicalInferencePort<VectorProfile>['generate']>(async (input) => ({
      ...input,
      vectors: input.chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        vector: Array.from({ length: profile.dimensions }, (_, index) => (index === 0 ? 1 : 0)),
      })),
    })),
    join: vi.fn(async () => {}),
  };
  const proof = {
    authorityEpoch: hash('epoch'),
    authorityRevision: 1,
    scope,
    storeId: ticket.storeId,
  };
  const publication: CanonicalVectorPublicationPort = {
    abortScan: vi.fn(async () => {}),
    beginScan: vi.fn(async () => ticket),
    commitTextFile: vi.fn(async () => {}),
    commitVectorFile: vi.fn(async () => {}),
    finishScan: vi.fn<CanonicalVectorPublicationPort['finishScan']>(async (input) => ({
      reason: input.aborted ? 'aborted' : input.errors.length ? 'scan-errors' : 'complete',
      scanComplete: !(input.aborted || input.errors.length) && input.full,
      ticket,
    })),
    prepareVectorFile: vi.fn(async (input) => makePlan(input.payload)),
    removeFile: vi.fn(async () => {}),
    vectorCoverage: vi.fn(async () => ({
      ...proof,
      counts: { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 },
      profile,
      profileHash: vectorProfileHash(profile),
      vectorCoverageComplete: true,
    })),
    verifyManifest: vi.fn(async () => ({
      changed: [],
      complete: true,
      missing: [],
      storeId: ticket.storeId,
      unexpected: [],
    })),
    verifyVectorManifest: vi.fn(async () => ({
      ...proof,
      changed: [],
      complete: true,
      missing: [],
      unexpected: [],
    })),
  };
  const host = new CanonicalIngestionHost({
    catalog,
    inference,
    mode: 'VECTOR',
    parser,
    publication,
    source,
  });
  return {
    catalog,
    file,
    host,
    inference,
    makePlan,
    profile,
    publication,
    recorded,
    request,
    source,
    ticket,
  };
}

describe('explicit canonical TEXT / VECTOR admission', () => {
  it('keeps explicit TEXT free of profile resolution and inference', async () => {
    const f = await fixture();
    const host = new CanonicalIngestionHost({
      catalog: f.catalog,
      mode: 'TEXT',
      parser,
      publication: f.publication,
      source: f.source,
    });
    await host.scan({ ...f.request, forceFileIds: [f.file.fileId] });
    expect(f.publication.commitTextFile).toHaveBeenCalledOnce();
    expect(f.catalog.resolveProfile).not.toHaveBeenCalled();
    expect(f.inference.generate).not.toHaveBeenCalled();
    expect(f.publication.prepareVectorFile).not.toHaveBeenCalled();
    await host.close();
    await f.host.close();
  });
  it.each([
    { kind: 'workspace', rootId: 'root' },
    { embeddingSetId: 'retained', kind: 'collection' },
  ] as const)('repairs unchanged stat-cache gaps in actual %s scope', async (scope) => {
    const f = await fixture(scope);
    try {
      expect((await f.host.scan(f.request)).scanComplete).toBe(true);
      expect(f.source.read).toHaveBeenCalledOnce();
      expect(f.publication.commitTextFile).not.toHaveBeenCalled();
      const preparation = vi.mocked(f.publication.prepareVectorFile).mock.calls[0]?.[0];
      expect(preparation?.file).toEqual(f.file);
      expect(preparation?.payload.content).toBe(f.recorded.content);
      const commit = vi.mocked(f.publication.commitVectorFile).mock.calls[0]?.[0];
      expect(commit?.embeddings.map((entry) => entry.chunkId)).toEqual(
        commit?.plan.embeddingChunkIds
      );
      expect(commit?.profile).toEqual(profile);
      expect(f.inference.join).toHaveBeenCalledTimes(
        vi.mocked(f.inference.generate).mock.calls.length
      );
      expect(f.publication.verifyVectorManifest).toHaveBeenCalledWith({
        files: [
          expect.objectContaining({
            chunks: expect.any(Array),
            contentHash: f.recorded.sourceHash,
            relativePath: f.file.relativePath,
            rootId: f.file.rootId,
          }),
        ],
        scope,
      });
      expect(f.catalog.completeFiles).toHaveBeenCalledOnce();
    } finally {
      await f.host.close();
    }
  });
  it('reuses complete vectors without admitting inference', async () => {
    const f = await fixture();
    vi.mocked(f.publication.prepareVectorFile).mockImplementation(async ({ payload }) => ({
      ...f.makePlan(payload),
      embeddingChunkIds: [],
    }));
    await f.host.scan(f.request);
    expect(f.inference.generate).not.toHaveBeenCalled();
    expect(f.publication.commitVectorFile).toHaveBeenCalledWith(
      expect.objectContaining({ embeddings: [] })
    );
    await f.host.close();
  });
  it.each(['provider', 'distance'] as const)(
    'refuses unsupported saved %s without TEXT degradation',
    async (field) => {
      const f = await fixture();
      vi.mocked(f.catalog.resolveProfile).mockResolvedValue(
        field === 'provider'
          ? { dimensions: 384, distance: 'cosine', modelId: 'saved-hosted', provider: 'openai' }
          : { ...profile, distance: 'l2' }
      );
      await expect(f.host.scan(f.request)).rejects.toThrow('explicitly saved local cosine');
      expect(f.inference.generate).not.toHaveBeenCalled();
      expect(f.publication.commitTextFile).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
      await f.host.close();
    }
  );
  it.each([
    'store',
    'source',
    'scope',
    'profile',
    'duplicate',
    'unknown-missing',
    'metadata',
  ] as const)('refuses malformed native %s plans before inference or completion', async (kind) => {
    const f = await fixture();
    vi.mocked(f.publication.prepareVectorFile).mockImplementation(async ({ payload }) => {
      const plan = f.makePlan(payload);
      if (kind === 'store') {
        return { ...plan, storeId: hash('foreign') };
      }
      if (kind === 'source') {
        return { ...plan, snapshot: { ...plan.snapshot, content: 'foreign' } };
      }
      if (kind === 'scope') {
        return { ...plan, snapshot: { ...plan.snapshot, rootId: 'foreign' } };
      }
      if (kind === 'profile') {
        return { ...plan, profile: { ...profile, revision: 'b'.repeat(40) } };
      }
      if (kind === 'duplicate') {
        return {
          ...plan,
          embeddingChunkIds: [...plan.embeddingChunkIds, plan.embeddingChunkIds[0]!],
        };
      }
      if (kind === 'unknown-missing') {
        return { ...plan, embeddingChunkIds: [hash('unknown')] };
      }
      return { ...plan, chunks: plan.chunks.map((chunk) => ({ ...chunk, tokenCount: 999 })) };
    });
    await expect(f.host.scan(f.request)).rejects.toThrow('Canonical');
    expect(f.inference.generate).not.toHaveBeenCalled();
    expect(f.publication.commitVectorFile).not.toHaveBeenCalled();
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    await f.host.close();
  });
  it.each(['request', 'profile', 'order', 'dimension', 'finite', 'sparse'] as const)(
    'refuses wrong inference %s before native/PG completion',
    async (kind) => {
      const f = await fixture();
      vi.mocked(f.inference.generate).mockImplementation(async (input) => {
        const vectors = input.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          vector: Array.from({ length: profile.dimensions }, () => 1),
        }));
        if (kind === 'order') {
          vectors[0] = { ...vectors[0]!, chunkId: hash('foreign') };
        }
        if (kind === 'dimension') {
          vectors[0] = { ...vectors[0]!, vector: [1] };
        }
        if (kind === 'finite') {
          vectors[0]!.vector[0] = Number.NaN;
        }
        if (kind === 'sparse') {
          Reflect.deleteProperty(vectors, 0);
        }
        return {
          profile: kind === 'profile' ? { ...profile, tokenCap: 512 } : profile,
          requestId: kind === 'request' ? 'stale' : input.requestId,
          vectors,
        };
      });
      await expect(f.host.scan(f.request)).rejects.toThrow('Canonical inference');
      expect(f.inference.cancel).toHaveBeenCalledOnce();
      expect(f.inference.join).toHaveBeenCalledOnce();
      expect(f.publication.commitVectorFile).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
      await f.host.close();
    }
  );
  it('holds cancellation and close through physical inference and join before finish/PG completion', async () => {
    const f = await fixture();
    const physical = deferred();
    const joined = deferred();
    vi.mocked(f.inference.generate).mockImplementation(async (input) => {
      await physical.promise;
      return {
        ...input,
        vectors: input.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          vector: Array.from({ length: 384 }, () => 1),
        })),
      };
    });
    vi.mocked(f.inference.join).mockImplementation(async () => {
      await joined.promise;
    });
    const rejected = expect(f.host.scan(f.request)).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(f.inference.generate).toHaveBeenCalledOnce());
    let closed = false;
    const closing = f.host.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(f.inference.cancel).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    expect(f.publication.finishScan).not.toHaveBeenCalled();
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    physical.resolve();
    await vi.waitFor(() => expect(f.inference.join).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    expect(f.publication.finishScan).not.toHaveBeenCalled();
    joined.resolve();
    await rejected;
    await closing;
    expect(f.publication.commitVectorFile).not.toHaveBeenCalled();
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
  });
  it('holds close through physical vector publication without late PG completion', async () => {
    const f = await fixture();
    const held = deferred();
    vi.mocked(f.publication.commitVectorFile).mockImplementation(async () => {
      await held.promise;
    });
    const rejected = expect(f.host.scan(f.request)).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(f.publication.commitVectorFile).toHaveBeenCalledOnce());
    let closed = false;
    const closing = f.host.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    expect(f.publication.finishScan).not.toHaveBeenCalled();
    held.resolve();
    await rejected;
    await closing;
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
  });
  it.each(['manifest', 'coverage', 'authority', 'profile'] as const)(
    'never publishes ready from a complete receipt with false %s proof',
    async (kind) => {
      const f = await fixture();
      if (kind === 'manifest') {
        vi.mocked(f.publication.verifyVectorManifest).mockResolvedValue({
          authorityEpoch: hash('epoch'),
          authorityRevision: 1,
          changed: [],
          complete: false,
          missing: [],
          scope: f.request.scope,
          storeId: f.ticket.storeId,
          unexpected: [],
        });
      }
      if (kind !== 'manifest') {
        const original = await f.publication.vectorCoverage({ profile, scope: f.request.scope });
        vi.mocked(f.publication.vectorCoverage).mockResolvedValue({
          ...original,
          ...(kind === 'coverage'
            ? { vectorCoverageComplete: false }
            : kind === 'authority'
              ? { authorityRevision: 2 }
              : { profileHash: hash('foreign') }),
        });
      }
      await expect(f.host.scan(f.request)).rejects.toThrow('full current scoped manifest');
      expect(vi.mocked(f.publication.finishScan).mock.calls.at(-1)?.[0].errors).not.toEqual([]);
      await f.host.close();
    }
  );
  it('rejects a saved profile change after inference before native commit', async () => {
    const f = await fixture();
    vi.mocked(f.catalog.resolveProfile)
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce(profile)
      .mockResolvedValue({ ...profile, revision: 'b'.repeat(40) });
    await expect(f.host.scan(f.request)).rejects.toThrow('saved vector profile changed');
    expect(f.publication.commitVectorFile).not.toHaveBeenCalled();
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    await f.host.close();
  });
  it('retains failed physical joins, blocks reuse and retries ownership through close', async () => {
    const f = await fixture();
    const joinFailure = new Error('physical join failed');
    vi.mocked(f.inference.join).mockRejectedValueOnce(joinFailure);
    await expect(f.host.scan(f.request)).rejects.toBe(joinFailure);
    expect(f.publication.finishScan).not.toHaveBeenCalled();
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    await expect(f.host.scan({ ...f.request, requestId: 'replacement' })).rejects.toThrow(
      'still owned'
    );
    await f.host.close();
    expect(f.inference.cancel).toHaveBeenCalledOnce();
    expect(f.inference.join).toHaveBeenCalledTimes(2);
  });
  it('joins cancellation admitted while physical inference join is held', async () => {
    const f = await fixture();
    const joining = deferred();
    const cancellation = deferred();
    vi.mocked(f.inference.join).mockImplementation(async () => {
      await joining.promise;
    });
    vi.mocked(f.inference.cancel).mockImplementation(async () => {
      await cancellation.promise;
    });
    const rejected = expect(f.host.scan(f.request)).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(f.inference.join).toHaveBeenCalledOnce());
    let closed = false;
    const closing = f.host.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(f.inference.cancel).toHaveBeenCalledOnce());
    joining.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.publication.finishScan).not.toHaveBeenCalled();
    cancellation.resolve();
    await rejected;
    await closing;
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
  });
  it('preserves an independent AbortError and failed stop notice during cancellation', async () => {
    const f = await fixture();
    const physical = deferred();
    const independent = new DOMException('independent renderer failure', 'AbortError');
    const notice = new Error('stop notice failed');
    vi.mocked(f.inference.generate).mockImplementation(async () => {
      await physical.promise;
      throw independent;
    });
    vi.mocked(f.inference.cancel).mockRejectedValue(notice);
    const result = f.host.scan(f.request).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.inference.generate).toHaveBeenCalledOnce());
    const cancelling = f.host.cancel(f.request.requestId).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.inference.cancel).toHaveBeenCalledOnce());
    physical.resolve();
    const failure = await result;
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected all independent failures.');
    }
    expect(failure.errors).toContain(independent);
    expect(failure.errors).toContain(notice);
    expect(await cancelling).toBe(failure);
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    await f.host.close();
  });

  it('refuses explicit VECTOR with an unwired inference/publication method before scan admission', async () => {
    const f = await fixture();
    const dependencies = {
      catalog: f.catalog,
      inference: f.inference,
      mode: 'VECTOR' as const,
      parser,
      publication: f.publication,
      source: f.source,
    };
    Reflect.deleteProperty(dependencies.inference, 'generate');
    expect(() => new CanonicalIngestionHost(dependencies)).toThrow(
      'real inference and scoped vector publication'
    );
    expect(f.publication.beginScan).not.toHaveBeenCalled();
    expect(f.catalog.resolveProfile).not.toHaveBeenCalled();
    await f.host.close();
  });
  it('accepts the inference owner successful cancellation disposition without matching AbortError names', async () => {
    const f = await fixture();
    const physical = deferred();
    const ownedReason = new DOMException('native owner cancelled', 'AbortError');
    vi.mocked(f.inference.generate).mockImplementation(async () => {
      await physical.promise;
      throw ownedReason;
    });
    const result = f.host.scan(f.request).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.inference.generate).toHaveBeenCalledOnce());
    const cancelling = f.host.cancel(f.request.requestId);
    await vi.waitFor(() => expect(f.inference.cancel).toHaveBeenCalledOnce());
    physical.resolve();
    await cancelling;
    const reason = await result;
    expect(reason).toBeInstanceOf(DOMException);
    expect(reason).not.toBe(ownedReason);
    expect(f.inference.join).toHaveBeenCalledOnce();
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    await f.host.close();
  });
  it('preserves an independent AbortError through the inference owner joined disposition', async () => {
    const f = await fixture();
    const physical = deferred();
    const independent = new DOMException('independent renderer fault', 'AbortError');
    vi.mocked(f.inference.generate).mockImplementation(async () => {
      await physical.promise;
      throw independent;
    });
    vi.mocked(f.inference.join).mockRejectedValue(independent);
    const result = f.host.scan(f.request).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.inference.generate).toHaveBeenCalledOnce());
    const cancelling = f.host.cancel(f.request.requestId).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.inference.cancel).toHaveBeenCalledOnce());
    physical.resolve();
    expect(await result).toBe(independent);
    expect(await cancelling).toBe(independent);
    expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    await expect(f.host.close()).rejects.toThrow('retirement failed');
    vi.mocked(f.inference.join).mockResolvedValue();
    await f.host.close();
  });
  it.each([undefined, null])(
    'rejects absent runtime profile %s without falling through to TEXT',
    async (missing) => {
      const f = await fixture();
      // Deliberately invalid callback result models a missing reverse-RPC profile.
      vi.mocked(f.catalog.resolveProfile).mockResolvedValue(missing as never);
      await expect(f.host.scan(f.request)).rejects.toThrow();
      expect(f.publication.commitTextFile).not.toHaveBeenCalled();
      expect(f.source.read).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
      await f.host.close();
    }
  );
});
