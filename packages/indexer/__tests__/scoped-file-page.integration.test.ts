import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { providedChunkSchema } from '../src/contracts.js';

const recording = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.String,
    fileId: Schema.String,
    result: Schema.Struct({ chunks: Schema.Array(providedChunkSchema) }),
  })
)(
  JSON.parse(
    readFileSync(new URL('./fixtures/canonical-provided-chunks.json', import.meta.url), 'utf8')
  )
);
const scope = { embeddingSetId: 'library', kind: 'collection' } as const;
const binding = {
  embeddingSetId: 'library',
  fileId: recording.fileId,
  profile: null,
  relativePath: null,
  rootId: null,
  sourcePath: '/import/recorded.ts',
};
const { profile: _profile, ...source } = binding;
test('paged native Library reads preserve all recorded chunks and refuse foreign or changed source authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-library-page-'));
  const port = await openIndexer(
    {
      dbPath: join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: [binding],
      rootIds: [],
      scopes: [scope],
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  try {
    const plan = await port.prepareScopedFile({
      snapshot: { ...source, content: recording.content, providedChunks: recording.result.chunks },
    });
    await port.commitScopedTextFile({ plan });
    const first = await port.readScopedFilePage({
      contentHash: plan.contentHash,
      fileId: binding.fileId,
      limit: 1,
      offset: 0,
      scope,
    });
    const chunks = [...first.chunks];
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = await port.readScopedFilePage({
        contentHash: plan.contentHash,
        fileId: binding.fileId,
        limit: 1,
        offset,
        scope,
        snapshotHash: first.snapshotHash,
      });
      chunks.push(...page.chunks);
      offset = page.nextOffset;
    }
    expect(first.total).toBe(plan.chunks.length);
    expect(chunks.map(({ vector: _vector, ...chunk }) => chunk)).toEqual(
      plan.chunks.map(({ embeddingHash: _hash, ...chunk }) => chunk)
    );
    expect(chunks.every((chunk) => chunk.vector === null)).toBe(true);
    await expect(
      port.readScopedFilePage({
        contentHash: plan.contentHash,
        fileId: binding.fileId,
        limit: 1,
        offset: 0,
        scope: { embeddingSetId: 'foreign', kind: 'collection' },
      })
    ).rejects.toThrow();
    await expect(
      port.readScopedFilePage({
        contentHash: 'f'.repeat(64),
        fileId: binding.fileId,
        limit: 1,
        offset: 0,
        scope,
      })
    ).rejects.toThrow();
    await expect(
      port.readScopedFilePage({
        contentHash: plan.contentHash,
        fileId: binding.fileId,
        limit: 1,
        offset: 1,
        scope,
        snapshotHash: 'f'.repeat(64),
      })
    ).rejects.toThrow();

    const profile = {
      dimensions: 384,
      distance: 'cosine',
      dtype: 'fp16',
      modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
      provider: 'local',
      revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
      tokenCap: 256,
    } as const;
    await port.replaceFileBindings([{ ...binding, profile }]);
    const vectorPlan = await port.prepareScopedFile({
      profile,
      snapshot: { ...source, content: recording.content, providedChunks: recording.result.chunks },
    });
    const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    await port.commitScopedFile({
      embeddings: vectorPlan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
      plan: vectorPlan,
      profile,
    });
    const vectorPage = await port.readScopedFilePage({
      contentHash: plan.contentHash,
      fileId: binding.fileId,
      limit: 100,
      offset: 0,
      scope,
    });
    expect(vectorPage.chunks.map((chunk) => chunk.vector)).toEqual(
      vectorPlan.chunks.map(() => ({ dimensions: 384, values: vector }))
    );
    await expect(
      port.readScopedFilePage({
        contentHash: plan.contentHash,
        fileId: binding.fileId,
        limit: 1,
        offset: 0,
        profileHash: null,
        scope,
      })
    ).rejects.toThrow();
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test('chunk bounds give each bound file its stored line ranges, and an unwritten file is not indexed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-chunk-bounds-'));
  const pending = { ...binding, fileId: `${recording.fileId}-pending`, sourcePath: '/import/b.ts' };
  const port = await openIndexer(
    {
      dbPath: join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: [binding, pending],
      rootIds: [],
      scopes: [scope],
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  try {
    const plan = await port.prepareScopedFile({
      snapshot: { ...source, content: recording.content, providedChunks: recording.result.chunks },
    });
    await port.commitScopedTextFile({ plan });

    const bounds = await port.readScopedFileChunkBounds({
      fileIds: [pending.fileId, binding.fileId],
      scope,
    });
    expect(bounds.files).toEqual([
      { fileId: pending.fileId, kind: 'not-indexed' },
      {
        chunks: plan.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          contentHash: chunk.contentHash,
          endLine: chunk.endLine,
          startLine: chunk.startLine,
          tokenCount: chunk.tokenCount,
        })),
        contentHash: plan.contentHash,
        fileId: binding.fileId,
        kind: 'indexed',
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
    // The same scope and binding authorization as a Library page.
    await expect(
      port.readScopedFileChunkBounds({
        fileIds: [binding.fileId],
        scope: { embeddingSetId: 'foreign', kind: 'collection' },
      })
    ).rejects.toThrow();
    await expect(
      port.readScopedFileChunkBounds({ fileIds: ['unbound-file'], scope })
    ).rejects.toThrow();
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});
