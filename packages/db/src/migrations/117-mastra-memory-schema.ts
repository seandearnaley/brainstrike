import type { Migration } from './migration-runner';

/**
 * Mastra's memory schema, moved into the migration chain (BST-1651).
 *
 * Until this migration the chain was BARE of `mastra_*` relations: they were
 * created lazily at runtime, by `PgliteMemoryStore.initialize()` and by the
 * renderer's `buildAssistantThreadRunsSchemaSql()` bootstrap. That absence was
 * the stated reason the assistant run tables could not have migrations of their
 * own (they carry `ON DELETE CASCADE` foreign keys to `mastra_threads`), which
 * in turn was the reason a ~590-line runtime DDL mirror existed in
 * `packages/assistant-data` at all. Creating the parents here removes the
 * premise, and migration 118 creates the children.
 *
 * OWNERSHIP. `@brainstrike/assistant-contract`'s `MASTRA_MEMORY_SCHEMA_SQL`
 * remains the single AUTHORITY for this DDL — it is what
 * `PgliteMemoryStore.initialize()` executes, which is Mastra's own storage
 * contract (a `MemoryStorage` must be able to stand its schema up on a bare
 * database) and is not being taken away from it. Both sites apply the same
 * shape idempotently, so there is exactly one shape, not two authorities.
 *
 * The SQL is a LITERAL here rather than an import of that constant, and that is
 * deliberate: `deriveCustomMigrations()` reads `migration.up` during
 * MODULE-SCOPE evaluation of `drizzle/migrate.ts`, so importing the constant
 * would reintroduce exactly the BST-558 chunk-initialization hazard that
 * `scripts/verify-mastra-schema-init-order.mjs` guards — an uninitialized
 * binding there does not throw, it splices the literal string "undefined" into
 * a migration. The copy is pinned to the constant by
 * `packages/db/__tests__/mastra-schema-migration-parity.test.ts`, which builds
 * both catalogs in real PGlite and fails on any relation, column, index or
 * constraint the chain does not reproduce — a total oracle, not a spot check.
 *
 * `mastra_vectors` and `mastra_workflow_snapshot` stay lazy: they belong to
 * Mastra's vector store and workflow storage, neither of which the assistant
 * repository reads, and nothing depends on their existence up front.
 */
export const migration117MastraMemorySchema: Migration = {
  down: `
    DROP TABLE IF EXISTS mastra_observational_memory;
    --> statement-breakpoint
    DROP TABLE IF EXISTS mastra_resources;
    --> statement-breakpoint
    DROP TABLE IF EXISTS mastra_messages;
    --> statement-breakpoint
    DROP TABLE IF EXISTS mastra_threads CASCADE;
  `,
  ledgerKey: 'custom-117-mastra-memory-schema',
  name: 'mastra_memory_schema',
  up: `
CREATE TABLE IF NOT EXISTS mastra_threads (
  id TEXT PRIMARY KEY,
  "resourceId" TEXT NOT NULL,
  title TEXT NOT NULL,
  metadata JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS mastra_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  content JSONB NOT NULL,
  role TEXT NOT NULL,
  type TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "resourceId" TEXT
);

CREATE TABLE IF NOT EXISTS mastra_resources (
  id TEXT PRIMARY KEY,
  "workingMemory" TEXT,
  metadata JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS mastra_observational_memory (
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
  ON mastra_threads ("resourceId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_threads_resourceid_updatedat_idx
  ON mastra_threads ("resourceId", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_messages_thread_id_createdat_idx
  ON mastra_messages (thread_id, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_messages_resourceid_createdat_idx
  ON mastra_messages ("resourceId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_observational_memory_lookup_key_idx
  ON mastra_observational_memory ("lookupKey", "createdAt" DESC);
  `,
  version: 117,
};
