/**
 * The DbProvider consumer hooks, split out of `db-provider.tsx` so that file
 * exports only the component: mixing hook and component exports breaks the
 * Vite Fast Refresh boundary (identity-based — see
 * docs/agents/ci-quality.md), downgrading every provider edit to a full
 * reload. Public API is unchanged: everything here re-exports through
 * `@brainstrike/db/react`.
 *
 * React-coupled: this module must never become reachable from the root
 * barrel (`src/index.ts`) — `architecture-ownership.test.ts` walks the root
 * import graph and fails on any React import.
 */
import { createLogger } from '@brainstrike/logging';
import { useContext, useEffect } from 'react';
import { DbContext, type DbContextValue, type DbInitializationStatus } from './db-context.js';
import type { DbHandle } from './db-handle.js';
import type { LiveQueryDrainRegistry } from './db-reset-drain.js';
import type { DrizzleDb } from './drizzle/database.js';
import type { DrizzleFileRecordRepository } from './repositories/drizzle/file-record-repository.js';
import type { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';
import type {
  IEmbeddingSetsRepository,
  IFileChunkRepository,
  IViewFilterPresetsRepository,
} from './repositories/interfaces.js';

// Same channel as db-provider.tsx: these hooks are the provider's consumer
// surface, and their warnings should land in the same place they always have.
const logger = createLogger('DbProvider');

function logDatabaseError(message: string, error: unknown): void {
  logger.error({ err: error }, message);
}

/**
 * The context fields whose non-null presence can signal "database already
 * initialized". Restricting `watch` to these keys makes it a type error to
 * watch an always-present function field (`clearAllData`, `factoryReset`,
 * `clearQueuesAndEmbeddingSets`) — doing so would never observe an
 * "uninitialized" state, so lazy init would silently never fire.
 */
type NullableDbField = {
  [K in keyof DbContextValue]-?: null extends DbContextValue[K] ? K : never;
}[keyof DbContextValue];

interface DbSelectorConfig<T> {
  hookName: string;
  /**
   * 'warn' logs `<hookName> must be used within a DbProvider` when there is
   * no provider, so a wiring bug is never mistaken for pre-init state.
   * 'silent' is reserved for hooks whose contract is explicitly optional
   * (useOptionalPGliteDatabase) — silence must be opted into per call site.
   */
  onMissingProvider: 'silent' | 'warn';
  select: (ctx: DbContextValue) => T | null;
  /** Nullable context field whose presence means "already initialized". */
  watch: NullableDbField;
}

/**
 * Shared body of the nullable consumer hooks: trigger lazy database
 * initialization on first access, then expose the selected context field
 * once the provider is ready and error-free.
 */
function useDbSelector<T>({
  hookName,
  onMissingProvider,
  select,
  watch,
}: DbSelectorConfig<T>): T | null {
  const ctx = useContext(DbContext);

  // Plain values (not ctx) in the dependency array, so the effect re-runs on
  // state transitions rather than on every provider render.
  const watched = ctx?.[watch];
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(watched || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [watched, error, initializing, initializeDatabase]);

  if (!ctx) {
    if (onMissingProvider === 'warn') {
      logger.warn(`${hookName} must be used within a DbProvider`);
    }
    return null;
  }

  return ctx.ready && !ctx.error ? select(ctx) : null;
}

export function useVectorEnabled(): boolean {
  const context = useContext(DbContext);
  if (context === undefined) {
    throw new Error('useVectorEnabled must be used within a DbProvider');
  }
  return context.vectorEnabled;
}

/**
 * Hook to check if database initialization is in progress.
 * Useful for showing loading states in UI components.
 */
export function useDbInitializing(): boolean {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error('useDbInitializing must be used within a DbProvider');
  }
  return ctx.initializing;
}

/**
 * Hook to inspect the lazy database initialization lifecycle.
 * `ready` on the provider context only means the provider is mounted; this
 * status is the deterministic signal for whether DB init is idle, in flight,
 * complete, or failed.
 */
export function useDbInitializationStatus(): DbInitializationStatus {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error('useDbInitializationStatus must be used within a DbProvider');
  }
  return ctx.initializationStatus;
}

