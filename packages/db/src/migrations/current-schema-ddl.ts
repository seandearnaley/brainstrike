/**
 * Brainstrike current-schema DDL: the whole schema in one step.
 *
 * THIS FILE IS THE SCHEMA'S SOURCE OF TRUTH. To change the schema, EDIT IT
 * HERE, then run `pnpm --filter @brainstrike/db db:schema:ddl` to normalize
 * what you wrote and `db:schema:catalog` to regenerate the fixture it is held
 * to. Editing `src/schema/index.ts` alone changes NOTHING about the shipped
 * schema -- that file is the deliberately drifted drizzle model used for typed
 * query building, and `db:generate` is blocked (ADR-0002).
 *
 * `db:schema:ddl` NORMALIZES rather than authors: it boots this DDL, reads the
 * catalogs back and re-emits them, so a hand edit survives and comes back in
 * the engine's canonical spelling (`VARCHAR(64)` becomes
 * `character varying(64)`). A correct file is a fixed point of that round
 * trip. It cannot invent a change you did not write here.
 *
 * This is what production applies at boot (via migrations/001-current-schema.ts).
 * It replaced a 151-step incremental chain whose only remaining job was to
 * construct this schema (ADR-0020: the product is greenfield, so there is no
 * migration history worth replaying). The schema is held to the catalog
 * readback of the database that chain built, frozen in
 * __tests__/fixtures/schema-catalog.snapshot.txt; changing this file without
 * regenerating that snapshot fails
 * __tests__/current-schema-catalog.integration.test.ts.
 */

/** sha256 of {@link CURRENT_SCHEMA_DDL}; the schema's ledger identity. */
// Pre-wrapped: the key is longer than the formatter's line width, so emitting it
// on one line would make a freshly generated file fail `biome check` until a
// `--fix` pass rewrote it. Regeneration has to be clean on its own.
export const CURRENT_SCHEMA_LEDGER_KEY =
  'custom-current-schema-b201d5d71414b77e72b6477925497a84f23a31b9709c002d6da25109247aa73b';

