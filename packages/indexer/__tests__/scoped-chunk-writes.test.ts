import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { scopedFileChunks, sha256 } from '../src/chunks.js';
import { providedChunkSchema, type ScopedFileSnapshot } from '../src/contracts.js';
import { ScopedIndex } from '../src/scoped-store.js';
import { sqliteVecEngine } from '../src/vector-engine.js';

const recording = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.String,
    fileId: Schema.String,
    relativePath: Schema.String,
    result: Schema.Struct({ chunks: Schema.Array(providedChunkSchema) }),
  })
)(
  JSON.parse(
    readFileSync(
      new URL(
        import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')
      ),
      'utf8'
    )
  )
);
const profile = {
  dimensions: 384,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  provider: 'openai',
} as const;
const binding = {
  embeddingSetId: 'collection',
  fileId: recording.fileId,
  profile,
  relativePath: recording.relativePath,
  rootId: 'root',
  sourcePath: null,
};
const snapshot = {
  ...binding,
  content: recording.content,
  profile: undefined,
  providedChunks: recording.result.chunks,
};
const { profile: _profile, ...canonicalSnapshot } = snapshot;
const chunks = scopedFileChunks(canonicalSnapshot, null);

function writer(
  change: Record<string, unknown> = {},
  missingVectors = false,
  source: ScopedFileSnapshot = canonicalSnapshot
) {
  const storedChunks = scopedFileChunks(source, null);
  const rows = storedChunks.map((chunk, index) => ({
    ...chunk,
    fileId: binding.fileId,
    id: chunk.chunkId,
    pk: index + 1,
    rootId: source.rootId,
    ...(index === 0 ? change : {}),
  }));
  const chunkWrites = vi.fn();
  const vectorWrites = vi.fn();
  const coarseWrites = vi.fn();
  const syntax = {
    replace: vi.fn(() => ({
      syntaxStatus: 'retained' as const,
      writtenRefs: 0,
      writtenSymbols: 0,
    })),
    validate: vi.fn(),
  };
  const prepare = (sql: string) => {
    const statement = {
      all: (..._args: unknown[]): unknown[] => {
        if (sql.includes('FROM scoped_vectors v JOIN file_chunks')) {
          return missingVectors
            ? []
            : storedChunks.map((chunk) => ({
                chunkId: chunk.chunkId,
                contentHash: chunk.contentHash,
              }));
        }
        if (sql.includes('FROM scoped_vectors WHERE chunk_pk=')) {
          return [];
        }
        if (sql.includes('FROM file_chunks WHERE file_record_id=')) {
          const fields = sql
            .slice(7, sql.indexOf(' FROM '))
            .split(',')
            .map((column) => column.trim().split(' AS ').at(-1)!);
          return rows.map((row: Record<string, unknown>) =>
            Object.fromEntries(fields.map((field) => [field, row[field]]))
          );
        }
        throw new Error(`Unexpected all: ${sql}`);
      },
      get: (...args: unknown[]): unknown => {
        if (sql.startsWith('SELECT epoch')) {
          return 'a'.repeat(64);
        }
        if (sql.includes('FROM index_metadata')) {
          return {
            schemaVersion: 16,
            storeId: 'b'.repeat(64),
          };
        }
        if (sql.includes('FROM file_records WHERE id=')) {
          return {
            contentHash: sha256(source.content),
            embeddingSetId: binding.embeddingSetId,
            rootId: source.rootId,
            scoped: 1,
            snapshotHash: sha256(JSON.stringify(source)),
          };
        }
        if (sql.startsWith('INSERT INTO file_chunks')) {
          chunkWrites(...args);
          return { pk: rows.find((row) => row.id === args[0])!.pk };
        }
        if (sql.startsWith('INSERT INTO scoped_vectors')) {
          vectorWrites(...args);
          return { pk: 10 + Number(args[0]) };
        }
        throw new Error(`Unexpected get: ${sql}`);
      },
      pluck: () => statement,
      run: (...args: unknown[]): void => {
        if (sql.startsWith('INSERT INTO scope_vec_')) {
          coarseWrites(...args);
        } else if (
          !(
            sql.startsWith('INSERT INTO file_records') ||
            sql.startsWith('INSERT INTO vector_profiles') ||
            sql.startsWith('DELETE FROM scoped_vectors')
          )
        ) {
          throw new Error(`Unexpected run: ${sql}`);
        }
      },
    };
    return statement;
  };
  const db = {
    exec: vi.fn(),
    prepare,
    transaction: <T>(work: () => T): (() => T) => work,
  } as unknown as Database.Database;
  const index = new ScopedIndex(
    db,
    {
      dbPath: '/unused',
      embedding: { indexMode: 'text-only' },
      fileBindings: [
        {
          ...binding,
          relativePath: source.relativePath,
          rootId: source.rootId,
          sourcePath: source.sourcePath,
        },
      ],
      rootIds: ['root'],
      scopes: [{ embeddingSetId: 'collection', kind: 'collection' }],
    },
    sqliteVecEngine,
    syntax
  );
  return { chunkWrites, coarseWrites, index, syntax, vectorWrites };
}

