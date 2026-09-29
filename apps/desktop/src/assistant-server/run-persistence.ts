/**
 * Run persistence for the desktop assistant server (BST-975 slice 2).
 *
 * Production migrations own schema creation. These writers only use the
 * server-owned run id created by the repository and never execute DDL.
 * The if(runId) gates remain at call sites, after createThreadRun completes.
 */
import {
  type AssistantRunEvent,
  readProviderRunError,
  type StreamChunk,
  sanitizeAssistantRunEventMetadata,
  type ToolCallTelemetrySample,
} from '@brainstrike/agent';
import type { AssistantChildRunUsage } from '@brainstrike/assistant-contract/run-usage';
import { AssistantRunErrorRepository } from '@brainstrike/db';
import { continuationProjectionId } from './delegated-continuation-identity';
import { createDesktopDelegatedConversationHost } from './delegated-conversation-host';
import { delegatedHostRunId } from './delegated-host-run-id';
import { completeFailedRootRun, settleFailedDelegationChildRuns } from './delegated-stream-failure';
import type { HookRunVerdict } from './hooks/run-verdict';
import { desktopAssistantServerLogger as logger } from './logger';
import { runCriticalDatabaseOperation } from './run-critical-database';

/**
 * Minimal structural DB surface shared by every writer in this module (BST-972
 * A1): exactly the `query` shape the raw SQL here needs — satisfied by
 * db-main's handle and by a bare PGlite in the paired integration tests, and
 * structurally assignable to the `AssistantRunErrorDatabase` the forensics
 * repository requires. Declared locally (not aliased to that repository's
 * type) so this module's callers are not coupled to a surface owned by one
 * `@brainstrike/db` repository.
 */
