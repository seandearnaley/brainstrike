import type { AssistantEditCheckpointRecord } from '@brainstrike/assistant-contract';
import {
  ASSISTANT_MESSAGE_TOMBSTONES_TABLE,
  DEFAULT_THREAD_TITLE,
  MASTRA_MEMORY_TABLES,
  MIND_OPS_TABLE,
  THREAD_DELETE_SIDECAR_TABLES,
  THREAD_TITLE_SOURCE_METADATA_KEY,
  THREAD_TITLE_SOURCE_OM,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  type AssistantRunEvent,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/assistant-contract/run-events';
import type { DbHandle } from '@brainstrike/db/react';
import {
  ASSISTANT_RUN_OUTCOME_SOURCES,
  ASSISTANT_RUN_OUTCOME_VERDICTS,
  CROSS_ROOT_USAGE_AGGREGATION_SQL,
  mapCrossRootUsageRow,
  mapRunLedgerRow,
  RUN_LEDGER_AGGREGATION_SQL,
  RUN_LEDGER_DEFAULT_LIMIT,
  RUN_LEDGER_MAX_LIMIT,
  RUN_OUTCOME_DETAIL_MAX_CHARS,
} from './assistant-run-ledger.js';
import {
  assertAllBulkThreadsFound,
  assertBulkThreadMetadataPatch,
  assertPersistableThreadMetadata,
  normalizeThreadMetadataForPersistence,
  requireAssistantThreadIds,
  requireNonemptyThreadMetadata,
  threadIdValuesSql,
} from './assistant-thread-metadata.js';
import {
  mapAssistantHistoryMessageRow,
  requireRunUsageKind,
  toEditCheckpointRecord,
  toLatestThreadRunRecord,
  toMemoryThread,
  toThreadRunEvent,
  toThreadRunRecord,
} from './assistant-thread-rows.js';
import {
  ASSISTANT_EDIT_CHECKPOINTS_TABLE,
  ASSISTANT_MESSAGE_PARENTS_TABLE,
  ASSISTANT_RUN_EVENTS_TABLE,
  ASSISTANT_RUN_OUTCOMES_TABLE,
  ASSISTANT_RUN_USAGE_TABLE,
  ASSISTANT_THREAD_RUNS_TABLE,
  assertAssistantMemorySchema,
  LATEST_THREAD_RUNS_BY_RESOURCE_SQL,
} from './assistant-thread-schema.js';
import type {
  AssistantHistoryMessage,
  AssistantMemoryThread,
  AssistantThreadMessageListOptions,
  AssistantThreadMetadata,
  AssistantThreadRepository,
  AssistantThreadRunEventListOptions,
  AssistantThreadRunRecord,
  CompleteAssistantThreadRunInput,
  CreateAssistantThreadRunInput,
  CrossRootUsageRow,
  RecordAssistantMessageParentInput,
  RecordRunOutcomeInput,
  RecordRunUsageInput,
  RunLedgerListOptions,
  RunLedgerRow,
  ThreadCumulativeUsage,
  ThreadModelUsageSubtotal,
} from './assistant-thread-types.js';
import {
  assertUsageTokenCount,
  normalizeDate,
  optionalNonNegativeFiniteNumber,
  parseJson,
  requireNonEmptyTopologyId,
  requireNonNegativeInteger,
  requireString,
} from './assistant-value-coercion.js';

const assistantThreadRepositoryCache = new WeakMap<DbHandle, AssistantThreadRepository>();

const assistantThreadSchemaProbePromises = new WeakMap<DbHandle, Promise<void>>();

function createThreadId(): string {
  return `thread-${crypto.randomUUID()}`;
}

function resolveInitialThreadTitle(title: string | undefined): string {
  if (title === undefined) {
    return DEFAULT_THREAD_TITLE;
  }
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    throw new Error('Thread title is required.');
  }
  return normalizedTitle;
}

