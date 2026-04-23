const TABLE_THREADS = 'mastra_threads';
const TABLE_MESSAGES = 'mastra_messages';
const TABLE_RESOURCES = 'mastra_resources';
const TABLE_OBSERVATIONAL_MEMORY = 'mastra_observational_memory';

export const MASTRA_MEMORY_TABLES = {
  messages: TABLE_MESSAGES,
  observationalMemory: TABLE_OBSERVATIONAL_MEMORY,
  resources: TABLE_RESOURCES,
  threads: TABLE_THREADS,
} as const;

export const MASTRA_VECTOR_TABLE = 'mastra_vectors';

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