interface RunPersistenceDatabase {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * The stream observers and the status writer take a PROVIDER, not a resolved
 * handle: each write awaits the current main-process database exactly where
 * the previous direct `getDatabase()` calls did, so resolution timing — and
 * behavior across a mid-run handle swap (e.g. factory reset) — is unchanged.
 * Desktop composition sites pass db-main's `getDatabase` verbatim.
 * (`recordDesktopAssistantHookRunOutcome` differs deliberately: its caller
 * resolves the handle inside the verdict recorder it builds, so it keeps
 * taking the resolved handle directly.)
 */
type RunPersistenceDatabaseProvider = () => Promise<RunPersistenceDatabase>;

const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';
const ASSISTANT_RUN_EVENTS_TABLE = 'brainstrike_assistant_run_events';
const ASSISTANT_RUN_OUTCOMES_TABLE = 'brainstrike_assistant_run_outcomes';
const ASSISTANT_RUN_USAGE_TABLE = 'brainstrike_assistant_run_usage';
const TOKEN_ESTIMATE_CALIBRATION_TABLE = 'brainstrike_token_estimate_calibration';
const TOOL_CALL_TELEMETRY_TABLE = 'brainstrike_tool_call_telemetry';

/**
 * Stamp the DURABLE host leg on a pause this leg streams, exactly where the
 * observer already stamps `runId` on every run event: the host is the one place
 * that knows which `brainstrike_assistant_thread_runs` row is streaming. The
 * notice carries it into its action echo, and the history topology adapter
 * anchors the suspended message on that leg's `turn_message_id` (BST-1163) —
 * the pause's own `runId` is Mastra's native run id and never matches a
 * thread-run row.
 *
 * A pause of THIS turn qualifies: the root's own, and a delegated child's card
 * (whose decision is appended by the root runtime, so the root turn's anchor is
 * the right one). A CHILD-CONTINUATION pause does not: a continuation leg's
 * `turn_message_id` is the continuation id, not a root message, so anchoring a
 * root edge on it would persist a dangling parent.
 */
function withHostLeg(chunk: StreamChunk, hostRunId: string): StreamChunk {
  if (chunk.type === 'tool-approval-required' || chunk.type === 'tool-suspend-required') {
    return {
      ...chunk,
      hostRunId,
      ...(chunk.type === 'tool-approval-required' ? { timelineRunId: hostRunId } : {}),
    };
  }
  if (
    chunk.type === 'delegated-conversation-chunk' &&
    (chunk.chunk.type === 'tool-approval-required' || chunk.chunk.type === 'tool-suspend-required')
  ) {
    return {
      ...chunk,
      chunk: {
        ...chunk.chunk,
        hostRunId,
        ...(chunk.chunk.type === 'tool-approval-required'
          ? { timelineRunId: delegatedHostRunId(hostRunId, chunk.identity) }
          : {}),
      },
    };
  }
  // Continuations have a child timeline but no root-message decision anchor.
  // Their events are already persisted by the continuation host; align only
  // the live display with that writer's canonical projection identity.
  if (
    chunk.type === 'child-continuation-chunk' &&
    (chunk.chunk.type === 'tool-approval-required' || chunk.chunk.type === 'run-event')
  ) {
    const timelineRunId = continuationProjectionId(hostRunId, chunk.continuationId);
    if (chunk.chunk.type === 'tool-approval-required') {
      return { ...chunk, chunk: { ...chunk.chunk, timelineRunId } };
    }
    return {
      ...chunk,
      chunk: { ...chunk.chunk, event: { ...chunk.chunk.event, runId: timelineRunId } },
    };
  }
  return chunk;
}

export async function* observeDesktopAssistantRunEvents(
  stream: AsyncIterable<StreamChunk>,
  runId: string,
  queuedEvents: AssistantRunEvent[],
  getDatabase: RunPersistenceDatabaseProvider
): AsyncIterable<StreamChunk> {
  let sequence = 0;
  const childSequences = new Map<string, number>();
  let persistenceErrorCount = 0;
  let persistenceError: unknown;
  let persistenceQueue: Promise<void> = Promise.resolve();
  const persistEvent = (event: AssistantRunEvent): void => {
    persistenceQueue = persistenceQueue
      .then(() => recordDesktopAssistantRunEvent(runId, event, getDatabase))
      .catch((error: unknown) => {
        persistenceErrorCount += 1;
        persistenceError ??= error;
        logger.error('Failed to persist assistant run event', {
          error,
          eventId: event.id,
          runId,
        });
      });
  };
  const flushPersistedEvents = async (): Promise<void> => {
    await persistenceQueue;
    if (persistenceError) {
      if (persistenceErrorCount > 1) {
        logger.error('Multiple assistant run events failed to persist', {
          failureCount: persistenceErrorCount,
          firstError: persistenceError,
          runId,
          suppressedFailureCount: persistenceErrorCount - 1,
        });
      }
      throw persistenceError;
    }
  };
  const drainQueuedEvents = async function* (): AsyncIterable<StreamChunk> {
    while (queuedEvents.length > 0) {
      const queuedEvent = queuedEvents.shift();
      if (!queuedEvent) {
        continue;
      }
      const event: AssistantRunEvent = {
        ...queuedEvent,
        runId,
        sequence: queuedEvent.sequence ?? sequence,
      };
      sequence = Math.max(sequence, (event.sequence ?? sequence) + 1);
      persistEvent(event);
      if (event.kind === 'subagent.failed') {
        await flushPersistedEvents();
      }
      yield { event, type: 'run-event' };
    }
  };
  let sourceError: unknown;
  let persistenceFlushError: unknown;
  try {
    yield* drainQueuedEvents();
    for await (const chunk of stream) {
      yield* drainQueuedEvents();
      if (chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'run-event') {
        const key = JSON.stringify([
          chunk.identity.parentRuntimeRunId,
          chunk.identity.parentToolCallId,
          chunk.identity.childRuntimeRunId,
        ]);
        const childSequence = childSequences.get(key) ?? 0;
        const event = await persistDelegatedRunEvent(chunk, runId, childSequence, getDatabase);
        childSequences.set(key, childSequence + 1);
        yield { ...chunk, chunk: { event, type: 'run-event' } };
        continue;
      }
      if (chunk.type !== 'run-event') {
        yield withHostLeg(chunk, runId);
        continue;
      }
      const event: AssistantRunEvent = {
        ...chunk.event,
        runId,
        sequence: chunk.event.sequence ?? sequence,
      };
      sequence = Math.max(sequence, (event.sequence ?? sequence) + 1);
      persistEvent(event);
      // The receiver closes a still-open child when this parent terminal is
      // published. Its exact native task/child rows must settle first.
      if (event.kind === 'subagent.failed') {
        await flushPersistedEvents();
      }
      yield { event, type: 'run-event' };
    }
    yield* drainQueuedEvents();
  } catch (error) {
    sourceError = error;
  } finally {
    try {
      await flushPersistedEvents();
    } catch (error) {
      persistenceFlushError = error;
    }
  }

  if (persistenceFlushError) {
    if (!sourceError) {
      throw persistenceFlushError;
    }
    logger.error('Failed to flush assistant run event persistence after stream error', {
      error: persistenceFlushError,
      runId,
      sourceError,
    });
  }
  if (sourceError) {
    throw sourceError;
  }
}

async function persistDelegatedRunEvent(
  chunk: Extract<StreamChunk, { type: 'delegated-conversation-chunk' }>,
  runId: string,
  sequence: number,
  getDatabase: RunPersistenceDatabaseProvider
): Promise<AssistantRunEvent> {
  if (chunk.chunk.type !== 'run-event' || !chunk.messageId) {
    throw new Error('Delegated run event requires native message identity.');
  }
  const { event } = chunk.chunk;
  const messageId = chunk.messageId;
  const persisted = await runCriticalDatabaseOperation({
    label: 'assistant-delegated-run-event-write',
    operation: async () =>
      createDesktopDelegatedConversationHost(await getDatabase(), runId).persistEvent(
        chunk.identity,
        messageId,
        event,
        sequence
      ),
    retry: 'idempotent',
    runId,
  });
  if (persisted.kind === 'subagent.failed') {
    if (!persisted.runId) {
      throw new Error('Delegated failure has no host run identity.');
    }
    await settleFailedDelegationChildRuns(
      await getDatabase(),
      runId,
      persisted.id,
      persisted.runId
    );
  }
  return persisted;
}

/** Use the existing foreground scheduler and diagnosed saturated-host recovery.
 * Accounting remains fail-closed after exhausted recovery, with a coded diagnostic. */
async function persistBoundDelegatedUsage(
  value: AssistantChildRunUsage,
  runId: string,
  getDatabase: RunPersistenceDatabaseProvider
): Promise<void> {
  try {
    await runCriticalDatabaseOperation({
      label: 'assistant-delegated-usage-write',
      operation: async () => {
        const database = await getDatabase();
        await createDesktopDelegatedConversationHost(database, runId).persistUsage(value);
      },
      retry: 'idempotent',
      runId,
    });
  } catch (error: unknown) {
    logger.error('Failed to persist bound delegated usage', {
      code: 'assistant_delegated_usage_write_failed',
      delegation: value.delegation,
      error,
      model: value.model,
      personaId: value.personaId,
      provider: value.provider,
      runId,
    });
    throw error;
  }
}

/**
 * Persist `child-run-usage` chunks (BST-953) as durable run_kind-tagged rows in
 * `brainstrike_assistant_run_usage`, forwarding every chunk unchanged (the
 * renderer refreshes its thread-total readout from the transient aui-data part;
 * it never writes child rows itself, so the two writers cannot double-count).
 *
 * DUPLICATION NOTE (same precedent as recordDesktopAssistantHookRunOutcome):
 * the INSERT mirrors `recordRunUsage` in
 * packages/assistant-data/src/assistant-memory-repository.ts. thread/resource ids
 * are derived from the runs row (main trusts its own bookkeeping, and — like
 * recordDesktopAssistantRunEvent — a missing runs row inserts nothing).
 *
 * Attribution rules (honesty over completeness):
 * - subagent and compaction-summary rows: chunk-carried model/provider (persona
 *   pin ?? parent for subagents), with the runs row as the SQL fallback — the
 *   auxiliary call genuinely ran on one of those.
 * - OM rows: ONLY the resolved observer target — falling back to the chat
 *   model would mislabel spend to the wrong model. Unattributable → dropped
 *   with a visible warn, never written under a guess.
 * - local observer targets are skipped entirely: local inference is unbilled,
 *   and an unpriceable row would honestly (but uselessly) blank the whole
 *   thread's cost readout.
 */
export async function* persistDesktopChildRunUsage(
  stream: AsyncIterable<StreamChunk>,
  runId: string,
  observerTarget: { readonly model: string; readonly provider: string } | undefined,
  getDatabase: RunPersistenceDatabaseProvider,
  requiresDelegationIdentity = false
): AsyncIterable<StreamChunk> {
  const persist = async (value: AssistantChildRunUsage): Promise<void> => {
    const isOmRow = value.source === 'om-observation' || value.source === 'om-reflection';
    const model = value.model ?? (isOmRow ? observerTarget?.model : undefined);
    const provider = value.provider ?? (isOmRow ? observerTarget?.provider : undefined);
    if (isOmRow && !(model && provider)) {
      logger.warn('Dropping unattributable child run usage (no resolved observer target)', {
        code: 'assistant_child_run_usage_unattributable',
        runId,
        source: value.source,
      });
      return;
    }
    if (provider === 'local') {
      // Local inference is unbilled; the thread-total meter is a billing view.
      return;
    }
    try {
      const database = await getDatabase();
      const result = await database.query(
        `INSERT INTO ${ASSISTANT_RUN_USAGE_TABLE}
          (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, created_at, run_kind)
         SELECT $1, runs.thread_id, runs.id, runs.resource_id, COALESCE($3, runs.model), COALESCE($4, runs.provider), $5, $6, $7, $8
         FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
         WHERE runs.id = $2
         RETURNING id`,
        [
          crypto.randomUUID(),
          runId,
          model ?? null,
          provider ?? null,
          Math.round(value.inputTokens),
          Math.round(value.outputTokens),
          new Date(),
          value.source,
        ]
      );
      if (result.rows.length === 0) {
        // INSERT..SELECT wrote nothing: no runs row for this id. Loud like the
        // other drops in this function — never a silent zero-row no-op.
        logger.warn('Child run usage has no thread-run row to attribute to', {
          code: 'assistant_child_run_usage_missing_run_row',
          runId,
          source: value.source,
        });
      }
    } catch (error: unknown) {
      // Best-effort relative to the turn (mirrors the renderer's durable
      // usage sink), but never silent.
      logger.warn('Failed to persist child run usage', {
        error,
        runId,
        source: value.source,
      });
    }
  };

  for await (const chunk of stream) {
    if (chunk.type === 'child-run-usage') {
      // AWAIT the row before forwarding: the renderer refreshes its cumulative
      // aggregate the moment the transient part arrives, so a chunk that
      // outran its INSERT would make that refresh reliably read the pre-write
      // state (review fix). The forwarding delay is one local PGlite insert.
      const value = chunk.value;
      if (value.source === 'subagent' && (requiresDelegationIdentity || value.delegation)) {
        if (value.provider !== 'local') {
          // Reconcile within the existing writer; authorization/write failure
          // must not publish a successful refresh or use a legacy insertion.
          await persistBoundDelegatedUsage(value, runId, getDatabase);
        }
      } else {
        await persist(value);
      }
    }
    yield chunk;
  }
}

function isSearchTelemetryTool(toolId: string): boolean {
  return (
    toolId === 'grepSearch' ||
    toolId === 'globWorkspace' ||
    toolId.endsWith('.grepSearch') ||
    toolId.endsWith('.globWorkspace')
  );
}

/**
 * Consume the internal run-end telemetry chunk and persist all of its samples
 * in ONE multi-row `INSERT … SELECT … FROM unnest(...)` (review fix: N
 * sequential awaited round-trips on single-connection PGlite, on the
 * latency-critical stream path, blocked the terminal finish chunk behind
 * every tool call). Every array parameter carries an explicit `::type[]`
 * cast — `INSERT … SELECT`, unlike `INSERT … VALUES`, does not propagate the
 * target column type back into the SELECT list, so an untyped bare `null`
 * resolves to `text` and fails a `text → boolean` assignment for every
 * non-search row (review fix; mirrors the `unnest($1::uuid[], $2::text[], …)`
 * batch convention already used by `packages/db/src/queue/job-queue.ts`).
 * The explicit parameter allowlist is the privacy boundary: no raw result,
 * input, pattern, path, file content, or command text reaches SQL.
 */
/**
 * Column-major arrays for the batched telemetry INSERT's `unnest()` parameters.
 * BST-1247: the substrate columns are isSearch-gated like `zero_match`
 * (defense-in-depth — `substrate_degraded` suppresses waste attribution, so a
 * stray non-search writer must not be able to zero out a tool's waste_score).
 */
function marshalTelemetryBatchColumns(samples: readonly ToolCallTelemetrySample[]): {
  candidatesTruncated: boolean[];
  engines: (string | null)[];
  ids: string[];
  isPaginationFollowup: boolean[];
  modelFacingChars: number[];
  occurredAts: string[];
  scanLimited: boolean[];
  toolIds: string[];
  truncated: boolean[];
  zeroMatch: (boolean | null)[];
} {
  const columns = {
    candidatesTruncated: [] as boolean[],
    engines: [] as (string | null)[],
    ids: [] as string[],
    isPaginationFollowup: [] as boolean[],
    modelFacingChars: [] as number[],
    occurredAts: [] as string[],
    scanLimited: [] as boolean[],
    toolIds: [] as string[],
    truncated: [] as boolean[],
    zeroMatch: [] as (boolean | null)[],
  };
  for (const sample of samples) {
    const isSearch = isSearchTelemetryTool(sample.toolId);
    columns.ids.push(crypto.randomUUID());
    columns.toolIds.push(sample.toolId);
    columns.occurredAts.push(new Date(sample.occurredAt).toISOString());
    columns.modelFacingChars.push(sample.modelFacingChars);
    columns.truncated.push(sample.truncated);
    columns.zeroMatch.push(isSearch ? (sample.zeroMatch ?? null) : null);
    columns.isPaginationFollowup.push(isSearch ? sample.isPaginationFollowup : false);
    columns.engines.push(isSearch ? (sample.engine ?? null) : null);
    columns.scanLimited.push(isSearch && sample.scanLimited);
    columns.candidatesTruncated.push(isSearch && sample.candidatesTruncated);
  }
  return columns;
}

export async function* persistDesktopToolCallTelemetry(
  stream: AsyncIterable<StreamChunk>,
  runId: string,
  getDatabase: RunPersistenceDatabaseProvider
): AsyncIterable<StreamChunk> {
  const persistBatch = async (samples: readonly ToolCallTelemetrySample[]): Promise<void> => {
    if (samples.length === 0) {
      return;
    }
    const {
      candidatesTruncated,
      engines,
      ids,
      isPaginationFollowup,
      modelFacingChars,
      occurredAts,
      scanLimited,
      toolIds,
      truncated,
      zeroMatch,
    } = marshalTelemetryBatchColumns(samples);
    try {
      const database = await getDatabase();
      const result = await database.query(
        `INSERT INTO ${TOOL_CALL_TELEMETRY_TABLE}
          (id, thread_id, run_id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup, engine, scan_limited, candidates_truncated)
         SELECT gen.id, runs.thread_id, runs.id, gen.tool_id, gen.occurred_at, gen.model_facing_chars, gen.truncated, gen.zero_match, gen.is_pagination_followup, gen.engine, gen.scan_limited, gen.candidates_truncated
         FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
         CROSS JOIN unnest(
           $2::text[], $3::text[], $4::timestamptz[], $5::integer[], $6::boolean[], $7::boolean[], $8::boolean[], $9::text[], $10::boolean[], $11::boolean[]
         ) AS gen(id, tool_id, occurred_at, model_facing_chars, truncated, zero_match, is_pagination_followup, engine, scan_limited, candidates_truncated)
         WHERE runs.id = $1
         RETURNING id`,
        [
          runId,
          ids,
          toolIds,
          occurredAts,
          modelFacingChars,
          truncated,
          zeroMatch,
          isPaginationFollowup,
          engines,
          scanLimited,
          candidatesTruncated,
        ]
      );
      if (result.rows.length !== samples.length) {
        logger.warn('Tool-call telemetry batch has no thread-run row to attribute to', {
          code: 'assistant_tool_call_telemetry_missing_run_row',
          expectedRows: samples.length,
          persistedRows: result.rows.length,
          runId,
        });
      }
    } catch (error: unknown) {
      // Best-effort relative to the turn, but never silent.
      logger.warn('Failed to persist tool-call telemetry batch', {
        code: 'assistant_tool_call_telemetry_persist_failed',
        error,
        runId,
        sampleCount: samples.length,
      });
    }
  };

  for await (const chunk of stream) {
    if (chunk.type !== 'tool-call-telemetry') {
      yield chunk;
      continue;
    }
    await persistBatch(chunk.value);
  }
}

/**
 * Consume the internal run-end estimator/provider pair and write one FK-less,
 * run-attributed calibration row. The explicit column allowlist is the privacy
 * boundary: token counts plus model/provider strings and a timestamp only — no
 * message content, tool content, file paths, prompts, or command text.
 * Persistence is best-effort relative to the assistant turn and never throws
 * into the stream, matching the sibling tool-call telemetry sink.
 */
export async function* persistDesktopTokenEstimateCalibration(
  stream: AsyncIterable<StreamChunk>,
  runId: string,
  getDatabase: RunPersistenceDatabaseProvider
): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    if (chunk.type !== 'token-estimate-calibration') {
      yield chunk;
      continue;
    }
    try {
      const database = await getDatabase();
      const result = await database.query(
        `INSERT INTO ${TOKEN_ESTIMATE_CALIBRATION_TABLE}
          (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
           final_step_prompt_tokens, step_count, model_visible_projection_count,
           resolved_domain_budget_tokens, resolved_transport_budget_tokens,
           prompt_baseline_tokens, occurred_at)
         SELECT $1, runs.thread_id, runs.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
         FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
         WHERE runs.id = $2
         RETURNING id`,
        [
          crypto.randomUUID(),
          runId,
          chunk.value.model,
          chunk.value.provider,
          chunk.value.estimatedPromptTokens,
          chunk.value.finalStepPromptTokens,
          chunk.value.stepCount,
          chunk.value.modelVisibleProjectionCount,
          chunk.value.resolvedDomainBudgetTokens ?? null,
          chunk.value.resolvedTransportBudgetTokens ?? null,
          chunk.value.promptBreakdownBaselineTokens ?? null,
          new Date(chunk.value.occurredAt).toISOString(),
        ]
      );
      if (result.rows.length === 0) {
        logger.warn('Token-estimate calibration has no thread-run row to attribute to', {
          code: 'assistant_token_estimate_calibration_missing_run_row',
          runId,
        });
      }
    } catch (error: unknown) {
      logger.warn('Failed to persist token-estimate calibration', {
        code: 'assistant_token_estimate_calibration_persist_failed',
        error,
        runId,
      });
    }
  }
}