export function createPgliteAssistantThreadRepository(
  database: DbHandle
): AssistantThreadRepository {
  const cachedRepository = assistantThreadRepositoryCache.get(database);
  if (cachedRepository) {
    return cachedRepository;
  }
  /**
   * One probe per database handle, memoized like the bootstrap it replaced. A
   * FAILED probe drops its promise so the next call re-probes: the handle may
   * legitimately become migrated (the browser first-run bootstrap and desktop
   * main both migrate before handing a handle out, but a test — or a future
   * caller that races init — can hold one that is not migrated yet). Caching
   * the negative answer would be the same "decide once, hide forever" mistake
   * the sidecar-presence latch in `PgliteMemoryStore` avoids.
   */
  const initialize = async (): Promise<void> => {
    let probePromise = assistantThreadSchemaProbePromises.get(database);
    if (!probePromise) {
      probePromise = assertAssistantMemorySchema(database).catch((error: unknown) => {
        assistantThreadSchemaProbePromises.delete(database);
        throw error;
      });
      assistantThreadSchemaProbePromises.set(database, probePromise);
    }
    await probePromise;
  };

  const listLatestThreadRuns = async (
    resourceId: string
  ): Promise<readonly AssistantThreadRunRecord[]> => {
    await initialize();
    const result = await database.query<Record<string, unknown>>(
      `SELECT
          latest_run.id,
          latest_run.resource_id AS "resourceId",
          latest_run.thread_id AS "threadId",
          latest_run.provider,
          latest_run.model,
          latest_run.model_settings AS "modelSettings",
          latest_run.provider_options AS "providerOptions",
          latest_run.runtime_kind AS "runtimeKind",
          latest_run.status,
          latest_run.error,
          latest_run.started_at AS "startedAt",
          latest_run.completed_at AS "completedAt",
          latest_run.created_at AS "createdAt",
          latest_run.updated_at AS "updatedAt",
          latest_run.turn_message_id AS "turnMessageId"
       FROM (${LATEST_THREAD_RUNS_BY_RESOURCE_SQL}) AS latest_run`,
      [resourceId]
    );
    return result.rows.map(toThreadRunRecord);
  };

  const listThreadCheckpoints = async (
    threadId: string
  ): Promise<readonly AssistantEditCheckpointRecord[]> => {
    await initialize();
    // Read-through only (Path A, like listThreadRunEvents). Queried across ALL
    // runs (not narrowed to the latest run) so past turns' edit cards stay
    // revertible after reload. before_content is intentionally NOT selected —
    // the raw prior bytes never leave the main process; revert reads them there.
    const result = await database.query<Record<string, unknown>>(
      `SELECT
          id,
          run_id AS "runId",
          resource_id AS "resourceId",
          thread_id AS "threadId",
          tool_call_id AS "toolCallId",
          tool_name AS "toolName",
          op,
          root_id AS "rootId",
          path,
          from_path AS "fromPath",
          before_existed AS "beforeExisted",
          before_hash AS "beforeHash",
          before_size AS "beforeSize",
          after_existed AS "afterExisted",
          after_hash AS "afterHash",
          capture_status AS "captureStatus",
          reverted_at AS "revertedAt",
          occurred_at AS "occurredAt"
       FROM ${ASSISTANT_EDIT_CHECKPOINTS_TABLE}
       WHERE thread_id = $1
       ORDER BY occurred_at ASC, id ASC`,
      [threadId]
    );
    return result.rows.map(toEditCheckpointRecord);
  };

  const listThreadRunEvents = async (
    threadId: string,
    resourceId: string,
    options?: AssistantThreadRunEventListOptions
  ): Promise<readonly AssistantRunEvent[]> => {
    await initialize();
    const limitLatestRuns =
      typeof options?.limitLatestRuns === 'number' && Number.isSafeInteger(options.limitLatestRuns)
        ? options.limitLatestRuns
        : undefined;
    if (limitLatestRuns !== undefined && limitLatestRuns < 1) {
      throw new Error('Assistant run event history limit must be a positive safe integer.');
    }
    const params: unknown[] = [threadId, resourceId];
    const boundedRunFilter =
      limitLatestRuns === undefined
        ? ''
        : `AND run.id IN (
            SELECT recent_run.id
            FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS recent_run
            WHERE recent_run.thread_id = $1 AND recent_run.resource_id = $2
            ORDER BY recent_run.started_at DESC, recent_run.created_at DESC, recent_run.id DESC
            LIMIT $3
          )`;
    if (limitLatestRuns !== undefined) {
      params.push(limitLatestRuns);
    }
    const result = await database.query<Record<string, unknown>>(
      `SELECT
          event.id,
          event.run_id,
          event.sequence,
          event.kind,
          event.status,
          event.label,
          event.detail,
          event.duration_ms,
          event.metadata,
          event.occurred_at
       FROM ${ASSISTANT_RUN_EVENTS_TABLE} AS event
       INNER JOIN ${ASSISTANT_THREAD_RUNS_TABLE} AS run ON run.id = event.run_id
       WHERE event.thread_id = $1
          AND event.resource_id = $2
          ${boundedRunFilter}
       ORDER BY run.started_at ASC, run.created_at ASC, run.id ASC,
                event.sequence ASC, event.occurred_at ASC, event.id ASC`,
      params
    );
    return result.rows.map(toThreadRunEvent);
  };

  const repository: AssistantThreadRepository = {
    async appendThreadRunEvent(runId: string, event: AssistantRunEvent): Promise<void> {
      await initialize();
      const sequence = event.sequence ?? 0;
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error('Assistant run event sequence must be a non-negative safe integer.');
      }
      const occurredAt = normalizeDate(event.timestamp);
      const sanitizedMetadata = sanitizeAssistantRunEventMetadata(event.metadata);
      const now = new Date();
      await database.query(
        `INSERT INTO ${ASSISTANT_RUN_EVENTS_TABLE}
          (
            id,
            run_id,
            resource_id,
            thread_id,
            sequence,
            kind,
            status,
            label,
            detail,
            metadata,
            duration_ms,
            occurred_at,
            created_at,
            updated_at
          )
         SELECT
            $1,
            runs.id,
            runs.resource_id,
            runs.thread_id,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8::jsonb,
            $9,
            $10,
            $11,
            $12
         FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
         WHERE runs.id = $2
         ON CONFLICT (id) DO UPDATE SET
            sequence = EXCLUDED.sequence,
            kind = EXCLUDED.kind,
            status = EXCLUDED.status,
            label = EXCLUDED.label,
            detail = EXCLUDED.detail,
            metadata = EXCLUDED.metadata,
            duration_ms = EXCLUDED.duration_ms,
            occurred_at = EXCLUDED.occurred_at,
            updated_at = EXCLUDED.updated_at`,
        [
          event.id,
          runId,
          sequence,
          event.kind,
          event.status,
          event.label,
          event.detail ?? null,
          sanitizedMetadata ? JSON.stringify(sanitizedMetadata) : null,
          event.durationMs ?? null,
          occurredAt,
          now,
          now,
        ]
      );
    },
    async completeThreadRun(runId: string, input: CompleteAssistantThreadRunInput): Promise<void> {
      await initialize();
      await database.query(
        `UPDATE ${ASSISTANT_THREAD_RUNS_TABLE}
         SET status = $2, error = $3, completed_at = $4, updated_at = $5
         WHERE id = $1`,
        [runId, input.status, input.error ?? null, new Date(), new Date()]
      );
    },
    async createThread(resourceId: string, title?: string): Promise<AssistantMemoryThread> {
      await initialize();
      const now = new Date();
      const thread = {
        createdAt: now,
        id: createThreadId(),
        resourceId,
        title: resolveInitialThreadTitle(title),
        updatedAt: now,
      } satisfies AssistantMemoryThread;
      await database.query(
        `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
          (id, "resourceId", title, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          thread.id,
          thread.resourceId,
          thread.title,
          // Only the default title is an OM-owned placeholder. An explicit
          // creation title is user-owned and must never be auto-overwritten.
          JSON.stringify({
            source: 'brainstrike',
            ...(title === undefined
              ? { [THREAD_TITLE_SOURCE_METADATA_KEY]: THREAD_TITLE_SOURCE_OM }
              : {}),
          }),
          thread.createdAt,
          thread.updatedAt,
        ]
      );
      return thread;
    },
    async createThreadRun(input: CreateAssistantThreadRunInput): Promise<AssistantThreadRunRecord> {
      await initialize();
      const now = new Date();
      const startedAt = input.startedAt ?? now;
      const completedAt = input.completedAt ?? null;
      const record = {
        completedAt,
        createdAt: now,
        error: input.error ?? null,
        id: input.id,
        model: input.model,
        provider: input.provider,
        resourceId: input.resourceId,
        runtimeKind: input.runtimeKind,
        startedAt,
        status: input.status ?? 'running',
        threadId: input.threadId,
        turnMessageId: input.turnMessageId ?? null,
        updatedAt: now,
        ...(input.modelSettings ? { modelSettings: { ...input.modelSettings } } : {}),
        ...(input.providerOptions ? { providerOptions: { ...input.providerOptions } } : {}),
      } satisfies AssistantThreadRunRecord;
      await database.query(
        `INSERT INTO ${ASSISTANT_THREAD_RUNS_TABLE}
          (
            id,
            resource_id,
            thread_id,
            provider,
            model,
            model_settings,
            provider_options,
            runtime_kind,
            status,
            error,
            started_at,
            completed_at,
            created_at,
            updated_at,
            turn_message_id
          )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          record.id,
          record.resourceId,
          record.threadId,
          record.provider,
          record.model,
          record.modelSettings ? JSON.stringify(record.modelSettings) : null,
          record.providerOptions ? JSON.stringify(record.providerOptions) : null,
          record.runtimeKind,
          record.status,
          record.error,
          record.startedAt,
          record.completedAt,
          record.createdAt,
          record.updatedAt,
          record.turnMessageId,
        ]
      );
      return record;
    },
    async deleteThread(threadId: string): Promise<void> {
      await initialize();
      // Sidecar stages derive from the ONE shared cascade spec so the
      // single/bulk CTEs (and the Mastra store override) can never drift in
      // stage-set or ordering again (BST-993). This path previously omitted
      // thread placements and relied on the panel's separate
      // clearThreadPlacement round trip; the CTE now owns the full cascade
      // (placements without a live thread were already inert by contract).
      const sidecarStages = THREAD_DELETE_SIDECAR_TABLES.map(
        ({ table, threadColumn }) => `deleted_${table} AS (
            DELETE FROM ${table}
            WHERE ${threadColumn} = $1
            RETURNING ${threadColumn}
          )`
      ).join(',\n          ');
      const sidecarCounts = THREAD_DELETE_SIDECAR_TABLES.map(
        ({ table }) => `(SELECT count(*) FROM deleted_${table}) AS "deleted_${table}_count"`
      ).join(',\n          ');
      await database.query(
        `WITH deleted_observational_memory AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
            WHERE "threadId" = $1 OR "lookupKey" = $2
            RETURNING id
          ),
          deleted_messages AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.messages}
            WHERE thread_id = $1
            RETURNING id
          ),
          ${sidecarStages},
          deleted_thread AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.threads}
            WHERE id = $1
            RETURNING id, "resourceId"
          ),
          inserted_mind_ops AS (
            INSERT INTO ${MIND_OPS_TABLE} (entity_kind, entity_id, op, resource_id)
            SELECT 'thread', id, 'delete', "resourceId" FROM deleted_thread
            RETURNING seq
          )
         SELECT
          (SELECT count(*) FROM deleted_observational_memory) AS deleted_observational_memory_count,
          (SELECT count(*) FROM deleted_messages) AS deleted_message_count,
          ${sidecarCounts},
          (SELECT count(*) FROM deleted_thread) AS deleted_thread_count,
          (SELECT count(*) FROM inserted_mind_ops) AS inserted_mind_op_count`,
        [threadId, `thread:${threadId}`]
      );
    },
    async deleteThreads(threadIds: readonly string[]): Promise<void> {
      requireAssistantThreadIds(threadIds);
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `WITH requested(id) AS (
            VALUES ${threadIdValuesSql(threadIds)}
          ),
          validation AS (
            SELECT COUNT(threads.id) = ${threadIds.length} AS all_found
            FROM requested
            LEFT JOIN ${MASTRA_MEMORY_TABLES.threads} AS threads ON threads.id = requested.id
          ),
          deleted_observational_memory AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
            WHERE (SELECT all_found FROM validation)
              AND (
                "threadId" IN (SELECT id FROM requested)
                OR "lookupKey" IN (SELECT 'thread:' || id FROM requested)
              )
            RETURNING id
          ),
          deleted_messages AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.messages}
            WHERE (SELECT all_found FROM validation)
              AND thread_id IN (SELECT id FROM requested)
            RETURNING id
          ),
          ${THREAD_DELETE_SIDECAR_TABLES.map(
            ({ table, threadColumn }) => `deleted_${table} AS (
            DELETE FROM ${table}
            WHERE (SELECT all_found FROM validation)
              AND ${threadColumn} IN (SELECT id FROM requested)
            RETURNING ${threadColumn}
          )`
          ).join(',\n          ')},
          deleted_threads AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.threads}
            WHERE (SELECT all_found FROM validation)
              AND id IN (SELECT id FROM requested)
            RETURNING id, "resourceId"
          ),
          inserted_mind_ops AS (
            INSERT INTO ${MIND_OPS_TABLE} (entity_kind, entity_id, op, resource_id)
            SELECT 'thread', id, 'delete', "resourceId" FROM deleted_threads
            RETURNING seq
          )
         SELECT
          (SELECT all_found FROM validation) AS "allFound",
          (SELECT count(*) FROM deleted_observational_memory) AS "deletedObservationalMemoryCount",
          (SELECT count(*) FROM deleted_messages) AS "deletedMessageCount",
          ${THREAD_DELETE_SIDECAR_TABLES.map(
            ({ table }) => `(SELECT count(*) FROM deleted_${table}) AS "deleted_${table}_count"`
          ).join(',\n          ')},
          (SELECT count(*) FROM deleted_threads) AS "deletedThreadCount",
          (SELECT count(*) FROM inserted_mind_ops) AS "insertedMindOpCount"`,
        [...threadIds]
      );
      assertAllBulkThreadsFound(result.rows[0]);
    },
    async getCrossRootUsage(resourceId: string): Promise<readonly CrossRootUsageRow[]> {
      await initialize();
      // Single source of truth shared with the reactive live-query hook
      // (CROSS_ROOT_USAGE_AGGREGATION_SQL + mapCrossRootUsageRow) so the
      // grouping/ordering/roots-join and the strict no-fabrication parse can
      // never drift between the validated method and the panel's query.
      const result = await database.query<Record<string, unknown>>(
        CROSS_ROOT_USAGE_AGGREGATION_SQL,
        [resourceId]
      );
      return result.rows.map(mapCrossRootUsageRow);
    },
    async getRunLedger(
      resourceId: string,
      options?: RunLedgerListOptions
    ): Promise<readonly RunLedgerRow[]> {
      const limit = options?.limitLatest ?? RUN_LEDGER_DEFAULT_LIMIT;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > RUN_LEDGER_MAX_LIMIT) {
        throw new Error(`Run ledger limitLatest must be between 1 and ${RUN_LEDGER_MAX_LIMIT}.`);
      }
      await initialize();
      // Single source of truth shared with any future reactive consumer
      // (RUN_LEDGER_AGGREGATION_SQL + mapRunLedgerRow) — same convention as
      // getCrossRootUsage.
      const result = await database.query<Record<string, unknown>>(RUN_LEDGER_AGGREGATION_SQL, [
        resourceId,
        limit,
      ]);
      return result.rows.map(mapRunLedgerRow);
    },
    async getThreadCumulativeUsage(threadId: string): Promise<ThreadCumulativeUsage | null> {
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `SELECT
            provider,
            model,
            run_kind AS "runKind",
            SUM(input_tokens)::bigint AS "inputTokens",
            SUM(output_tokens)::bigint AS "outputTokens",
            SUM(COALESCE(cache_read_input_tokens, 0))::bigint AS "cacheReadTokens",
            SUM(COALESCE(cache_creation_input_tokens, 0))::bigint AS "cacheCreationTokens",
            SUM(billed_cost_usd) AS "billedCostUsd",
            SUM(CASE WHEN billed_cost_usd IS NULL THEN input_tokens ELSE 0 END)::bigint
              AS "estimatedInputTokens",
            SUM(CASE WHEN billed_cost_usd IS NULL THEN output_tokens ELSE 0 END)::bigint
              AS "estimatedOutputTokens",
            SUM(CASE WHEN billed_cost_usd IS NULL THEN COALESCE(cache_read_input_tokens, 0) ELSE 0 END)::bigint
              AS "estimatedCacheReadTokens",
            SUM(CASE WHEN billed_cost_usd IS NULL THEN COALESCE(cache_creation_input_tokens, 0) ELSE 0 END)::bigint
              AS "estimatedCacheCreationTokens"
         FROM ${ASSISTANT_RUN_USAGE_TABLE}
         WHERE thread_id = $1
         GROUP BY provider, model, run_kind
         ORDER BY provider ASC, model ASC, run_kind ASC`,
        [threadId]
      );
      if (result.rows.length === 0) {
        return null;
      }
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const perModel = result.rows.map((row) => {
        const inputTokens = requireNonNegativeInteger(row['inputTokens'], 'inputTokens');
        const outputTokens = requireNonNegativeInteger(row['outputTokens'], 'outputTokens');
        const billedCostUsd = optionalNonNegativeFiniteNumber(
          row['billedCostUsd'],
          'billedCostUsd'
        );
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        return {
          ...(billedCostUsd === undefined
            ? {}
            : {
                billedCostUsd,
                estimatedInputTokens: requireNonNegativeInteger(
                  row['estimatedInputTokens'],
                  'estimatedInputTokens'
                ),
                estimatedOutputTokens: requireNonNegativeInteger(
                  row['estimatedOutputTokens'],
                  'estimatedOutputTokens'
                ),
              }),
          cacheCreationTokens: requireNonNegativeInteger(
            row['cacheCreationTokens'] ?? 0,
            'cacheCreationTokens'
          ),
          cacheReadTokens: requireNonNegativeInteger(
            row['cacheReadTokens'] ?? 0,
            'cacheReadTokens'
          ),
          estimatedCacheCreationTokens: requireNonNegativeInteger(
            row['estimatedCacheCreationTokens'] ?? 0,
            'estimatedCacheCreationTokens'
          ),
          estimatedCacheReadTokens: requireNonNegativeInteger(
            row['estimatedCacheReadTokens'] ?? 0,
            'estimatedCacheReadTokens'
          ),
          inputTokens,
          model: requireString(row['model'], 'model'),
          outputTokens,
          provider: requireString(row['provider'], 'provider'),
          runKind: requireRunUsageKind(row['runKind']),
        } satisfies ThreadModelUsageSubtotal;
      });
      return { perModel, totalInputTokens, totalOutputTokens };
    },
    async getThreadRunTurnMessageId(runId: string, threadId: string): Promise<string | null> {
      requireString(runId, 'runId');
      requireString(threadId, 'threadId');
      await initialize();
      const result = await database.query<{ turnMessageId: string | null }>(
        `SELECT turn_message_id AS "turnMessageId"
         FROM ${ASSISTANT_THREAD_RUNS_TABLE}
         WHERE id = $1 AND thread_id = $2`,
        [runId, threadId]
      );
      const value = result.rows[0]?.turnMessageId;
      return typeof value === 'string' && value.length > 0 ? value : null;
    },
    listLatestThreadRuns,
    async listMessages(
      threadId: string,
      resourceId: string,
      options?: AssistantThreadMessageListOptions
    ): Promise<readonly AssistantHistoryMessage[]> {
      await initialize();
      const limitLatest =
        typeof options?.limitLatest === 'number' && Number.isSafeInteger(options.limitLatest)
          ? options.limitLatest
          : undefined;
      if (limitLatest !== undefined && limitLatest < 1) {
        throw new Error('Assistant message history limit must be a positive safe integer.');
      }
      const params: unknown[] = [threadId, resourceId];
      const limitClause =
        limitLatest === undefined
          ? ''
          : `-- id is a deterministic tie-breaker for same-timestamp rows;
               -- insertion-order ties need a future monotonic schema column.
               ORDER BY "createdAt" DESC, id DESC
               LIMIT $3`;
      // Soft-rewind exclusion (BST-1115) sits INSIDE the windowing subquery, so
      // it applies before `limitLatest` — the hydration window is the latest N
      // VISIBLE messages, not N rows of which some are then dropped. Reload
      // hydration is this query, which is why a tombstoned message stays gone
      // across a restart without any renderer-side memory of the rewind.
      const sql = `SELECT
          recent_messages.id,
          recent_messages.role,
          recent_messages.content,
          recent_messages."createdAt",
          message_parents.message_id AS "parentMappingMessageId",
          message_parents.parent_id AS "parentId"
        FROM (
          SELECT id, role, content, "createdAt"
          FROM ${MASTRA_MEMORY_TABLES.messages}
          WHERE thread_id = $1 AND "resourceId" = $2
            AND NOT EXISTS (
              SELECT 1 FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} AS tombstones
              WHERE tombstones.message_id = ${MASTRA_MEMORY_TABLES.messages}.id
            )
          ${limitClause}
        ) AS recent_messages
        LEFT JOIN ${ASSISTANT_MESSAGE_PARENTS_TABLE} AS message_parents
          ON message_parents.message_id = recent_messages.id
          AND message_parents.thread_id = $1
          AND message_parents.resource_id = $2
        ORDER BY recent_messages."createdAt" ASC, recent_messages.id ASC`;
      if (limitLatest !== undefined) {
        params.push(limitLatest);
      }
      const result = await database.query<Record<string, unknown>>(sql, params);
      return result.rows.map(mapAssistantHistoryMessageRow);
    },
    listThreadCheckpoints,
    listThreadRunEvents,
    async listThreads(resourceId: string): Promise<readonly AssistantMemoryThread[]> {
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `SELECT
           threads.id,
           threads."resourceId",
           threads.title,
           threads.metadata,
           threads."createdAt",
           threads."updatedAt",
           latest_run.id AS "latestRunId",
           latest_run.resource_id AS "latestRunResourceId",
           latest_run.thread_id AS "latestRunThreadId",
           latest_run.provider AS "latestRunProvider",
           latest_run.model AS "latestRunModel",
           latest_run.model_settings AS "latestRunModelSettings",
           latest_run.provider_options AS "latestRunProviderOptions",
           latest_run.runtime_kind AS "latestRunRuntimeKind",
           latest_run.status AS "latestRunStatus",
           latest_run.error AS "latestRunError",
           latest_run.started_at AS "latestRunStartedAt",
           latest_run.completed_at AS "latestRunCompletedAt",
           latest_run.created_at AS "latestRunCreatedAt",
           latest_run.updated_at AS "latestRunUpdatedAt",
           latest_run.turn_message_id AS "latestRunTurnMessageId"
         FROM ${MASTRA_MEMORY_TABLES.threads} AS threads
         LEFT JOIN (
           ${LATEST_THREAD_RUNS_BY_RESOURCE_SQL}
         ) AS latest_run ON latest_run.thread_id = threads.id
         WHERE threads."resourceId" = $1
         ORDER BY threads."updatedAt" DESC, threads.id DESC`,
        [resourceId]
      );
      return result.rows.map((row) => {
        const threadId = requireString(row['id'], 'id');
        const latestRun = toLatestThreadRunRecord(row);
        return toMemoryThread({
          createdAt: row['createdAt'],
          id: threadId,
          metadata: parseJson(row['metadata']),
          resourceId: requireString(row['resourceId'], 'resourceId'),
          title: typeof row['title'] === 'string' ? row['title'] : null,
          updatedAt: row['updatedAt'],
          ...(latestRun ? { latestRun } : {}),
        });
      });
    },
    async recordMessageParent(input: RecordAssistantMessageParentInput): Promise<void> {
      const messageId = requireNonEmptyTopologyId(input.messageId, 'messageId');
      const threadId = requireNonEmptyTopologyId(input.threadId, 'threadId');
      const resourceId = requireNonEmptyTopologyId(input.resourceId, 'resourceId');
      const parentId =
        input.parentId === null ? null : requireNonEmptyTopologyId(input.parentId, 'parentId');
      await initialize();
      const now = new Date();
      const result = await database.query(
        `INSERT INTO ${ASSISTANT_MESSAGE_PARENTS_TABLE}
          (message_id, thread_id, resource_id, parent_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (message_id) DO UPDATE
           SET updated_at = EXCLUDED.updated_at
           WHERE ${ASSISTANT_MESSAGE_PARENTS_TABLE}.thread_id = EXCLUDED.thread_id
             AND ${ASSISTANT_MESSAGE_PARENTS_TABLE}.resource_id = EXCLUDED.resource_id
             AND ${ASSISTANT_MESSAGE_PARENTS_TABLE}.parent_id IS NOT DISTINCT FROM EXCLUDED.parent_id
         RETURNING message_id`,
        [messageId, threadId, resourceId, parentId, now]
      );
      if (result.rows.length !== 1) {
        throw new Error(`Assistant message ${messageId} has conflicting branch topology.`);
      }
    },
    async recordRunOutcome(input: RecordRunOutcomeInput): Promise<void> {
      requireString(input.runId, 'runId');
      requireString(input.threadId, 'threadId');
      requireString(input.resourceId, 'resourceId');
      if (!ASSISTANT_RUN_OUTCOME_VERDICTS.includes(input.verdict)) {
        throw new Error(`Invalid run outcome verdict: ${String(input.verdict)}`);
      }
      if (!ASSISTANT_RUN_OUTCOME_SOURCES.includes(input.source)) {
        throw new Error(`Invalid run outcome source: ${String(input.source)}`);
      }
      if (input.detail !== undefined && input.detail.length > RUN_OUTCOME_DETAIL_MAX_CHARS) {
        // Bounded storage, never silent truncation: the caller owns shortening.
        throw new Error(`Run outcome detail exceeds ${RUN_OUTCOME_DETAIL_MAX_CHARS} characters.`);
      }
      await initialize();
      // One label per run: a later verdict replaces the earlier one (a user
      // verdict overriding a derived edit_revert or hook label is the intended
      // flow). EXCEPTION: NO derived writer ('hook' OR 'edit_revert') ever
      // overwrites an explicit 'user' label — the conflict clause carries the
      // precedence rule so it holds in SQL, byte-consistent with the
      // main-process writer (apps/desktop assistant-server/run-persistence.ts
      // recordDesktopAssistantHookRunOutcome). Review #1694: without this, a
      // post-verdict revert would silently clobber the user's authoritative
      // verdict.
      const conflictGuard =
        input.source === 'user' ? '' : ` WHERE ${ASSISTANT_RUN_OUTCOMES_TABLE}.source <> 'user'`;
      await database.query(
        `INSERT INTO ${ASSISTANT_RUN_OUTCOMES_TABLE}
          (run_id, thread_id, resource_id, verdict, source, detail, labeled_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (run_id) DO UPDATE SET
          thread_id = EXCLUDED.thread_id,
          resource_id = EXCLUDED.resource_id,
          verdict = EXCLUDED.verdict,
          source = EXCLUDED.source,
          detail = EXCLUDED.detail,
          labeled_at = EXCLUDED.labeled_at,
          updated_at = NOW()${conflictGuard}`,
        [
          input.runId,
          input.threadId,
          input.resourceId,
          input.verdict,
          input.source,
          input.detail ?? null,
          input.labeledAt ?? new Date(),
        ]
      );
    },
    async recordRunUsage(input: RecordRunUsageInput): Promise<void> {
      assertUsageTokenCount(input.inputTokens, 'inputTokens');
      assertUsageTokenCount(input.outputTokens, 'outputTokens');
      if (
        input.billedCostUsd !== undefined &&
        (!Number.isFinite(input.billedCostUsd) || input.billedCostUsd < 0)
      ) {
        throw new Error('Assistant run usage billedCostUsd must be a finite, non-negative number.');
      }
      if (input.cacheReadInputTokens !== undefined) {
        assertUsageTokenCount(input.cacheReadInputTokens, 'cacheReadInputTokens');
      }
      if (input.cacheCreationInputTokens !== undefined) {
        assertUsageTokenCount(input.cacheCreationInputTokens, 'cacheCreationInputTokens');
      }
      if (
        (input.cacheReadInputTokens ?? 0) + (input.cacheCreationInputTokens ?? 0) >
        input.inputTokens
      ) {
        // inputTokens is the TOTAL the model saw; the cache classes are shares
        // of it. A row violating that would poison every downstream estimate.
        throw new Error('Assistant run usage cache token classes exceed total inputTokens.');
      }
      await initialize();
      await database.query(
        `INSERT INTO ${ASSISTANT_RUN_USAGE_TABLE}
          (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, created_at, root_id, billed_cost_usd, cache_read_input_tokens, cache_creation_input_tokens, run_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          crypto.randomUUID(),
          input.threadId,
          input.runId,
          input.resourceId,
          input.model,
          input.provider,
          input.inputTokens,
          input.outputTokens,
          new Date(),
          input.rootId ?? null,
          input.billedCostUsd ?? null,
          input.cacheReadInputTokens ?? null,
          input.cacheCreationInputTokens ?? null,
          input.runKind ?? 'chat',
        ]
      );
    },
    async renameThread(threadId: string, title: string): Promise<void> {
      const normalizedTitle = title.trim();
      if (!normalizedTitle) {
        throw new Error('Thread title is required.');
      }
      await initialize();
      // A manual rename is user-owned: clear the OM marker (if present) so no
      // later auto-title write can ever overwrite this title again.
      await database.query(
        `UPDATE ${MASTRA_MEMORY_TABLES.threads}
         SET title = $2, metadata = COALESCE(metadata, '{}'::jsonb) - $3, "updatedAt" = $4
         WHERE id = $1`,
        [threadId, normalizedTitle, THREAD_TITLE_SOURCE_METADATA_KEY, new Date()]
      );
    },
    async updateThreadMetadata(threadId: string, metadata: AssistantThreadMetadata): Promise<void> {
      assertPersistableThreadMetadata(metadata);
      const normalized = normalizeThreadMetadataForPersistence(metadata);
      await initialize();
      // Setting any checkout mode is a checkout transition, so its branch is
      // per-checkout. Only a transition to Local also drops the three keys
      // whose authority has no meaning after the hand-off.
      const currentMetadata = metadata.checkoutMode
        ? metadata.checkoutMode === 'local'
          ? "COALESCE(metadata, '{}'::jsonb) - 'checkoutBranch' - 'checkoutWorktreeId' - 'checkoutWorktreePath' - 'checkoutLocalRootId'"
          : "COALESCE(metadata, '{}'::jsonb) - 'checkoutBranch'"
        : "COALESCE(metadata, '{}'::jsonb)";
      await database.query(
        `UPDATE ${MASTRA_MEMORY_TABLES.threads}
         SET metadata = (${currentMetadata}) || $2::jsonb
         WHERE id = $1`,
        [threadId, JSON.stringify(normalized)]
      );
    },
    async updateThreadsMetadata(
      threadIds: readonly string[],
      metadata: AssistantThreadMetadata
    ): Promise<void> {
      requireAssistantThreadIds(threadIds);
      requireNonemptyThreadMetadata(metadata);
      // `assertBulkThreadMetadataPatch` first: it names the SPECIFIC reason
      // (checkout state is a single-thread, atomic write) for the class of
      // rejection a generic "invalid key" from the broader validator below
      // would not explain. Both run — the second stays load-bearing beyond
      // checkout keys (key whitelist, icon/color, string-shape checks).
      assertBulkThreadMetadataPatch(metadata);
      assertPersistableThreadMetadata(metadata);
      const normalized = normalizeThreadMetadataForPersistence(metadata);
      await initialize();
      const metadataParameter = threadIds.length + 1;
      const result = await database.query<Record<string, unknown>>(
        `WITH requested(id) AS (
            VALUES ${threadIdValuesSql(threadIds)}
          ),
          validation AS (
            SELECT COUNT(threads.id) = ${threadIds.length} AS all_found
            FROM requested
            LEFT JOIN ${MASTRA_MEMORY_TABLES.threads} AS threads ON threads.id = requested.id
          ),
          updated_threads AS (
            UPDATE ${MASTRA_MEMORY_TABLES.threads} AS threads
            SET metadata = COALESCE(threads.metadata, '{}'::jsonb) || $${metadataParameter}::jsonb
            FROM requested
            WHERE (SELECT all_found FROM validation)
              AND threads.id = requested.id
            RETURNING threads.id
          )
         SELECT
          (SELECT all_found FROM validation) AS "allFound",
          (SELECT count(*) FROM updated_threads) AS "updatedThreadCount"`,
        [...threadIds, JSON.stringify(normalized)]
      );
      assertAllBulkThreadsFound(result.rows[0]);
    },
  };
  assistantThreadRepositoryCache.set(database, repository);
  return repository;
}
