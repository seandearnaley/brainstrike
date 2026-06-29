export const MASTRA_MEMORY_TABLES = {
  messages: 'mastra_messages',
  observationalMemory: 'mastra_observational_memory',
  resources: 'mastra_resources',
  threads: 'mastra_threads',
} as const;

export const MASTRA_WORKFLOW_TABLE = 'mastra_workflow_snapshot';

export const MASTRA_MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${MASTRA_MEMORY_TABLES.resources} (
  id TEXT PRIMARY KEY,
  "workingMemory" TEXT,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${MASTRA_MEMORY_TABLES.threads} (
  id TEXT PRIMARY KEY,
  "resourceId" TEXT NOT NULL,
  title TEXT NOT NULL,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  FOREIGN KEY ("resourceId") REFERENCES ${MASTRA_MEMORY_TABLES.resources}(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS mastra_threads_resource_updated_idx
  ON ${MASTRA_MEMORY_TABLES.threads} ("resourceId", "updatedAt" DESC, id DESC);

CREATE TABLE IF NOT EXISTS ${MASTRA_MEMORY_TABLES.messages} (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  role TEXT NOT NULL,
  type TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "resourceId" TEXT,
  FOREIGN KEY (thread_id) REFERENCES ${MASTRA_MEMORY_TABLES.threads}(id) ON DELETE CASCADE,
  FOREIGN KEY ("resourceId") REFERENCES ${MASTRA_MEMORY_TABLES.resources}(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS mastra_messages_thread_created_idx
  ON ${MASTRA_MEMORY_TABLES.messages} (thread_id, "createdAt", id);

CREATE INDEX IF NOT EXISTS mastra_messages_resource_created_idx
  ON ${MASTRA_MEMORY_TABLES.messages} ("resourceId", "createdAt", id);

CREATE TABLE IF NOT EXISTS ${MASTRA_MEMORY_TABLES.observationalMemory} (
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
  "updatedAt" TEXT NOT NULL,
  FOREIGN KEY ("resourceId") REFERENCES ${MASTRA_MEMORY_TABLES.resources}(id) ON DELETE CASCADE,
  FOREIGN KEY ("threadId") REFERENCES ${MASTRA_MEMORY_TABLES.threads}(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS mastra_observational_memory_lookup_generation_idx
  ON ${MASTRA_MEMORY_TABLES.observationalMemory} ("lookupKey", "generationCount" DESC, "createdAt" DESC);
`;

export const MASTRA_WORKFLOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${MASTRA_WORKFLOW_TABLE} (
  workflow_name TEXT NOT NULL,
  run_id TEXT NOT NULL,
  "resourceId" TEXT,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  PRIMARY KEY (workflow_name, run_id)
);

CREATE INDEX IF NOT EXISTS mastra_workflow_snapshot_run_id_idx
  ON ${MASTRA_WORKFLOW_TABLE} (run_id);

CREATE INDEX IF NOT EXISTS mastra_workflow_snapshot_created_idx
  ON ${MASTRA_WORKFLOW_TABLE} ("createdAt" DESC, run_id ASC, workflow_name ASC);
`;
