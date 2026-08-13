/**
 * The React entry for @brainstrike/db (BST-990): `@brainstrike/db/react`.
 *
 * The root barrel is React-free — its `export * from './db-provider.js'`
 * previously made every STATIC barrel import from a non-React runtime load
 * React at module init (Electron main via db-ipc's engine helpers, the
 * embedding Web Workers). Node ESM does not tree-shake `export *`, so the
 * only fix is a separate entry. Everything React-coupled lives here: the
 * provider, the hooks, and the live-query layer. Engine consumers keep
 * importing '@brainstrike/db'; React consumers import this subpath
 * (precedent: './browser-pglite-storage' has been a consumed subpath for
 * months).
 *
 * Guarded by `architecture-ownership.test.ts`: the root index must never
 * re-export these three modules again.
 */
export type { DbInitializationStatus } from './db-context.js';
export type {
  DbHandle,
  DbInsertChunksAndEnqueueEmbeddingJobsOptions,
} from './db-handle.js';
export { DbProvider } from './db-provider.js';
export { getDefaultDbPath } from './default-db-path.js';
export {
  useClearAllData,
  useClearQueuesAndEmbeddingSets,
  useDbInitializationStatus,
  useDbInitializing,
  useDbProviderError,
  useDrizzleDb,
  useEmbeddingSetsRepository,
  useFactoryReset,
  useFileChunkRepository,
  useFileRecordRepository,
  useOptionalPGliteDatabase,
  usePGliteDatabase,
  useVectorEnabled,
  useViewFilterPresetsRepository,
} from './use-db.js';
export {
  type DrizzleLiveQueryOptions,
  type DrizzleQueryLike,
  useDrizzleLiveQuery,
  useDrizzleLiveQueryWithRefresh,
} from './use-drizzle-live-query.js';
export {
  deepEqual,
  type LiveQueryHookResult,
  makeLiveQueryKey,
  type UsePGliteLiveQueryOptions,
  usePGliteLiveQuery,
} from './use-live-query.js';
