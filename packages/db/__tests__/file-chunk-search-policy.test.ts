import { describe, expect, it, vi } from 'vitest';

import type { FileChunk } from '../src/models/file-chunk.js';
import {
  buildChunkDistanceExpressions,
  buildRawFullTextScopePlan,
  buildRawVectorScopePlan,
  mapVectorSearchRows,
  normalizeChunkSearchScope,
  tsqueryFunctionForMode,
} from '../src/repositories/file-chunk-search-policy.js';

describe('file chunk search policy', () => {
  it('normalizes shared vector and full-text scope inputs once', () => {
    expect(
      normalizeChunkSearchScope({
        filePaths: [' src/a.ts ', '', 'src/a.ts', 'src/b.ts'],
        selectionSnapshotId: ' snapshot-1 ',
      })
    ).toEqual({
      filePaths: ['src/a.ts', 'src/b.ts'],
      selectionSnapshotId: 'snapshot-1',
    });
    expect(normalizeChunkSearchScope({ filePaths: [], selectionSnapshotId: '   ' })).toEqual({
      filePaths: undefined,
      selectionSnapshotId: undefined,
    });
  });

  it('maps every FTS query mode to its canonical Postgres function', () => {
    expect(['plain', 'phrase', 'websearch'].map(tsqueryFunctionForMode)).toEqual([
      'plainto_tsquery',
      'phraseto_tsquery',
      'websearch_to_tsquery',
    ]);
  });

  it.each([
    ['cosine', '<=>', '(1 - (', ' / 2.0))'],
    ['l2', '<->', '(1.0 / (1.0 + (', ')))'],
    ['ip', '<#>', '(1.0 / (1.0 + exp(+(', '))))'],
  ] as const)(
    'plans %s distance expressions for ANN and exact search',
    (distance, operator, similarityPrefix, similaritySuffix) => {
      const ann = buildChunkDistanceExpressions(distance, 768, 'halfvec');
      const exact = buildChunkDistanceExpressions(distance, 768, 'exact');

      expect(ann.orderExpr).toBe(`(embedding::halfvec(768)) ${operator} $1::halfvec(768)`);
      expect(ann.similarityExpr.startsWith(similarityPrefix)).toBe(true);
      expect(ann.similarityExpr).toContain(operator);
      expect(ann.similarityExpr.endsWith(similaritySuffix)).toBe(true);
      expect(exact.orderExpr).toBe(`embedding ${operator} $1::vector(768)`);
      expect(exact.similarityExpr.startsWith(similarityPrefix)).toBe(true);
      expect(exact.similarityExpr).toContain(operator);
      expect(exact.similarityExpr.endsWith(similaritySuffix)).toBe(true);
    }
  );

  it('rejects unsafe dimensions before they can be interpolated into SQL', () => {
    expect(() => buildChunkDistanceExpressions('cosine', 768.5)).toThrow(
      'buildChunkDistanceExpressions dimension must be a positive integer'
    );
    expect(() => buildChunkDistanceExpressions('cosine', 4, 'halfvec', 3)).toThrow(
      'buildChunkDistanceExpressions dimension 4 exceeds maximum 3'
    );
    expect(() => buildChunkDistanceExpressions('cosine', 4)).not.toThrow();
  });

  it('maps chunks only after similarity filtering and limiting', () => {
    const rows = [
      { id: 'below', rank: '1', similarity: '0.4' },
      { id: 'first', rank: '2', similarity: '0.9' },
      { id: 'second', rank: '3', similarity: '0.8' },
      { id: 'not-finite', rank: '4', similarity: 'NaN' },
    ];
    const mapChunk = vi.fn(
      (row: (typeof rows)[number]): FileChunk => ({
        chunkIndex: 0,
        chunkSize: 1,
        chunkType: 'text',
        content: row.id,
        contentHash: `hash-${row.id}`,
        createdAt: '2026-09-18T00:00:00.000Z',
        fileRecordId: 'file-1',
        id: row.id,
        tokenCount: 1,
        updatedAt: '2026-09-18T00:00:00.000Z',
      })
    );

    const results = mapVectorSearchRows(rows, mapChunk, 0.5, 1);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ chunk: { id: 'first' }, rank: 2, similarity: 0.9 });
    expect(mapChunk).toHaveBeenCalledTimes(1);
    expect(mapChunk).toHaveBeenCalledWith(rows[1]);
  });

  it('builds one parameterized vector scope plan for search and bounded counts', () => {
    const scope = {
      chunkType: 'code',
      embeddingSetId: 'set-1',
      filePaths: ['src/a.ts'],
      fileRecordId: 'file-1',
      rootId: 'root-1',
      rootIds: ['root-2', 'root-3'],
      selectionSnapshotId: 'snapshot-1',
    } as const;

    const search = buildRawVectorScopePlan(2, scope);
    const count = buildRawVectorScopePlan(1, scope);

    expect(search.narrowed).toBe(true);
    expect(search.values).toEqual([
      'file-1',
      'code',
      'snapshot-1',
      ['src/a.ts'],
      'root-1',
      ['root-2', 'root-3'],
      'set-1',
    ]);
    expect(search.clauses.join('\n')).toContain('file_record_id = $2');
    expect(search.clauses.join('\n')).toContain('embedding_set_id = $8');
    expect(count.clauses.join('\n')).toContain('file_record_id = $1');
    expect(count.clauses.join('\n')).toContain('embedding_set_id = $7');
  });

  it('does not treat mandatory embedding-set scope as a narrowed search', () => {
    expect(buildRawVectorScopePlan(2, { embeddingSetId: 'set-1' })).toEqual({
      clauses: ['embedding_set_id = $2'],
      narrowed: false,
      values: ['set-1'],
    });
  });

  it('keeps full-text coverage scope and composed allowlists parameterized', () => {
    expect(
      buildRawFullTextScopePlan(3, {
        chunkType: 'text',
        embeddingSetId: 'set-1',
        filePaths: ['a.ts'],
        fileRecordId: 'file-1',
        rootIds: [],
        selectionSnapshotId: 'snapshot-1',
      })
    ).toEqual({
      clauses: [
        'file_record_id = $3',
        'chunk_type = $4',
        '(embedding_set_id = $5 OR (embedding_set_id IS NULL AND file_record_id IN (SELECT id FROM file_records WHERE embedding_set_id = $5)))',
        expect.stringContaining('ssf.snapshot_id = $6'),
        expect.stringContaining('path = ANY($7::text[])'),
        'file_record_id IN (SELECT id FROM file_records WHERE root_id = ANY($8::text[]))',
      ],
      values: ['file-1', 'text', 'set-1', 'snapshot-1', ['a.ts'], []],
    });
  });
});
