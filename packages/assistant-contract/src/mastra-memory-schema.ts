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

export const SQLITE_MASTRA_MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE_RESOURCES} (
  id TEXT PRIMARY KEY,
  "workingMemory" TEXT,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${TABLE_THREADS} (
  id TEXT PRIMARY KEY,
  "resourceId" TEXT NOT NULL,
  title TEXT NOT NULL,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mastra_threads_resource_updated_idx
  ON ${TABLE_THREADS} ("resourceId", "updatedAt" DESC, id DESC);

CREATE TABLE IF NOT EXISTS ${TABLE_MESSAGES} (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  role TEXT NOT NULL,
  type TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "resourceId" TEXT
);

CREATE INDEX IF NOT EXISTS mastra_messages_thread_created_idx
  ON ${TABLE_MESSAGES} (thread_id, "createdAt", id);

CREATE INDEX IF NOT EXISTS mastra_messages_resource_created_idx
  ON ${TABLE_MESSAGES} ("resourceId", "createdAt", id);

CREATE TABLE IF NOT EXISTS ${TABLE_OBSERVATIONAL_MEMORY} (
  id TEXT PRIMARY KEY,
  "lookupKey" TEXT NOT NULL,
  scope TEXT NOT NULL,
  "resourceId" TEXT,
  "threadId" TEXT,
  "activeObservations" TEXT NOT NULL,
  "activeObservationsPendingUpdate" TEXT,
  "originType" TEXT NOT NULL,
  config TEXT NOT NULL CHECK (json_valid(config)),
  "generationCount" INTEGER NOT NULL,
  "lastObservedAt" TEXT,
  "lastReflectionAt" TEXT,
  "pendingMessageTokens" INTEGER NOT NULL,
  "totalTokensObserved" INTEGER NOT NULL,
  "observationTokenCount" INTEGER NOT NULL,
  "isObserving" INTEGER NOT NULL CHECK ("isObserving" IN (0, 1)),
  "isReflecting" INTEGER NOT NULL CHECK ("isReflecting" IN (0, 1)),
  "observedMessageIds" TEXT CHECK ("observedMessageIds" IS NULL OR json_valid("observedMessageIds")),
  "observedTimezone" TEXT,
  "bufferedObservations" TEXT,
  "bufferedObservationTokens" INTEGER,
  "bufferedMessageIds" TEXT CHECK ("bufferedMessageIds" IS NULL OR json_valid("bufferedMessageIds")),
  "bufferedReflection" TEXT,
  "bufferedReflectionTokens" INTEGER,
  "bufferedReflectionInputTokens" INTEGER,
  "reflectedObservationLineCount" INTEGER,
  "bufferedObservationChunks" TEXT CHECK ("bufferedObservationChunks" IS NULL OR json_valid("bufferedObservationChunks")),
  "isBufferingObservation" INTEGER NOT NULL CHECK ("isBufferingObservation" IN (0, 1)),
  "isBufferingReflection" INTEGER NOT NULL CHECK ("isBufferingReflection" IN (0, 1)),
  "lastBufferedAtTokens" INTEGER NOT NULL,
  "lastBufferedAtTime" TEXT,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mastra_observational_memory_lookup_generation_idx
  ON ${TABLE_OBSERVATIONAL_MEMORY} ("lookupKey", "generationCount" DESC, "createdAt" DESC);
`;

export const SQLITE_MASTRA_WORKFLOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE_WORKFLOW_SNAPSHOT} (
  workflow_name TEXT NOT NULL,
  run_id TEXT NOT NULL,
  "resourceId" TEXT,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  PRIMARY KEY (workflow_name, run_id)
);

CREATE INDEX IF NOT EXISTS mastra_workflow_snapshot_run_id_idx
  ON ${TABLE_WORKFLOW_SNAPSHOT} (run_id);

CREATE INDEX IF NOT EXISTS mastra_workflow_snapshot_created_idx
  ON ${TABLE_WORKFLOW_SNAPSHOT} ("createdAt" DESC, run_id ASC, workflow_name ASC);
`;
