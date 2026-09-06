import type { Migration } from './migration-runner';

/**
 * Scoped embedding backfill/status queries are on the hot path during large
 * workspace indexing. Keep embedding-set identity indexed instead of extracting
 * it from JSON payloads for every queue poll/reconciliation pass.
 */
export const migration043JobQueueEmbeddingSetId: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_job_queue_embed_set_state;
    --> statement-breakpoint

    ALTER TABLE job_queue
      DROP COLUMN IF EXISTS embedding_set_id;
  `,
  ledgerKey: 'custom-043-job-queue-embedding-set-id',
  name: 'job_queue_embedding_set_id',
  up: `
    ALTER TABLE job_queue
      ADD COLUMN IF NOT EXISTS embedding_set_id TEXT;
    --> statement-breakpoint

    UPDATE job_queue
       SET embedding_set_id = payload->>'embeddingSetId'
     WHERE embedding_set_id IS NULL
       AND job_type = 'embed_chunk'
       AND payload->>'embeddingSetId' IS NOT NULL;
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_job_queue_embed_set_state
      ON job_queue(queue, job_type, embedding_set_id, state, updated_at)
      WHERE job_type = 'embed_chunk'
        AND embedding_set_id IS NOT NULL;
  `,
  version: 43,
};