export const CURRENT_SCHEMA_DDL = `-- EXTENSIONS (3)
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pg_textsearch";

-- FUNCTION PRIVILEGES (4)
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep_for(interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep_until(timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;

-- SEQUENCES (1)
CREATE SEQUENCE "brainstrike_mind_ops_seq_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 NO CYCLE;

-- TABLES (55)
CREATE TABLE "brainstrike_assistant_message_parents" (
  "message_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "parent_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_assistant_message_tombstones" (
  "message_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "rewind_id" text NOT NULL,
  "revert_id" text,
  "tombstoned_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_assistant_native_runs" (
  "native_run_id" text NOT NULL,
  "host_run_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_assistant_prompt_manifests" (
  "id" text NOT NULL,
  "host_run_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "kind" text NOT NULL,
  "native_run_id" text,
  "parent_tool_call_id" text,
  "persona_id" text,
  "provider" text,
  "model" text,
  "system_context_source" text NOT NULL,
  "system_messages" jsonb NOT NULL,
  "persona_instructions" text,
  "delegation_prompt" text,
  "tool_names" jsonb NOT NULL,
  "total_chars" integer NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_assistant_run_errors" (
  "run_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "code" text NOT NULL,
  "message" text,
  "cause_chain" jsonb,
  "http_status" integer,
  "provider_request_id" text,
  "response_headers" jsonb,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_assistant_run_events" (
  "id" text NOT NULL,
  "run_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "label" text NOT NULL,
  "detail" text,
  "duration_ms" integer,
  "metadata" jsonb,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
CREATE TABLE "brainstrike_assistant_run_outcomes" (
  "run_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "verdict" text NOT NULL,
  "source" text NOT NULL,
  "detail" text,
  "labeled_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_assistant_run_treatments" (
  "run_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "experiment_id" text,
  "variant" text,
  "injection_status" text NOT NULL,
  "signal_injected" boolean NOT NULL,
  "signal_content_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_assistant_run_usage" (
  "id" text NOT NULL,
  "thread_id" text NOT NULL,
  "run_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "model" text NOT NULL,
  "provider" text NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "root_id" text,
  "billed_cost_usd" numeric(24,12),
  "cache_read_input_tokens" integer,
  "cache_creation_input_tokens" integer,
  "run_kind" text DEFAULT 'chat'::text NOT NULL
);
CREATE TABLE "brainstrike_assistant_thread_groups" (
  "id" text NOT NULL,
  "resource_id" text NOT NULL,
  "name" text NOT NULL,
  "rank" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "color" text,
  "icon" text
);
CREATE TABLE "brainstrike_assistant_thread_placements" (
  "thread_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "group_id" text,
  "rank" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "flat_rank" text
);
CREATE TABLE "brainstrike_assistant_thread_runs" (
  "id" text NOT NULL,
  "resource_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "model_settings" jsonb,
  "provider_options" jsonb,
  "runtime_kind" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "started_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "turn_message_id" text,
  "generation_run_id" text
);
CREATE TABLE "brainstrike_assistant_thread_workspaces" (
  "thread_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_assistant_tool_output_artifacts" (
  "id" text DEFAULT (uuidv7())::text NOT NULL,
  "resource_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "run_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "format" text NOT NULL,
  "content" bytea NOT NULL,
  "byte_length" bigint NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "execution_thread_id" text NOT NULL
);
CREATE TABLE "brainstrike_diagnostic_events" (
  "id" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "severity" text NOT NULL,
  "source" text NOT NULL,
  "scope" text,
  "code" text,
  "message" text NOT NULL,
  "stack" text,
  "cause_chain" jsonb,
  "context" jsonb,
  "fingerprint" text NOT NULL,
  "session_id" text NOT NULL,
  "run_id" text,
  "thread_id" text,
  "resource_id" text,
  "root_id" text,
  "app_version" text NOT NULL,
  "platform" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_forge_prs" (
  "repo_common_dir" text NOT NULL,
  "branch" text NOT NULL,
  "number" integer,
  "url" text,
  "title" text,
  "state" text,
  "is_draft" boolean,
  "review_decision" text,
  "checks_json" jsonb,
  "head_sha" text,
  "observed_at" timestamp with time zone NOT NULL
);
CREATE TABLE "brainstrike_mcp_task_authorities" (
  "authority_epoch" uuid DEFAULT uuidv7() NOT NULL,
  "server_id" text NOT NULL,
  "resource" text NOT NULL,
  "principal_id" text NOT NULL,
  "runtime_id" text NOT NULL,
  "connection_generation" bigint NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "retired_at" timestamp with time zone
);
CREATE TABLE "brainstrike_mcp_tasks" (
  "server_id" text NOT NULL,
  "resource" text NOT NULL,
  "principal_id" text NOT NULL,
  "task_id" text NOT NULL,
  "status" text NOT NULL,
  "status_message" text,
  "input_metadata" jsonb,
  "result_metadata" jsonb,
  "history" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "terminal_at" timestamp with time zone,
  "authority_epoch" uuid NOT NULL,
  "blocked_diagnostic" jsonb
);
CREATE TABLE "brainstrike_mind_ops" (
  "seq" bigint DEFAULT nextval('brainstrike_mind_ops_seq_seq'::regclass) NOT NULL,
  "entity_kind" text NOT NULL,
  "entity_id" text NOT NULL,
  "op" text NOT NULL,
  "resource_id" text,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_thread_message_index" (
  "message_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "role" text NOT NULL,
  "content_text" text DEFAULT ''::text NOT NULL,
  "content_hash" text NOT NULL,
  "content_tsvector" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content_text)) STORED,
  "message_created_at" timestamp with time zone NOT NULL,
  "embedding" vector(384),
  "embedding_profile_id" text,
  "embedding_error" text,
  "embedding_updated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE "brainstrike_thread_search_profiles" (
  "id" text NOT NULL,
  "model_id" text NOT NULL,
  "model_key" text NOT NULL,
  "dimensions" integer NOT NULL,
  "distance" text DEFAULT 'cosine'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE "brainstrike_thread_search_state" (
  "thread_id" text NOT NULL,
  "last_activity_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE "brainstrike_token_estimate_calibration" (
  "id" text NOT NULL,
  "thread_id" text NOT NULL,
  "run_id" text NOT NULL,
  "model" text NOT NULL,
  "provider" text NOT NULL,
  "estimated_prompt_tokens" integer NOT NULL,
  "final_step_prompt_tokens" integer NOT NULL,
  "step_count" integer DEFAULT 1 NOT NULL,
  "model_visible_projection_count" integer DEFAULT 0 NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_domain_budget_tokens" integer,
  "resolved_transport_budget_tokens" integer,
  "prompt_baseline_tokens" integer
);
CREATE TABLE "brainstrike_tool_call_telemetry" (
  "id" text NOT NULL,
  "thread_id" text NOT NULL,
  "run_id" text NOT NULL,
  "tool_id" text NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "model_facing_chars" integer NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "zero_match" boolean,
  "is_pagination_followup" boolean DEFAULT false NOT NULL,
  "engine" text,
  "scan_limited" boolean DEFAULT false NOT NULL,
  "candidates_truncated" boolean DEFAULT false NOT NULL
);
CREATE TABLE "brainstrike_workspace_snapshots" (
  "id" text NOT NULL,
  "thread_id" text NOT NULL,
  "run_id" text,
  "root_id" text NOT NULL,
  "root_path" text NOT NULL,
  "commit_oid" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "brainstrike_worktrees" (
  "id" text NOT NULL,
  "repo_common_dir" text NOT NULL,
  "path" text NOT NULL,
  "branch" text,
  "base_ref" text NOT NULL,
  "created_by" text NOT NULL,
  "thread_id" text,
  "run_id" text,
  "setup_status" text DEFAULT 'none'::text NOT NULL,
  "setup_output" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  "archive_snapshot_ref" text,
  "setup_reason" text
);
CREATE TABLE "collection_indexing_stats" (
  "embedding_set_id" text NOT NULL,
  "file_count" integer DEFAULT 0 NOT NULL,
  "chunk_count" integer DEFAULT 0 NOT NULL,
  "embedded_chunk_count" integer DEFAULT 0 NOT NULL,
  "pending_chunk_count" integer DEFAULT 0 NOT NULL,
  "dirty" boolean DEFAULT false NOT NULL,
  "last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "embedding_cache" (
  "id" uuid DEFAULT uuidv7() NOT NULL,
  "content_hash" text NOT NULL,
  "model_key" text NOT NULL,
  "embedding" vector NOT NULL,
  "dimensions" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "access_count" integer DEFAULT 1 NOT NULL
);
CREATE TABLE "embedding_dimension_index_maintenance" (
  "dimension" integer NOT NULL,
  "state" text NOT NULL,
  "reason" text NOT NULL,
  "strategy" text DEFAULT 'regular'::text NOT NULL,
  "requested_at" text NOT NULL,
  "next_run_at" text NOT NULL,
  "started_at" text,
  "completed_at" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_duration_ms" integer,
  "last_foreground_probe_p95_ms" integer,
  "last_foreground_probe_max_ms" integer,
  "last_invalid_index_name" text,
  "last_error" text
);
CREATE TABLE "embedding_dimension_index_suspensions" (
  "dimension" integer NOT NULL,
  "reason" text NOT NULL,
  "suspended_at" text NOT NULL
);
CREATE TABLE "embedding_sets" (
  "id" text NOT NULL,
  "model_key" text NOT NULL,
  "model_id" text NOT NULL,
  "dimensions" integer NOT NULL,
  "distance" text DEFAULT 'cosine'::text,
  "created_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
  "name" text,
  "description" text,
  "tags" text,
  "category" text,
  "allow_duplicates" boolean DEFAULT false,
  "system_role" text
);
CREATE TABLE "file_chunks" (
  "id" text NOT NULL,
  "file_record_id" text NOT NULL,
  "chunk_index" integer NOT NULL,
  "content" text NOT NULL,
  "content_hash" text,
  "token_count" integer,
  "chunk_type" text,
  "chunk_size" integer,
  "embedding" vector,
  "embedding_set_id" text,
  "embedding_updated_at" text,
  "embedding_hash" text,
  "created_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
  "updated_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
  "start_line" integer,
  "end_line" integer,
  "start_offset" integer,
  "end_offset" integer,
  "content_tsvector" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED
);
CREATE TABLE "file_records" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "path" text NOT NULL,
  "size" integer NOT NULL,
  "created_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
  "updated_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
  "content" text,
  "content_hash" text,
  "token_count" integer,
  "processed_at" text,
  "embedding_set_id" text,
  "chunks_processed_at" text,
  "chunks_count" integer,
  "chunking_strategy" text,
  "mtime_ms" bigint,
  "root_id" text
);
CREATE TABLE "file_relationships" (
  "id" text NOT NULL,
  "source_id" text NOT NULL,
  "target_id" text NOT NULL,
  "relationship_type" text NOT NULL,
  "metadata" jsonb,
  "created_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);
CREATE TABLE "file_symbol_refs" (
  "file_record_id" text NOT NULL,
  "seq" integer NOT NULL,
  "from_symbol_seq" integer,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "module" text,
  "line" integer NOT NULL
);
CREATE TABLE "file_symbols" (
  "file_record_id" text NOT NULL,
  "seq" integer NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "exported" boolean DEFAULT false NOT NULL,
  "start_line" integer NOT NULL,
  "end_line" integer NOT NULL,
  "start_offset" integer NOT NULL,
  "end_offset" integer NOT NULL
);
CREATE TABLE "file_tags" (
  "id" text NOT NULL,
  "file_id" text NOT NULL,
  "tag" text NOT NULL,
  "created_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);
CREATE TABLE "file_token_cache" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "folder_id" text NOT NULL,
  "file_path" text NOT NULL,
  "content_hash" text NOT NULL,
  "file_size" bigint NOT NULL,
  "mtime_ms" bigint,
  "token_count" integer NOT NULL,
  "counting_mode" text NOT NULL,
  "model_encoding" text,
  "created_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
  "updated_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL
);
CREATE TABLE "job_queue" (
  "id" text NOT NULL,
  "queue" text NOT NULL,
  "job_type" text NOT NULL,
  "payload" jsonb,
  "state" text DEFAULT 'queued'::text NOT NULL,
  "run_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "backoff_ms" integer DEFAULT 0 NOT NULL,
  "lease_token" text,
  "leased_until" text,
  "worker_id" text,
  "dedupe_key" text,
  "error" text,
  "created_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
  "updated_at" text DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text) NOT NULL,
  "chunk_id" text,
  "embedding_set_id" text
);
CREATE TABLE "job_queue_metrics" (
  "queue" text NOT NULL,
  "succeeded_total" bigint DEFAULT 0 NOT NULL,
  "failed_total" bigint DEFAULT 0 NOT NULL,
  "canceled_total" bigint DEFAULT 0 NOT NULL
);
CREATE TABLE "mastra_background_tasks" (
  "id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "agent_id" text NOT NULL,
  "run_id" text NOT NULL,
  "thread_id" text,
  "resource_id" text,
  "status" text NOT NULL,
  "args" jsonb NOT NULL,
  "result" jsonb,
  "error" jsonb,
  "suspend_payload" jsonb,
  "retry_count" integer NOT NULL,
  "max_retries" integer NOT NULL,
  "timeout_ms" integer NOT NULL,
  "createdAt" timestamp with time zone NOT NULL,
  "startedAt" timestamp with time zone,
  "suspendedAt" timestamp with time zone,
  "completedAt" timestamp with time zone,
  "delivered_at" timestamp with time zone
);
CREATE TABLE "mastra_messages" (
  "id" text NOT NULL,
  "thread_id" text NOT NULL,
  "content" jsonb NOT NULL,
  "role" text NOT NULL,
  "type" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL,
  "resourceId" text
);
CREATE TABLE "mastra_observational_memory" (
  "id" text NOT NULL,
  "lookupKey" text NOT NULL,
  "scope" text NOT NULL,
  "resourceId" text,
  "threadId" text,
  "activeObservations" text NOT NULL,
  "activeObservationsPendingUpdate" text,
  "originType" text NOT NULL,
  "config" jsonb NOT NULL,
  "generationCount" integer NOT NULL,
  "lastObservedAt" timestamp with time zone,
  "lastReflectionAt" timestamp with time zone,
  "pendingMessageTokens" integer NOT NULL,
  "totalTokensObserved" integer NOT NULL,
  "observationTokenCount" integer NOT NULL,
  "isObserving" boolean NOT NULL,
  "isReflecting" boolean NOT NULL,
  "observedMessageIds" jsonb,
  "observedTimezone" text,
  "bufferedObservations" text,
  "bufferedObservationTokens" integer,
  "bufferedMessageIds" jsonb,
  "bufferedReflection" text,
  "bufferedReflectionTokens" integer,
  "bufferedReflectionInputTokens" integer,
  "reflectedObservationLineCount" integer,
  "bufferedObservationChunks" jsonb,
  "isBufferingObservation" boolean NOT NULL,
  "isBufferingReflection" boolean NOT NULL,
  "lastBufferedAtTokens" integer NOT NULL,
  "lastBufferedAtTime" timestamp with time zone,
  "metadata" jsonb,
  "createdAt" timestamp with time zone NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL
);
CREATE TABLE "mastra_resources" (
  "id" text NOT NULL,
  "workingMemory" text,
  "metadata" jsonb,
  "createdAt" timestamp with time zone NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL
);
CREATE TABLE "mastra_threads" (
  "id" text NOT NULL,
  "resourceId" text NOT NULL,
  "title" text NOT NULL,
  "metadata" jsonb,
  "createdAt" timestamp with time zone NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL
);
CREATE TABLE "models" (
  "id" text NOT NULL,
  "provider_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "tagline" text,
  "best_for" jsonb,
  "icon" text,
  "is_enabled" boolean DEFAULT false NOT NULL,
  "capabilities" jsonb,
  "parameters" jsonb,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "prompt_embedding_profiles" (
  "id" text NOT NULL,
  "model_id" text NOT NULL,
  "model_key" text NOT NULL,
  "dimensions" integer NOT NULL,
  "distance" text DEFAULT 'cosine'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE "prompt_item_revisions" (
  "id" text NOT NULL,
  "prompt_item_id" text NOT NULL,
  "revision" integer NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "description" text,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model_key" text,
  "model_settings" jsonb,
  "note" text,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE "prompt_items" (
  "id" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "description" text,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "is_favorite" boolean DEFAULT false NOT NULL,
  "archived_at" timestamp with time zone,
  "source_url" text,
  "rating" integer,
  "model_key" text,
  "model_settings" jsonb,
  "revision" integer DEFAULT 1 NOT NULL,
  "use_count" integer DEFAULT 0 NOT NULL,
  "last_used_at" timestamp with time zone,
  "last_used_action" text,
  "embedding" vector,
  "embedding_profile_id" text,
  "embedding_revision" integer,
  "embedding_error" text,
  "embedding_updated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE "providers" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "icon" text,
  "is_enabled" boolean DEFAULT false NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "roots" (
  "id" text DEFAULT (uuidv7())::text NOT NULL,
  "kind" text NOT NULL,
  "display_name" text NOT NULL,
  "path" text,
  "status" text DEFAULT 'live'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_verified_at" timestamp with time zone
);
CREATE TABLE "selection_snapshot_files" (
  "snapshot_id" uuid NOT NULL,
  "file_path" text NOT NULL
);
CREATE TABLE "selection_snapshots" (
  "id" uuid DEFAULT uuidv7() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone
);
CREATE TABLE "token_cache" (
  "id" uuid DEFAULT uuidv7() NOT NULL,
  "file_path" text NOT NULL,
  "content_hash" text NOT NULL,
  "token_count" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "view_filter_presets" (
  "id" uuid DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "icon" text DEFAULT 'file'::text NOT NULL,
  "includes" text[] DEFAULT '{}'::text[] NOT NULL,
  "excludes" text[] DEFAULT '{}'::text[] NOT NULL,
  "use_regex" boolean DEFAULT false NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- SEQUENCE OWNERSHIP (1)
ALTER SEQUENCE "brainstrike_mind_ops_seq_seq" OWNED BY "brainstrike_mind_ops"."seq";

-- PRIMARY KEY / UNIQUE / CHECK CONSTRAINTS (156)
ALTER TABLE "brainstrike_assistant_message_parents" ADD CONSTRAINT "brainstrike_assistant_message_parents_pkey" PRIMARY KEY (message_id);
ALTER TABLE "brainstrike_assistant_message_tombstones" ADD CONSTRAINT "brainstrike_assistant_message_tombstones_pkey" PRIMARY KEY (message_id);
ALTER TABLE "brainstrike_assistant_native_runs" ADD CONSTRAINT "brainstrike_assistant_native_runs_native_run_id_check" CHECK ((length(btrim(native_run_id)) > 0));
ALTER TABLE "brainstrike_assistant_native_runs" ADD CONSTRAINT "brainstrike_assistant_native_runs_pkey" PRIMARY KEY (native_run_id);
ALTER TABLE "brainstrike_assistant_prompt_manifests" ADD CONSTRAINT "brainstrike_assistant_prompt_manife_system_context_source_check" CHECK ((system_context_source = ANY (ARRAY['captured'::text, 'root-leg'::text, 'none'::text])));
ALTER TABLE "brainstrike_assistant_prompt_manifests" ADD CONSTRAINT "brainstrike_assistant_prompt_manifests_id_check" CHECK ((length(btrim(id)) > 0));
ALTER TABLE "brainstrike_assistant_prompt_manifests" ADD CONSTRAINT "brainstrike_assistant_prompt_manifests_kind_check" CHECK ((kind = ANY (ARRAY['root-leg'::text, 'child-first-step'::text, 'continuation'::text])));
ALTER TABLE "brainstrike_assistant_prompt_manifests" ADD CONSTRAINT "brainstrike_assistant_prompt_manifests_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_assistant_prompt_manifests" ADD CONSTRAINT "brainstrike_assistant_prompt_manifests_thread_id_check" CHECK ((length(btrim(thread_id)) > 0));
ALTER TABLE "brainstrike_assistant_prompt_manifests" ADD CONSTRAINT "brainstrike_assistant_prompt_manifests_total_chars_check" CHECK ((total_chars >= 0));
ALTER TABLE "brainstrike_assistant_run_errors" ADD CONSTRAINT "brainstrike_assistant_run_errors_pkey" PRIMARY KEY (run_id);
ALTER TABLE "brainstrike_assistant_run_errors" ADD CONSTRAINT "bst_assistant_run_errors_cause_chain_check" CHECK (((cause_chain IS NULL) OR (jsonb_typeof(cause_chain) = 'array'::text)));
ALTER TABLE "brainstrike_assistant_run_errors" ADD CONSTRAINT "bst_assistant_run_errors_code_check" CHECK ((length(code) > 0));
ALTER TABLE "brainstrike_assistant_run_errors" ADD CONSTRAINT "bst_assistant_run_errors_http_status_check" CHECK (((http_status IS NULL) OR ((http_status >= 100) AND (http_status <= 599))));
ALTER TABLE "brainstrike_assistant_run_errors" ADD CONSTRAINT "bst_assistant_run_errors_resource_check" CHECK ((length(resource_id) > 0));
ALTER TABLE "brainstrike_assistant_run_errors" ADD CONSTRAINT "bst_assistant_run_errors_response_headers_check" CHECK (((response_headers IS NULL) OR (jsonb_typeof(response_headers) = 'object'::text)));
ALTER TABLE "brainstrike_assistant_run_errors" ADD CONSTRAINT "bst_assistant_run_errors_run_check" CHECK ((length(run_id) > 0));
ALTER TABLE "brainstrike_assistant_run_errors" ADD CONSTRAINT "bst_assistant_run_errors_thread_check" CHECK ((length(thread_id) > 0));
ALTER TABLE "brainstrike_assistant_run_events" ADD CONSTRAINT "brainstrike_assistant_run_events_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_assistant_run_outcomes" ADD CONSTRAINT "brainstrike_assistant_run_outcomes_pkey" PRIMARY KEY (run_id);
ALTER TABLE "brainstrike_assistant_run_outcomes" ADD CONSTRAINT "brainstrike_assistant_run_outcomes_source_check" CHECK ((source = ANY (ARRAY['user'::text, 'edit_revert'::text, 'hook'::text])));
ALTER TABLE "brainstrike_assistant_run_outcomes" ADD CONSTRAINT "brainstrike_assistant_run_outcomes_verdict_check" CHECK ((verdict = ANY (ARRAY['succeeded'::text, 'failed'::text, 'mixed'::text])));
ALTER TABLE "brainstrike_assistant_run_treatments" ADD CONSTRAINT "brainstrike_assistant_run_treatments_injected_consistency" CHECK ((signal_injected = (injection_status = 'injected'::text)));
ALTER TABLE "brainstrike_assistant_run_treatments" ADD CONSTRAINT "brainstrike_assistant_run_treatments_injection_status_check" CHECK ((injection_status = ANY (ARRAY['continuation'::text, 'injected'::text, 'no_waste'::text, 'preference_malformed'::text, 'preference_off'::text, 'query_failed'::text])));
ALTER TABLE "brainstrike_assistant_run_treatments" ADD CONSTRAINT "brainstrike_assistant_run_treatments_pkey" PRIMARY KEY (run_id);
ALTER TABLE "brainstrike_assistant_run_usage" ADD CONSTRAINT "brainstrike_assistant_run_usa_cache_creation_input_tokens_check" CHECK ((cache_creation_input_tokens >= 0));
ALTER TABLE "brainstrike_assistant_run_usage" ADD CONSTRAINT "brainstrike_assistant_run_usage_billed_cost_usd_check" CHECK ((billed_cost_usd >= (0)::numeric));
ALTER TABLE "brainstrike_assistant_run_usage" ADD CONSTRAINT "brainstrike_assistant_run_usage_cache_read_input_tokens_check" CHECK ((cache_read_input_tokens >= 0));
ALTER TABLE "brainstrike_assistant_run_usage" ADD CONSTRAINT "brainstrike_assistant_run_usage_input_tokens_check" CHECK ((input_tokens >= 0));
ALTER TABLE "brainstrike_assistant_run_usage" ADD CONSTRAINT "brainstrike_assistant_run_usage_output_tokens_check" CHECK ((output_tokens >= 0));
ALTER TABLE "brainstrike_assistant_run_usage" ADD CONSTRAINT "brainstrike_assistant_run_usage_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_assistant_run_usage" ADD CONSTRAINT "brainstrike_assistant_run_usage_run_kind_check" CHECK ((run_kind = ANY (ARRAY['chat'::text, 'subagent'::text, 'compaction-summary'::text, 'om-observation'::text, 'om-reflection'::text])));
ALTER TABLE "brainstrike_assistant_thread_groups" ADD CONSTRAINT "brainstrike_assistant_thread_groups_color_check" CHECK (((color IS NULL) OR (color = ANY (ARRAY['blue'::text, 'emerald'::text, 'amber'::text, 'rose'::text, 'violet'::text, 'slate'::text, 'cyan'::text, 'lime'::text, 'orange'::text, 'fuchsia'::text, 'indigo'::text, 'red'::text, 'teal'::text, 'green'::text, 'yellow'::text, 'pink'::text, 'purple'::text, 'zinc'::text]))));
ALTER TABLE "brainstrike_assistant_thread_groups" ADD CONSTRAINT "brainstrike_assistant_thread_groups_icon_check" CHECK (((icon IS NULL) OR (icon = ANY (ARRAY['message'::text, 'bug'::text, 'code'::text, 'rocket'::text, 'research'::text, 'plan'::text]))));
ALTER TABLE "brainstrike_assistant_thread_groups" ADD CONSTRAINT "brainstrike_assistant_thread_groups_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_assistant_thread_placements" ADD CONSTRAINT "brainstrike_assistant_thread_placements_pkey" PRIMARY KEY (thread_id);
ALTER TABLE "brainstrike_assistant_thread_runs" ADD CONSTRAINT "brainstrike_assistant_thread_runs_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_assistant_thread_workspaces" ADD CONSTRAINT "brainstrike_assistant_thread_workspaces_pkey" PRIMARY KEY (thread_id);
ALTER TABLE "brainstrike_assistant_tool_output_artifacts" ADD CONSTRAINT "brainstrike_assistant_tool_output_artifacts_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_assistant_tool_output_artifacts" ADD CONSTRAINT "bst_tool_output_artifacts_bytes_check" CHECK (((byte_length >= 0) AND (byte_length = octet_length(content))));
ALTER TABLE "brainstrike_assistant_tool_output_artifacts" ADD CONSTRAINT "bst_tool_output_artifacts_call_check" CHECK (((octet_length(tool_call_id) >= 1) AND (octet_length(tool_call_id) <= 512)));
ALTER TABLE "brainstrike_assistant_tool_output_artifacts" ADD CONSTRAINT "bst_tool_output_artifacts_execution_thread_check" CHECK (((octet_length(execution_thread_id) >= 1) AND (octet_length(execution_thread_id) <= 512)));
ALTER TABLE "brainstrike_assistant_tool_output_artifacts" ADD CONSTRAINT "bst_tool_output_artifacts_expiry_check" CHECK ((expires_at > created_at));
ALTER TABLE "brainstrike_assistant_tool_output_artifacts" ADD CONSTRAINT "bst_tool_output_artifacts_format_check" CHECK ((format = ANY (ARRAY['json'::text, 'text'::text])));
ALTER TABLE "brainstrike_assistant_tool_output_artifacts" ADD CONSTRAINT "bst_tool_output_artifacts_resource_check" CHECK (((octet_length(resource_id) >= 1) AND (octet_length(resource_id) <= 512)));
ALTER TABLE "brainstrike_assistant_tool_output_artifacts" ADD CONSTRAINT "bst_tool_output_artifacts_run_check" CHECK (((octet_length(run_id) >= 1) AND (octet_length(run_id) <= 512)));
ALTER TABLE "brainstrike_assistant_tool_output_artifacts" ADD CONSTRAINT "bst_tool_output_artifacts_thread_check" CHECK (((octet_length(thread_id) >= 1) AND (octet_length(thread_id) <= 512)));
ALTER TABLE "brainstrike_diagnostic_events" ADD CONSTRAINT "brainstrike_diagnostic_events_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_diagnostic_events" ADD CONSTRAINT "brainstrike_diagnostic_events_severity_check" CHECK ((severity = ANY (ARRAY['warn'::text, 'error'::text, 'fatal'::text])));
ALTER TABLE "brainstrike_forge_prs" ADD CONSTRAINT "brainstrike_forge_prs_check" CHECK ((((number IS NULL) AND (url IS NULL) AND (title IS NULL) AND (state IS NULL) AND (is_draft IS NULL) AND (checks_json IS NULL) AND (head_sha IS NULL)) OR ((number IS NOT NULL) AND (url IS NOT NULL) AND (title IS NOT NULL) AND (state IS NOT NULL) AND (is_draft IS NOT NULL) AND (checks_json IS NOT NULL) AND (head_sha IS NOT NULL))));
ALTER TABLE "brainstrike_forge_prs" ADD CONSTRAINT "brainstrike_forge_prs_pkey" PRIMARY KEY (repo_common_dir, branch);
ALTER TABLE "brainstrike_forge_prs" ADD CONSTRAINT "brainstrike_forge_prs_state_check" CHECK (((state IS NULL) OR (state = ANY (ARRAY['open'::text, 'closed'::text, 'merged'::text]))));
ALTER TABLE "brainstrike_mcp_task_authorities" ADD CONSTRAINT "brainstrike_mcp_task_authorit_authority_epoch_server_id_res_key" UNIQUE (authority_epoch, server_id, resource, principal_id);
ALTER TABLE "brainstrike_mcp_task_authorities" ADD CONSTRAINT "brainstrike_mcp_task_authorities_check" CHECK ((created_at <= updated_at));
ALTER TABLE "brainstrike_mcp_task_authorities" ADD CONSTRAINT "brainstrike_mcp_task_authorities_check1" CHECK (((retired_at IS NULL) OR (retired_at = updated_at)));
ALTER TABLE "brainstrike_mcp_task_authorities" ADD CONSTRAINT "brainstrike_mcp_task_authorities_connection_generation_check" CHECK ((connection_generation >= 0));
ALTER TABLE "brainstrike_mcp_task_authorities" ADD CONSTRAINT "brainstrike_mcp_task_authorities_pkey" PRIMARY KEY (authority_epoch);
ALTER TABLE "brainstrike_mcp_task_authorities" ADD CONSTRAINT "brainstrike_mcp_task_authorities_principal_id_check" CHECK (((octet_length(principal_id) >= 1) AND (octet_length(principal_id) <= 512)));
ALTER TABLE "brainstrike_mcp_task_authorities" ADD CONSTRAINT "brainstrike_mcp_task_authorities_resource_check" CHECK (((octet_length(resource) >= 1) AND (octet_length(resource) <= 2048)));
ALTER TABLE "brainstrike_mcp_task_authorities" ADD CONSTRAINT "brainstrike_mcp_task_authorities_runtime_id_check" CHECK (((octet_length(runtime_id) >= 1) AND (octet_length(runtime_id) <= 512)));
ALTER TABLE "brainstrike_mcp_task_authorities" ADD CONSTRAINT "brainstrike_mcp_task_authorities_server_id_check" CHECK (((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 512)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_blocked_diagnostic_object_check" CHECK (((blocked_diagnostic IS NULL) OR (jsonb_typeof(blocked_diagnostic) = 'object'::text)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_blocked_diagnostic_size_check" CHECK ((octet_length(COALESCE((blocked_diagnostic)::text, ''::text)) <= 4096));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_check" CHECK (((status <> 'input_required'::text) OR (input_metadata IS NOT NULL)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_check1" CHECK (((status <> ALL (ARRAY['completed'::text, 'failed'::text])) OR (result_metadata IS NOT NULL)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_check3" CHECK (((created_at <= updated_at) AND ((terminal_at IS NULL) OR (terminal_at = updated_at))));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_history_check" CHECK (((jsonb_typeof(history) = 'array'::text) AND ((jsonb_array_length(history) >= 1) AND (jsonb_array_length(history) <= 32))));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_input_metadata_check" CHECK (((input_metadata IS NULL) OR (jsonb_typeof(input_metadata) = 'object'::text)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_input_metadata_check1" CHECK ((octet_length(COALESCE((input_metadata)::text, ''::text)) <= 65536));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_pkey" PRIMARY KEY (authority_epoch, task_id);
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_principal_id_check" CHECK (((octet_length(principal_id) >= 1) AND (octet_length(principal_id) <= 512)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_resource_check" CHECK (((octet_length(resource) >= 1) AND (octet_length(resource) <= 2048)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_result_metadata_check" CHECK (((result_metadata IS NULL) OR (jsonb_typeof(result_metadata) = 'object'::text)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_result_metadata_check1" CHECK ((octet_length(COALESCE((result_metadata)::text, ''::text)) <= 65536));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_server_id_check" CHECK (((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 512)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_status_check" CHECK ((status = ANY (ARRAY['working'::text, 'input_required'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_status_message_check" CHECK (((status_message IS NULL) OR (octet_length(status_message) <= 4096)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_task_id_check" CHECK (((octet_length(task_id) >= 1) AND (octet_length(task_id) <= 1024)));
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_terminal_state_check" CHECK ((((status = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text])) OR (blocked_diagnostic IS NOT NULL)) = (terminal_at IS NOT NULL)));
ALTER TABLE "brainstrike_mind_ops" ADD CONSTRAINT "brainstrike_mind_ops_entity_kind_check" CHECK ((entity_kind = ANY (ARRAY['thread'::text, 'prompt_item'::text])));
ALTER TABLE "brainstrike_mind_ops" ADD CONSTRAINT "brainstrike_mind_ops_op_check" CHECK ((op = 'delete'::text));
ALTER TABLE "brainstrike_mind_ops" ADD CONSTRAINT "brainstrike_mind_ops_pkey" PRIMARY KEY (seq);
ALTER TABLE "brainstrike_thread_message_index" ADD CONSTRAINT "brainstrike_thread_message_index_pkey" PRIMARY KEY (message_id);
ALTER TABLE "brainstrike_thread_search_profiles" ADD CONSTRAINT "brainstrike_thread_search_profiles_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_thread_search_profiles" ADD CONSTRAINT "thread_search_profiles_dimensions_check" CHECK ((dimensions > 0));
ALTER TABLE "brainstrike_thread_search_profiles" ADD CONSTRAINT "thread_search_profiles_distance_check" CHECK ((distance = ANY (ARRAY['cosine'::text, 'l2'::text, 'ip'::text])));
ALTER TABLE "brainstrike_thread_search_profiles" ADD CONSTRAINT "thread_search_profiles_singleton_check" CHECK ((id = 'default'::text));
ALTER TABLE "brainstrike_thread_search_state" ADD CONSTRAINT "brainstrike_thread_search_state_pkey" PRIMARY KEY (thread_id);
ALTER TABLE "brainstrike_token_estimate_calibration" ADD CONSTRAINT "brainstrike_token_estimate_c_model_visible_projection_cou_check" CHECK ((model_visible_projection_count >= 0));
ALTER TABLE "brainstrike_token_estimate_calibration" ADD CONSTRAINT "brainstrike_token_estimate_c_resolved_domain_budget_token_check" CHECK (((resolved_domain_budget_tokens IS NULL) OR (resolved_domain_budget_tokens > 0)));
ALTER TABLE "brainstrike_token_estimate_calibration" ADD CONSTRAINT "brainstrike_token_estimate_c_resolved_transport_budget_to_check" CHECK (((resolved_transport_budget_tokens IS NULL) OR (resolved_transport_budget_tokens > 0)));
ALTER TABLE "brainstrike_token_estimate_calibration" ADD CONSTRAINT "brainstrike_token_estimate_calib_final_step_prompt_tokens_check" CHECK ((final_step_prompt_tokens >= 0));
ALTER TABLE "brainstrike_token_estimate_calibration" ADD CONSTRAINT "brainstrike_token_estimate_calibr_estimated_prompt_tokens_check" CHECK ((estimated_prompt_tokens >= 0));
ALTER TABLE "brainstrike_token_estimate_calibration" ADD CONSTRAINT "brainstrike_token_estimate_calibra_prompt_baseline_tokens_check" CHECK (((prompt_baseline_tokens IS NULL) OR (prompt_baseline_tokens > 0)));
ALTER TABLE "brainstrike_token_estimate_calibration" ADD CONSTRAINT "brainstrike_token_estimate_calibration_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_token_estimate_calibration" ADD CONSTRAINT "brainstrike_token_estimate_calibration_step_count_check" CHECK ((step_count >= 1));
ALTER TABLE "brainstrike_tool_call_telemetry" ADD CONSTRAINT "brainstrike_tool_call_telemetry_model_facing_chars_check" CHECK ((model_facing_chars >= 0));
ALTER TABLE "brainstrike_tool_call_telemetry" ADD CONSTRAINT "brainstrike_tool_call_telemetry_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_workspace_snapshots" ADD CONSTRAINT "brainstrike_workspace_snapshots_kind_check" CHECK ((kind = ANY (ARRAY['turn-start'::text, 'turn-end'::text, 'pre-revert'::text])));
ALTER TABLE "brainstrike_workspace_snapshots" ADD CONSTRAINT "brainstrike_workspace_snapshots_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_worktrees" ADD CONSTRAINT "brainstrike_worktrees_archive_consistency" CHECK (((archived_at IS NULL) = (archive_snapshot_ref IS NULL)));
ALTER TABLE "brainstrike_worktrees" ADD CONSTRAINT "brainstrike_worktrees_created_by_check" CHECK ((created_by = ANY (ARRAY['agent'::text, 'user'::text])));
ALTER TABLE "brainstrike_worktrees" ADD CONSTRAINT "brainstrike_worktrees_path_key" UNIQUE (path);
ALTER TABLE "brainstrike_worktrees" ADD CONSTRAINT "brainstrike_worktrees_pkey" PRIMARY KEY (id);
ALTER TABLE "brainstrike_worktrees" ADD CONSTRAINT "brainstrike_worktrees_setup_status_check" CHECK ((setup_status = ANY (ARRAY['failed'::text, 'none'::text, 'skipped'::text, 'succeeded'::text])));
ALTER TABLE "collection_indexing_stats" ADD CONSTRAINT "collection_indexing_stats_pkey" PRIMARY KEY (embedding_set_id);
ALTER TABLE "embedding_cache" ADD CONSTRAINT "embedding_cache_pkey" PRIMARY KEY (id);
ALTER TABLE "embedding_dimension_index_maintenance" ADD CONSTRAINT "embedding_dimension_index_ma_last_foreground_probe_max_ms_check" CHECK (((last_foreground_probe_max_ms IS NULL) OR (last_foreground_probe_max_ms >= 0)));
ALTER TABLE "embedding_dimension_index_maintenance" ADD CONSTRAINT "embedding_dimension_index_ma_last_foreground_probe_p95_ms_check" CHECK (((last_foreground_probe_p95_ms IS NULL) OR (last_foreground_probe_p95_ms >= 0)));
ALTER TABLE "embedding_dimension_index_maintenance" ADD CONSTRAINT "embedding_dimension_index_maintenance_attempts_check" CHECK ((attempts >= 0));
ALTER TABLE "embedding_dimension_index_maintenance" ADD CONSTRAINT "embedding_dimension_index_maintenance_last_duration_ms_check" CHECK (((last_duration_ms IS NULL) OR (last_duration_ms >= 0)));
ALTER TABLE "embedding_dimension_index_maintenance" ADD CONSTRAINT "embedding_dimension_index_maintenance_pkey" PRIMARY KEY (dimension);
ALTER TABLE "embedding_dimension_index_maintenance" ADD CONSTRAINT "embedding_dimension_index_maintenance_state_check" CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text])));
ALTER TABLE "embedding_dimension_index_maintenance" ADD CONSTRAINT "embedding_dimension_index_maintenance_strategy_check" CHECK ((strategy = ANY (ARRAY['regular'::text, 'concurrent'::text])));
ALTER TABLE "embedding_dimension_index_suspensions" ADD CONSTRAINT "embedding_dimension_index_suspensions_pkey" PRIMARY KEY (dimension);
ALTER TABLE "embedding_sets" ADD CONSTRAINT "embedding_sets_pkey" PRIMARY KEY (id);
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_pkey" PRIMARY KEY (id);
ALTER TABLE "file_records" ADD CONSTRAINT "file_records_pkey" PRIMARY KEY (id);
ALTER TABLE "file_relationships" ADD CONSTRAINT "file_relationships_pkey" PRIMARY KEY (id);
ALTER TABLE "file_symbol_refs" ADD CONSTRAINT "file_symbol_refs_kind_check" CHECK ((kind = ANY (ARRAY['call'::text, 'import'::text, 'extends'::text, 'implements'::text])));
ALTER TABLE "file_symbol_refs" ADD CONSTRAINT "file_symbol_refs_pkey" PRIMARY KEY (file_record_id, seq);
ALTER TABLE "file_symbols" ADD CONSTRAINT "file_symbols_kind_check" CHECK ((kind = ANY (ARRAY['function'::text, 'class'::text, 'method'::text, 'variable'::text, 'interface'::text, 'type'::text, 'enum'::text])));
ALTER TABLE "file_symbols" ADD CONSTRAINT "file_symbols_pkey" PRIMARY KEY (file_record_id, seq);
ALTER TABLE "file_tags" ADD CONSTRAINT "file_tags_pkey" PRIMARY KEY (id);
ALTER TABLE "file_token_cache" ADD CONSTRAINT "file_token_cache_pkey" PRIMARY KEY (id);
ALTER TABLE "job_queue" ADD CONSTRAINT "job_queue_pkey" PRIMARY KEY (id);
ALTER TABLE "job_queue_metrics" ADD CONSTRAINT "job_queue_metrics_pkey" PRIMARY KEY (queue);
ALTER TABLE "mastra_background_tasks" ADD CONSTRAINT "mastra_background_tasks_pkey" PRIMARY KEY (id);
ALTER TABLE "mastra_messages" ADD CONSTRAINT "mastra_messages_pkey" PRIMARY KEY (id);
ALTER TABLE "mastra_observational_memory" ADD CONSTRAINT "mastra_observational_memory_pkey" PRIMARY KEY (id);
ALTER TABLE "mastra_resources" ADD CONSTRAINT "mastra_resources_pkey" PRIMARY KEY (id);
ALTER TABLE "mastra_threads" ADD CONSTRAINT "mastra_threads_pkey" PRIMARY KEY (id);
ALTER TABLE "models" ADD CONSTRAINT "models_pkey" PRIMARY KEY (id);
ALTER TABLE "prompt_embedding_profiles" ADD CONSTRAINT "prompt_embedding_profiles_dimensions_check" CHECK ((dimensions > 0));
ALTER TABLE "prompt_embedding_profiles" ADD CONSTRAINT "prompt_embedding_profiles_distance_check" CHECK ((distance = ANY (ARRAY['cosine'::text, 'l2'::text, 'ip'::text])));
ALTER TABLE "prompt_embedding_profiles" ADD CONSTRAINT "prompt_embedding_profiles_pkey" PRIMARY KEY (id);
ALTER TABLE "prompt_embedding_profiles" ADD CONSTRAINT "prompt_embedding_profiles_singleton_check" CHECK ((id = 'default'::text));
ALTER TABLE "prompt_item_revisions" ADD CONSTRAINT "prompt_item_revisions_pkey" PRIMARY KEY (id);
ALTER TABLE "prompt_item_revisions" ADD CONSTRAINT "prompt_item_revisions_revision_check" CHECK ((revision > 0));
ALTER TABLE "prompt_item_revisions" ADD CONSTRAINT "prompt_item_revisions_unique" UNIQUE (prompt_item_id, revision);
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_content_check" CHECK ((length(TRIM(BOTH FROM content)) > 0));
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_kind_check" CHECK ((kind = ANY (ARRAY['prompt'::text, 'snippet'::text, 'fragment'::text])));
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_last_used_action_check" CHECK (((last_used_action IS NULL) OR (last_used_action = ANY (ARRAY['compose'::text, 'insert'::text, 'new-thread'::text]))));
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_pkey" PRIMARY KEY (id);
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_rating_check" CHECK (((rating IS NULL) OR ((rating >= 0) AND (rating <= 5))));
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_revision_check" CHECK ((revision > 0));
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_tags_check" CHECK ((jsonb_typeof(tags) = 'array'::text));
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_title_check" CHECK ((length(TRIM(BOTH FROM title)) > 0));
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_use_count_check" CHECK ((use_count >= 0));
ALTER TABLE "providers" ADD CONSTRAINT "providers_pkey" PRIMARY KEY (id);
ALTER TABLE "roots" ADD CONSTRAINT "roots_kind_check" CHECK ((kind = ANY (ARRAY['path'::text, 'fsa'::text, 'snapshot'::text, 'legacy'::text, 'worktree'::text])));
ALTER TABLE "roots" ADD CONSTRAINT "roots_pkey" PRIMARY KEY (id);
ALTER TABLE "roots" ADD CONSTRAINT "roots_status_check" CHECK ((status = ANY (ARRAY['live'::text, 'needs-regrant'::text, 'disconnected'::text, 'snapshot-stale'::text])));
ALTER TABLE "selection_snapshots" ADD CONSTRAINT "selection_snapshots_pkey" PRIMARY KEY (id);
ALTER TABLE "token_cache" ADD CONSTRAINT "token_cache_pkey" PRIMARY KEY (id);
ALTER TABLE "view_filter_presets" ADD CONSTRAINT "view_filter_presets_pkey" PRIMARY KEY (id);

-- FOREIGN KEY CONSTRAINTS (19)
ALTER TABLE "brainstrike_assistant_native_runs" ADD CONSTRAINT "brainstrike_assistant_native_runs_host_run_id_fkey" FOREIGN KEY (host_run_id) REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE;
ALTER TABLE "brainstrike_assistant_prompt_manifests" ADD CONSTRAINT "brainstrike_assistant_prompt_manifests_host_run_id_fkey" FOREIGN KEY (host_run_id) REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE;
ALTER TABLE "brainstrike_assistant_run_events" ADD CONSTRAINT "brainstrike_assistant_run_events_run_id_fkey" FOREIGN KEY (run_id) REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE;
ALTER TABLE "brainstrike_assistant_run_events" ADD CONSTRAINT "brainstrike_assistant_run_events_thread_id_fkey" FOREIGN KEY (thread_id) REFERENCES mastra_threads(id) ON DELETE CASCADE;
ALTER TABLE "brainstrike_assistant_thread_runs" ADD CONSTRAINT "brainstrike_assistant_thread_runs_thread_id_fkey" FOREIGN KEY (thread_id) REFERENCES mastra_threads(id) ON DELETE CASCADE;
ALTER TABLE "brainstrike_mcp_tasks" ADD CONSTRAINT "brainstrike_mcp_tasks_authority_fk" FOREIGN KEY (authority_epoch, server_id, resource, principal_id) REFERENCES brainstrike_mcp_task_authorities(authority_epoch, server_id, resource, principal_id) ON DELETE CASCADE;
ALTER TABLE "brainstrike_thread_message_index" ADD CONSTRAINT "brainstrike_thread_message_index_embedding_profile_id_fkey" FOREIGN KEY (embedding_profile_id) REFERENCES brainstrike_thread_search_profiles(id) ON DELETE SET NULL;
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_record_id_file_records_id_fk" FOREIGN KEY (file_record_id) REFERENCES file_records(id) ON DELETE CASCADE;
ALTER TABLE "file_records" ADD CONSTRAINT "file_records_root_id_fkey" FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE;
ALTER TABLE "file_relationships" ADD CONSTRAINT "file_relationships_source_id_file_records_id_fk" FOREIGN KEY (source_id) REFERENCES file_records(id) ON DELETE CASCADE;
ALTER TABLE "file_relationships" ADD CONSTRAINT "file_relationships_target_id_file_records_id_fk" FOREIGN KEY (target_id) REFERENCES file_records(id) ON DELETE CASCADE;
ALTER TABLE "file_symbol_refs" ADD CONSTRAINT "file_symbol_refs_file_record_id_fkey" FOREIGN KEY (file_record_id) REFERENCES file_records(id) ON DELETE CASCADE;
ALTER TABLE "file_symbol_refs" ADD CONSTRAINT "file_symbol_refs_file_record_id_from_symbol_seq_fkey" FOREIGN KEY (file_record_id, from_symbol_seq) REFERENCES file_symbols(file_record_id, seq) ON DELETE CASCADE;
ALTER TABLE "file_symbols" ADD CONSTRAINT "file_symbols_file_record_id_fkey" FOREIGN KEY (file_record_id) REFERENCES file_records(id) ON DELETE CASCADE;
ALTER TABLE "file_tags" ADD CONSTRAINT "file_tags_file_id_file_records_id_fk" FOREIGN KEY (file_id) REFERENCES file_records(id) ON DELETE CASCADE;
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_providers_id_fk" FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE;
ALTER TABLE "prompt_item_revisions" ADD CONSTRAINT "prompt_item_revisions_prompt_item_id_fkey" FOREIGN KEY (prompt_item_id) REFERENCES prompt_items(id) ON DELETE CASCADE;
ALTER TABLE "prompt_items" ADD CONSTRAINT "prompt_items_embedding_profile_id_fkey" FOREIGN KEY (embedding_profile_id) REFERENCES prompt_embedding_profiles(id) ON DELETE SET NULL;
ALTER TABLE "selection_snapshot_files" ADD CONSTRAINT "selection_snapshot_files_snapshot_id_selection_snapshots_id_fk" FOREIGN KEY (snapshot_id) REFERENCES selection_snapshots(id) ON DELETE CASCADE;

-- INDEXES (105)
CREATE INDEX brainstrike_assistant_message_parents_thread_idx ON public.brainstrike_assistant_message_parents USING btree (thread_id, resource_id);
CREATE INDEX brainstrike_assistant_message_tombstones_rewind_idx ON public.brainstrike_assistant_message_tombstones USING btree (rewind_id);
CREATE INDEX brainstrike_assistant_message_tombstones_thread_idx ON public.brainstrike_assistant_message_tombstones USING btree (thread_id);
CREATE INDEX brainstrike_assistant_native_runs_host_run_idx ON public.brainstrike_assistant_native_runs USING btree (host_run_id);
CREATE INDEX brainstrike_assistant_prompt_manifests_run_idx ON public.brainstrike_assistant_prompt_manifests USING btree (host_run_id, created_at);
CREATE INDEX bst_assistant_run_errors_resource_idx ON public.brainstrike_assistant_run_errors USING btree (resource_id, occurred_at DESC);
CREATE INDEX bst_assistant_run_errors_thread_idx ON public.brainstrike_assistant_run_errors USING btree (thread_id, occurred_at DESC);
CREATE INDEX brainstrike_assistant_run_events_approval_answer_at_idx ON public.brainstrike_assistant_run_events USING btree (resource_id, thread_id, ((metadata ->> 'toolCallId'::text)), occurred_at) WHERE (kind = ANY (ARRAY['tool.started'::text, 'tool.completed'::text, 'tool.failed'::text, 'tool.resume.unsupported'::text]));
CREATE INDEX brainstrike_assistant_run_events_approval_pause_idx ON public.brainstrike_assistant_run_events USING btree (resource_id, thread_id) WHERE (kind = 'tool.approval.requested'::text);
CREATE INDEX brainstrike_assistant_run_events_run_idx ON public.brainstrike_assistant_run_events USING btree (run_id, sequence, occurred_at);
CREATE INDEX brainstrike_assistant_run_events_thread_idx ON public.brainstrike_assistant_run_events USING btree (thread_id, resource_id, sequence, occurred_at);
CREATE INDEX brainstrike_assistant_run_outcomes_resource_idx ON public.brainstrike_assistant_run_outcomes USING btree (resource_id, labeled_at DESC);
CREATE INDEX brainstrike_assistant_run_outcomes_thread_idx ON public.brainstrike_assistant_run_outcomes USING btree (thread_id, resource_id);
CREATE INDEX brainstrike_assistant_run_treatments_created_at_idx ON public.brainstrike_assistant_run_treatments USING btree (created_at);
CREATE INDEX brainstrike_assistant_run_usage_root_idx ON public.brainstrike_assistant_run_usage USING btree (resource_id, root_id);
CREATE INDEX brainstrike_assistant_run_usage_thread_idx ON public.brainstrike_assistant_run_usage USING btree (thread_id);
CREATE INDEX idx_assistant_thread_groups_resource_rank ON public.brainstrike_assistant_thread_groups USING btree (resource_id, rank);
CREATE INDEX idx_assistant_thread_placements_resource_group ON public.brainstrike_assistant_thread_placements USING btree (resource_id, group_id);
CREATE INDEX brainstrike_assistant_thread_runs_resource_idx ON public.brainstrike_assistant_thread_runs USING btree (resource_id);
CREATE INDEX brainstrike_assistant_thread_runs_status_idx ON public.brainstrike_assistant_thread_runs USING btree (status);
CREATE INDEX brainstrike_assistant_thread_runs_thread_latest_idx ON public.brainstrike_assistant_thread_runs USING btree (resource_id, thread_id, started_at DESC, id DESC);
CREATE INDEX bst_tool_output_artifacts_expires_idx ON public.brainstrike_assistant_tool_output_artifacts USING btree (expires_at, id);
CREATE UNIQUE INDEX bst_tool_output_artifacts_scope_call_uidx ON public.brainstrike_assistant_tool_output_artifacts USING btree (resource_id, thread_id, run_id, execution_thread_id, tool_call_id);
CREATE INDEX bst_diagnostic_events_fingerprint_idx ON public.brainstrike_diagnostic_events USING btree (fingerprint, occurred_at DESC);
CREATE INDEX bst_diagnostic_events_occurred_idx ON public.brainstrike_diagnostic_events USING btree (occurred_at DESC);
CREATE INDEX bst_diagnostic_events_run_idx ON public.brainstrike_diagnostic_events USING btree (run_id, occurred_at DESC) WHERE (run_id IS NOT NULL);
CREATE INDEX bst_diagnostic_events_severity_idx ON public.brainstrike_diagnostic_events USING btree (severity, occurred_at DESC);
CREATE INDEX bst_diagnostic_events_thread_idx ON public.brainstrike_diagnostic_events USING btree (thread_id) WHERE (thread_id IS NOT NULL);
CREATE UNIQUE INDEX brainstrike_mcp_task_authorities_live_scope_idx ON public.brainstrike_mcp_task_authorities USING btree (server_id, resource, principal_id) WHERE (retired_at IS NULL);
CREATE INDEX brainstrike_mcp_tasks_resume_idx ON public.brainstrike_mcp_tasks USING btree (authority_epoch, updated_at) WHERE (terminal_at IS NULL);
CREATE INDEX brainstrike_mind_ops_entity_idx ON public.brainstrike_mind_ops USING btree (entity_kind, entity_id);
CREATE INDEX idx_thread_message_index_embedding_hnsw ON public.brainstrike_thread_message_index USING hnsw (embedding vector_cosine_ops) WHERE (embedding IS NOT NULL);
CREATE INDEX idx_thread_message_index_errored_embedding ON public.brainstrike_thread_message_index USING btree (embedding_updated_at) WHERE (embedding_error IS NOT NULL);
CREATE INDEX idx_thread_message_index_pending_embedding ON public.brainstrike_thread_message_index USING btree (resource_id, message_created_at DESC) WHERE ((embedding IS NULL) AND (embedding_error IS NULL) AND (content_text <> ''::text));
CREATE INDEX idx_thread_message_index_resource ON public.brainstrike_thread_message_index USING btree (resource_id);
CREATE INDEX idx_thread_message_index_thread_created ON public.brainstrike_thread_message_index USING btree (thread_id, message_created_at DESC);
CREATE INDEX idx_thread_message_index_tsvector ON public.brainstrike_thread_message_index USING gin (content_tsvector);
CREATE INDEX brainstrike_token_estimate_calibration_model_idx ON public.brainstrike_token_estimate_calibration USING btree (model, occurred_at DESC);
CREATE INDEX brainstrike_token_estimate_calibration_occurred_at_idx ON public.brainstrike_token_estimate_calibration USING btree (occurred_at);
CREATE INDEX brainstrike_token_estimate_calibration_thread_idx ON public.brainstrike_token_estimate_calibration USING btree (thread_id);
CREATE INDEX brainstrike_tool_call_telemetry_occurred_at_idx ON public.brainstrike_tool_call_telemetry USING btree (occurred_at);
CREATE INDEX brainstrike_tool_call_telemetry_thread_idx ON public.brainstrike_tool_call_telemetry USING btree (thread_id);
CREATE INDEX brainstrike_tool_call_telemetry_tool_time_idx ON public.brainstrike_tool_call_telemetry USING btree (tool_id, occurred_at DESC);
CREATE INDEX brainstrike_workspace_snapshots_root_idx ON public.brainstrike_workspace_snapshots USING btree (root_id);
CREATE INDEX brainstrike_workspace_snapshots_thread_idx ON public.brainstrike_workspace_snapshots USING btree (thread_id, created_at);
CREATE INDEX brainstrike_worktrees_repo_active_idx ON public.brainstrike_worktrees USING btree (repo_common_dir) WHERE (archived_at IS NULL);
CREATE INDEX brainstrike_worktrees_thread_idx ON public.brainstrike_worktrees USING btree (thread_id);
CREATE INDEX idx_collection_indexing_stats_dirty ON public.collection_indexing_stats USING btree (dirty, last_refreshed_at);
CREATE INDEX idx_embedding_cache_accessed_at ON public.embedding_cache USING btree (accessed_at);
CREATE UNIQUE INDEX idx_embedding_cache_content_model ON public.embedding_cache USING btree (content_hash, model_key);
CREATE INDEX idx_embedding_dimension_index_maintenance_due ON public.embedding_dimension_index_maintenance USING btree (state, next_run_at, requested_at);
CREATE UNIQUE INDEX idx_embedding_sets_workspace_index_system_role ON public.embedding_sets USING btree (system_role) WHERE (system_role = 'workspace-index'::text);
CREATE INDEX idx_file_chunks_content_bm25 ON public.file_chunks USING bm25 (content) WITH (text_config=english);
CREATE INDEX idx_file_chunks_content_hash ON public.file_chunks USING btree (content_hash);
CREATE INDEX idx_file_chunks_content_trgm ON public.file_chunks USING gin (content gin_trgm_ops);
CREATE INDEX idx_file_chunks_content_tsvector ON public.file_chunks USING gin (content_tsvector);
CREATE INDEX idx_file_chunks_embedding_set_id ON public.file_chunks USING btree (embedding_set_id);
CREATE INDEX idx_file_chunks_file_record_id ON public.file_chunks USING btree (file_record_id);
CREATE INDEX idx_file_records_content_hash ON public.file_records USING btree (content_hash);
CREATE INDEX idx_file_records_embedding_set_id ON public.file_records USING btree (embedding_set_id);
CREATE INDEX idx_file_records_name_trgm ON public.file_records USING gin (name gin_trgm_ops);
CREATE INDEX idx_file_records_path ON public.file_records USING btree (path);
CREATE INDEX idx_file_records_root_id ON public.file_records USING btree (root_id);
CREATE UNIQUE INDEX idx_file_records_root_identity ON public.file_records USING btree (embedding_set_id, root_id, path) WHERE ((embedding_set_id IS NOT NULL) AND (root_id IS NOT NULL));
CREATE UNIQUE INDEX idx_file_records_text_partition_identity ON public.file_records USING btree (root_id, path) WHERE ((embedding_set_id IS NULL) AND (root_id IS NOT NULL));
CREATE INDEX idx_file_relationships_source ON public.file_relationships USING btree (source_id);
CREATE INDEX idx_file_relationships_target ON public.file_relationships USING btree (target_id);
CREATE INDEX idx_file_relationships_type ON public.file_relationships USING btree (relationship_type);
CREATE UNIQUE INDEX idx_file_relationships_unique ON public.file_relationships USING btree (source_id, target_id, relationship_type);
CREATE INDEX idx_file_symbol_refs_name_kind ON public.file_symbol_refs USING btree (name, kind);
CREATE INDEX idx_file_symbols_name ON public.file_symbols USING btree (name);
CREATE INDEX idx_file_tags_tag ON public.file_tags USING btree (tag);
CREATE UNIQUE INDEX idx_file_tags_unique ON public.file_tags USING btree (file_id, tag);
CREATE UNIQUE INDEX idx_file_token_cache_folder_path_unique ON public.file_token_cache USING btree (folder_id, file_path);
CREATE INDEX idx_file_token_cache_hash ON public.file_token_cache USING btree (content_hash);
CREATE INDEX idx_file_token_cache_mode ON public.file_token_cache USING btree (folder_id, counting_mode);
CREATE INDEX idx_job_queue_active_embed_chunk_id ON public.job_queue USING btree (chunk_id) WHERE ((job_type = 'embed_chunk'::text) AND (chunk_id IS NOT NULL) AND (state = ANY (ARRAY['queued'::text, 'running'::text])));
CREATE UNIQUE INDEX idx_job_queue_dedupe_active ON public.job_queue USING btree (dedupe_key) WHERE ((dedupe_key IS NOT NULL) AND (state = ANY (ARRAY['queued'::text, 'running'::text])));
CREATE INDEX idx_job_queue_dedupe_key ON public.job_queue USING btree (dedupe_key);
CREATE INDEX idx_job_queue_embed_set_state ON public.job_queue USING btree (queue, job_type, embedding_set_id, state, updated_at) WHERE ((job_type = 'embed_chunk'::text) AND (embedding_set_id IS NOT NULL));
CREATE INDEX idx_job_queue_leased_until ON public.job_queue USING btree (leased_until);
CREATE INDEX idx_job_queue_state_run_at ON public.job_queue USING btree (state, run_at);
CREATE INDEX idx_mastra_background_tasks_status ON public.mastra_background_tasks USING btree (status, agent_id);
CREATE INDEX idx_mastra_background_tasks_thread ON public.mastra_background_tasks USING btree (resource_id, thread_id, "createdAt", id);
CREATE INDEX mastra_messages_resourceid_createdat_idx ON public.mastra_messages USING btree ("resourceId", "createdAt" DESC);
CREATE INDEX mastra_messages_thread_id_createdat_idx ON public.mastra_messages USING btree (thread_id, "createdAt" DESC);
CREATE INDEX mastra_observational_memory_lookup_key_idx ON public.mastra_observational_memory USING btree ("lookupKey", "createdAt" DESC);
CREATE INDEX mastra_threads_resourceid_createdat_idx ON public.mastra_threads USING btree ("resourceId", "createdAt" DESC);
CREATE INDEX mastra_threads_resourceid_updatedat_idx ON public.mastra_threads USING btree ("resourceId", "updatedAt" DESC);
CREATE INDEX idx_models_provider_id ON public.models USING btree (provider_id);
CREATE INDEX idx_models_sort_order ON public.models USING btree (sort_order);
CREATE INDEX idx_prompt_items_embedding_profile_id ON public.prompt_items USING btree (embedding_profile_id);
CREATE INDEX idx_prompt_items_favorite_updated_at ON public.prompt_items USING btree (updated_at DESC) WHERE (is_favorite = true);
CREATE INDEX idx_prompt_items_kind_updated_at ON public.prompt_items USING btree (kind, updated_at DESC);
CREATE INDEX idx_prompt_items_tags ON public.prompt_items USING gin (tags);
CREATE INDEX idx_providers_sort_order ON public.providers USING btree (sort_order);
CREATE UNIQUE INDEX idx_roots_path_identity ON public.roots USING btree (path) WHERE ((path IS NOT NULL) AND (kind = 'path'::text));
CREATE INDEX idx_selection_snapshot_files_file_path ON public.selection_snapshot_files USING btree (file_path);
CREATE INDEX idx_selection_snapshot_files_snapshot_id ON public.selection_snapshot_files USING btree (snapshot_id);
CREATE UNIQUE INDEX idx_selection_snapshot_files_unique ON public.selection_snapshot_files USING btree (snapshot_id, file_path);
CREATE INDEX idx_selection_snapshots_created_at ON public.selection_snapshots USING btree (created_at);
CREATE INDEX idx_token_cache_content_hash ON public.token_cache USING btree (content_hash);
CREATE INDEX idx_token_cache_file_path ON public.token_cache USING btree (file_path);
CREATE INDEX idx_view_filter_presets_is_default ON public.view_filter_presets USING btree (is_default);
CREATE INDEX idx_view_filter_presets_sort_order ON public.view_filter_presets USING btree (sort_order);

-- SEED DATA (5)
INSERT INTO "brainstrike_thread_search_profiles" ("id", "model_id", "model_key", "dimensions", "distance") VALUES
  ('default'::text, 'Xenova/all-MiniLM-L6-v2'::text, 'local::Xenova/all-MiniLM-L6-v2'::text, '384'::integer, 'cosine'::text);
INSERT INTO "prompt_embedding_profiles" ("id", "model_id", "model_key", "dimensions", "distance") VALUES
  ('default'::text, 'Xenova/all-MiniLM-L6-v2'::text, 'local::Xenova/all-MiniLM-L6-v2'::text, '384'::integer, 'cosine'::text);
INSERT INTO "providers" ("id", "name", "icon", "is_enabled", "sort_order") VALUES
  ('anthropic'::text, 'Anthropic'::text, NULL, 'true'::boolean, '2'::integer),
  ('bedrock'::text, 'Amazon Bedrock'::text, NULL, 'false'::boolean, '8'::integer),
  ('cohere'::text, 'Cohere'::text, NULL, 'false'::boolean, '6'::integer),
  ('google'::text, 'Google AI Studio'::text, NULL, 'true'::boolean, '3'::integer),
  ('local'::text, 'Local (Browser)'::text, NULL, 'true'::boolean, '4'::integer),
  ('openai'::text, 'OpenAI'::text, NULL, 'true'::boolean, '1'::integer),
  ('openai-codex'::text, 'OpenAI (ChatGPT)'::text, NULL, 'false'::boolean, '9'::integer),
  ('openrouter'::text, 'OpenRouter'::text, NULL, 'false'::boolean, '5'::integer),
  ('voyage'::text, 'Voyage AI'::text, NULL, 'false'::boolean, '7'::integer);
INSERT INTO "view_filter_presets" ("name", "description", "icon", "includes", "excludes", "use_regex", "is_default", "sort_order") VALUES
  ('All Code'::text, 'All programming language source files'::text, 'code'::text, '{*.ts,*.tsx,*.js,*.jsx,*.py,*.rs,*.go,*.java,*.c,*.cpp,*.h,*.hpp,*.cs,*.rb,*.php,*.swift,*.kt}'::text[], '{node_modules,dist,build,target,__pycache__,.git,vendor}'::text[], 'false'::boolean, 'true'::boolean, '2'::integer),
  ('All Files'::text, 'Show all files without filtering'::text, 'folder-open'::text, '{*}'::text[], '{node_modules,.git,dist,build}'::text[], 'false'::boolean, 'true'::boolean, '7'::integer),
  ('Config Files'::text, 'Configuration and environment files'::text, 'settings'::text, '{*.json,*.yaml,*.yml,*.toml,*.ini,*.env*,*.config.*,tsconfig*,package.json,Cargo.toml}'::text[], '{node_modules,package-lock.json,yarn.lock,pnpm-lock.yaml}'::text[], 'false'::boolean, 'true'::boolean, '4'::integer),
  ('Documentation'::text, 'Markdown and documentation files'::text, 'file-text'::text, '{*.md,*.mdx,*.txt,*.rst,README*,LICENSE*,CHANGELOG*}'::text[], '{node_modules,.git}'::text[], 'false'::boolean, 'true'::boolean, '3'::integer),
  ('Styles'::text, 'CSS and styling files'::text, 'palette'::text, '{*.css,*.scss,*.sass,*.less,*.styl,*.styled.*}'::text[], '{node_modules,dist}'::text[], 'false'::boolean, 'true'::boolean, '5'::integer),
  ('Tests'::text, 'Test files only'::text, 'flask-conical'::text, '{*.test.*,*.spec.*,**/__tests__/**,**/tests/**,**/test/**}'::text[], '{node_modules,coverage}'::text[], 'false'::boolean, 'true'::boolean, '6'::integer),
  ('TypeScript/JavaScript'::text, 'Source files for TypeScript and JavaScript projects'::text, 'file-code'::text, '{*.ts,*.tsx,*.js,*.jsx,*.mjs,*.cjs}'::text[], '{node_modules,dist,build,.next,coverage,*.test.*,*.spec.*}'::text[], 'false'::boolean, 'true'::boolean, '1'::integer);
INSERT INTO "models" ("id", "provider_id", "name", "description", "tagline", "best_for", "icon", "is_enabled", "capabilities", "parameters", "sort_order") VALUES
  ('Xenova/all-MiniLM-L6-v2'::text, 'local'::text, 'all-MiniLM-L6-v2'::text, NULL, 'Fast & efficient'::text, '["English", "Speed"]'::jsonb, NULL, 'true'::boolean, '{"type": "embedding", "prompts": {"query": "", "document": ""}, "defaultDimension": 384}'::jsonb, '{"size": "~23MB"}'::jsonb, '3'::integer),
  ('Xenova/bge-base-en-v1.5'::text, 'local'::text, 'BGE Base'::text, NULL, 'High quality'::text, '["English", "Retrieval"]'::jsonb, NULL, 'false'::boolean, '{"type": "embedding", "prompts": {"query": "Represent this sentence for searching relevant passages: ", "document": ""}, "defaultDimension": 768}'::jsonb, '{"size": "~110MB"}'::jsonb, '5'::integer),
  ('Xenova/bge-large-en-v1.5'::text, 'local'::text, 'BGE Large'::text, NULL, 'SOTA performance'::text, '["English", "High accuracy"]'::jsonb, NULL, 'false'::boolean, '{"type": "embedding", "prompts": {"query": "Represent this sentence for searching relevant passages: ", "document": ""}, "defaultDimension": 1024}'::jsonb, '{"size": "~340MB"}'::jsonb, '6'::integer),
  ('Xenova/bge-small-en-v1.5'::text, 'local'::text, 'BGE Small'::text, NULL, 'Balanced performance'::text, '["English", "General purpose"]'::jsonb, NULL, 'true'::boolean, '{"type": "embedding", "prompts": {"query": "Represent this sentence for searching relevant passages: ", "document": ""}, "defaultDimension": 384}'::jsonb, '{"size": "~34MB"}'::jsonb, '4'::integer),
  ('Xenova/jina-embeddings-v2-base-en'::text, 'local'::text, 'Jina v2 Base EN'::text, NULL, 'Best English model'::text, '["English", "High performance"]'::jsonb, NULL, 'false'::boolean, '{"type": "embedding", "prompts": {"query": "", "document": ""}, "defaultDimension": 768}'::jsonb, '{"size": "~300MB"}'::jsonb, '2'::integer),
  ('amazon.nova-2-lite-v1:0'::text, 'bedrock'::text, 'Amazon Nova 2 Lite'::text, NULL, 'Reasoning Nova at low cost'::text, '["Reasoning", "Visual analysis", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '12'::integer),
  ('amazon.nova-lite-v1:0'::text, 'bedrock'::text, 'Amazon Nova Lite'::text, NULL, 'Low-cost multimodal Nova model'::text, '["High throughput", "Multimodal"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '7'::integer),
  ('amazon.nova-micro-v1:0'::text, 'bedrock'::text, 'Amazon Nova Micro'::text, NULL, 'Fastest text-only Nova model'::text, '["Simple tasks", "Speed"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '8'::integer),
  ('amazon.nova-pro-v1:0'::text, 'bedrock'::text, 'Amazon Nova Pro'::text, NULL, 'Capable multimodal Nova model'::text, '["Multimodal", "Document analysis"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '6'::integer),
  ('anthropic.claude-fable-5'::text, 'bedrock'::text, 'Claude Fable 5 (Bedrock)'::text, NULL, 'Frontier Claude through AWS'::text, '["Complex reasoning", "Coding", "Agentic workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '1'::integer),
  ('anthropic.claude-fable-5-1'::text, 'bedrock'::text, 'Claude Fable 5.1 (Bedrock)'::text, NULL, 'For demanding reasoning and long-horizon agentic work'::text, '["Long-horizon agentic coding", "Multistep research", "Document, spreadsheet, and slide work"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '13'::integer),
  ('anthropic.claude-haiku-4-5-20251001-v1:0'::text, 'bedrock'::text, 'Claude Haiku 4.5 (Bedrock)'::text, NULL, 'Fastest for lightweight tasks'::text, '["Quick responses", "High volume"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '5'::integer),
  ('anthropic.claude-opus-4-8'::text, 'bedrock'::text, 'Claude Opus 4.8 (Bedrock)'::text, NULL, 'For your toughest challenges'::text, '["Complex tasks", "Research", "Coding"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '2'::integer),
  ('anthropic.claude-opus-5'::text, 'bedrock'::text, 'Claude Opus 5 (Bedrock)'::text, NULL, 'Anthropic''s most advanced Opus model'::text, '["Long-running agents", "Coding", "Professional work"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '14'::integer),
  ('anthropic.claude-opus-5-5'::text, 'bedrock'::text, 'Claude Opus 5.5 (Bedrock)'::text, NULL, 'Anthropic''s most capable Opus model'::text, '["Coding", "Knowledge work", "Long-running tasks"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '15'::integer),
  ('anthropic.claude-sonnet-4-6'::text, 'bedrock'::text, 'Claude Sonnet 4.6 (Bedrock)'::text, NULL, 'Balanced Claude model'::text, '["Coding", "Analysis"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '4'::integer),
  ('anthropic.claude-sonnet-5'::text, 'bedrock'::text, 'Claude Sonnet 5 (Bedrock)'::text, NULL, 'Best mix of smarts and speed'::text, '["Coding", "Analysis", "Writing"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '3'::integer),
  ('anthropic/claude-fable-5'::text, 'openrouter'::text, 'Claude Fable 5 (OpenRouter)'::text, NULL, 'Highest-capability Claude 5 route'::text, '["Deep research", "Complex agents"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '22'::integer),
  ('anthropic/claude-fable-5.1'::text, 'openrouter'::text, 'Claude Fable 5.1 (OpenRouter)'::text, NULL, 'Improves on Claude Fable 5 across the board'::text, '["Agentic coding", "Long-running agentic workflows", "Knowledge work"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '49'::integer),
  ('anthropic/claude-haiku-4.5'::text, 'openrouter'::text, 'Claude Haiku 4.5 (OpenRouter)'::text, NULL, 'Fastest Claude model'::text, '["Quick responses"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '41'::integer),
  ('anthropic/claude-opus-4.8'::text, 'openrouter'::text, 'Claude Opus 4.8 (OpenRouter)'::text, NULL, 'Most capable Claude'::text, '["Deep research"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '39'::integer),
  ('anthropic/claude-opus-5'::text, 'openrouter'::text, 'Claude Opus 5 (OpenRouter)'::text, NULL, 'For complex agentic coding and enterprise work'::text, '["Agentic coding", "Enterprise work"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '50'::integer),
  ('anthropic/claude-opus-5.5'::text, 'openrouter'::text, 'Claude Opus 5.5 (OpenRouter)'::text, NULL, 'Anthropic''s flagship model, succeeding Claude Opus 5'::text, '["Demanding reasoning", "Coding", "Long-horizon agentic work"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '64'::integer),
  ('anthropic/claude-sonnet-4.6'::text, 'openrouter'::text, 'Claude Sonnet 4.6 (OpenRouter)'::text, NULL, 'Balanced Claude model'::text, '["Analysis", "Writing"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '40'::integer),
  ('anthropic/claude-sonnet-5'::text, 'openrouter'::text, 'Claude Sonnet 5 (OpenRouter)'::text, NULL, 'Balanced Claude 5 route'::text, '["Analysis", "Coding", "Writing"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '23'::integer),
  ('bytedance-seed/seed-2-1-turbo'::text, 'openrouter'::text, 'Seed 2.1 Turbo (OpenRouter)'::text, NULL, 'Multimodal model for coding and long-horizon agent workflows'::text, '["End-to-end software delivery", "Multi-step task execution"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '66'::integer),
  ('claude-fable-5'::text, 'anthropic'::text, 'Claude Fable 5'::text, NULL, 'Highest-capability Claude 5 tier'::text, '["Deep research", "Complex agents"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '1'::integer),
  ('claude-fable-5-1'::text, 'anthropic'::text, 'Claude Fable 5.1'::text, NULL, 'For demanding reasoning and long-horizon agentic work'::text, '["Long-horizon agentic coding", "Multistep research", "Document, spreadsheet, and slide work"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '7'::integer),
  ('claude-haiku-4-5'::text, 'anthropic'::text, 'Claude Haiku 4.5'::text, NULL, 'Fastest Claude model'::text, '["Quick responses", "Data extraction"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '6'::integer),
  ('claude-opus-4-8'::text, 'anthropic'::text, 'Claude Opus 4.8'::text, NULL, 'Most capable Claude model'::text, '["Deep research", "Agentic coding"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '3'::integer),
  ('claude-opus-5'::text, 'anthropic'::text, 'Claude Opus 5'::text, NULL, 'For complex agentic coding and enterprise work'::text, '["Agentic coding", "Enterprise work"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '2'::integer),
  ('claude-opus-5-5'::text, 'anthropic'::text, 'Claude Opus 5.5'::text, NULL, 'For long-running agentic coding and knowledge work'::text, '["Long-running agentic coding", "Knowledge work"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '8'::integer),
  ('claude-sonnet-4-6'::text, 'anthropic'::text, 'Claude Sonnet 4.6'::text, NULL, 'Best balance of speed and intelligence'::text, '["Analysis", "Coding", "Writing"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '5'::integer),
  ('claude-sonnet-5'::text, 'anthropic'::text, 'Claude Sonnet 5'::text, NULL, 'Balanced Claude 5 model'::text, '["Analysis", "Coding", "Writing"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '4'::integer),
  ('codex/gpt-5.3-codex-spark'::text, 'openai-codex'::text, 'GPT-5.3 Codex Spark'::text, NULL, 'Lightweight coding, included with your ChatGPT subscription'::text, '["Coding", "Cost efficiency"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '4'::integer),
  ('codex/gpt-5.4'::text, 'openai-codex'::text, 'GPT-5.4'::text, NULL, 'Included with your ChatGPT subscription'::text, '["General purpose", "Coding"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '2'::integer),
  ('codex/gpt-5.4-mini'::text, 'openai-codex'::text, 'GPT-5.4 Mini'::text, NULL, 'Faster, included with your ChatGPT subscription'::text, '["Fast responses", "Everyday tasks"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '3'::integer),
  ('codex/gpt-5.5'::text, 'openai-codex'::text, 'GPT-5.5'::text, NULL, 'Included with your ChatGPT subscription'::text, '["Complex reasoning", "Coding", "Agentic workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '1'::integer),
  ('cohere/command-a-plus'::text, 'openrouter'::text, 'Command A+ (OpenRouter)'::text, NULL, 'Cohere''s flagship model for enterprise agentic workflows'::text, '["Enterprise agentic workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '65'::integer),
  ('deepseek.v3.2'::text, 'bedrock'::text, 'DeepSeek V3.2 (Bedrock)'::text, NULL, 'Efficient open reasoning model'::text, '["Reasoning", "Cost efficiency"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '11'::integer),
  ('deepseek/deepseek-v4-flash'::text, 'openrouter'::text, 'DeepSeek V4 Flash (OpenRouter)'::text, NULL, 'Fast efficient DeepSeek route'::text, '["Fast iteration", "Coding"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '27'::integer),
  ('deepseek/deepseek-v4-flash-0731'::text, 'openrouter'::text, 'DeepSeek V4 Flash 0731 (OpenRouter)'::text, NULL, 'Sparse mixture-of-experts revision for coding, reasoning and agents'::text, '["Coding", "Reasoning", "Agent workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '57'::integer),
  ('deepseek/deepseek-v4-pro'::text, 'openrouter'::text, 'DeepSeek V4 Pro (OpenRouter)'::text, NULL, 'High-capability DeepSeek route'::text, '["Reasoning", "Coding"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '26'::integer),
  ('deepseek/deepseek-v4-pro-0813'::text, 'openrouter'::text, 'DeepSeek V4 Pro 0813 (OpenRouter)'::text, NULL, 'GA release snapshot of DeepSeek V4 Pro'::text, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '56'::integer),
  ('deepseek/deepseek-v4.1-flash'::text, 'openrouter'::text, 'DeepSeek V4.1 Flash (OpenRouter)'::text, NULL, 'Sparse mixture-of-experts flash model on DeepSeek''s Causal Encoder-Decoder architecture'::text, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '58'::integer),
  ('embed-english-v3.0'::text, 'cohere'::text, 'Embed English v3.0'::text, NULL, 'Optimized for English'::text, '["Search", "RAG"]'::jsonb, NULL, 'false'::boolean, '{"type": "embedding", "defaultDimension": 1024}'::jsonb, NULL, '1'::integer),
  ('embed-multilingual-v3.0'::text, 'cohere'::text, 'Embed Multilingual v3.0'::text, NULL, '100+ languages supported'::text, '["Global apps", "Cross-lingual search"]'::jsonb, NULL, 'false'::boolean, '{"type": "embedding", "defaultDimension": 1024}'::jsonb, NULL, '2'::integer),
  ('gemini-2.5-flash'::text, 'google'::text, 'Gemini 2.5 Flash'::text, NULL, 'Stable fast model'::text, '["Realtime apps", "High volume"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '6'::integer),
  ('gemini-2.5-flash-lite'::text, 'google'::text, 'Gemini 2.5 Flash Lite'::text, NULL, 'Stable lightweight flash'::text, '["Lightweight", "High volume"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '7'::integer),
  ('gemini-2.5-pro'::text, 'google'::text, 'Gemini 2.5 Pro'::text, NULL, 'Stable advanced reasoning'::text, '["Complex tasks", "Analysis"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '5'::integer),
  ('gemini-3.1-flash-lite'::text, 'google'::text, 'Gemini 3.1 Flash Lite'::text, NULL, 'Lightweight low-cost flash'::text, '["Lightweight", "High volume"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '4'::integer),
  ('gemini-3.1-pro-preview'::text, 'google'::text, 'Gemini 3.1 Pro (Preview)'::text, NULL, 'Advanced reasoning preview'::text, '["Complex tasks", "Analysis"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '3'::integer),
  ('gemini-3.5-flash'::text, 'google'::text, 'Gemini 3.5 Flash'::text, NULL, 'Stable low-latency flagship flash'::text, '["Realtime apps", "High volume"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '2'::integer),
  ('gemini-3.5-flash-lite'::text, 'google'::text, 'Gemini 3.5 Flash-Lite'::text, NULL, 'Low-latency multimodal for high-throughput subagent tasks and document parsing'::text, '["High-throughput subagent tasks", "Document parsing", "Low-latency multimodal execution"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '12'::integer),
  ('gemini-3.6-flash'::text, 'google'::text, 'Gemini 3.6 Flash'::text, NULL, 'Frontier intelligence for code generation and agentic execution'::text, '["Code generation", "Agentic execution", "Spatial reasoning"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '11'::integer),
  ('gemini-3.7-flash'::text, 'google'::text, 'Gemini 3.7 Flash'::text, NULL, 'Fast multimodal reasoning for complex agentic workflows'::text, '["Code generation", "Spatial/multimodal reasoning", "Multi-step agentic workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '1'::integer),
  ('gemini-3.8-flash'::text, 'google'::text, 'Gemini 3.8 Flash'::text, NULL, 'Long-horizon software engineering and autonomous agents at Flash speed'::text, '["Long-horizon software engineering", "Autonomous agents", "Complex enterprise workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '10'::integer),
  ('gemini-embedding-001'::text, 'google'::text, 'Gemini Embedding 001'::text, NULL, 'Configurable embeddings'::text, '["General purpose", "Retrieval"]'::jsonb, NULL, 'true'::boolean, '{"type": "embedding", "defaultDimension": 3072}'::jsonb, NULL, '8'::integer),
  ('gemini-embedding-2'::text, 'google'::text, 'Gemini Embedding 2'::text, NULL, 'Auto-normalizing configurable embeddings'::text, '["General purpose", "Retrieval"]'::jsonb, NULL, 'true'::boolean, '{"type": "embedding", "defaultDimension": 3072}'::jsonb, NULL, '9'::integer),
  ('google/gemini-2.5-flash'::text, 'openrouter'::text, 'Gemini 2.5 Flash (OpenRouter)'::text, NULL, 'Stable fast Gemini'::text, '["Realtime apps"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '44'::integer),
  ('google/gemini-3.1-pro-preview'::text, 'openrouter'::text, 'Gemini 3.1 Pro (OpenRouter)'::text, NULL, 'Advanced Gemini preview'::text, '["Complex tasks"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '43'::integer),
  ('google/gemini-3.5-flash'::text, 'openrouter'::text, 'Gemini 3.5 Flash (OpenRouter)'::text, NULL, 'Stable low-latency Gemini'::text, '["Realtime apps"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '42'::integer),
  ('google/gemini-3.5-flash-lite'::text, 'openrouter'::text, 'Gemini 3.5 Flash Lite (OpenRouter)'::text, NULL, 'Efficient model for focused agent tasks'::text, '["Subagents", "Focused coding tasks", "High-volume workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '12'::integer),
  ('google/gemini-3.6-flash'::text, 'openrouter'::text, 'Gemini 3.6 Flash (OpenRouter)'::text, NULL, 'High-efficiency coding and agentic model'::text, '["Coding", "Agentic workflows", "Multimodal development"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '11'::integer),
  ('google/gemini-3.7-flash'::text, 'openrouter'::text, 'Gemini 3.7 Flash (OpenRouter)'::text, NULL, 'Fast multimodal reasoning for agentic workflows'::text, '["Agentic workflows", "Coding", "Multimodal reasoning"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '8'::integer),
  ('google/gemini-3.8-flash'::text, 'openrouter'::text, 'Gemini 3.8 Flash (OpenRouter)'::text, NULL, 'Google''s most intelligent Flash model'::text, '["Software engineering", "Agentic tasks", "Multi-step reasoning"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '48'::integer),
  ('gpt-5.2'::text, 'openai'::text, 'GPT-5.2'::text, NULL, 'Previous-generation flagship'::text, '["Reasoning", "Coding"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '11'::integer),
  ('gpt-5.2-pro'::text, 'openai'::text, 'GPT-5.2 Pro'::text, NULL, 'Previous higher tier'::text, '["Complex reasoning"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '12'::integer),
  ('gpt-5.3-codex'::text, 'openai'::text, 'GPT-5.3 Codex'::text, NULL, 'Agentic coding model'::text, '["Coding", "Agentic"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '10'::integer),
  ('gpt-5.4'::text, 'openai'::text, 'GPT-5.4'::text, NULL, 'Balanced cost-aware flagship'::text, '["Reasoning", "Coding", "Multimodal"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '6'::integer),
  ('gpt-5.4-mini'::text, 'openai'::text, 'GPT-5.4 Mini'::text, NULL, 'Lower latency, lower cost'::text, '["Chat", "High volume"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '8'::integer),
  ('gpt-5.4-nano'::text, 'openai'::text, 'GPT-5.4 Nano'::text, NULL, 'Smallest, fastest tier'::text, '["Lightweight", "Classification"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '9'::integer),
  ('gpt-5.4-pro'::text, 'openai'::text, 'GPT-5.4 Pro'::text, NULL, 'Higher capability tier'::text, '["Complex reasoning", "Tool use"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '7'::integer),
  ('gpt-5.5'::text, 'openai'::text, 'GPT-5.5'::text, NULL, 'Newest flagship for complex work'::text, '["Reasoning", "Coding", "Agentic"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '4'::integer),
  ('gpt-5.5-pro'::text, 'openai'::text, 'GPT-5.5 Pro'::text, NULL, 'Highest capability tier'::text, '["Complex reasoning", "Tool use"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '5'::integer),
  ('gpt-5.6-luna'::text, 'openai'::text, 'GPT-5.6 Luna'::text, NULL, 'Efficient GPT-5.6 tier'::text, '["High volume", "Fast iteration"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '3'::integer),
  ('gpt-5.6-sol'::text, 'openai'::text, 'GPT-5.6 Sol'::text, NULL, 'Highest-capability GPT-5.6 tier'::text, '["Deep reasoning", "Agentic work"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '1'::integer),
  ('gpt-5.6-terra'::text, 'openai'::text, 'GPT-5.6 Terra'::text, NULL, 'Balanced GPT-5.6 tier'::text, '["Reasoning", "Coding", "Tool use"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '2'::integer),
  ('gpt-6-astra'::text, 'openai'::text, 'GPT-6 Astra'::text, NULL, 'Our most capable model, built for the hardest end-to-end work'::text, '["Reasoning", "Coding", "Computer use", "Research", "Document creation"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '15'::integer),
  ('gpt-6-luna'::text, 'openai'::text, 'GPT-6 Luna'::text, NULL, 'Our most efficient model for focused, high-volume tasks'::text, '["Focused tasks", "High-volume tasks"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '17'::integer),
  ('gpt-6-sol'::text, 'openai'::text, 'GPT-6 Sol'::text, NULL, 'Built to power complex coding and agentic workflows'::text, '["Complex coding", "Agentic workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '16'::integer),
  ('inclusionai/ling-3.0-flash'::text, 'openrouter'::text, 'Ling 3.0 Flash (OpenRouter)'::text, NULL, 'Token-efficient 124B-parameter MoE flash route for production-scale agentic inference'::text, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '59'::integer),
  ('jinaai/jina-embeddings-v2-base-code'::text, 'local'::text, 'Jina Code'::text, NULL, 'Code-aware embeddings'::text, '["Code search", "Multilingual"]'::jsonb, NULL, 'false'::boolean, '{"type": "embedding", "prompts": {"query": "", "document": ""}, "defaultDimension": 768}'::jsonb, '{"size": "~300MB"}'::jsonb, '1'::integer),
  ('kwaipilot/kat-coder-pro-v2.5'::text, 'openrouter'::text, 'KAT-Coder Pro V2.5 (OpenRouter)'::text, NULL, 'Flagship autonomous coding model'::text, '["Issue resolution", "Repository editing", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '15'::integer),
  ('meituan/longcat-2.0'::text, 'openrouter'::text, 'LongCat 2.0 (OpenRouter)'::text, NULL, 'Long-context repository coding model'::text, '["Repository changes", "Long-horizon coding", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '13'::integer),
  ('meta.llama4-maverick-17b-instruct-v1:0'::text, 'bedrock'::text, 'Llama 4 Maverick (Bedrock)'::text, NULL, 'Open-weight multimodal workhorse'::text, '["General purpose", "Multimodal"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '9'::integer),
  ('meta.llama4-scout-17b-instruct-v1:0'::text, 'bedrock'::text, 'Llama 4 Scout (Bedrock)'::text, NULL, 'Very long context, open weights'::text, '["Long context", "Large codebases"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '10'::integer),
  ('meta/muse-glimmer-30b'::text, 'openrouter'::text, 'Muse Glimmer 30B (OpenRouter)'::text, NULL, 'Dense open-weight multimodal model distilled from Muse Spark'::text, '["Autonomous agents on consumer hardware"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '63'::integer),
  ('meta/muse-spark-1.1'::text, 'openrouter'::text, 'Muse Spark 1.1 (OpenRouter)'::text, NULL, 'Multimodal agentic reasoning from Meta'::text, '["Agentic coding", "Tool use", "Multimodal workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '17'::integer),
  ('meta/muse-spark-1.2'::text, 'openrouter'::text, 'Muse Spark 1.2 (OpenRouter)'::text, NULL, 'Optimized for real coding workflows, with higher first-attempt accuracy and more reliable tool calling'::text, '["Multi-file refactors", "Long debugging sessions", "Whole-repository generation"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '3'::integer),
  ('meta/muse-spark-1.3'::text, 'openrouter'::text, 'Muse Spark 1.3 (OpenRouter)'::text, NULL, 'Multimodal reasoning for long-running agentic work'::text, '["Agentic workflows", "Multi-agent workflows", "Coding"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '47'::integer),
  ('meta/muse-spark-1.3-contributor'::text, 'openrouter'::text, 'Muse Spark 1.3 Contributor (OpenRouter)'::text, NULL, 'Cost-efficient contributor tier of Meta''s multimodal reasoning model'::text, '["Experimentation", "Learning", "Early-stage agentic workflows", "Multi-agent workflows", "Coding workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '62'::integer),
  ('minimax/minimax-m3'::text, 'openrouter'::text, 'MiniMax M3 (OpenRouter)'::text, NULL, 'Long-context general model'::text, '["Reasoning", "Agents", "Multilingual"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '25'::integer),
  ('moonshotai/kimi-k2.6'::text, 'openrouter'::text, 'Kimi K2.6 (OpenRouter)'::text, NULL, 'Long-context general model'::text, '["Reasoning", "Agents", "Multilingual"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '32'::integer),
  ('moonshotai/kimi-k2.7-code'::text, 'openrouter'::text, 'Kimi K2.7 Code (OpenRouter)'::text, NULL, 'Kimi coding specialist'::text, '["Coding", "Agentic development"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '33'::integer),
  ('moonshotai/kimi-k3'::text, 'openrouter'::text, 'Kimi K3 (OpenRouter)'::text, NULL, 'Million-token multimodal reasoning model'::text, '["Long-horizon coding", "Knowledge work", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '18'::integer),
  ('nvidia/nemotron-3-ultra-550b-a55b'::text, 'openrouter'::text, 'Nemotron 3 Ultra (OpenRouter)'::text, NULL, 'Open frontier-reasoning and orchestration mixture-of-experts model'::text, '["Reasoning", "Orchestration"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '68'::integer),
  ('nvidia/nemotron-3.5-lightning'::text, 'openrouter'::text, 'Nemotron 3.5 Lightning (OpenRouter)'::text, NULL, 'Efficient open reasoning for high-throughput agentic workloads'::text, '["Agentic workflows", "Long-context text", "Tool calling"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '5'::integer),
  ('onnx-community/gemma-4-E2B-it-ONNX'::text, 'local'::text, 'Gemma 4 E2B'::text, NULL, 'Desktop and browser local reasoning model with WebGPU acceleration'::text, '["General tasks", "Coding", "Tool calling", "Local reasoning"]'::jsonb, NULL, 'true'::boolean, '{"type": "llm", "vision": false, "streaming": false, "toolCalling": true, "contextWindow": 131072}'::jsonb, '{"size": "~3.9GB (text-only q4f16)", "device": "webgpu", "architecture": "Gemma 4 E2B", "quantization": "q4f16"}'::jsonb, '7'::integer),
  ('onnx-community/granite-embedding-small-english-r2-ONNX'::text, 'local'::text, 'Granite Embedding Small R2'::text, 'On Brainstrike''s retrieval eval of 100 code and docs queries it recalls 60% of relevant results in the top 10, against 52% for all-MiniLM-L6-v2. English, 384 dimensions; a 97 MB download for WebGPU. Without WebGPU it runs on WASM (52 MB), far more slowly and with more than 4 GB of memory.'::text, 'Best semantic search with WebGPU'::text, '["English", "Code search", "Retrieval"]'::jsonb, NULL, 'true'::boolean, '{"type": "embedding", "pooling": "cls", "prompts": {"query": "", "document": ""}, "defaultDimension": 384}'::jsonb, '{"size": "~97MB", "revision": "1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8", "execution": {"wasm": "q8", "webgpu": "fp16"}}'::jsonb, '0'::integer),
  ('openai/gpt-5.2'::text, 'openrouter'::text, 'GPT-5.2 (OpenRouter)'::text, NULL, 'Previous OpenAI flagship'::text, '["Reasoning", "Coding"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '38'::integer),
  ('openai/gpt-5.3-codex'::text, 'openrouter'::text, 'GPT-5.3 Codex (OpenRouter)'::text, NULL, 'Agentic coding model'::text, '["Coding", "Agentic"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '37'::integer),
  ('openai/gpt-5.4'::text, 'openrouter'::text, 'GPT-5.4 (OpenRouter)'::text, NULL, 'Balanced OpenAI flagship'::text, '["Reasoning", "Coding"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '35'::integer),
  ('openai/gpt-5.4-mini'::text, 'openrouter'::text, 'GPT-5.4 Mini (OpenRouter)'::text, NULL, 'Lower-cost OpenAI model'::text, '["Chat", "High volume"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '36'::integer),
  ('openai/gpt-5.5'::text, 'openrouter'::text, 'GPT-5.5 (OpenRouter)'::text, NULL, 'Newest OpenAI flagship'::text, '["Reasoning", "Coding"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '34'::integer),
  ('openai/gpt-5.6-luna'::text, 'openrouter'::text, 'GPT-5.6 Luna (OpenRouter)'::text, NULL, 'Efficient GPT-5.6 route'::text, '["High volume", "Fast iteration"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '21'::integer),
  ('openai/gpt-5.6-sol'::text, 'openrouter'::text, 'GPT-5.6 Sol (OpenRouter)'::text, NULL, 'Highest-capability GPT-5.6 route'::text, '["Deep reasoning", "Agentic work"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '19'::integer),
  ('openai/gpt-5.6-terra'::text, 'openrouter'::text, 'GPT-5.6 Terra (OpenRouter)'::text, NULL, 'Balanced GPT-5.6 route'::text, '["Reasoning", "Coding", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '20'::integer),
  ('openai/gpt-6-astra'::text, 'openrouter'::text, 'GPT-6 Astra (OpenRouter)'::text, NULL, 'OpenAI''s flagship model for demanding end-to-end work'::text, '["Advanced analysis", "Software engineering", "Deep research", "Document creation"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '45'::integer),
  ('openai/gpt-6-luna'::text, 'openrouter'::text, 'GPT-6 Luna (OpenRouter)'::text, NULL, 'Fast, cost-efficient model in OpenAI''s GPT-6 series'::text, '["High-volume workloads", "Latency-sensitive workloads", "Chat", "Classification"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '61'::integer),
  ('openai/gpt-6-sol'::text, 'openrouter'::text, 'GPT-6 Sol (OpenRouter)'::text, NULL, 'Cost-efficient high-end model in OpenAI''s GPT-6 series'::text, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '60'::integer),
  ('poolside/laguna-s-2.1'::text, 'openrouter'::text, 'Laguna S 2.1 (OpenRouter)'::text, NULL, 'Million-token coding agent from Poolside'::text, '["Repository-scale coding", "Terminal workflows", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '9'::integer),
  ('poolside/laguna-xs-2.1'::text, 'openrouter'::text, 'Laguna XS 2.1 (OpenRouter)'::text, NULL, 'Efficient coding agent from Poolside'::text, '["Coding", "Fast iteration", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '10'::integer),
  ('qwen/qwen3-coder-next'::text, 'openrouter'::text, 'Qwen3 Coder Next (OpenRouter)'::text, NULL, 'Qwen coding specialist'::text, '["Coding", "Agentic development"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '31'::integer),
  ('qwen/qwen3.6-flash'::text, 'openrouter'::text, 'Qwen3.6 Flash (OpenRouter)'::text, NULL, 'Fast Qwen model'::text, '["High volume", "Fast iteration"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '30'::integer),
  ('qwen/qwen3.7-max'::text, 'openrouter'::text, 'Qwen3.7 Max (OpenRouter)'::text, NULL, 'Flagship Qwen reasoning model'::text, '["Reasoning", "Agents", "Multilingual"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '28'::integer),
  ('qwen/qwen3.7-plus'::text, 'openrouter'::text, 'Qwen3.7 Plus (OpenRouter)'::text, NULL, 'Balanced Qwen reasoning model'::text, '["Reasoning", "Coding", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '29'::integer),
  ('qwen/qwen3.8-2.4t-a95b'::text, 'openrouter'::text, 'Qwen3.8 2.4T A95B (OpenRouter)'::text, NULL, 'Text-only mandatory-reasoning model for long agentic work'::text, '["Agentic coding", "Complex reasoning", "Long-context workflows"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '6'::integer),
  ('qwen/qwen3.8-27b'::text, 'openrouter'::text, 'Qwen3.8 27B (OpenRouter)'::text, NULL, 'Multimodal reasoning for coding and long-horizon agents'::text, '["Agentic workflows", "Coding", "Multimodal reasoning"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '7'::integer),
  ('qwen/qwen3.8-flash'::text, 'openrouter'::text, 'Qwen3.8 Flash (OpenRouter)'::text, NULL, NULL, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '1'::integer),
  ('qwen/qwen3.8-max-0902'::text, 'openrouter'::text, 'Qwen3.8 Max 0902 (OpenRouter)'::text, NULL, 'Updated snapshot of Qwen3.8 Max'::text, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '46'::integer),
  ('qwen/qwen3.8-omni-flash'::text, 'openrouter'::text, 'Qwen3.8 Omni Flash (OpenRouter)'::text, NULL, 'Omni-modal reasoning model with native audio-video understanding'::text, '["Audio-video analysis", "Summarization"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '67'::integer),
  ('tencent/hy3'::text, 'openrouter'::text, 'Hy3 (OpenRouter)'::text, NULL, 'Mixture-of-experts model for reasoning and agentic workflows'::text, '["Reasoning", "Agentic workflows", "Production use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '53'::integer),
  ('tencent/hy4-preview'::text, 'openrouter'::text, 'Hy4 Preview (OpenRouter)'::text, NULL, 'Mixture-of-experts preview for coding agents and tool use'::text, '["Coding agents", "Tool use", "Productivity tasks"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '51'::integer),
  ('text-embedding-3-large'::text, 'openai'::text, 'Text Embedding 3 Large'::text, NULL, 'High-precision embeddings'::text, '["Semantic search", "Knowledge retrieval"]'::jsonb, NULL, 'true'::boolean, '{"type": "embedding", "defaultDimension": 3072}'::jsonb, NULL, '14'::integer),
  ('text-embedding-3-small'::text, 'openai'::text, 'Text Embedding 3 Small'::text, NULL, 'Efficient embeddings'::text, '["Search", "Clustering"]'::jsonb, NULL, 'true'::boolean, '{"type": "embedding", "defaultDimension": 1536}'::jsonb, NULL, '13'::integer),
  ('thinkingmachines/inkling'::text, 'openrouter'::text, 'Inkling (OpenRouter)'::text, NULL, 'Multimodal reasoning for agent systems'::text, '["Coding", "Agentic workflows", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '14'::integer),
  ('thinkingmachines/inkling-small'::text, 'openrouter'::text, 'Inkling Small (OpenRouter)'::text, NULL, 'Open-weight multimodal mixture-of-experts with 12B of 276B parameters active'::text, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '69'::integer),
  ('upstage/solar-pro4'::text, 'openrouter'::text, 'Solar Pro 4 (OpenRouter)'::text, NULL, 'Cost-efficient long-context model for document-intensive work'::text, '["Long-horizon tasks", "Agentic workflows", "Office productivity"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '55'::integer),
  ('voyage-3'::text, 'voyage'::text, 'Voyage 3'::text, NULL, 'State-of-the-art retrieval'::text, '["Legal", "Finance", "Code"]'::jsonb, NULL, 'false'::boolean, '{"type": "embedding", "defaultDimension": 1024}'::jsonb, NULL, '1'::integer),
  ('voyage-3-lite'::text, 'voyage'::text, 'Voyage 3 Lite'::text, NULL, 'Efficient retrieval'::text, '["Low latency apps"]'::jsonb, NULL, 'false'::boolean, '{"type": "embedding", "defaultDimension": 512}'::jsonb, NULL, '2'::integer),
  ('x-ai/grok-4.5'::text, 'openrouter'::text, 'Grok 4.5 (OpenRouter)'::text, NULL, 'Frontier coding and knowledge-work model'::text, '["Coding", "Knowledge work", "Reasoning"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '16'::integer),
  ('x-ai/grok-4.6'::text, 'openrouter'::text, 'Grok 4.6 (OpenRouter)'::text, NULL, 'Frontier multimodal reasoning for coding, agentic work, and STEM'::text, '["Agentic coding", "Knowledge work", "Long-context reasoning"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '4'::integer),
  ('x-ai/grok-4.7'::text, 'openrouter'::text, 'Grok 4.7 (OpenRouter)'::text, NULL, 'Flagship model for coding, agentic tasks, and knowledge work, succeeding Grok 4.6'::text, '["Coding", "Agentic tasks", "Knowledge work", "Long-running software engineering"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '70'::integer),
  ('xiaomi/mimo-v2.5'::text, 'openrouter'::text, 'MiMo-V2.5 (OpenRouter)'::text, NULL, 'Omnimodal model with image and video understanding'::text, '["Agentic tasks", "Image understanding", "Video understanding"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '54'::integer),
  ('xiaomi/mimo-v2.6-flash'::text, 'openrouter'::text, 'MiMo-V2.6-Flash (OpenRouter)'::text, NULL, 'Open-source mixture-of-experts model with 15B of 309B parameters active'::text, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '73'::integer),
  ('xiaomi/mimo-v2.6-pro'::text, 'openrouter'::text, 'MiMo-V2.6-Pro (OpenRouter)'::text, NULL, 'Xiaomi''s flagship foundation model, built at over 1T parameters'::text, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '72'::integer),
  ('z-ai/glm-5.2'::text, 'openrouter'::text, 'GLM-5.2 (OpenRouter)'::text, NULL, 'Long-context agentic reasoning'::text, '["Reasoning", "Coding", "Tool use"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '24'::integer),
  ('z-ai/glm-5.3'::text, 'openrouter'::text, 'GLM-5.3 (OpenRouter)'::text, NULL, NULL, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": false, "streaming": true}'::jsonb, NULL, '2'::integer),
  ('z-ai/glm-5.3-flash'::text, 'openrouter'::text, 'GLM 5.3 Flash (OpenRouter)'::text, NULL, 'Native multimodal model for efficient coding and long-horizon agents'::text, '["Coding", "Long-horizon agents", "Long context"]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '52'::integer),
  ('z-ai/glm-5.3-flashx'::text, 'openrouter'::text, 'GLM 5.3 FlashX (OpenRouter)'::text, NULL, 'High-speed variant of GLM-5.3-Flash at up to 200 tokens/s'::text, '[]'::jsonb, NULL, 'false'::boolean, '{"type": "llm", "vision": true, "streaming": true}'::jsonb, NULL, '71'::integer);
`;
