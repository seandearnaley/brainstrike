import type { Migration } from './migration-runner';

/**
 * Persist the model-qualified input hash in durable embedding jobs (BST-391).
 *
 * New producers write this field before enqueue. This migration upgrades valid
 * historical jobs so the renderer worker can require the field without a
 * legacy compute-on-claim path. Active jobs whose source identity cannot be
 * proven are canceled visibly and counted instead of being silently guessed.
 */
export const migration105EmbeddingJobInputHash: Migration = {
  down: `
    UPDATE job_queue
       SET payload = payload - 'embeddingInputHash'
     WHERE job_type = 'embed_chunk'
       AND jsonb_typeof(payload) = 'object';
  `,
  name: 'embedding_job_input_hash',
  up: `
    UPDATE job_queue AS jq
       SET payload = jsonb_set(
         jq.payload,
         '{embeddingInputHash}',
         to_jsonb(
           encode(
             sha256(convert_to(fc.content_hash || ':' || (jq.payload->>'modelKey'), 'UTF8')),
             'hex'
           )
         ),
         true
       )
      FROM file_chunks AS fc
     WHERE jq.job_type = 'embed_chunk'
       AND jsonb_typeof(jq.payload) = 'object'
       AND NOT jq.payload ? 'embeddingInputHash'
       AND NULLIF(jq.payload->>'modelKey', '') IS NOT NULL
       AND NULLIF(fc.content_hash, '') IS NOT NULL
       AND fc.id::text = jq.payload->>'chunkId';
    --> statement-breakpoint

    WITH canceled AS (
      UPDATE job_queue AS jq
         SET state = 'canceled',
             leased_until = NULL,
             error = COALESCE(
               jq.error,
               'canceled by migration 105: cannot prove embeddingInputHash'
             ),
             updated_at = to_char(
               CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
       WHERE jq.job_type = 'embed_chunk'
         AND jq.state IN ('queued', 'running')
         AND NOT EXISTS (
           SELECT 1
             FROM file_chunks AS fc
            WHERE fc.id::text = jq.payload->>'chunkId'
              AND NULLIF(jq.payload->>'modelKey', '') IS NOT NULL
              AND NULLIF(fc.content_hash, '') IS NOT NULL
              AND jq.payload->>'embeddingInputHash' = encode(
                sha256(convert_to(fc.content_hash || ':' || (jq.payload->>'modelKey'), 'UTF8')),
                'hex'
              )
         )
       RETURNING jq.queue
    )
    INSERT INTO job_queue_metrics (queue, canceled_total)
    SELECT queue, COUNT(*) FROM canceled GROUP BY queue
    ON CONFLICT (queue) DO UPDATE
      SET canceled_total = job_queue_metrics.canceled_total + EXCLUDED.canceled_total;
  `,
  version: 105,
};
