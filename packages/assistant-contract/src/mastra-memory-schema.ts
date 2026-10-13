const TABLE_THREADS = 'mastra_threads';
const TABLE_MESSAGES = 'mastra_messages';
const TABLE_RESOURCES = 'mastra_resources';
const TABLE_OBSERVATIONAL_MEMORY = 'mastra_observational_memory';
const TABLE_WORKFLOW_SNAPSHOT = 'mastra_workflow_snapshot';

export const MASTRA_MEMORY_TABLES = {
  messages: TABLE_MESSAGES,
  observationalMemory: TABLE_OBSERVATIONAL_MEMORY,
  resources: TABLE_RESOURCES,
  threads: TABLE_THREADS,
} as const;

export const MASTRA_VECTOR_TABLE = 'mastra_vectors';
export const MASTRA_WORKFLOW_TABLE = TABLE_WORKFLOW_SNAPSHOT;
export const MASTRA_BACKGROUND_TASKS_TABLE = 'mastra_background_tasks';

/**
 * Assistant-ui's client-owned branch topology layered over Mastra's durable
 * message content (migration 055). Desktop main writes a root row (BST-1200
 * M2's compaction summary) via raw SQL against this table name directly —
 * NOT by importing `@brainstrike/assistant-data`, which is the renderer's
 * bootstrap/repository package (built ESM-only, no `require` condition, and
 * per `docs/agents/platform-contracts.md`'s BST-558 lesson, deliberately
 * fragile to import from anywhere but the renderer's own module graph).
 */
export const ASSISTANT_MESSAGE_PARENTS_TABLE = 'brainstrike_assistant_message_parents';

/** Title seeded on a thread before anyone (user or observer) has named it. */
export const DEFAULT_THREAD_TITLE = 'New Thread';

/**
 * Thread metadata key marking a title as system/auto-generated rather than
 * user-chosen: stamped on the seeded placeholder at thread creation and
 * re-stamped whenever the observational-memory title extractor writes a
 * title through `PgliteMemoryStore#updateThread`. A title carrying this
 * marker (or an empty title) may be overwritten by a later auto-title write;
 * any other title was set by the user through the dedicated rename path,
 * which clears this marker, so it stays protected forever after.
 */
export const THREAD_TITLE_SOURCE_METADATA_KEY = 'titleSource';
export const THREAD_TITLE_SOURCE_OM = 'om';

