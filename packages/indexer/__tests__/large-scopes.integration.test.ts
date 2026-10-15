import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IndexFileBinding, IndexScope, ScopedFilePlan } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDesktopIndex, openDesktopIndexReader } from '../src/desktop-index-connection.js';
import { IndexReader, IndexWriter } from '../src/store.js';

const profile = {
  dimensions: 1536,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  provider: 'openai',
} as const;
const collection = { embeddingSetId: 'large', kind: 'collection' } as const;
const modes = ['bm25', 'trigram', 'vector'] as const;
const queryVector = Array.from({ length: profile.dimensions }, (_, index) => (index === 0 ? 1 : 0));

function nativeVariableLimit(): number {
  const db = openConnection(':memory:');
  try {
    const option: unknown = db
      .prepare(
        "SELECT compile_options FROM pragma_compile_options WHERE compile_options LIKE 'MAX_VARIABLE_NUMBER=%'"
      )
      .pluck()
      .get();
    if (typeof option !== 'string') {
      throw new TypeError('Native driver did not report its variable limit.');
    }
    const limit = Number(option.split('=')[1]);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Native driver variable limit is invalid.');
    }
    return limit;
  } finally {
    db.close();
  }
}

describe('native scoped searches above the SQLite variable limit', () => {
  let directory: string;
  let writer: IndexWriter;
  let reader: IndexReader;
  let inventory: IndexFileBinding[];
  let largeScopes: IndexScope[];
  let target: IndexFileBinding;
  let variableLimit: number;
  const published = new Map<string, ScopedFilePlan>();

  beforeAll(async () => {
    variableLimit = nativeVariableLimit();
    // Reproduce the reviewed defect with a real catalog-shaped inventory above the driver limit.
    inventory = Array.from({ length: variableLimit + 2 }, (_, index) => ({
      embeddingSetId: collection.embeddingSetId,
      fileId: `canonical-file-${index}`,
      profile,
      relativePath: null,
      rootId: null,
      sourcePath: `/imports/file-${index}.txt`,
    }));
    target = inventory.at(-1)!;
    largeScopes = [
      collection,
      ...Array.from({ length: variableLimit + 1 }, (_, index) => ({
        kind: 'workspace' as const,
        rootId: `authorized-root-${index}`,
      })),
    ];
    const revoked = { ...target, fileId: 'revoked-file' };
    const outside = { ...target, embeddingSetId: 'outside', fileId: 'outside-file' };
    directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-large-scopes-'));
    const options = {
      dbPath: path.join(directory, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      fileBindings: [...inventory, revoked, outside],
      rootIds: [],
      scopes: [...largeScopes, { embeddingSetId: 'outside', kind: 'collection' }],
    };
    writer = new IndexWriter(options, openDesktopIndex(options));
    for (const [binding, content, vector] of [
      [
        inventory[0]!,
        'canonical secondary material\n',
        queryVector.map((_, i) => (i === 1 ? 1 : 0)),
      ],
      [target, 'canonical\n', queryVector],
      [revoked, 'canonical\n'.repeat(105), queryVector],
      [outside, 'canonical\n'.repeat(105), queryVector],
    ] as const) {
      const { profile: _profile, ...snapshot } = binding;
      const plan = writer.scoped.prepare({
        profile,
        snapshot: { ...snapshot, chunkLines: 1, content },
      });
      writer.scoped.commitVector({
        embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
        plan,
        profile,
      });
      published.set(binding.fileId, plan);
    }
    reader = new IndexReader(options, openDesktopIndexReader(options));
    expect(reader.db.pragma('query_only', { simple: true })).toBe(1);
    writer.scoped.replaceBindings([...inventory, outside]);
    reader.scoped.replaceBindings([...inventory, outside]);
  });

  afterAll(async () => {
    reader?.db.close();
    writer?.db.close();
    if (directory) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  function search(
    mode: (typeof modes)[number],
    scopes: readonly IndexScope[],
    fileIds?: readonly string[]
  ): ReturnType<IndexReader['scoped']['search']> {
    return reader.scoped.search({
      ...(fileIds ? { fileIds } : {}),
      limit: 1,
      mode,
      scopes,
      ...(mode === 'vector' ? { profile, vector: queryVector } : { text: 'canonical' }),
    });
  }

  it.each(modes)('validates and ranks the full large inventory for %s', (mode) => {
    expect(inventory.length).toBeGreaterThan(variableLimit);
    const result = search(mode, [collection]);
    expect(result.hits.map((hit) => hit.fileId)).toEqual([target.fileId]);
    expect(result.scanLimited).toBe(false);
    if (mode === 'vector') {
      // Over 200 perfect-match revoked/outside vectors must be excluded before top100.
      expect(result.candidateCount).toBe(2);
      expect(result.candidatesTruncated).toBe(false);
    }
  });

  it.each(modes)('applies an explicit file filter above the variable limit for %s', (mode) => {
    const fileIds = inventory.slice(1).map((file) => file.fileId);
    expect(fileIds.length).toBeGreaterThan(variableLimit);
    const result = search(mode, [collection], fileIds);
    expect(result.hits.map((hit) => hit.fileId)).toEqual([target.fileId]);
    expect(result.candidateCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it.each(modes)('applies complete large scope and file lists for %s', (mode) => {
    expect(largeScopes.length).toBeGreaterThan(variableLimit);
    const result = search(
      mode,
      largeScopes,
      inventory.slice(1).map((file) => file.fileId)
    );
    expect(result.hits.map((hit) => hit.fileId)).toEqual([target.fileId]);
    expect(result.candidateCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('checks changed binding metadata beyond the variable limit in every mode', () => {
    reader.scoped.replaceBindings(
      inventory.map((file) =>
        file.fileId === target.fileId ? { ...file, sourcePath: '/imports/replaced.txt' } : file
      )
    );
    try {
      for (const mode of modes) {
        expect(() => search(mode, [collection])).toThrow(
          expect.objectContaining({ code: 'file-ownership-changed' })
        );
      }
    } finally {
      reader.scoped.replaceBindings(inventory);
    }
  });

  it('verifies full manifests and actual profile coverage above the variable limit', () => {
    const files = inventory.map(({ profile: _profile, ...file }) => {
      const plan = published.get(file.fileId);
      return {
        ...file,
        chunks:
          plan?.chunks.map(({ content: _content, embeddingHash: _hash, ...chunk }) => chunk) ?? [],
        contentHash: plan?.contentHash ?? '0'.repeat(64),
      };
    });
    const manifest = reader.scoped.verifyManifest({ files, scope: collection });
    expect(manifest.complete).toBe(false);
    expect(manifest.missing).toHaveLength(inventory.length - 2);
    expect(manifest.changed).toEqual([]);
    expect(manifest.unexpected.map((file) => file.fileId)).toEqual(['revoked-file']);
    expect(reader.scoped.coverage({ profile, scope: collection })).toMatchObject({
      counts: { chunks: 2, indexedFiles: 2, missingVectors: 0, vectors: 2 },
      vectorCoverageComplete: false,
    });
  });
});
