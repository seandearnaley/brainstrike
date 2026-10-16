import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  openIndexer,
  type ScopedFilePlan,
  type ScopedManifestFile,
  vectorProfileHash,
} from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { Schema } from 'effect';
import { expect, it } from 'vitest';
import { providedChunkSchema } from '../src/contracts.js';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const scope = { embeddingSetId: 'collection', kind: 'collection' } as const;
const profile = {
  dimensions: 1536,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  provider: 'openai',
} as const;
const binding = {
  embeddingSetId: scope.embeddingSetId,
  fileId: 'canonical-import',
  profile,
  relativePath: null,
  rootId: null,
  sourcePath: '/imports/source.txt',
};

function manifestFile(plan: ScopedFilePlan): ScopedManifestFile {
  const { fileId, rootId, relativePath, embeddingSetId, sourcePath } = plan.snapshot;
  return {
    chunks: plan.chunks.map(
      ({ content: _content, embeddingHash: _embeddingHash, ...chunk }) => chunk
    ),
    contentHash: plan.contentHash,
    embeddingSetId,
    fileId,
    relativePath,
    rootId,
    sourcePath,
  };
}

it('verifies complete rootless manifests with exact file/chunk identities through reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-scoped-manifest-'));
  const rooted = {
    ...binding,
    fileId: 'workspace-member',
    relativePath: 'source.txt',
    rootId: 'root',
  };
  const empty = { ...binding, fileId: 'empty-import' };
  const outside = { ...binding, embeddingSetId: 'outside', fileId: 'outside-import' };
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    fileBindings: [binding, rooted, empty, outside],
    rootIds: ['root'],
    scopes: [scope, { embeddingSetId: 'outside', kind: 'collection' }],
  };
  let port = await openIndexer(options, deadlines);
  try {
    const plans: ScopedFilePlan[] = [];
    for (const { profile: _profile, ...file } of [binding, rooted, empty]) {
      plans.push(
        await port.prepareScopedFile({
          snapshot: {
            ...file,
            chunkLines: 1,
            content: file.fileId === empty.fileId ? '' : 'canonical\n',
          },
        })
      );
    }
    const files = plans.map(manifestFile);
    const request = { files, scope };
    expect(await port.verifyScopedManifest(request)).toMatchObject({
      changed: [],
      complete: false,
      missing: files,
      scope,
      unexpected: [],
    });
    await expect(port.verifyScopedManifest({ files: [files[0]], scope })).rejects.toMatchObject({
      code: 'incomplete-manifest',
    });
    await expect(port.verifyScopedManifest({ files: [], scope })).rejects.toMatchObject({
      code: 'incomplete-manifest',
    });
    for (const plan of plans) {
      await port.commitScopedTextFile({ plan });
    }
    const { profile: _outsideProfile, ...foreign } = outside;
    await port.commitScopedTextFile({
      plan: await port.prepareScopedFile({
        snapshot: { ...foreign, chunkLines: 1, content: 'canonical\n' },
      }),
    });
    const verified = await port.verifyScopedManifest(request);
    expect(verified).toMatchObject({
      changed: [],
      complete: true,
      missing: [],
      scope,
      unexpected: [],
    });
    expect(verified.storeId).toBe((await port.info()).storeId);
    const workspace = { kind: 'workspace', rootId: 'root' } as const;
    expect(
      (await port.verifyScopedManifest({ files: [files[1]], scope: workspace })).complete
    ).toBe(true);
    expect(await port.coverageScope({ profile, scope: workspace })).toMatchObject({
      counts: { chunks: 1, indexedFiles: 1, missingVectors: 1, vectors: 0 },
      vectorCoverageComplete: false,
    });
    const batch = await port.coverageBatch([
      { profile, scope: workspace },
      { profile, scope },
    ]);
    expect(batch.map((result) => result.scope)).toEqual([workspace, scope]);
    expect(batch.map((result) => result.counts)).toEqual([
      { chunks: 1, indexedFiles: 1, missingVectors: 1, vectors: 0 },
      { chunks: 2, indexedFiles: 3, missingVectors: 2, vectors: 0 },
    ]);
    expect(batch[0]).toMatchObject({ storeId: verified.storeId });
    expect(batch[1]).toMatchObject({
      authorityEpoch: batch[0]!.authorityEpoch,
      authorityRevision: batch[0]!.authorityRevision,
      storeId: batch[0]!.storeId,
    });
    await expect(
      port.coverageBatch([
        { profile, scope: workspace },
        { profile, scope: { embeddingSetId: 'foreign', kind: 'collection' } },
      ])
    ).rejects.toMatchObject({ code: 'scope-not-authorized' });
    await expect(port.coverageBatch([{ profile, scope, unknown: true }])).rejects.toThrow();
    const wrongChunk = {
      ...files[0]!,
      chunks: [{ ...files[0]!.chunks[0]!, chunkId: '0'.repeat(64) }],
    };
    expect(
      (await port.verifyScopedManifest({ files: [wrongChunk, ...files.slice(1)], scope })).changed
    ).toEqual([wrongChunk]);
    const wrongHash = { ...files[0]!, contentHash: '0'.repeat(64) };
    expect(
      (await port.verifyScopedManifest({ files: [wrongHash, ...files.slice(1)], scope })).changed
    ).toEqual([wrongHash]);
    const missingChunk = { ...files[0]!, chunks: [] };
    expect(
      (await port.verifyScopedManifest({ files: [missingChunk, ...files.slice(1)], scope }))
        .complete
    ).toBe(false);
    await expect(
      port.verifyScopedManifest({ files: [...files, files[0]], scope })
    ).rejects.toThrow();
    await expect(port.verifyScopedManifest({ files, limit: 1, scope })).rejects.toThrow();
    await expect(
      port.verifyScopedManifest({ files, scope: { embeddingSetId: 'foreign', kind: 'collection' } })
    ).rejects.toMatchObject({ code: 'scope-not-authorized' });
    await expect(
      port.verifyScopedManifest({
        files: [{ ...files[0], sourcePath: '/imports/forged.txt' }, ...files.slice(1)],
        scope,
      })
    ).rejects.toMatchObject({ code: 'file-not-authorized' });
    await port.replaceFileBindings([binding, rooted, outside]);
    const extra = await port.verifyScopedManifest({ files: files.slice(0, 2), scope });
    expect(extra).toMatchObject({
      complete: false,
      unexpected: [{ chunks: [], fileId: empty.fileId }],
    });
    await port.close();
    port = await openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines);
    const reopened = await port.verifyScopedManifest(request);
    expect(reopened).toMatchObject({ complete: true, storeId: verified.storeId });
    expect(reopened.authorityEpoch).not.toBe(verified.authorityEpoch);
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('compares every original canonical parser chunk field without depending on descriptor order', async () => {
  const captured = Schema.decodeUnknownSync(
    Schema.Struct({
      content: Schema.String,
      result: Schema.Struct({ chunks: Schema.Array(providedChunkSchema) }),
    })
  )(
    JSON.parse(
      await readFile(
        new URL(
          import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')
        ),
        'utf8'
      )
    )
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-parser-manifest-'));
  const port = await openIndexer(
    {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: [binding],
      rootIds: [],
      scopes: [scope],
    },
    deadlines
  );
  try {
    const { profile: _profile, ...file } = binding;
    const plan = await port.prepareScopedFile({
      snapshot: { ...file, content: captured.content, providedChunks: captured.result.chunks },
    });
    await port.commitScopedTextFile({ plan });
    const manifest = manifestFile(plan);
    expect(
      (
        await port.verifyScopedManifest({
          files: [{ ...manifest, chunks: [...manifest.chunks].reverse() }],
          scope,
        })
      ).complete
    ).toBe(true);
    for (const key of [
      'chunkIndex',
      'chunkSize',
      'startOffset',
      'endOffset',
      'tokenCount',
      'startLine',
      'endLine',
    ] as const) {
      const chunk = manifest.chunks[0]!;
      const changed = {
        ...manifest,
        chunks: [{ ...chunk, [key]: (chunk[key] ?? 0) + 1 }, ...manifest.chunks.slice(1)],
      };
      expect((await port.verifyScopedManifest({ files: [changed], scope })).changed).toEqual([
        changed,
      ]);
    }
    const chunk = manifest.chunks[0]!;
    const changed = {
      ...manifest,
      chunks: [
        { ...chunk, chunkType: chunk.chunkType === 'text' ? 'recursive' : 'text' },
        ...manifest.chunks.slice(1),
      ],
    };
    expect((await port.verifyScopedManifest({ files: [changed], scope })).complete).toBe(false);
    await expect(
      port.verifyScopedManifest({
        files: [{ ...manifest, chunks: [...manifest.chunks, chunk] }],
        scope,
      })
    ).rejects.toThrow();
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('reports complete selected-profile vector coverage independently of full-source manifests and top100', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-scoped-coverage-'));
  const emptyScope = { embeddingSetId: 'empty', kind: 'collection' } as const;
  const missing = { ...binding, fileId: 'unpublished-import' };
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    fileBindings: [binding, missing],
    rootIds: [],
    scopes: [scope, emptyScope],
  };
  const port = await openIndexer(options, deadlines);
  const vector = Array.from({ length: profile.dimensions }, (_, index) => (index === 0 ? 1 : 0));
  try {
    const { profile: _profile, ...file } = binding;
    const snapshot = { ...file, chunkLines: 1, content: 'canonical\n'.repeat(101) };
    const textPlan = await port.prepareScopedFile({ snapshot });
    await port.commitScopedTextFile({ plan: textPlan });
    expect(await port.coverageScope({ scope })).toMatchObject({
      counts: { chunks: 101, indexedFiles: 1, missingVectors: 101, vectors: 0 },
      profile: null,
      profileHash: null,
      vectorCoverageComplete: false,
    });
    expect(await port.coverageScope({ profile, scope })).toMatchObject({
      counts: { chunks: 101, indexedFiles: 1, missingVectors: 101, vectors: 0 },
      profile,
      profileHash: vectorProfileHash(profile),
      vectorCoverageComplete: false,
    });
    const plan = await port.prepareScopedFile({ profile, snapshot });
    await port.commitScopedFile({
      embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
      plan,
      profile,
    });
    const coverage = await port.coverageScope({ profile, scope });
    expect(coverage).toMatchObject({
      counts: { chunks: 101, missingVectors: 0, vectors: 101 },
      vectorCoverageComplete: false,
    });
    await port.replaceFileBindings([binding]);
    expect(await port.coverageScope({ profile, scope })).toMatchObject({
      counts: { chunks: 101, indexedFiles: 1, missingVectors: 0, vectors: 101 },
      vectorCoverageComplete: true,
    });
    const result = await port.searchScopes({
      limit: 100,
      mode: 'vector',
      profile,
      scopes: [scope],
      vector,
    });
    expect(result.hits).toHaveLength(100);
    expect(result.candidatesTruncated).toBe(true);
    expect((await port.coverageScope({ scope })).counts.vectors).toBe(0);
    const large = { ...profile, dimensions: 3072, modelId: 'text-embedding-3-large' };
    await port.replaceFileBindings([{ ...binding, profile: large }]);
    await expect(port.coverageScope({ profile, scope })).rejects.toMatchObject({
      code: 'profile-not-authorized',
    });
    expect(await port.coverageScope({ profile: large, scope })).toMatchObject({
      counts: { chunks: 101, missingVectors: 101, vectors: 0 },
      vectorCoverageComplete: false,
    });
    await port.replaceFileBindings([binding]);
    expect((await port.coverageScope({ profile, scope })).vectorCoverageComplete).toBe(true);
    expect(await port.coverageScope({ profile, scope: emptyScope })).toMatchObject({
      counts: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
      vectorCoverageComplete: false,
    });
    expect((await port.verifyScopedManifest({ files: [], scope: emptyScope })).complete).toBe(true);
    await expect(
      port.coverageScope({ profile, scope: { embeddingSetId: 'foreign', kind: 'collection' } })
    ).rejects.toMatchObject({ code: 'scope-not-authorized' });
    await expect(
      port.coverageScope({ fileIds: [binding.fileId], profile, scope })
    ).rejects.toThrow();
    const corrupt = openConnection(options.dbPath);
    try {
      const id: unknown = corrupt
        .prepare('SELECT pk FROM scoped_vectors ORDER BY pk LIMIT 1')
        .pluck()
        .get();
      if (typeof id !== 'number') {
        throw new TypeError('Expected the actual source vector ID.');
      }
      corrupt.prepare('DELETE FROM scope_vec_1536 WHERE id=?').run(BigInt(id));
    } finally {
      corrupt.close();
    }
    await expect(port.coverageScope({ profile, scope })).rejects.toMatchObject({
      code: 'rebuild-required',
    });
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('rejects changed stored Float32 bytes on every public coverage read', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-scoped-vector-bytes-'));
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    fileBindings: [binding],
    rootIds: [],
    scopes: [scope],
  };
  const port = await openIndexer(options, deadlines);
  try {
    const { profile: _profile, ...file } = binding;
    const plan = await port.prepareScopedFile({
      profile,
      snapshot: { ...file, chunkLines: 1, content: 'canonical\n' },
    });
    await port.commitScopedFile({
      embeddings: plan.embeddingChunkIds.map((chunkId) => ({
        chunkId,
        vector: Array.from({ length: profile.dimensions }, (_, index) => (index === 0 ? 1 : 0)),
      })),
      plan,
      profile,
    });
    expect((await port.coverageScope({ profile, scope })).vectorCoverageComplete).toBe(true);
    const corrupt = openConnection(options.dbPath);
    try {
      const stored: unknown = corrupt.prepare('SELECT emb FROM scoped_vectors').pluck().get();
      if (!(stored instanceof Uint8Array)) {
        throw new TypeError('Expected the actual stored Float32 vector bytes.');
      }
      const valid = Buffer.from(stored);
      const update = corrupt.prepare('UPDATE scoped_vectors SET emb=? WHERE profile_hash=?');
      for (const bits of [
        0x00_00_00_00, 0x80_00_00_00, 0x7f_c0_00_00, 0x7f_80_00_01, 0x7f_80_00_00, 0xff_80_00_00,
      ]) {
        const invalid = Buffer.alloc(valid.byteLength);
        invalid.writeUInt32LE(bits, invalid.byteLength - 4);
        expect(update.run(invalid, vectorProfileHash(profile)).changes).toBe(1);
        await expect(port.coverageScope({ profile, scope })).rejects.toMatchObject({
          code: 'rebuild-required',
          message:
            'Scoped profile/vector storage is invalid: Embedding must remain finite and nonzero as float32.',
        });
        expect(update.run(valid, vectorProfileHash(profile)).changes).toBe(1);
        expect((await port.coverageScope({ profile, scope })).vectorCoverageComplete).toBe(true);
      }
    } finally {
      corrupt.close();
    }
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});
