import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNodeChunker } from '@brainstrike/chunking-worker/node';
import type {
  IndexerPort,
  ScopedIndexerPort,
  ScopedManifestFile,
  VectorProfile,
} from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import type {
  CanonicalCatalogPort,
  CanonicalInferencePort,
  CanonicalPublicationPort,
  CanonicalScanRequest,
  CanonicalSourceFile,
  CanonicalSourcePort,
  CanonicalSourceScope,
  CanonicalVectorPublicationPort,
} from '../src/ports.js';

const { CanonicalIngestionHost } = await import('../dist/index.js');
const { openIndexer } = await import('@brainstrike/indexer');
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
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };

it.each([
  { kind: 'workspace', rootId: 'root' },
  { embeddingSetId: 'retained', kind: 'collection' },
] as const)(
  'publishes bounded cross-file VECTOR through public native scoped writer for %s with controlled inference',
  async (scope: CanonicalSourceScope) => {
    const captured = JSON.parse(
      await readFile(
        new URL(
          import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')
        ),
        'utf8'
      )
    ) as { content: string; fileId: string; relativePath: string };
    // Recorded canonical source enlarged to exercise multiple 1–64 inference batches.
    const content = Array.from({ length: 128 }, (_, index) =>
      captured.content
        .replaceAll(
          'createArtifactReaderModelProjection',
          `createArtifactReaderModelProjection${index}`
        )
        .replaceAll('projectArtifactReaderModelOutput', `projectArtifactReaderModelOutput${index}`)
    ).join('\n');
    const contentHash = createHash('sha256').update(content).digest('hex');
    const file: CanonicalSourceFile = {
      embeddingSetId: scope.kind === 'collection' ? scope.embeddingSetId : 'managed-set',
      fileId: captured.fileId,
      fileName: 'artifact-reader-model-projection.ts',
      relativePath: scope.kind === 'workspace' ? captured.relativePath : null,
      rootId: scope.kind === 'workspace' ? scope.rootId : null,
      sourcePath: '/retained/original.ts',
      stat: { mtimeMs: 123, size: Buffer.byteLength(content) },
    };
    const entries = [
      { content, contentHash, file },
      ...[1, 2].map((index) => ({
        content: captured.content,
        contentHash: createHash('sha256').update(captured.content).digest('hex'),
        file: {
          ...file,
          fileId: `${file.fileId}-${index}`,
          relativePath: file.relativePath ? `small-${index}.ts` : null,
          sourcePath: `/retained/small-${index}.ts`,
          stat: { mtimeMs: 123, size: Buffer.byteLength(captured.content) },
        },
      })),
    ];
    const bindings = entries.map(({ file: current }) => {
      const { fileName: _name, stat: _stat, ...identity } = current;
      return { ...identity, profile };
    });
    const entryFor = (fileId: string) => {
      const entry = entries.find((item) => item.file.fileId === fileId);
      if (!entry) {
        throw new Error('Unexpected canonical native file.');
      }
      return entry;
    };
    const bindingFor = (fileId: string) => {
      const binding = bindings.find((item) => item.fileId === fileId);
      if (!binding) {
        throw new Error('Unexpected canonical native binding.');
      }
      const { profile: _profile, ...identity } = binding;
      return identity;
    };
    const { fileName: _name, stat: _stat, ...binding } = file;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-canonical-vector-'));
    let port: IndexerPort & ScopedIndexerPort = await openIndexer(
      {
        dbPath: path.join(directory, 'index.sqlite'),
        embedding: { indexMode: 'text-only' },
        fileBindings: bindings,
        rootIds: file.rootId ? [file.rootId] : [],
        scopes: [{ embeddingSetId: file.embeddingSetId!, kind: 'collection' }],
      },
      deadlines
    );
    const manifests = new Map<string, ScopedManifestFile>();
    let generation = 0;
    let storeId = (await port.info()).storeId;
    const base: CanonicalPublicationPort = {
      abortScan: vi.fn(async () => {}),
      beginScan: async (request) => ({ ...request, generation: ++generation, storeId }),
      commitTextFile: async ({ file: current, payload }) => {
        const plan = await port.prepareScopedFile({
          snapshot: {
            ...bindingFor(current.fileId),
            content: payload.content,
            providedChunks: payload.providedChunks,
          },
        });
        await port.commitScopedTextFile({ plan, syntax: payload.syntax });
      },
      finishScan: async (request) => ({
        reason: request.aborted ? 'aborted' : request.errors.length ? 'scan-errors' : 'complete',
        scanComplete:
          !(request.aborted || request.errors.length) &&
          request.full &&
          !request.truncatedDirectories.length,
        ticket: request.ticket,
      }),
      removeFile: async ({ file: removed }) => {
        await port.removeScopedFile({ fileId: removed.fileId, scope });
      },
      verifyManifest: async ({ files }) => ({
        changed: [],
        complete: false,
        missing: files,
        storeId,
        unexpected: [],
      }),
    };
    const publication: CanonicalVectorPublicationPort = {
      ...base,
      commitVectorFile: async ({ plan, embeddings, profile: selected, syntax }) => {
        await port.commitScopedFile({ embeddings, plan, profile: selected, syntax });
        manifests.set(plan.snapshot.fileId, {
          ...bindingFor(plan.snapshot.fileId),
          chunks: plan.chunks.map(({ content: _text, embeddingHash: _hash, ...chunk }) => chunk),
          contentHash: plan.contentHash,
        });
      },
      prepareVectorFile: async ({ file: current, payload, profile: selected }) =>
        port.prepareScopedFile({
          profile: selected,
          snapshot: {
            ...bindingFor(current.fileId),
            content: payload.content,
            providedChunks: payload.providedChunks,
          },
        }),
      vectorCoverage: async (request) => port.coverageScope(request),
      verifyVectorManifest: async (request) => port.verifyScopedManifest(request),
    };
    const catalog: CanonicalCatalogPort<VectorProfile> = {
      applyManagedCacheBatch: async () => {},
      completeFiles: vi.fn(async () => {}),
      loadAuthorizedBatch: async ({ files }) =>
        files.map((current) => {
          const entry = entryFor(current.fileId);
          return { ...entry.file, chunksProcessed: true, contentHash: entry.contentHash };
        }),
      prepareManagedSourcesBatch: async () => [],
      removeFiles: async () => {},
      resolveProfile: async () => profile,
    };
    const source: CanonicalSourcePort = {
      close: async () => {},
      async *discover() {
        yield { files: entries.map((entry) => entry.file), removed: [] };
        return { errors: [], full: true, truncatedDirectories: [] };
      },
      read: vi.fn(async (current) => {
        const entry = entryFor(current.fileId);
        return { content: entry.content, stat: entry.file.stat };
      }),
    };
    const inference: CanonicalInferencePort<VectorProfile> = {
      cancel: vi.fn(async () => {}),
      generate: vi.fn<CanonicalInferencePort<VectorProfile>['generate']>(async (input) => ({
        ...input,
        vectors: input.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          vector: Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0)),
        })),
      })),
      join: vi.fn(async () => {}),
    };
    const request: CanonicalScanRequest = {
      batchSize: 64,
      chunkingOptions: { maxTokens: 64, strategy: 'auto', tokenTrueSizing: true },
      maxFileBytes: 1_000_000,
      requestId: 'text-scan',
      scope,
    };
    const textHost = new CanonicalIngestionHost({
      catalog,
      chunker,
      mode: 'TEXT',
      publication,
      source,
    });
    const vectorHost = new CanonicalIngestionHost({
      catalog,
      chunker,
      inference,
      mode: 'VECTOR',
      publication,
      source,
    });
    try {
      await textHost.scan(request);
      expect(inference.generate).not.toHaveBeenCalled();
      expect((await port.coverageScope({ profile, scope })).vectorCoverageComplete).toBe(false);
      expect((await vectorHost.scan({ ...request, requestId: 'vector-scan' })).scanComplete).toBe(
        true
      );
      const batches = vi.mocked(inference.generate).mock.calls.map(([input]) => input);
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.every((batch) => batch.chunks.length > 0 && batch.chunks.length <= 64)).toBe(
        true
      );
      expect(new Set(batches.map((batch) => batch.requestId)).size).toBe(batches.length);
      expect(
        batches.every((batch) => JSON.stringify(batch.profile) === JSON.stringify(profile))
      ).toBe(true);
      const manifest = [...manifests.values()];
      expect(manifest.map((entry) => entry.fileId)).toEqual(
        entries.map((entry) => entry.file.fileId)
      );
      const owners = new Map(
        manifest.flatMap((entry) =>
          entry.chunks.map((chunk) => [chunk.chunkId, entry.fileId] as const)
        )
      );
      expect(
        batches.some(
          (batch) => new Set(batch.chunks.map((chunk) => owners.get(chunk.chunkId))).size > 1
        )
      ).toBe(true);
      expect(batches.flatMap((batch) => batch.chunks.map((chunk) => chunk.chunkId))).toEqual(
        manifest.flatMap((entry) => entry.chunks.map((chunk) => chunk.chunkId))
      );
      expect(await port.verifyScopedManifest({ files: manifest, scope })).toMatchObject({
        complete: true,
      });
      expect(await port.coverageScope({ profile, scope })).toMatchObject({
        counts: { missingVectors: 0 },
        vectorCoverageComplete: true,
      });
      const calls = batches.length;
      await vectorHost.scan({ ...request, requestId: 'covered-scan' });
      expect(inference.generate).toHaveBeenCalledTimes(calls);
      await port.close();
      port = await openIndexer(
        {
          dbPath: path.join(directory, 'index.sqlite'),
          embedding: { indexMode: 'open-existing' },
          fileBindings: bindings,
          rootIds: file.rootId ? [file.rootId] : [],
          scopes: [{ embeddingSetId: file.embeddingSetId!, kind: 'collection' }],
        },
        deadlines
      );
      storeId = (await port.info()).storeId;
      expect((await port.verifyScopedManifest({ files: manifest, scope })).complete).toBe(true);
      expect((await port.coverageScope({ profile, scope })).vectorCoverageComplete).toBe(true);
      await port.replaceFileBindings([
        ...bindings,
        { ...binding, fileId: 'authorized-but-undiscovered', profile },
      ]);
      await expect(vectorHost.scan({ ...request, requestId: 'incomplete-scope' })).rejects.toThrow(
        'manifest'
      );
      await port.replaceFileBindings(bindings);
      for (const entry of entries) {
        await port.removeScopedFile({ fileId: entry.file.fileId, scope });
      }
      const completed = vi.mocked(catalog.completeFiles).mock.calls.length;
      let changedAuthority = false;
      vi.mocked(inference.generate).mockImplementation(async (input) => {
        if (!changedAuthority) {
          changedAuthority = true;
          await port.replaceFileBindings(bindings);
        }
        return {
          ...input,
          vectors: input.chunks.map((chunk) => ({
            chunkId: chunk.chunkId,
            vector: Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0)),
          })),
        };
      });
      await expect(vectorHost.scan({ ...request, requestId: 'stale-native-plan' })).rejects.toThrow(
        'authority changed'
      );
      expect(catalog.completeFiles).toHaveBeenCalledTimes(completed);
      expect((await port.coverageScope({ profile, scope })).vectorCoverageComplete).toBe(false);
    } finally {
      await textHost.close();
      await vectorHost.close();
      await port.close();
      await rm(directory, { force: true, recursive: true });
    }
  }
);