export function useDbProviderError(): Error | null {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error('useDbProviderError must be used within a DbProvider');
  }
  return ctx.error;
}

export function useFileRecordRepository():
  | DrizzleFileRecordRepository
  | ElectronFileRecordRepository
  | null {
  return useDbSelector({
    hookName: 'useFileRecordRepository',
    onMissingProvider: 'warn',
    select: (ctx) => ctx.fileRecordRepository,
    watch: 'fileRecordRepository',
  });
}

export function usePGliteDatabase(): DbHandle | null {
  return useDbSelector({
    hookName: 'usePGliteDatabase',
    onMissingProvider: 'warn',
    select: (ctx) => ctx.db,
    watch: 'db',
  });
}

/**
 * The provider-scoped live-query drain registry (BST-1329). Deliberately NOT
 * a `useDbSelector` hook: registering a handle must neither trigger lazy DB
 * initialization nor wait for readiness, and there is no provider-missing
 * warning — a registry-less environment (no provider) simply means the handle
 * has no drain owner.
 */
export function useLiveQueryDrainRegistry(): LiveQueryDrainRegistry | null {
  const ctx = useContext(DbContext);
  return ctx?.liveQueryDrainRegistry ?? null;
}

export function useOptionalPGliteDatabase(): DbHandle | null {
  return useDbSelector({
    hookName: 'useOptionalPGliteDatabase',
    onMissingProvider: 'silent',
    select: (ctx) => ctx.db,
    watch: 'db',
  });
}

export function useFileChunkRepository(): IFileChunkRepository | null {
  return useDbSelector({
    hookName: 'useFileChunkRepository',
    onMissingProvider: 'warn',
    select: (ctx) => ctx.chunkRepository,
    watch: 'chunkRepository',
  });
}

export function useClearAllData():
  | (() => Promise<{ deletedFiles: number; deletedChunks: number }>)
  | null {
  return useDbSelector({
    hookName: 'useClearAllData',
    onMissingProvider: 'warn',
    select: (ctx) => ctx.clearAllData,
    // clearAllData is always present; the repository is the init signal.
    watch: 'fileRecordRepository',
  });
}

export function useFactoryReset(): (() => Promise<void>) | null {
  return useDbSelector({
    hookName: 'useFactoryReset',
    onMissingProvider: 'warn',
    select: (ctx) => ctx.factoryReset,
    // factoryReset is always present; the db handle is the init signal.
    watch: 'db',
  });
}

export function useClearQueuesAndEmbeddingSets(): (() => Promise<void>) | null {
  return useDbSelector({
    hookName: 'useClearQueuesAndEmbeddingSets',
    onMissingProvider: 'warn',
    select: (ctx) => ctx.clearQueuesAndEmbeddingSets,
    // clearQueuesAndEmbeddingSets is always present; db is the init signal.
    watch: 'db',
  });
}

/**
 * Hook to access the Drizzle database instance directly.
 * Use this for advanced queries or when you need the raw Drizzle instance.
 */
export function useDrizzleDb(): DrizzleDb | null {
  return useDbSelector({
    hookName: 'useDrizzleDb',
    onMissingProvider: 'warn',
    select: (ctx) => ctx.drizzleDb,
    watch: 'drizzleDb',
  });
}

/**
 * Hook to access the EmbeddingSets repository.
 * Use this to manage embedding sets (collections) in the database.
 */
export function useEmbeddingSetsRepository(): IEmbeddingSetsRepository | null {
  return useDbSelector({
    hookName: 'useEmbeddingSetsRepository',
    onMissingProvider: 'warn',
    select: (ctx) => ctx.embeddingSetsRepository,
    watch: 'embeddingSetsRepository',
  });
}

/**
 * Hook to access the ViewFilterPresets repository.
 * Use this to manage view filter presets (include/exclude patterns) in the database.
 */
export function useViewFilterPresetsRepository(): IViewFilterPresetsRepository | null {
  return useDbSelector({
    hookName: 'useViewFilterPresetsRepository',
    onMissingProvider: 'warn',
    select: (ctx) => ctx.viewFilterPresetsRepository,
    watch: 'viewFilterPresetsRepository',
  });
}
