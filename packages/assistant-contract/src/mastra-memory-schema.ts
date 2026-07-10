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
