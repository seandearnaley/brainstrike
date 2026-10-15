// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  asDrawerQueryable,
  DRAWER_CHUNK_PAGE_SIZE,
  DRAWER_INCOMPLETE_FILE_LIMIT,
  loadChunksForFile,
  loadIncompleteFiles,
} from '../collection-debug-queries';

function capture() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { database: { query }, query };
}

describe('drawer queries read the queue through its first-class columns', () => {
  /**
   * Regression pin for the review finding: deriving chunk/set identity by
   * splitting `job_queue.dedupe_key` is wrong. The old pipeline builder emitted
   * `embed:<chunkId>:<setId>:<modelKey>`, so `split_part(dedupe_key, ':', 1)`
   * yielded the literal 'embed' — every failure silently read as merely
   * pending. #2364 has since collapsed the rival formats into one canonical
   * `buildEmbedJobDedupeKey` in `@brainstrike/indexing-contract`, but that does
   * NOT make the key parseable: `parseDedupeKey` rejects embedding job keys
   * outright, so the columns stay the only supported route.
   */
  it('never parses dedupe_key', async () => {
    const chunks = capture();
    await loadChunksForFile(chunks.database, 'file-1', 'col-1');
    const incomplete = capture();
    await loadIncompleteFiles(incomplete.database, 'col-1');

    for (const sql of [chunks.query.mock.calls[0]?.[0], incomplete.query.mock.calls[0]?.[0]]) {
      expect(sql).toBeTypeOf('string');
      expect(sql).not.toMatch(/split_part/i);
      expect(sql).not.toMatch(/dedupe_key/i);
    }
  });

  it('matches embed jobs on job_type + chunk_id + embedding_set_id', async () => {
    const chunks = capture();
    await loadChunksForFile(chunks.database, 'file-1', 'col-1');
    const sql = String(chunks.query.mock.calls[0]?.[0]);

    expect(sql).toMatch(/job_type\s*=\s*'embed_chunk'/);
    expect(sql).toMatch(/chunk_id\s*=\s*fc\.id/);
    expect(sql).toMatch(/embedding_set_id/);
    expect(sql).toMatch(/state\s*=\s*'failed'/);
  });

  it('scopes the chunk query failure lookup to the active set, like the file query does', async () => {
    const chunks = capture();
    await loadChunksForFile(chunks.database, 'file-1', 'col-1');

    // The set id must actually be bound, not merely mentioned: a failure
    // recorded against a DIFFERENT embedding set must not mark this chunk.
    expect(chunks.query.mock.calls[0]?.[1]).toContain('col-1');
  });

  it('pages chunks by the declared page size', async () => {
    const { database, query } = capture();
    await loadChunksForFile(database, 'file-1', 'col-1', 2);

    expect(query.mock.calls[0]?.[1]).toEqual([
      'file-1',
      'col-1',
      DRAWER_CHUNK_PAGE_SIZE,
      2 * DRAWER_CHUNK_PAGE_SIZE,
    ]);
  });

  it('bounds the incomplete-file list', async () => {
    const { database, query } = capture();
    await loadIncompleteFiles(database, 'col-1');

    expect(query.mock.calls[0]?.[1]).toEqual(['col-1', DRAWER_INCOMPLETE_FILE_LIMIT]);
  });
});

describe('asDrawerQueryable', () => {
  it('throws on an unusable handle rather than yielding an empty result', () => {
    expect(() => asDrawerQueryable(null)).toThrow(/database query support/i);
    expect(() => asDrawerQueryable({})).toThrow(/database query support/i);
  });
});