export const MASTRA_MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE_THREADS} (
  id TEXT PRIMARY KEY,
  "resourceId" TEXT NOT NULL,
  title TEXT NOT NULL,
  metadata JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ${TABLE_MESSAGES} (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  content JSONB NOT NULL,
  role TEXT NOT NULL,
  type TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "resourceId" TEXT
);

CREATE TABLE IF NOT EXISTS ${TABLE_RESOURCES} (
  id TEXT PRIMARY KEY,
  "workingMemory" TEXT,
  metadata JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ${TABLE_OBSERVATIONAL_MEMORY} (
  id TEXT PRIMARY KEY,
  "lookupKey" TEXT NOT NULL,
  scope TEXT NOT NULL,
  "resourceId" TEXT,
  "threadId" TEXT,
  "activeObservations" TEXT NOT NULL,
  "activeObservationsPendingUpdate" TEXT,
  "originType" TEXT NOT NULL,
  config JSONB NOT NULL,
  "generationCount" INTEGER NOT NULL,
  "lastObservedAt" TIMESTAMPTZ,
  "lastReflectionAt" TIMESTAMPTZ,
  "pendingMessageTokens" INTEGER NOT NULL,
  "totalTokensObserved" INTEGER NOT NULL,
  "observationTokenCount" INTEGER NOT NULL,
  "isObserving" BOOLEAN NOT NULL,
  "isReflecting" BOOLEAN NOT NULL,
  "observedMessageIds" JSONB,
  "observedTimezone" TEXT,
  "bufferedObservations" TEXT,
  "bufferedObservationTokens" INTEGER,
  "bufferedMessageIds" JSONB,
  "bufferedReflection" TEXT,
  "bufferedReflectionTokens" INTEGER,
  "bufferedReflectionInputTokens" INTEGER,
  "reflectedObservationLineCount" INTEGER,
  "bufferedObservationChunks" JSONB,
  "isBufferingObservation" BOOLEAN NOT NULL,
  "isBufferingReflection" BOOLEAN NOT NULL,
  "lastBufferedAtTokens" INTEGER NOT NULL,
  "lastBufferedAtTime" TIMESTAMPTZ,
  metadata JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS mastra_threads_resourceid_createdat_idx
  ON ${TABLE_THREADS} ("resourceId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_threads_resourceid_updatedat_idx
  ON ${TABLE_THREADS} ("resourceId", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_messages_thread_id_createdat_idx
  ON ${TABLE_MESSAGES} (thread_id, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_messages_resourceid_createdat_idx
  ON ${TABLE_MESSAGES} ("resourceId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_observational_memory_lookup_key_idx
  ON ${TABLE_OBSERVATIONAL_MEMORY} ("lookupKey", "createdAt" DESC);
`;

export const MASTRA_WORKFLOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE_WORKFLOW_SNAPSHOT} (
  workflow_name TEXT NOT NULL,
  run_id TEXT NOT NULL,
  "resourceId" TEXT,
  snapshot JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workflow_name, run_id)
);

CREATE INDEX IF NOT EXISTS mastra_workflow_snapshot_workflow_createdat_idx
  ON ${TABLE_WORKFLOW_SNAPSHOT} (workflow_name, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_workflow_snapshot_run_id_idx
  ON ${TABLE_WORKFLOW_SNAPSHOT} (run_id);

CREATE INDEX IF NOT EXISTS mastra_workflow_snapshot_resource_createdat_idx
  ON ${TABLE_WORKFLOW_SNAPSHOT} ("resourceId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_workflow_snapshot_status_createdat_idx
  ON ${TABLE_WORKFLOW_SNAPSHOT} ((snapshot ->> 'status'), "createdAt" DESC);
`;

/**
 * Sync-the-mind op-log seam (BST-993, ruling 2026-07-28: sync covers the
 * "mind" — threads/memory/prompts — never vectors/HNSW).
 *
 * `brainstrike_mind_ops` is a Brainstrike-owned, append-only sidecar
 * (migration 079 in BOTH runners — sidecar-not-ALTER per the thread-groups /
 * thread-search precedent: Mastra owns the mastra_* schema and its lazy
 * tables have no evolution mechanism). Tombstone semantics derive FROM this
 * log; there are no `deleted_at` columns on Mastra-owned tables, which keeps
 * the thread-search orphan GC's physical-delete contract and the readonly
 * sandbox role's visibility rules intact.
 *
 * Scope is DELIBERATELY delete-ops only: a tombstone seam. Emitting upsert
 * ops from write paths is sync-engine territory and is NOT laid here (the
 * ticket's own boundary: no engine choice). `seq` (BIGSERIAL) is the
 * lamport-ish local order; a future engine adds device identity around it.
 */
export const MIND_OPS_TABLE = 'brainstrike_mind_ops';

export const MIND_OP_ENTITY_KINDS = ['thread', 'prompt_item'] as const;
export type MindOpEntityKind = (typeof MIND_OP_ENTITY_KINDS)[number];

export const MIND_OPS = ['delete'] as const;
export type MindOp = (typeof MIND_OPS)[number];

/**
 * Soft-rewind tombstone sidecar (BST-1115, migration 080 in BOTH runners plus
 * the app-shell bootstrap mirror — same sidecar-not-ALTER precedent as
 * migration 055's message parents).
 *
 * A tombstone row hides its message from every Brainstrike-owned read path
 * while Mastra keeps owning the content row. `message_id` is the primary key
 * (a message is tombstoned at most once) and `rewind_id` groups the rows one
 * rewind wrote, which is what makes redo an exact inverse: delete the newest
 * batch and the messages reappear untouched. `revert_id` is separate and
 * NULLABLE — it links the paired journal file revert, which a
 * `conversation-only` rewind never performs.
 */
export const ASSISTANT_MESSAGE_TOMBSTONES_TABLE = 'brainstrike_assistant_message_tombstones';

/**
 * Shadow-git snapshot ledger (BST-1164 W7, migration 081 in BOTH runners plus
 * the app-shell bootstrap mirror — keep every shape byte-identical to 081).
 *
 * One row per snapshot commit in a workspace root's shadow git repo
 * (`userData/snapshots/<rootId>/git`); the row is the source of truth for the
 * turn↔commit-oid mapping while shadow refs only keep objects alive for GC.
 * Thread-keyed sidecar: rows cascade on thread delete via
 * {@link THREAD_DELETE_SIDECAR_TABLES}. `run_id` is nullable provenance (a
 * turn is not a run); `kind` is CHECK-constrained to
 * 'turn-start' | 'turn-end' | 'pre-revert'.
 */
export const WORKSPACE_SNAPSHOTS_TABLE = 'brainstrike_workspace_snapshots';

/**
 * Storage ceiling for a single canvas document, in UTF-8 BYTES.
 *
 * It lives in this shared contract rather than beside the schema because two
 * places enforce it and they are in different packages: the `manageCanvas`
 * input schema bounds each incoming FIELD, and the host's canvas store bounds
 * the COMPOSED result of an update — which is the only path that can produce a
 * document larger than any field it was given. One constant, so the two cannot
 * drift.
 */
export const CANVAS_HTML_MAX_BYTES = 8_000_000;

const CANVAS_HTML_ENCODER = new TextEncoder();

/**
 * Whether `value` fits the canvas storage ceiling, in UTF-8 bytes.
 *
 * A PREDICATE rather than a byte count, because every caller only ever compares
 * against the ceiling — and returning a count forces the measurement that the
 * bounds below usually make unnecessary.
 *
 * Both bounds follow from UTF-8/UTF-16 arithmetic and decide most inputs
 * without touching the encoder:
 *   - UTF-8 length >= UTF-16 length, so more units than the ceiling is over it.
 *   - UTF-8 length <= 3x UTF-16 length (a BMP unit is at most 3 bytes; a
 *     surrogate PAIR is 2 units and 4 bytes, which is under that ratio), so
 *     three times the units fitting means the bytes fit.
 * Only the band between those needs a real encode. That matters here because
 * this runs TWICE per tool call — `ManageCanvasInputSchema`'s superRefine
 * re-parses through `ManageCanvasActionInputSchema` — and because Zod 4 runs
 * checks non-abortively, so a payload that already failed `.max()` still
 * reaches this. Materialising a ~32 MB `Uint8Array` on the hostile path, twice,
 * is the thing worth avoiding.
 *
 * `TextEncoder`, not Node's `Buffer`: this package is a shared contract that
 * ships to the renderer and the hosted web bundle, where `Buffer` is not a
 * global and would be a ReferenceError the first time a canvas payload is
 * parsed. The encoder is hoisted rather than constructed per call.
 */
export function canvasHtmlWithinByteCeiling(value: string): boolean {
  if (value.length > CANVAS_HTML_MAX_BYTES) {
    return false;
  }
  if (value.length * 3 <= CANVAS_HTML_MAX_BYTES) {
    return true;
  }
  return CANVAS_HTML_ENCODER.encode(value).length <= CANVAS_HTML_MAX_BYTES;
}

/**
 * Privacy-safe per-tool model-output telemetry (BST-1190, migration 083 in
 * BOTH runners plus the app-shell bootstrap mirror). The mirror is required
 * because the repository's thread-delete CTE references every registered
 * sidecar unconditionally, even though only desktop main writes these rows.
 */
export const TOOL_CALL_TELEMETRY_TABLE = 'brainstrike_tool_call_telemetry';

/**
 * Privacy-safe estimator/provider prompt-token pairs (BST-1205, migration 086
 * in BOTH runners plus the app-shell bootstrap mirror). The mirror is required
 * because thread deletion references every registered sidecar unconditionally,
 * while desktop main owns normal writes.
 */
export const TOKEN_ESTIMATE_CALIBRATION_TABLE = 'brainstrike_token_estimate_calibration';

/**
 * The ordered thread-delete cascade over Brainstrike sidecar tables keyed by
 * thread identity. Any matching ownership/provenance column selects a row.
 * All three delete implementations (single CTE, bulk CTE, and
 * the Mastra `MemoryStorage.deleteThread` override) derive their stages from
 * this ONE list so the cascades can never drift again (BST-993 review: the
 * single/bulk CTEs had diverged in both stage-set and ordering).
 * `mastra_observational_memory` is not listed: its predicate is composite
 * ("threadId" OR "lookupKey") and stays inline at each site.
 */
export const THREAD_DELETE_SIDECAR_TABLES = [
  // Artifacts are root-readable but child-produced; either identity owns deletion.
  {
    table: 'brainstrike_assistant_tool_output_artifacts',
    threadColumns: ['thread_id', 'execution_thread_id'],
  },
  // Clear descendants atomically, including native (non-panel) deletion.
  { table: 'brainstrike_thread_message_index', threadColumns: ['thread_id'] },
  { table: 'brainstrike_thread_search_state', threadColumns: ['thread_id'] },
  { table: MASTRA_BACKGROUND_TASKS_TABLE, threadColumns: ['thread_id'] },
  { table: TOKEN_ESTIMATE_CALIBRATION_TABLE, threadColumns: ['thread_id'] },
  { table: TOOL_CALL_TELEMETRY_TABLE, threadColumns: ['thread_id'] },
  { table: 'brainstrike_assistant_run_errors', threadColumns: ['thread_id'] },
  { table: 'brainstrike_assistant_message_parents', threadColumns: ['thread_id'] },
  { table: 'brainstrike_assistant_message_tombstones', threadColumns: ['thread_id'] },
  { table: 'brainstrike_assistant_thread_placements', threadColumns: ['thread_id'] },
  // Per-thread workspace snapshots (BST-1268, migration 094): deleting a
  // thread deletes its saved workspace.
  { table: 'brainstrike_assistant_thread_workspaces', threadColumns: ['thread_id'] },
  // Shadow-git snapshot rows (BST-1164): deleting a thread deletes its
  // turn↔oid ledger. The shadow refs/objects those rows point at live on the
  // main-process filesystem and are pruned by SnapshotService GC, not by SQL.
  { table: 'brainstrike_workspace_snapshots', threadColumns: ['thread_id'] },
  // Prompt manifests are keyed by the ROOT host run (their FK) but named by a
  // thread: a delegation's first step by the thread that dispatched it (the
  // child thread does not exist yet), a human follow-up by the child it was
  // sent to. Deleting a delegated branch drops the prompts sent to and from it.
  { table: 'brainstrike_assistant_prompt_manifests', threadColumns: ['thread_id'] },
] as const;

/** Mastra's public background-task storage schema; shared with migrations/reset. */
export const MASTRA_BACKGROUND_TASKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${MASTRA_BACKGROUND_TASKS_TABLE} (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  thread_id TEXT,
  resource_id TEXT,
  status TEXT NOT NULL,
  args JSONB NOT NULL,
  result JSONB,
  error JSONB,
  suspend_payload JSONB,
  retry_count INTEGER NOT NULL,
  max_retries INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "startedAt" TIMESTAMPTZ,
  "suspendedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ
);
ALTER TABLE ${MASTRA_BACKGROUND_TASKS_TABLE} ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_mastra_background_tasks_thread
  ON ${MASTRA_BACKGROUND_TASKS_TABLE} (resource_id, thread_id, "createdAt", id);
CREATE INDEX IF NOT EXISTS idx_mastra_background_tasks_status
  ON ${MASTRA_BACKGROUND_TASKS_TABLE} (status, agent_id);
`;
