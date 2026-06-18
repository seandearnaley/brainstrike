import { applyManagedCacheBatch, migrate, wasmLoader } from '@brainstrike/db';
import { describe, expect, it } from 'vitest';
import { runWorkspaceIndexStageBenchmark } from '../workspace-index-debug-benchmark';

describe('runWorkspaceIndexStageBenchmark integration', () => {
  it('runs the DB completion ceiling benchmark against real migrated PGlite and cleans up synthetic rows', {
    timeout: 30_000,
  }, async () => {
    const db = await wasmLoader.createPGlite(
      `memory://workspace-index-debug-benchmark-${Date.now()}`
    );
    await migrate(db);

    try {
      const result = await runWorkspaceIndexStageBenchmark({
        db,
        request: {
          chunkCount: 3,
          dimensions: 384,
          mode: 'db-completion-ceiling',
        },
      });

      expect(result).toMatchObject({
        chunkCount: 3,
        completedChunkCount: 3,
        dimensions: 384,
        mode: 'db-completion-ceiling',
      });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(result.chunksPerSecond).toBeGreaterThan(0);

      const leftovers = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
             FROM (
               SELECT id FROM roots WHERE id LIKE 'workspace-index-stage-db-completion-ceiling%'
               UNION ALL
               SELECT id FROM file_records WHERE id LIKE 'workspace-index-stage-db-completion-ceiling%'
               UNION ALL
               SELECT id FROM file_chunks WHERE id LIKE 'workspace-index-stage-db-completion-ceiling%'
               UNION ALL
               SELECT id FROM job_queue WHERE id LIKE 'workspace-index-stage-db-completion-ceiling%'
               UNION ALL
               SELECT id FROM embedding_sets WHERE id LIKE 'workspace-index-stage-db-completion-ceiling%'
             ) synthetic_rows`
      );
      expect(leftovers.rows[0]?.count).toBe('0');
    } finally {
      await db.close();
    }
  });

  it('runs the import ceiling benchmark against real migrated PGlite and cleans up synthetic rows', {
    timeout: 30_000,
  }, async () => {
    const db = await wasmLoader.createPGlite(
      `memory://workspace-index-import-benchmark-${Date.now()}`
    );
    await migrate(db);

    try {
      const result = await runWorkspaceIndexStageBenchmark({
        applyManagedCacheBatch: (args) => applyManagedCacheBatch(db, args),
        db,
        request: {
          chunkCount: 3,
          mode: 'import-ceiling',
        },
      });

      expect(result).toMatchObject({
        chunkCount: 3,
        completedChunkCount: 3,
        dimensions: 0,
        mode: 'import-ceiling',
      });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(result.chunksPerSecond).toBeGreaterThan(0);

      const leftovers = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
             FROM (
               SELECT id FROM roots WHERE id LIKE 'workspace-index-stage-import-ceiling%'
               UNION ALL
               SELECT id FROM file_records WHERE id LIKE 'workspace-index-stage-import-ceiling%'
               UNION ALL
               SELECT id FROM file_chunks WHERE id LIKE 'workspace-index-stage-import-ceiling%'
               UNION ALL
               SELECT embedding_set_id AS id
                 FROM file_chunks
                WHERE embedding_set_id LIKE 'workspace-index-stage-import-ceiling%'
               UNION ALL
               SELECT id FROM job_queue WHERE id LIKE 'workspace-index-stage-import-ceiling%'
               UNION ALL
               SELECT embedding_set_id AS id
                 FROM job_queue
                WHERE embedding_set_id LIKE 'workspace-index-stage-import-ceiling%'
               UNION ALL
               SELECT id FROM embedding_sets WHERE id LIKE 'workspace-index-stage-import-ceiling%'
               UNION ALL
               SELECT embedding_set_id AS id
                 FROM collection_indexing_stats
                WHERE embedding_set_id LIKE 'workspace-index-stage-import-ceiling%'
             ) synthetic_rows`
      );
      expect(leftovers.rows[0]?.count).toBe('0');
    } finally {
      await db.close();
    }
  });
});