describe('scoped chunk write admission through the real commit path', () => {
  it('does not update equal actual chunk rows, while still replacing supplied syntax', () => {
    const { index, chunkWrites, syntax } = writer();
    const { storeId } = index.prepare({ snapshot: canonicalSnapshot });
    index.commitTexts({
      files: [{ snapshot: canonicalSnapshot, syntax: { refs: [], symbols: [] } }],
      storeId,
    });
    expect(chunkWrites).not.toHaveBeenCalled();
    expect(syntax.validate).toHaveBeenCalled();
    expect(syntax.replace).toHaveBeenCalledWith({ refs: [], symbols: [] }, binding.fileId, false);
  });

  it.each([
    { startLine: 2 },
    { endLine: 5 },
    { content: 'different stored bytes' },
    { contentHash: 'c'.repeat(64) },
    { chunkIndex: 3 },
    { chunkSize: 512 },
    { chunkType: 'text' },
    { startOffset: 1 },
    { endOffset: 201 },
    { tokenCount: 40 },
    { rootId: null },
  ])('updates a row differing in %j even with the same snapshot hash', (change) => {
    const { index, chunkWrites } = writer(change);
    const { storeId } = index.prepare({ snapshot: canonicalSnapshot });
    index.commitTexts({ files: [{ snapshot: canonicalSnapshot }], storeId });
    expect(chunkWrites).toHaveBeenCalledTimes(1);
  });

  it('compares nullable root and line-policy metadata exactly', () => {
    const { providedChunks: _chunks, ...source } = canonicalSnapshot;
    const rootless = {
      ...source,
      chunkLines: 1,
      relativePath: null,
      rootId: null,
      sourcePath: '/imports/source.ts',
    };
    const { index, chunkWrites } = writer({}, false, rootless);
    const { storeId } = index.prepare({ snapshot: rootless });
    index.commitTexts({ files: [{ snapshot: rootless }], storeId });
    expect(chunkWrites).not.toHaveBeenCalled();
  });

  it('inserts every missing current-profile vector using unchanged chunk PKs', () => {
    const { index, chunkWrites, vectorWrites, coarseWrites } = writer({}, true);
    const plan = index.prepare({ profile, snapshot: canonicalSnapshot });
    index.commitVector({
      embeddings: plan.embeddingChunkIds.map((chunkId) => ({
        chunkId,
        vector: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
      })),
      plan,
      profile,
    });
    expect(chunkWrites).not.toHaveBeenCalled();
    expect(vectorWrites.mock.calls.map((call) => call[0])).toEqual([1, 2]);
    expect(coarseWrites).toHaveBeenCalledTimes(chunks.length);
  });

  it('retains covered vector and coarse rows without rewriting chunks', () => {
    const { index, chunkWrites, vectorWrites, coarseWrites } = writer();
    const plan = index.prepare({ profile, snapshot: canonicalSnapshot });
    expect(plan.embeddingChunkIds).toEqual([]);
    index.commitVector({ embeddings: [], plan, profile });
    expect(chunkWrites).not.toHaveBeenCalled();
    expect(vectorWrites).not.toHaveBeenCalled();
    expect(coarseWrites).not.toHaveBeenCalled();
  });

  it('refuses a plan after binding replacement before any chunk write', () => {
    const { index, chunkWrites } = writer();
    const plan = index.prepare({ profile, snapshot: canonicalSnapshot });
    index.replaceBindings([binding]);
    expect(() => index.commitVector({ embeddings: [], plan, profile })).toThrow(
      'Canonical binding authority changed'
    );
    expect(chunkWrites).not.toHaveBeenCalled();
  });
});
