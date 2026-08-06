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
 * The ordered thread-delete cascade over Brainstrike sidecar tables keyed by
 * `thread_id`. All three delete implementations (single CTE, bulk CTE, and
 * the Mastra `MemoryStorage.deleteThread` override) derive their stages from
 * this ONE list so the cascades can never drift again (BST-993 review: the
 * single/bulk CTEs had diverged in both stage-set and ordering).
 * `mastra_observational_memory` is not listed: its predicate is composite
 * ("threadId" OR "lookupKey") and stays inline at each site.
 */
export const THREAD_DELETE_SIDECAR_TABLES = [
  { table: 'brainstrike_assistant_edit_checkpoints', threadColumn: 'thread_id' },
  { table: 'brainstrike_assistant_run_errors', threadColumn: 'thread_id' },
  { table: 'brainstrike_assistant_message_parents', threadColumn: 'thread_id' },
  { table: 'brainstrike_assistant_message_tombstones', threadColumn: 'thread_id' },
  { table: 'brainstrike_assistant_thread_placements', threadColumn: 'thread_id' },
] as const;