/**
 * Durable run status read for the reattachment reclaim probe
 * (GET /assistant/run-status). Returns undefined when no row exists — for a
 * runId taken from a stored reattachment record that proves the record is
 * stale, because runs gain their durable row before any stream response can
 * mint a record. Read errors THROW (the endpoint 500s); a fabricated status
 * here could silently reclaim a live run.
 */
export async function readDesktopAssistantThreadRunStatus(
  runId: string,
  getDatabase: RunPersistenceDatabaseProvider
): Promise<string | undefined> {
  const database = await getDatabase();
  const result = await database.query(
    `SELECT status FROM ${ASSISTANT_THREAD_RUNS_TABLE} WHERE id = $1`,
    [runId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    return;
  }
  const status = (row as { status?: unknown }).status;
  if (typeof status !== 'string') {
    throw new Error(`Assistant thread run ${runId} has a non-string status column.`);
  }
  return status;
}

export async function recordDesktopAssistantThreadRunStatus(
  runId: string,
  status: 'cancelled' | 'completed' | 'failed',
  error: string | null,
  getDatabase: RunPersistenceDatabaseProvider
): Promise<void> {
  try {
    await completeDesktopAssistantThreadRun(runId, status, error, getDatabase);
  } catch (statusError) {
    logger.error('Failed to update assistant thread run status', {
      error: statusError,
      runId,
      status,
    });
  }
}

async function completeDesktopAssistantThreadRun(
  runId: string,
  status: 'cancelled' | 'completed' | 'failed',
  error: string | null,
  getDatabase: RunPersistenceDatabaseProvider
): Promise<void> {
  const now = new Date();
  const database = await getDatabase();
  if (status === 'failed') {
    await completeFailedRootRun(database, runId, error);
    return;
  }
  await database.query(
    `UPDATE ${ASSISTANT_THREAD_RUNS_TABLE}
     SET status = $2, error = $3, completed_at = $4, updated_at = $5
     WHERE id = $1 AND status NOT IN ('cancelling', 'cancelled')`,
    [runId, status, error, now, now]
  );
}

/**
 * Task Ledger source 'hook': persist a Stop-hook-reported verdict for a run.
 *
 * DUPLICATION NOTE (same precedent as the repository's bootstrap-SQL mirror of
 * migration 060): this upsert's column set + SET list are kept byte-consistent
 * with `recordRunOutcome` in packages/assistant-data/src/assistant-memory-repository.ts.
 * Two deliberate differences: thread/resource ids are derived from the runs row
 * (mirrors recordDesktopAssistantRunEvent — the main process trusts its own
 * bookkeeping, not hook-adjacent input), and the conflict clause carries the
 * precedence rule `source <> 'user'` — a hook label must NEVER overwrite an
 * explicit user verdict, while a later user verdict (plain repository upsert)
 * still replaces a hook label. Keep the three writers' semantics in sync.
 *
 * Zero affected rows is disambiguated loudly: a missing runs row THROWS (a
 * verdict for an unknown run is a caller bug, never a silent no-op); an
 * existing user label logs the skip (expected precedence).
 */
export async function recordDesktopAssistantHookRunOutcome(
  database: RunPersistenceDatabase,
  runId: string,
  verdict: HookRunVerdict
): Promise<void> {
  const result = await database.query(
    `INSERT INTO ${ASSISTANT_RUN_OUTCOMES_TABLE}
      (run_id, thread_id, resource_id, verdict, source, detail, labeled_at, created_at, updated_at)
     SELECT runs.id, runs.thread_id, runs.resource_id, $2, 'hook', $3, NOW(), NOW(), NOW()
     FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
     WHERE runs.id = $1
     ON CONFLICT (run_id) DO UPDATE SET
      thread_id = EXCLUDED.thread_id,
      resource_id = EXCLUDED.resource_id,
      verdict = EXCLUDED.verdict,
      source = EXCLUDED.source,
      detail = EXCLUDED.detail,
      labeled_at = EXCLUDED.labeled_at,
      updated_at = NOW()
     WHERE ${ASSISTANT_RUN_OUTCOMES_TABLE}.source <> 'user'
     RETURNING run_id`,
    [runId, verdict.verdict, verdict.detail ?? null]
  );
  if (result.rows.length === 1) {
    return;
  }
  const run = await database.query(`SELECT 1 FROM ${ASSISTANT_THREAD_RUNS_TABLE} WHERE id = $1`, [
    runId,
  ]);
  if (run.rows.length === 0) {
    throw new Error(
      `Cannot record hook run verdict: assistant run ${runId} has no thread-run row.`
    );
  }
  logger.info('Hook run verdict skipped: an existing user label takes precedence', {
    runId,
    verdict: verdict.verdict,
  });
}

/**
 * EXPORTED for the worktree service (BST-1390), which emits its lifecycle rows
 * through this same writer and therefore inherits the documented `if (runId)`
 * gate and the "missing parent row ⇒ 0 rows, silent no-op" behavior (the INSERT
 * is an `INSERT ... SELECT ... FROM brainstrike_assistant_thread_runs WHERE id
 * = $runId`, so an unknown/absent runId writes nothing). Scoped child events
 * instead use the delegated repository's atomic authorization/header/event
 * mutation from this same stream observer; never publish them through an
 * unauthenticated native child resource id.
 */
export async function recordDesktopAssistantRunEvent(
  runId: string,
  event: AssistantRunEvent,
  getDatabase: RunPersistenceDatabaseProvider
): Promise<void> {
  const now = new Date();
  let metadata = sanitizeAssistantRunEventMetadata(event.metadata);
  const database = await getDatabase();
  await runCriticalDatabaseOperation({
    label: 'assistant-run-event-write',
    onRetry: ({ error }) => {
      metadata = sanitizeAssistantRunEventMetadata({
        ...metadata,
        databaseRetry: {
          attempt: 2,
          pendingCount: error.pendingCount,
          reason: 'host-saturated-timeout',
          requestKind: error.requestKind,
          timeoutMs: error.timeoutMs,
        },
      });
    },
    operation: () =>
      database.query(
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
          event.sequence ?? 0,
          event.kind,
          event.status,
          event.label,
          event.detail ?? null,
          metadata ? JSON.stringify(metadata) : null,
          event.durationMs ?? null,
          new Date(event.timestamp),
          now,
          now,
        ]
      ),
    retry: 'idempotent',
    runId,
  });
  if (event.kind === 'subagent.failed') {
    await settleFailedDelegationChildRuns(database, runId, event.id);
  }
  if (event.kind !== 'run.failed') {
    return;
  }
  const runError = readProviderRunError(metadata);
  if (!runError) {
    return;
  }
  try {
    await new AssistantRunErrorRepository(database).record({
      ...runError,
      occurredAt: new Date(event.timestamp),
      runId,
    });
  } catch (error) {
    logger.error('Failed to persist assistant provider failure forensics', {
      error,
      eventId: event.id,
      runId,
    });
  }
}
