import type { Migration } from './migration-runner';

/**
 * Embedding job cancellation is on the managed-cache hot path. Do not extract
 * chunk identity from JSON payloads there: large workspace queues need a first
 * class indexed column so file replace/delete work stays bounded.
 */
export const migration042JobQueueChunkId: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_job_queue_active_embed_chunk_id;
    --> statement-breakpoint

    ALTER TABLE job_queue
      DROP COLUMN IF EXISTS chunk_id;
  `,
  name: 'job_queue_chunk_id',
  up: `
    ALTER TABLE job_queue
      ADD COLUMN IF NOT EXISTS chunk_id TEXT;
    --> statement-breakpoint

    UPDATE job_queue
       SET chunk_id = payload->>'chunkId'
     WHERE chunk_id IS NULL
       AND job_type = 'embed_chunk'
       AND payload->>'chunkId' IS NOT NULL;
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_job_queue_active_embed_chunk_id
      ON job_queue(chunk_id)
      WHERE job_type = 'embed_chunk'
        AND chunk_id IS NOT NULL
        AND state IN ('queued','running');
  `,
  version: 42,
};
