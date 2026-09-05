import type { Migration } from './migration-runner';

/**
 * Persist the model-qualified input hash in durable embedding jobs (BST-391).
 *
 * New producers write both fields before enqueue. This migration upgrades valid
 * historical active and retryable jobs so the renderer worker can require the
 * fields without a legacy compute-on-claim path. Jobs whose source identity
 * cannot be proven are canceled visibly and counted instead of being silently
 * guessed or becoming invalid candidates for requeueFailed().
 */
export const migration105EmbeddingJobInputHash: Migration = {
  down: `
    UPDATE job_queue
       SET payload = payload - 'embeddingInputHash' - 'sourceContentHash'
     WHERE job_type = 'embed_chunk'
       AND jsonb_typeof(payload) = 'object';
  `,
  ledgerKey: 'custom-105-embedding-job-input-hash',
  name: 'embedding_job_input_hash',
  up: `
    WITH proven_source AS (
      SELECT
        jq.id,
        fc.content_hash,
        CASE
          WHEN jq.payload->>'modelKey' ~ '^(local|transformers|openai|google|cohere|voyage|ollama|lmstudio)(::|:).+'
          THEN jq.payload->>'modelKey'
          WHEN jq.payload->>'provider' IN ('openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio')
          THEN (jq.payload->>'provider') || '::' || (jq.payload->>'modelKey')
          ELSE NULL
        END AS resolved_model_key
      FROM job_queue AS jq
      JOIN file_chunks AS fc ON fc.id = jq.chunk_id
      WHERE jq.job_type = 'embed_chunk'
        AND jq.state IN ('queued', 'running', 'failed')
        AND jsonb_typeof(jq.payload) = 'object'
        AND NULLIF(jq.payload->>'modelKey', '') IS NOT NULL
        AND NULLIF(fc.content_hash, '') IS NOT NULL
        AND jq.payload->>'chunkId' = jq.chunk_id
        AND COALESCE(NULLIF(jq.payload->>'embeddingSetId', ''), 'none') =
            COALESCE(NULLIF(jq.embedding_set_id, ''), 'none')
        AND jq.dedupe_key =
            jq.chunk_id || ':' || COALESCE(NULLIF(jq.embedding_set_id, ''), 'none') || ':' || fc.content_hash
    )
    UPDATE job_queue AS jq
       SET payload = jsonb_set(
         jsonb_set(
           jq.payload,
           '{sourceContentHash}',
           to_jsonb(proven_source.content_hash),
           true
         ),
         '{embeddingInputHash}',
         to_jsonb(
           encode(
             sha256(convert_to(
               proven_source.content_hash || ':' || proven_source.resolved_model_key,
               'UTF8'
             )),
             'hex'
           )
         ),
         true
       )
      FROM proven_source
     WHERE jq.id = proven_source.id
       AND proven_source.resolved_model_key IS NOT NULL
       AND (
         NOT jq.payload ? 'embeddingInputHash'
         OR NOT jq.payload ? 'sourceContentHash'
       );
    --> statement-breakpoint

    WITH proven_source AS (
      SELECT
        jq.id,
        fc.content_hash,
        CASE
          WHEN jq.payload->>'modelKey' ~ '^(local|transformers|openai|google|cohere|voyage|ollama|lmstudio)(::|:).+'
          THEN jq.payload->>'modelKey'
          WHEN jq.payload->>'provider' IN ('openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio')
          THEN (jq.payload->>'provider') || '::' || (jq.payload->>'modelKey')
          ELSE NULL
        END AS resolved_model_key
      FROM job_queue AS jq
      JOIN file_chunks AS fc ON fc.id = jq.chunk_id
      WHERE jq.job_type = 'embed_chunk'
        AND jq.state IN ('queued', 'running', 'failed')
        AND jsonb_typeof(jq.payload) = 'object'
        AND NULLIF(jq.payload->>'modelKey', '') IS NOT NULL
        AND NULLIF(fc.content_hash, '') IS NOT NULL
        AND jq.payload->>'chunkId' = jq.chunk_id
        AND COALESCE(NULLIF(jq.payload->>'embeddingSetId', ''), 'none') =
            COALESCE(NULLIF(jq.embedding_set_id, ''), 'none')
        AND jq.dedupe_key =
            jq.chunk_id || ':' || COALESCE(NULLIF(jq.embedding_set_id, ''), 'none') || ':' || fc.content_hash
    ), canceled AS (
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
         AND jq.state IN ('queued', 'running', 'failed')
         AND NOT EXISTS (
           SELECT 1
             FROM proven_source
            WHERE proven_source.id = jq.id
              AND proven_source.resolved_model_key IS NOT NULL
              AND jq.payload->>'sourceContentHash' = proven_source.content_hash
              AND jq.payload->>'embeddingInputHash' = encode(
                sha256(convert_to(
                  proven_source.content_hash || ':' || proven_source.resolved_model_key,
                  'UTF8'
                )),
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
