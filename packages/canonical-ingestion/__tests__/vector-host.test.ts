import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createNodeChunker } from '@brainstrike/chunking-worker/node';
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
const chunker = createNodeChunker({ parser: 'oxc' });
const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
function deferred() {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  scope: CanonicalSourceScope = { kind: 'workspace', rootId: 'root' },
  selectedProfile: VectorProfile = profile
) {
  const profile = selectedProfile;
  const recorded = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')
      ),
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
  const makePlan = (
    payload: CanonicalIndexPayload,
    currentFile: CanonicalSourceFile = file
  ): ScopedFilePlan => {
    const { fileName: _name, stat: _stat, ...binding } = currentFile;
    const chunks = payload.providedChunks.map((chunk) => ({
      ...chunk,
      chunkId: hash(`${currentFile.fileId}:${chunk.chunkIndex}`),
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
    chunker,
    inference,
    mode: 'VECTOR',
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
      chunker,
      mode: 'TEXT',
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
    'preserves supported saved %s through the canonical vector path',
    async (field) => {
      const selected: VectorProfile =
        field === 'provider'
          ? { dimensions: 384, distance: 'cosine', modelId: 'saved-hosted', provider: 'openai' }
          : { ...profile, distance: 'l2' };
      const f = await fixture(undefined, selected);
      await f.host.scan(f.request);
      expect(f.inference.generate).toHaveBeenCalledWith(
        expect.objectContaining({ profile: selected })
      );
      expect(f.publication.commitVectorFile).toHaveBeenCalledWith(
        expect.objectContaining({ profile: selected })
      );
      expect(f.publication.commitTextFile).not.toHaveBeenCalled();
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
      chunker,
      inference: f.inference,
      mode: 'VECTOR' as const,
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

async function batchFixture(
  inputs: readonly {
    readonly content?: string;
    readonly copies?: number;
    readonly reused?: boolean;
  }[],
  scope: CanonicalSourceScope = { kind: 'workspace', rootId: 'root' },
  split = inputs.length
) {
  const f = await fixture(scope);
  const files = inputs.map((input, index) => {
    const content =
      input.content ??
      Array.from({ length: input.copies ?? 1 }, (_, copy) =>
        f.recorded.content
          .replaceAll(
            'createArtifactReaderModelProjection',
            `createArtifactReaderModelProjection${copy}`
          )
          .replaceAll('projectArtifactReaderModelOutput', `projectArtifactReaderModelOutput${copy}`)
      ).join('\n');
    return {
      content,
      file: {
        ...f.file,
        fileId: `file-${index}`,
        relativePath: scope.kind === 'workspace' ? `file-${index}.ts` : null,
        stat: { mtimeMs: index + 1, size: Buffer.byteLength(content) },
      },
      reused: input.reused ?? false,
    };
  });
  f.source.discover = async function* () {
    for (let offset = 0; offset < files.length; offset += split) {
      yield { files: files.slice(offset, offset + split).map((entry) => entry.file), removed: [] };
    }
    return { errors: [], full: true, truncatedDirectories: [] };
  };
  vi.mocked(f.source.read).mockImplementation(async (file) => {
    if (!('fileId' in file)) {
      throw new Error('Unexpected discovered source in registered fixture.');
    }
    const entry = files.find((item) => item.file.fileId === file.fileId);
    if (!entry) {
      throw new Error('Unexpected source file.');
    }
    return { content: entry.content, stat: entry.file.stat };
  });
  vi.mocked(f.catalog.loadAuthorizedBatch).mockImplementation(async ({ files: selected }) =>
    selected.map((file) => {
      const entry = files.find((item) => item.file.fileId === file.fileId);
      if (!entry) {
        throw new Error('Unexpected catalog file.');
      }
      return { ...entry.file, chunksProcessed: true, contentHash: hash(entry.content) };
    })
  );
  vi.mocked(f.publication.prepareVectorFile).mockImplementation(async ({ file, payload }) => {
    const entry = files.find((item) => item.file.fileId === file.fileId);
    if (!entry) {
      throw new Error('Unexpected publication file.');
    }
    const plan = f.makePlan(payload, entry.file);
    return entry.reused ? { ...plan, embeddingChunkIds: [] } : plan;
  });
  vi.mocked(f.inference.generate).mockImplementation(async (input) => ({
    ...input,
    vectors: input.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      vector: Array.from({ length: profile.dimensions }, (_, index) =>
        index === 0 ? Number.parseInt(chunk.chunkId.slice(0, 6), 16) + 1 : 0
      ),
    })),
  }));
  return { ...f, files };
}

describe('bounded ordered cross-file vector inference', () => {
  it.each([
    { kind: 'workspace', rootId: 'root' },
    { embeddingSetId: 'retained', kind: 'collection' },
  ] as const)(
    'groups small files within one %s discovery batch and routes complete vectors in order',
    async (scope) => {
      const f = await batchFixture([{}, {}], scope);
      try {
        const receipt = await f.host.scan(f.request);
        expect(receipt.scanComplete).toBe(true);
        const plans = vi.mocked(f.publication.prepareVectorFile).mock.results;
        const prepared = await Promise.all(plans.map((result) => result.value));
        expect(prepared.every((plan) => plan.embeddingChunkIds.length > 0)).toBe(true);
        const expectedIds = prepared.flatMap((plan) => plan.embeddingChunkIds);
        expect(expectedIds.length).toBeLessThanOrEqual(64);
        expect(f.inference.generate).toHaveBeenCalledOnce();
        expect(
          vi.mocked(f.inference.generate).mock.calls[0]?.[0].chunks.map((chunk) => chunk.chunkId)
        ).toEqual(expectedIds);
        const commits = vi
          .mocked(f.publication.commitVectorFile)
          .mock.calls.map(([commit]) => commit);
        expect(commits.map((commit) => commit.file.fileId)).toEqual(
          f.files.map((entry) => entry.file.fileId)
        );
        for (const [index, commit] of commits.entries()) {
          expect(commit.ticket).toEqual(f.ticket);
          expect(commit.profile).toEqual(profile);
          expect(commit.plan).toEqual(prepared[index]);
          expect(commit.embeddings).toEqual(
            commit.plan.embeddingChunkIds.map((chunkId) => ({
              chunkId,
              vector: Array.from({ length: 384 }, (_, position) =>
                position === 0 ? Number.parseInt(chunkId.slice(0, 6), 16) + 1 : 0
              ),
            }))
          );
          expect(commit.syntax).toEqual(
            vi.mocked(f.publication.prepareVectorFile).mock.calls[index]?.[0].payload.syntax
          );
        }
        expect(f.inference.join).toHaveBeenCalledOnce();
        expect(f.catalog.completeFiles).toHaveBeenCalledAfter(
          vi.mocked(f.publication.commitVectorFile)
        );
        expect(f.publication.finishScan).toHaveBeenCalledAfter(vi.mocked(f.catalog.completeFiles));
        expect(
          vi
            .mocked(f.publication.verifyVectorManifest)
            .mock.calls[0]?.[0].files.map((file) => file.fileId)
        ).toEqual(f.files.map((entry) => entry.file.fileId));
      } finally {
        await f.host.close();
      }
    }
  );
  it('keeps separate discovery batches separate even under the same scan owner', async () => {
    const f = await batchFixture([{}, {}], undefined, 1);
    try {
      await f.host.scan(f.request);
      expect(f.inference.generate).toHaveBeenCalledTimes(2);
      const commits = vi
        .mocked(f.publication.commitVectorFile)
        .mock.calls.map(([commit]) => commit);
      for (const [index, [input]] of vi.mocked(f.inference.generate).mock.calls.entries()) {
        expect(input.chunks.map((chunk) => chunk.chunkId)).toEqual(
          commits[index]?.plan.embeddingChunkIds
        );
      }
      expect(f.catalog.completeFiles).toHaveBeenCalledTimes(2);
    } finally {
      await f.host.close();
    }
  });

  it('bounds transport requests and preserves empty, reused and oversized file ordering', async () => {
    const f = await batchFixture([
      { content: '' },
      { reused: true },
      { copies: 40 },
      {},
      { content: '' },
      {},
    ]);
    try {
      expect((await f.host.scan({ ...f.request, maxFileBytes: 1_000_000 })).scanComplete).toBe(
        true
      );
      const commits = vi
        .mocked(f.publication.commitVectorFile)
        .mock.calls.map(([commit]) => commit);
      expect(commits.map((commit) => commit.file.fileId)).toEqual(
        f.files.map((entry) => entry.file.fileId)
      );
      expect(commits[0]?.plan.chunks).toEqual([]);
      expect(commits[1]?.plan.embeddingChunkIds).toEqual([]);
      expect(commits[2]?.plan.embeddingChunkIds.length).toBeGreaterThan(64);
      const calls = vi.mocked(f.inference.generate).mock.calls.map(([input]) => input);
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every((input) => input.chunks.length > 0 && input.chunks.length <= 64)).toBe(
        true
      );
      expect(calls.flatMap((input) => input.chunks.map((chunk) => chunk.chunkId))).toEqual(
        commits.flatMap((commit) => commit.plan.embeddingChunkIds)
      );
      for (const commit of commits) {
        expect(commit.embeddings.map((embedding) => embedding.chunkId)).toEqual(
          commit.plan.embeddingChunkIds
        );
      }
      const noMissing = commits.filter((commit) => commit.plan.embeddingChunkIds.length === 0);
      expect(noMissing).toHaveLength(3);
      expect(noMissing.every((commit) => commit.embeddings.length === 0)).toBe(true);
      expect(f.inference.join).toHaveBeenCalledTimes(calls.length);
    } finally {
      await f.host.close();
    }
  });

  it('does not publish a partial oversized file when a later inference segment fails', async () => {
    const f = await batchFixture([{ copies: 40 }, {}]);
    const generate = vi.mocked(f.inference.generate).getMockImplementation();
    if (!generate) {
      throw new Error('Expected controlled inference.');
    }
    vi.mocked(f.inference.generate)
      .mockImplementationOnce(generate)
      .mockRejectedValue(new Error('second inference failed'));
    try {
      await expect(f.host.scan({ ...f.request, maxFileBytes: 1_000_000 })).rejects.toThrow(
        'second inference failed'
      );
      expect(f.inference.generate).toHaveBeenCalledTimes(2);
      expect(f.inference.cancel).toHaveBeenCalledOnce();
      expect(f.inference.join).toHaveBeenCalledTimes(2);
      expect(f.publication.commitVectorFile).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
      expect(vi.mocked(f.publication.finishScan).mock.calls.at(-1)?.[0].errors).not.toEqual([]);
    } finally {
      await f.host.close();
    }
  });

  it('rechecks the saved profile after grouped inference before any file commit', async () => {
    const f = await batchFixture([{}, {}]);
    const generate = vi.mocked(f.inference.generate).getMockImplementation();
    if (!generate) {
      throw new Error('Expected controlled inference.');
    }
    vi.mocked(f.inference.generate).mockImplementation(async (input) => {
      const result = await generate(input);
      vi.mocked(f.catalog.resolveProfile).mockResolvedValue({
        ...profile,
        revision: 'b'.repeat(40),
      });
      return result;
    });
    try {
      await expect(f.host.scan(f.request)).rejects.toThrow('saved vector profile changed');
      expect(f.inference.generate).toHaveBeenCalledOnce();
      expect(f.inference.join).toHaveBeenCalledOnce();
      expect(f.publication.commitVectorFile).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });

  it('retains grouped inference ownership through cancellation and physical join without publication', async () => {
    const f = await batchFixture([{}, {}]);
    const physical = deferred();
    const joined = deferred();
    const generate = vi.mocked(f.inference.generate).getMockImplementation();
    if (!generate) {
      throw new Error('Expected controlled inference.');
    }
    vi.mocked(f.inference.generate).mockImplementation(async (input) => {
      await physical.promise;
      return generate(input);
    });
    vi.mocked(f.inference.join).mockImplementation(async () => {
      await joined.promise;
    });
    const rejected = expect(f.host.scan(f.request)).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(f.inference.generate).toHaveBeenCalledOnce());
    const plans = await Promise.all(
      vi.mocked(f.publication.prepareVectorFile).mock.results.map((result) => result.value)
    );
    expect(
      vi.mocked(f.inference.generate).mock.calls[0]?.[0].chunks.map((chunk) => chunk.chunkId)
    ).toEqual(plans.flatMap((plan) => plan.embeddingChunkIds));
    let closed = false;
    const closing = f.host.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(f.inference.cancel).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
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

  it('keeps a completed prefix file intact while refusing a later partial file and PG completion', async () => {
    const f = await batchFixture([{}, { copies: 40 }]);
    const generate = vi.mocked(f.inference.generate).getMockImplementation();
    if (!generate) {
      throw new Error('Expected controlled inference.');
    }
    vi.mocked(f.inference.generate)
      .mockImplementationOnce(generate)
      .mockRejectedValue(new Error('later grouped inference failed'));
    try {
      await expect(f.host.scan({ ...f.request, maxFileBytes: 1_000_000 })).rejects.toThrow(
        'later grouped inference failed'
      );
      expect(f.publication.commitVectorFile).toHaveBeenCalledOnce();
      const commit = vi.mocked(f.publication.commitVectorFile).mock.calls[0]?.[0];
      expect(commit?.file.fileId).toBe(f.files[0]?.file.fileId);
      expect(commit?.embeddings.map((vector) => vector.chunkId)).toEqual(
        commit?.plan.embeddingChunkIds
      );
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
      expect(vi.mocked(f.publication.finishScan).mock.calls.at(-1)?.[0].errors).not.toEqual([]);
    } finally {
      await f.host.close();
    }
  });

  it('refuses a wrong vector for a later file in a grouped response before publishing the earlier file', async () => {
    const f = await batchFixture([{}, {}]);
    const generate = vi.mocked(f.inference.generate).getMockImplementation();
    if (!generate) {
      throw new Error('Expected controlled inference.');
    }
    vi.mocked(f.inference.generate).mockImplementation(async (input) => {
      const result = await generate(input);
      return {
        ...result,
        vectors: result.vectors.map((vector, index) =>
          index === result.vectors.length - 1 ? { ...vector, chunkId: hash('foreign') } : vector
        ),
      };
    });
    try {
      await expect(f.host.scan(f.request)).rejects.toThrow('Canonical inference');
      expect(f.inference.cancel).toHaveBeenCalledOnce();
      expect(f.inference.join).toHaveBeenCalledOnce();
      expect(f.publication.commitVectorFile).not.toHaveBeenCalled();
      expect(f.catalog.completeFiles).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });
});
