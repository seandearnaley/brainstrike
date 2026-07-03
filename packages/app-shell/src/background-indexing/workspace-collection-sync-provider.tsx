import {
  applyManagedCacheBatch as applyManagedCacheBatchLocally,
  applyTursoManagedCacheBatch,
  type BrainstrikeDbExecutionClient,
  type BrainstrikeDbTransactionClient,
  createDatabasePressureController,
  createPriorityDbHandle,
  type DatabaseWorkSchedulerSnapshot,
  type DbHandle,
  ElectronEmbeddingSetsRepository,
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  extractDbExecutionClient,
  getDatabasePressureWaitingReason,
  getDatabaseWorkScheduler,
  invalidateManagedCacheEntriesByIdentity as invalidateManagedCacheEntriesByIdentityLocally,
  TursoEmbeddingSetsRepository,
  TursoFileChunkRepository,
  TursoFileRecordRepository,
  useModelRegistryDbClient,
  useOptionalProfileBootstrapReport,
  useWorkspaceRootsDbClient,
} from '@brainstrike/db';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEventDetail,
  useFileSystem,
} from '@brainstrike/file-explorer-ui/shell';
import { useOptionalFileTreeContext } from '@brainstrike/file-explorer-ui/tree';
import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import {
  ensureBackgroundIndexingPreferencesHydrated,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import {
  useWorkspaceCollectionSyncStatusStore,
  type WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import type { DirectoryHandle, FileSystemChange } from '@brainstrike/types';
import {
  getBackgroundWorkArbiterSnapshot,
  getBackgroundWorkPauseReasonLabels,
  registerBackgroundWorkPauseHandler,
  setBackgroundWorkManualPause,
  subscribeToBackgroundWorkArbiter,
} from '@brainstrike/utils';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils/background-indexing-policy';
import { createLogger } from '@brainstrike/utils/logger';
import {
  assertValidWorkspaceIndexingPowerSnapshot,
  type WorkspaceIndexingPowerSnapshot,
} from '@brainstrike/utils/workspace-indexing-power-snapshot';
import {
  createWorkspaceIndexingQosTransitionLogger,
  resolveWorkspaceIndexingQosPolicy,
  type WorkspaceIndexingDatabasePressure,
  type WorkspaceIndexingPipelineInputs,
  type WorkspaceIndexingQosPolicy,
} from '@brainstrike/utils/workspace-indexing-qos';
import { useSharedEmbeddingRuntime } from '@brainstrike/vector-management';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { getAssistantForegroundActivitySnapshot } from '../assistant-foreground-activity';
import { RootIdentityProvider } from '../roots/root-identity-context';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';
import { boundBackgroundPermitWait } from './background-permit-wait';
import { useResyncOnReturnToVisibility } from './use-resync-on-return-to-visibility';
import {
  WorkspaceCollectionSyncService,
  type WorkspaceCollectionSyncServiceDependencies,
} from './workspace-collection-sync-service';
import {
  isWorkspaceIndexBlockedError,
  WorkspaceIndexBlockedError,
} from './workspace-index-blocked-error';
import { bootstrapWorkspaceIndexCollection } from './workspace-index-bootstrap-service';
import { runWorkspaceIndexStageBenchmark } from './workspace-index-debug-benchmark';
import {
  countExpectedWorkspaceIndexFiles,
  readWorkspaceIndexDebugRows,
  readWorkspaceIndexMemorySample,
  shouldExposeWorkspaceIndexDebugApi,
  type WorkspaceIndexDebugApi,
  type WorkspaceIndexDebugDbQuery,
  type WorkspaceIndexDebugSnapshot,
  type WorkspaceIndexDebugSummary,
} from './workspace-index-debug-harness';

const logger = createLogger('WorkspaceCollectionSyncProvider');

export { FILE_EXPLORER_REFRESH_EVENT };

const HIGH_RETAINED_HEAP_RATIO = 0.75;

interface BrowserPerformanceMemory {
  readonly jsHeapSizeLimit?: number;
  readonly usedJSHeapSize?: number;
}

/**
 * The sync service signals foreground-style import progress through `setImporting`.
 * Background indexing intentionally discards it: the global `isImporting` flag is
 * the foreground bulk-import pause switch for collection live queries, and raising
 * it would freeze the collection selector + counts at 0/0 during background work.
 */
const NOOP_SET_IMPORTING = (_active: boolean): void => {
  // intentionally empty — see comment above
};
const BACKGROUND_DATABASE_WORK_OPTIONS = {
  label: 'background indexing',
  priority: 'background',
} as const;
const BACKGROUND_PRESSURE_POLL_MS = 50;
const BACKGROUND_POWER_SNAPSHOT_CACHE_MS = 1000;
const RECENT_USER_INPUT_WINDOW_MS = 30_000;
// Longest the background indexer will defer to an unsettled file-tree UI
// restoration before indexing anyway (a giant root can keep the tree loading for
// minutes; indexing must not block on it indefinitely).
const TREE_RESTORATION_GRACE_MS = 5000;
const QUEUE_DRAINED_EVENT = 'brainstrike:queue-drained' as const;
const WORKSPACE_COVERAGE_AUDIT_MESSAGE =
  'Verifying Workspace Index coverage before reporting idle.';
const TURSO_BACKGROUND_CHUNK_ENQUEUE_REQUIRED_ERROR =
  'Workspace Index Turso background import requires atomic chunk/job enqueue support.';
const TURSO_BACKGROUND_CHUNK_UPDATE_UNSUPPORTED_ERROR =
  'Workspace Index Turso background import does not support chunk updates; use the atomic chunk/job enqueue path instead.';

type BackgroundIndexingRuntimeEngine = 'pglite' | 'turso';
type BootstrapRuntimeEngine = 'libsql' | 'pglite' | 'turso' | 'unknown';
type WorkspaceIndexDebugSqlRuntime = 'pglite' | 'turso';
interface BackgroundTursoTransactionStatement {
  params?: unknown[];
  sql: string;
}
type BackgroundTursoRunTransaction = (
  statements: BackgroundTursoTransactionStatement[],
  resultIndex: number,
  options?: typeof BACKGROUND_DATABASE_WORK_OPTIONS
) => Promise<unknown>;

function isBackgroundIndexingRuntimeEngine(
  runtimeEngine: BootstrapRuntimeEngine
): runtimeEngine is BackgroundIndexingRuntimeEngine {
  return runtimeEngine === 'pglite' || runtimeEngine === 'turso';
}

function getWorkspaceIndexDebugSqlParameter(
  runtimeEngine: WorkspaceIndexDebugSqlRuntime,
  index: number
): string {
  return runtimeEngine === 'turso' ? `?${index}` : `$${index}`;
}

function buildWorkspaceIndexDebugCollectionFilter(
  runtimeEngine: WorkspaceIndexDebugSqlRuntime,
  columnName: string
): string {
  const collectionIdParameter = getWorkspaceIndexDebugSqlParameter(runtimeEngine, 1);
  const nullableCollectionIdParameter =
    runtimeEngine === 'pglite' ? `${collectionIdParameter}::text` : collectionIdParameter;
  return `(${nullableCollectionIdParameter} IS NULL OR ${columnName} = ${nullableCollectionIdParameter})`;
}

interface BackgroundIndexingPreferencesPersistApi {
  readonly hasHydrated?: () => boolean;
  readonly onFinishHydration?: (
    listener: (state: ReturnType<typeof useBackgroundIndexingPreferencesStore.getState>) => void
  ) => () => void;
}

function getBackgroundIndexingPreferencesPersistApi():
  | BackgroundIndexingPreferencesPersistApi
  | undefined {
  return (
    useBackgroundIndexingPreferencesStore as typeof useBackgroundIndexingPreferencesStore & {
      persist?: BackgroundIndexingPreferencesPersistApi;
    }
  ).persist;
}

function readBackgroundIndexingPreferencesPersistHydrated(): boolean {
  return getBackgroundIndexingPreferencesPersistApi()?.hasHydrated?.() === true;
}

function subscribeToBackgroundIndexingPreferencesPersistHydration(
  callback: () => void
): () => void {
  return (
    getBackgroundIndexingPreferencesPersistApi()?.onFinishHydration?.(() => {
      callback();
    }) ?? (() => undefined)
  );
}

function createRuntimeUnavailableMessage(missingDependencies: string[]): string {
  if (missingDependencies.length === 0) {
    return 'Background indexing runtime is unavailable.';
  }
  return `Background indexing runtime is unavailable: ${missingDependencies.join(', ')}.`;
}

interface BackgroundRepositorySet {
  readonly chunkRepository: unknown;
  readonly embeddingSetsRepository: unknown;
  readonly fileRecordRepository: unknown;
}

function collectMissingBackgroundRepositoryDependencies(
  backgroundRepositories: BackgroundRepositorySet | null
): string[] {
  if (!backgroundRepositories) {
    return ['backgroundRepositories'];
  }
  return [
    ...(backgroundRepositories.fileRecordRepository ? [] : ['fileRecordRepository']),
    ...(backgroundRepositories.chunkRepository ? [] : ['chunkRepository']),
    ...(backgroundRepositories.embeddingSetsRepository ? [] : ['embeddingSetsRepository']),
  ];
}

function collectMissingRuntimeDependencies(args: {
  backgroundDb: unknown;
  backgroundRepositories: BackgroundRepositorySet | null;
  db: unknown;
  fileSystemAdapter: unknown;
  runtimeEngine: BootstrapRuntimeEngine;
  tursoExecutionClient: unknown;
  waitForBackgroundPermit: unknown;
}): string[] {
  return [
    ...(args.db ? [] : ['db']),
    ...(args.backgroundDb ? [] : ['backgroundDb']),
    ...(args.waitForBackgroundPermit ? [] : ['waitForBackgroundPermit']),
    ...(isBackgroundIndexingRuntimeEngine(args.runtimeEngine) ? [] : ['runtimeEngine']),
    ...(args.runtimeEngine === 'turso' && !args.tursoExecutionClient
      ? ['tursoExecutionClient']
      : []),
    ...collectMissingBackgroundRepositoryDependencies(args.backgroundRepositories),
    ...(args.fileSystemAdapter ? [] : ['fileSystemAdapter']),
  ];
}

function createClearedProgressPatch(): Pick<
  WorkspaceCollectionSyncStatusPatch,
  | 'backfillRequestId'
  | 'blockedReason'
  | 'chunkingProgress'
  | 'currentFilePath'
  | 'embeddingProgress'
  | 'importProgress'
  | 'lastError'
  | 'pauseReasons'
  | 'processedFiles'
  | 'queueProgress'
  | 'queuedFiles'
  | 'scanSummary'
> {
  return {
    backfillRequestId: null,
    blockedReason: null,
    currentFilePath: null,
    scanSummary: null,
    importProgress: null,
    chunkingProgress: null,
    embeddingProgress: null,
    queueProgress: null,
    queuedFiles: 0,
    processedFiles: 0,
    lastError: null,
    pauseReasons: [],
  };
}

interface WorkspaceCoverageAuditTarget {
  readonly dbRootId: string;
  readonly expectedFileCount: number;
  readonly rootPath: string;
}

type WorkspaceCoverageAuditOutcome =
  | {
      readonly kind: 'complete';
    }
  | {
      readonly kind: 'incomplete';
      readonly indexedCounts: ReadonlyMap<string, number>;
      readonly message: string;
      readonly missingTargets: readonly WorkspaceCoverageAuditTarget[];
    }
  | {
      readonly kind: 'unresolved-root';
      readonly message: string;
      readonly rootPath: string;
    };
type WorkspaceCoverageIncompleteOutcome = Extract<
  WorkspaceCoverageAuditOutcome,
  { readonly kind: 'incomplete' }
>;
type WorkspaceCoverageAuditTargetResult =
  | WorkspaceCoverageAuditTarget
  | Extract<WorkspaceCoverageAuditOutcome, { readonly kind: 'unresolved-root' }>;

function parseDatabaseCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readRootIdFromCountRow(row: unknown): string | null {
  if (!(row && typeof row === 'object')) {
    return null;
  }
  const record = row as Record<string, unknown>;
  const rootId = record['root_id'] ?? record['rootId'];
  return typeof rootId === 'string' && rootId.length > 0 ? rootId : null;
}

function readFileCountFromCountRow(row: unknown): number {
  if (!(row && typeof row === 'object')) {
    return 0;
  }
  const record = row as Record<string, unknown>;
  return parseDatabaseCount(record['file_count'] ?? record['fileCount'] ?? record['count']);
}

function createTursoBackgroundChunkRepository(
  repository: TursoFileChunkRepository
): WorkspaceCollectionSyncServiceDependencies['chunkRepository'] {
  return {
    deleteByFileRecordId: (fileRecordId) => repository.deleteByFileRecordId(fileRecordId),
    getCoverageForSet: (embeddingSetId) => repository.getCoverageForSet(embeddingSetId),
    insertMany: async () => {
      throw new Error(TURSO_BACKGROUND_CHUNK_ENQUEUE_REQUIRED_ERROR);
    },
    update: async () => {
      throw new Error(TURSO_BACKGROUND_CHUNK_UPDATE_UNSUPPORTED_ERROR);
    },
  };
}

function getBackgroundTursoRunTransaction(): BackgroundTursoRunTransaction | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const runTransaction = (
    window.electronAPI?.db as
      | { readonly runTransaction?: BackgroundTursoRunTransaction }
      | undefined
  )?.runTransaction;
  return typeof runTransaction === 'function' ? runTransaction : null;
}

function createBackgroundTursoExecutionClient(db: DbHandle): BrainstrikeDbExecutionClient {
  if (typeof db.exec !== 'function') {
    throw new Error('Workspace Index Turso background repositories require db.exec support.');
  }
  const query = db.query.bind(db);
  const exec = db.exec.bind(db);
  const transactionClient: BrainstrikeDbTransactionClient = {
    exec: async (sql, params, options) => {
      const forwardedParams = params ? [...params] : undefined;
      if (options === undefined) {
        await exec(sql, forwardedParams);
        return;
      }
      await exec(sql, forwardedParams, options);
    },
    query: async (sql, params, options) => {
      const forwardedParams = params ? [...params] : undefined;
      if (options === undefined) {
        return await query(sql, forwardedParams);
      }
      return await query(sql, forwardedParams, options);
    },
  };
  return {
    ...transactionClient,
    transaction: async (callback) => {
      const runTransaction = getBackgroundTursoRunTransaction();
      if (!runTransaction) {
        throw new Error(
          'Workspace Index Turso background repository transactions require desktop transaction IPC support.'
        );
      }
      const statements: BackgroundTursoTransactionStatement[] = [];
      const batchClient: BrainstrikeDbTransactionClient = {
        exec: async (sql, params, options) => {
          if (options) {
            throw new Error(
              'Workspace Index Turso background transaction adapter does not support per-statement work options.'
            );
          }
          statements.push({ sql, ...(params ? { params: [...params] } : {}) });
        },
        query: async () => {
          throw new Error(
            'Workspace Index Turso background transaction adapter only supports exec statements.'
          );
        },
      };

      const result = await callback(batchClient);
      if (statements.length > 0) {
        await runTransaction(statements, 0, BACKGROUND_DATABASE_WORK_OPTIONS);
      }
      return result;
    },
  };
}

function isUnresolvedRootAuditOutcome(
  value: WorkspaceCoverageAuditTargetResult
): value is Extract<WorkspaceCoverageAuditOutcome, { readonly kind: 'unresolved-root' }> {
  return 'kind' in value && value.kind === 'unresolved-root';
}

function isWorkspaceCoverageAuditTarget(
  value: WorkspaceCoverageAuditTargetResult
): value is WorkspaceCoverageAuditTarget {
  return !isUnresolvedRootAuditOutcome(value);
}

async function readIndexedFileCountsByRoot(args: {
  collectionId: string;
  db: DbHandle;
  rootIds: readonly string[];
  runtimeEngine: 'pglite' | 'turso';
}): Promise<Map<string, number>> {
  if (args.rootIds.length === 0) {
    return new Map();
  }
  const rootPlaceholders =
    args.runtimeEngine === 'pglite'
      ? args.rootIds.map((_, index) => `$${index + 2}`).join(', ')
      : args.rootIds.map(() => '?').join(', ');
  const collectionPlaceholder = args.runtimeEngine === 'pglite' ? '$1' : '?';
  const result = await args.db.query(
    `
      SELECT root_id, COUNT(*) AS file_count
      FROM file_records
      WHERE embedding_set_id = ${collectionPlaceholder}
        AND root_id IN (${rootPlaceholders})
      GROUP BY root_id
    `,
    [args.collectionId, ...args.rootIds]
  );
  const counts = new Map<string, number>();
  for (const row of Array.isArray(result.rows) ? result.rows : []) {
    const rootId = readRootIdFromCountRow(row);
    if (rootId) {
      counts.set(rootId, readFileCountFromCountRow(row));
    }
  }
  return counts;
}

function buildCoverageAuditMessage(args: {
  missingTargets: readonly WorkspaceCoverageAuditTarget[];
  indexedCounts: ReadonlyMap<string, number>;
}): string {
  const firstMissing = args.missingTargets[0];
  const rootSummary = args.missingTargets
    .slice(0, 3)
    .map((target) => {
      const indexedFileCount = args.indexedCounts.get(target.dbRootId) ?? 0;
      return `${target.rootPath} (${indexedFileCount}/${target.expectedFileCount} files indexed)`;
    })
    .join('; ');
  const extraCount =
    args.missingTargets.length > 3 ? `; +${args.missingTargets.length - 3} more` : '';
  return `Workspace Index coverage is incomplete after the pipeline reported idle: ${rootSummary}${extraCount}. A full recovery sync is required before this index can be treated as complete.${
    firstMissing ? ` First incomplete root: ${firstMissing.rootPath}.` : ''
  }`;
}

function getActiveRootHandles(args: {
  rootDirectoryHandle: DirectoryHandle | null;
  rootDirectoryHandles: readonly DirectoryHandle[];
}): readonly DirectoryHandle[] {
  if (args.rootDirectoryHandles.length > 0) {
    return args.rootDirectoryHandles;
  }
  return args.rootDirectoryHandle ? [args.rootDirectoryHandle] : [];
}

function createCoverageAuditKey(args: {
  collectionId: string;
  handles: readonly DirectoryHandle[];
  policyPreset: BackgroundIndexingPolicyPreset;
  rootIdByPath: ReadonlyMap<string, string>;
}): string {
  const rootsKey = args.handles
    .map((handle) => `${handle.path}:${handle.rootId ?? args.rootIdByPath.get(handle.path) ?? ''}`)
    .join('|');
  return `${args.collectionId}:${args.policyPreset}:${rootsKey}`;
}

function createCoverageStatusPatch(args: {
  activeRootPath: string | null;
  collectionId: string;
  lastError: string | null;
  state: 'error' | 'idle' | 'waiting';
}): WorkspaceCollectionSyncStatusPatch {
  return {
    state: args.state,
    managedCollectionId: args.collectionId,
    activeRootPath: args.activeRootPath,
    currentFilePath: null,
    queuedFiles: 0,
    lastError: args.lastError,
    pauseReasons: [],
  };
}

interface IdleCoverageAuditRequest {
  readonly activeRootPath: string | null;
  readonly auditKey: string;
  readonly collectionId: string;
  readonly db: DbHandle;
  readonly fileSystemAdapter: NonNullable<ReturnType<typeof useAdapters>['fileSystemAdapter']>;
  readonly handles: readonly DirectoryHandle[];
  readonly runtimeEngine: BackgroundIndexingRuntimeEngine;
}

function shouldResetCoverageAuditTracking(
  status: ReturnType<typeof useWorkspaceCollectionSyncStatusStore.getState>
): boolean {
  return status.state !== 'idle' && status.state !== 'waiting';
}

function createIdleCoverageAuditRequest(args: {
  backgroundDb: DbHandle | null;
  enabled: boolean;
  fileSystemAdapter: NonNullable<ReturnType<typeof useAdapters>['fileSystemAdapter']> | null;
  indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  managedCollectionId: string | null;
  rootDirectoryHandle: DirectoryHandle | null;
  rootDirectoryHandles: readonly DirectoryHandle[];
  rootIdByPath: ReadonlyMap<string, string>;
  runtimeEngine: BootstrapRuntimeEngine;
  status: ReturnType<typeof useWorkspaceCollectionSyncStatusStore.getState>;
}): IdleCoverageAuditRequest | null {
  if (args.status.state !== 'idle') {
    return null;
  }
  const collectionId = args.status.managedCollectionId ?? args.managedCollectionId;
  const auditRuntimeEngine = isBackgroundIndexingRuntimeEngine(args.runtimeEngine)
    ? args.runtimeEngine
    : null;
  if (
    !(
      args.enabled &&
      collectionId &&
      args.backgroundDb &&
      args.fileSystemAdapter &&
      auditRuntimeEngine
    )
  ) {
    return null;
  }
  const handles = getActiveRootHandles({
    rootDirectoryHandle: args.rootDirectoryHandle,
    rootDirectoryHandles: args.rootDirectoryHandles,
  });
  if (handles.length === 0) {
    return null;
  }
  return {
    activeRootPath: args.rootDirectoryHandle?.path ?? handles[0]?.path ?? null,
    auditKey: createCoverageAuditKey({
      collectionId,
      handles,
      policyPreset: args.indexingPolicyPreset,
      rootIdByPath: args.rootIdByPath,
    }),
    collectionId,
    db: args.backgroundDb,
    fileSystemAdapter: args.fileSystemAdapter,
    handles,
    runtimeEngine: auditRuntimeEngine,
  };
}

async function buildCoverageAuditTargets(args: {
  fileSystemAdapter: NonNullable<ReturnType<typeof useAdapters>['fileSystemAdapter']>;
  handles: readonly DirectoryHandle[];
  policyPreset: BackgroundIndexingPolicyPreset;
  resolveDbRootId: (path: string, rootId?: string) => Promise<string | null>;
  rootIdByPath: ReadonlyMap<string, string>;
}): Promise<readonly WorkspaceCoverageAuditTarget[] | WorkspaceCoverageAuditOutcome> {
  const targetResults: WorkspaceCoverageAuditTargetResult[] = await Promise.all(
    args.handles.map(async (handle) => {
      const adapterRootId = handle.rootId ?? args.rootIdByPath.get(handle.path);
      const dbRootId = await args.resolveDbRootId(handle.path, adapterRootId);
      if (!dbRootId) {
        return {
          kind: 'unresolved-root',
          message: `Workspace Index coverage cannot be verified because root ${handle.path} has no resolved database root id.`,
          rootPath: handle.path,
        };
      }
      const expected = await countExpectedWorkspaceIndexFiles({
        fileSystemAdapter: args.fileSystemAdapter,
        includeFiles: false,
        policyPreset: args.policyPreset,
        rootHandle: handle,
      });
      return {
        dbRootId,
        expectedFileCount: expected.expectedFileCount,
        rootPath: handle.path,
      };
    })
  );
  const unresolvedRoot = targetResults.find(isUnresolvedRootAuditOutcome);
  if (unresolvedRoot) {
    return unresolvedRoot;
  }
  return targetResults.filter(isWorkspaceCoverageAuditTarget);
}

function isCoverageAuditOutcome(
  value: readonly WorkspaceCoverageAuditTarget[] | WorkspaceCoverageAuditOutcome
): value is WorkspaceCoverageAuditOutcome {
  return !Array.isArray(value);
}

async function runWorkspaceCoverageAudit(args: {
  collectionId: string;
  db: DbHandle;
  fileSystemAdapter: NonNullable<ReturnType<typeof useAdapters>['fileSystemAdapter']>;
  handles: readonly DirectoryHandle[];
  isCurrent: () => boolean;
  policyPreset: BackgroundIndexingPolicyPreset;
  resolveDbRootId: (path: string, rootId?: string) => Promise<string | null>;
  rootIdByPath: ReadonlyMap<string, string>;
  runtimeEngine: 'pglite' | 'turso';
}): Promise<WorkspaceCoverageAuditOutcome | null> {
  if (!args.isCurrent()) {
    return null;
  }
  const targets = await buildCoverageAuditTargets(args);
  if (args.isCurrent()) {
    if (isCoverageAuditOutcome(targets)) {
      return targets;
    }
  } else {
    return null;
  }
  if (!args.isCurrent()) {
    return null;
  }
  const indexedCounts = await readIndexedFileCountsByRoot({
    collectionId: args.collectionId,
    db: args.db,
    rootIds: targets.map((target) => target.dbRootId),
    runtimeEngine: args.runtimeEngine,
  });
  if (args.isCurrent()) {
    const missingTargets = targets.filter(
      (target) => (indexedCounts.get(target.dbRootId) ?? 0) < target.expectedFileCount
    );
    if (missingTargets.length === 0) {
      return { kind: 'complete' };
    }
    return {
      kind: 'incomplete',
      indexedCounts,
      message: buildCoverageAuditMessage({ indexedCounts, missingTargets }),
      missingTargets,
    };
  }
  return null;
}

function applyWorkspaceCoverageAuditOutcome(args: {
  activeRootPath: string | null;
  auditKey: string;
  collectionId: string;
  markAuditVerified: (auditKey: string) => void;
  outcome: WorkspaceCoverageAuditOutcome;
  setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => void;
}): boolean {
  if (args.outcome.kind === 'complete') {
    args.markAuditVerified(args.auditKey);
    args.setStatus(
      createCoverageStatusPatch({
        activeRootPath: args.activeRootPath,
        collectionId: args.collectionId,
        lastError: null,
        state: 'idle',
      })
    );
    return false;
  }
  if (args.outcome.kind === 'unresolved-root') {
    logger.warn(args.outcome.message, { rootPath: args.outcome.rootPath });
    args.setStatus(
      createCoverageStatusPatch({
        activeRootPath: args.outcome.rootPath,
        collectionId: args.collectionId,
        lastError: args.outcome.message,
        state: 'waiting',
      })
    );
    return false;
  }
  applyWorkspaceCoverageIncompleteOutcome({
    collectionId: args.collectionId,
    outcome: args.outcome,
    setStatus: args.setStatus,
  });
  return true;
}

function applyWorkspaceCoverageIncompleteOutcome(args: {
  collectionId: string;
  outcome: WorkspaceCoverageIncompleteOutcome;
  setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => void;
}): void {
  logger.warn('Workspace Index idle coverage audit found incomplete roots', {
    collectionId: args.collectionId,
    missingRoots: args.outcome.missingTargets.map((target) => ({
      expectedFileCount: target.expectedFileCount,
      indexedFileCount: args.outcome.indexedCounts.get(target.dbRootId) ?? 0,
      rootPath: target.rootPath,
    })),
  });
  args.setStatus(
    createCoverageStatusPatch({
      activeRootPath: args.outcome.missingTargets[0]?.rootPath ?? null,
      collectionId: args.collectionId,
      lastError: args.outcome.message,
      state: 'waiting',
    })
  );
}

function startWorkspaceCoverageAudit(args: {
  activeRootPath: string | null;
  auditKey: string;
  clearInFlightAudit: (auditKey: string) => void;
  collectionId: string;
  db: DbHandle;
  fileSystemAdapter: NonNullable<ReturnType<typeof useAdapters>['fileSystemAdapter']>;
  handles: readonly DirectoryHandle[];
  isCurrent: () => boolean;
  markAuditVerified: (auditKey: string) => void;
  policyPreset: BackgroundIndexingPolicyPreset;
  resolveDbRootId: (path: string, rootId?: string) => Promise<string | null>;
  rootIdByPath: ReadonlyMap<string, string>;
  runtimeEngine: 'pglite' | 'turso';
  setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => void;
}): Promise<boolean> {
  return runWorkspaceCoverageAudit({
    collectionId: args.collectionId,
    db: args.db,
    fileSystemAdapter: args.fileSystemAdapter,
    handles: args.handles,
    isCurrent: args.isCurrent,
    policyPreset: args.policyPreset,
    resolveDbRootId: args.resolveDbRootId,
    rootIdByPath: args.rootIdByPath,
    runtimeEngine: args.runtimeEngine,
  })
    .then((outcome) => {
      if (!outcome) {
        return false;
      }
      return applyWorkspaceCoverageAuditOutcome({
        activeRootPath: args.activeRootPath,
        auditKey: args.auditKey,
        collectionId: args.collectionId,
        markAuditVerified: args.markAuditVerified,
        outcome,
        setStatus: args.setStatus,
      });
    })
    .catch((error: unknown) => {
      if (!args.isCurrent()) {
        return false;
      }
      const message = `Workspace Index coverage audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      logger.error(message, { error });
      args.setStatus(
        createCoverageStatusPatch({
          activeRootPath: args.activeRootPath,
          collectionId: args.collectionId,
          lastError: message,
          state: 'error',
        })
      );
      return false;
    })
    .finally(() => {
      args.clearInFlightAudit(args.auditKey);
    });
}

interface WorkspaceIndexingPowerBridge {
  getSnapshot?: () => Promise<WorkspaceIndexingPowerSnapshot>;
}

type TriggerSyncScope =
  | {
      mode: 'full';
    }
  | {
      mode: 'paths';
      roots: Array<{
        changes: readonly FileSystemChange[];
        rootId: string;
      }>;
    };

interface TriggerSyncOptions {
  restartActive?: boolean;
}

function mergeTriggerSyncScopes(
  current: TriggerSyncScope | null,
  incoming: TriggerSyncScope
): TriggerSyncScope {
  if (current === null) {
    return incoming;
  }
  if (current.mode === 'full' || incoming.mode === 'full') {
    return { mode: 'full' };
  }

  const rootsById = new Map<string, { changes: FileSystemChange[]; rootId: string }>();
  for (const root of current.roots) {
    rootsById.set(root.rootId, {
      rootId: root.rootId,
      changes: [...root.changes],
    });
  }
  for (const root of incoming.roots) {
    const existing = rootsById.get(root.rootId);
    rootsById.set(root.rootId, {
      rootId: root.rootId,
      changes: [...(existing?.changes ?? []), ...root.changes],
    });
  }
  return {
    mode: 'paths',
    roots: [...rootsById.values()],
  };
}

function handleActiveSyncLoopRequest(args: {
  options: TriggerSyncOptions;
  pendingSyncScopeRef: { current: TriggerSyncScope | null };
  reportCancelError: (error: unknown) => void;
  scope: TriggerSyncScope;
  service: WorkspaceCollectionSyncService;
  syncLoopActiveRef: { current: boolean };
  syncLoopDebugRef: { current: Record<string, unknown> };
  syncLoopGenerationRef: { current: number };
}): boolean {
  if (!args.syncLoopActiveRef.current) {
    return false;
  }
  if (args.options.restartActive === true) {
    args.syncLoopGenerationRef.current += 1;
    args.syncLoopActiveRef.current = false;
    args.pendingSyncScopeRef.current = null;
    void args.service.cancel().catch(args.reportCancelError);
    return false;
  }

  args.pendingSyncScopeRef.current = mergeTriggerSyncScopes(
    args.pendingSyncScopeRef.current,
    args.scope
  );
  args.syncLoopDebugRef.current = {
    ...args.syncLoopDebugRef.current,
    pendingScope: args.pendingSyncScopeRef.current.mode,
    state: 'queued-while-active',
    updatedAt: new Date().toISOString(),
  };
  return true;
}

function invalidateActiveSyncLoop(args: {
  pendingSyncScopeRef: { current: TriggerSyncScope | null };
  reportCancelError: (error: unknown) => void;
  service: WorkspaceCollectionSyncService;
  syncLoopActiveRef: { current: boolean };
  syncLoopGenerationRef: { current: number };
}): void {
  if (!(args.syncLoopActiveRef.current || args.pendingSyncScopeRef.current)) {
    return;
  }
  args.syncLoopGenerationRef.current += 1;
  args.syncLoopActiveRef.current = false;
  args.pendingSyncScopeRef.current = null;
  void args.service.cancel().catch(args.reportCancelError);
}

interface SyncLoopTarget {
  handle: DirectoryHandle;
  scope: {
    changes?: readonly FileSystemChange[];
    mode: 'full' | 'paths';
  };
}

type ResolvedSyncLoopTarget = SyncLoopTarget & { dbRootId: string };

function buildFullSyncTargets(handles: readonly DirectoryHandle[]): SyncLoopTarget[] {
  return handles.map((handle) => ({
    handle,
    scope: { mode: 'full' },
  }));
}

function hasResolvedDbRootId(
  target: SyncLoopTarget & { dbRootId: string | null }
): target is ResolvedSyncLoopTarget {
  return target.dbRootId !== null;
}

// Order targets by ASCENDING indexed file count so the LEAST-covered roots sync
// first: a brand-new (0-file) root, or one whose earlier pass imported nothing,
// is reached before a giant repo that is only partway through its import, and
// before fully-indexed roots that just need a re-scan. Stable (equal coverage
// keeps discovery order). Reading ACTUAL coverage — rather than a session flag —
// means a root whose pass was superseded before importing anything stays at 0
// and keeps its first claim, so one huge root can never starve the others.
function orderTargetsByIndexedCoverage(
  targets: readonly ResolvedSyncLoopTarget[],
  indexedCounts: ReadonlyMap<string, number>
): ResolvedSyncLoopTarget[] {
  return targets
    .map((target, index) => ({ count: indexedCounts.get(target.dbRootId) ?? 0, index, target }))
    .sort((a, b) => a.count - b.count || a.index - b.index)
    .map((entry) => entry.target);
}

// Read each root's actual indexed file count, then order least-covered-first.
// Skips the query when there is only one root to order (nothing to reorder) or
// when the DB/collection is unavailable. A failed query falls back to discovery
// order (logged) so the ordering optimization never blocks indexing.
async function loadOrderedSyncTargets(args: {
  backgroundDb: DbHandle | null;
  managedCollectionId: string | null;
  runtimeEngine: BootstrapRuntimeEngine;
  syncableTargets: readonly ResolvedSyncLoopTarget[];
}): Promise<ResolvedSyncLoopTarget[]> {
  const { backgroundDb, managedCollectionId, runtimeEngine, syncableTargets } = args;
  if (
    syncableTargets.length <= 1 ||
    !(managedCollectionId && backgroundDb) ||
    !isBackgroundIndexingRuntimeEngine(runtimeEngine)
  ) {
    return orderTargetsByIndexedCoverage(syncableTargets, new Map());
  }
  const indexedCounts = await readIndexedFileCountsByRoot({
    collectionId: managedCollectionId,
    db: backgroundDb,
    rootIds: syncableTargets.map((target) => target.dbRootId),
    runtimeEngine,
  }).catch((error) => {
    logger.warn('Coverage-based root ordering query failed; using discovery order', { error });
    return new Map<string, number>();
  });
  return orderTargetsByIndexedCoverage(syncableTargets, indexedCounts);
}

export interface WorkspaceCollectionSyncProviderProps {
  children: ReactNode;
}

function createBackgroundRepositoryDb(db: DbHandle): {
  exec: (sql: string) => Promise<void>;
  insertChunksAndEnqueueEmbeddingJobs?: DbHandle['insertChunksAndEnqueueEmbeddingJobs'];
  query: DbHandle['query'];
} {
  if (!db.exec) {
    throw new Error('Background indexing requires database exec support.');
  }
  const handle: {
    exec: (sql: string) => Promise<void>;
    insertChunksAndEnqueueEmbeddingJobs?: DbHandle['insertChunksAndEnqueueEmbeddingJobs'];
    query: DbHandle['query'];
  } = {
    query: db.query,
    exec: async (sql: string) => {
      await db.exec?.(sql);
    },
  };
  if (db.insertChunksAndEnqueueEmbeddingJobs) {
    handle.insertChunksAndEnqueueEmbeddingJobs = db.insertChunksAndEnqueueEmbeddingJobs.bind(db);
  }
  return handle;
}

function isFileSystemChange(value: unknown): value is FileSystemChange {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate['kind'] === 'file' || candidate['kind'] === 'directory') &&
    (candidate['type'] === 'added' ||
      candidate['type'] === 'removed' ||
      candidate['type'] === 'modified') &&
    typeof candidate['path'] === 'string' &&
    candidate['path'].length > 0
  );
}

function isWorkspaceRefreshDetail(value: unknown): value is FileExplorerRefreshEventDetail {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !(
      candidate['source'] === 'watcher' ||
      candidate['source'] === 'manual' ||
      candidate['source'] === 'visibility-recovery'
    )
  ) {
    return false;
  }
  if (!(candidate['scope'] === 'incremental' || candidate['scope'] === 'full')) {
    return false;
  }
  if (!Array.isArray(candidate['roots'])) {
    return false;
  }
  return candidate['roots'].every((root) => {
    if (!(root && typeof root === 'object')) {
      return false;
    }
    const rootCandidate = root as Record<string, unknown>;
    return (
      typeof rootCandidate['rootId'] === 'string' &&
      rootCandidate['rootId'].length > 0 &&
      typeof rootCandidate['rootPath'] === 'string' &&
      Array.isArray(rootCandidate['changes']) &&
      rootCandidate['changes'].every(isFileSystemChange)
    );
  });
}

function parseRefreshSyncScope(event: Event): TriggerSyncScope {
  if (!(event instanceof CustomEvent)) {
    return { mode: 'full' };
  }
  if (!isWorkspaceRefreshDetail(event.detail)) {
    return { mode: 'full' };
  }
  if (!(event.detail.source === 'watcher' && event.detail.scope === 'incremental')) {
    return { mode: 'full' };
  }
  if (event.detail.roots.length === 0) {
    return { mode: 'full' };
  }
  return {
    mode: 'paths',
    roots: event.detail.roots.map((root) => ({
      rootId: root.rootId,
      changes: root.changes,
    })),
  };
}

function buildPathSyncTargets(args: {
  allHandles: readonly DirectoryHandle[];
  rootIdByPath: ReadonlyMap<string, string>;
  scope: Extract<TriggerSyncScope, { mode: 'paths' }>;
}): SyncLoopTarget[] {
  const targetByRootId = new Map<string, SyncLoopTarget>();
  for (const handle of args.allHandles) {
    const rootId = handle.rootId ?? args.rootIdByPath.get(handle.path);
    if (!rootId) {
      continue;
    }
    targetByRootId.set(rootId, {
      handle,
      scope: { mode: 'paths', changes: [] },
    });
  }
  for (const root of args.scope.roots) {
    const target = targetByRootId.get(root.rootId);
    if (!target) {
      continue;
    }
    const existingChanges = target.scope.changes ?? [];
    targetByRootId.set(root.rootId, {
      handle: target.handle,
      scope: {
        mode: 'paths',
        changes: [...existingChanges, ...root.changes],
      },
    });
  }
  return [...targetByRootId.values()].filter(
    (target) => target.scope.mode === 'paths' && (target.scope.changes?.length ?? 0) > 0
  );
}

function buildSyncLoopTargets(args: {
  rootDirectoryHandle: DirectoryHandle;
  rootDirectoryHandles: readonly DirectoryHandle[];
  rootIdByPath: ReadonlyMap<string, string>;
  scope: TriggerSyncScope;
}): SyncLoopTarget[] {
  const allHandles =
    args.rootDirectoryHandles.length > 0 ? args.rootDirectoryHandles : [args.rootDirectoryHandle];
  if (args.scope.mode === 'full') {
    return buildFullSyncTargets(allHandles);
  }
  const pathTargets = buildPathSyncTargets({
    allHandles,
    rootIdByPath: args.rootIdByPath,
    scope: args.scope,
  });
  if (pathTargets.length > 0) {
    return pathTargets;
  }
  logger.warn('Watcher refresh referenced no active workspace roots; running full recovery sync', {
    rootIds: args.scope.roots.map((root) => root.rootId),
  });
  return buildFullSyncTargets(allHandles);
}

function createWaitForBackgroundPermit(
  db: DbHandle
): (options: { readonly label: string }) => Promise<void> {
  const scheduler = getDatabaseWorkScheduler(db);
  if (scheduler) {
    return boundBackgroundPermitWait(
      createDatabasePressureController({ scheduler }).waitForBackgroundPermit
    );
  }

  const schedulerSnapshot =
    typeof window === 'undefined' ? undefined : window.electronAPI?.db?.schedulerSnapshot;
  if (!schedulerSnapshot) {
    throw new Error('Background indexing requires database QoS scheduler snapshots.');
  }

  return boundBackgroundPermitWait(
    createDatabasePressureController({
      pollMs: BACKGROUND_PRESSURE_POLL_MS,
      snapshotSource: {
        getSnapshot: schedulerSnapshot,
      },
    }).waitForBackgroundPermit
  );
}

function toWorkspaceIndexingDatabasePressure(
  snapshot: DatabaseWorkSchedulerSnapshot
): WorkspaceIndexingDatabasePressure {
  const waitingReason = getDatabasePressureWaitingReason(snapshot, snapshot.snapshotAt);
  const normalPressure = waitingReason?.startsWith('normal-') === true;
  return {
    available: true,
    foregroundPressure: waitingReason !== null && !normalPressure,
    normalPressure,
  };
}

function createReadDatabasePressure(
  db: DbHandle
): () => Promise<WorkspaceIndexingDatabasePressure> {
  const scheduler = getDatabaseWorkScheduler(db);
  if (scheduler) {
    return async () => toWorkspaceIndexingDatabasePressure(scheduler.getSnapshot());
  }

  const schedulerSnapshot =
    typeof window === 'undefined' ? undefined : window.electronAPI?.db?.schedulerSnapshot;
  if (!schedulerSnapshot) {
    throw new Error('Workspace Index QoS requires database scheduler snapshots.');
  }

  return async () => toWorkspaceIndexingDatabasePressure(await schedulerSnapshot());
}

function readRendererMemoryPressure(): WorkspaceIndexingPipelineInputs['memory'] {
  const memory = (globalThis.performance as Performance & { memory?: BrowserPerformanceMemory })
    .memory;
  const used = memory?.usedJSHeapSize;
  const limit = memory?.jsHeapSizeLimit;
  if (
    typeof used !== 'number' ||
    typeof limit !== 'number' ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return { available: false };
  }
  const retainedHeapRatio = used / limit;
  return {
    available: true,
    pressure: retainedHeapRatio >= HIGH_RETAINED_HEAP_RATIO ? 'high' : 'normal',
    retainedHeapRatio,
  };
}

function createReadPipelineInputs(
  db: DbHandle,
  runtimeEngine: 'pglite' | 'turso'
): () => Promise<WorkspaceIndexingPipelineInputs> {
  return async () => {
    const sql =
      runtimeEngine === 'pglite'
        ? `SELECT COUNT(*)::int AS count
             FROM job_queue
            WHERE queue = 'embeddings'
              AND job_type = 'embed_chunk'
              AND state IN ('queued', 'running')`
        : `SELECT COUNT(*) AS count
             FROM job_queue
            WHERE queue = 'embeddings'
              AND job_type = 'embed_chunk'
              AND state IN ('queued', 'running')`;
    const result = await db.query<{ count: number | string }>(sql);
    const rawCount = result.rows[0]?.count;
    const activeEmbeddingJobs = typeof rawCount === 'number' ? rawCount : Number(rawCount ?? 0);
    if (!Number.isFinite(activeEmbeddingJobs) || activeEmbeddingJobs < 0) {
      throw new Error('Workspace Index QoS received an invalid embedding queue depth.');
    }
    return {
      accelerator: { available: false },
      memory: readRendererMemoryPressure(),
      progress: { available: false },
      queueDepth: {
        activeEmbeddingJobs,
        available: true,
      },
    };
  };
}

function createReadPowerSnapshot(): (() => Promise<WorkspaceIndexingPowerSnapshot>) | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { power?: WorkspaceIndexingPowerBridge }).power;
  const getSnapshot = bridge?.getSnapshot;
  if (typeof getSnapshot !== 'function') {
    return null;
  }
  return createCachedSnapshotReader(
    async () => assertValidWorkspaceIndexingPowerSnapshot(await getSnapshot()),
    BACKGROUND_POWER_SNAPSHOT_CACHE_MS
  );
}

function createCachedSnapshotReader<TSnapshot>(
  readSnapshot: () => TSnapshot | Promise<TSnapshot>,
  cacheMs: number,
  now: () => number = () => Date.now()
): () => Promise<TSnapshot> {
  let cachedSnapshot: TSnapshot | null = null;
  let cachedAt = 0;
  let pendingSnapshot: Promise<TSnapshot> | null = null;
  return async () => {
    const readAt = now();
    if (cachedSnapshot && readAt - cachedAt <= cacheMs) {
      return cachedSnapshot;
    }
    if (pendingSnapshot) {
      return pendingSnapshot;
    }
    cachedSnapshot = null;
    cachedAt = 0;
    pendingSnapshot = Promise.resolve()
      .then(readSnapshot)
      .then((snapshot) => {
        cachedSnapshot = snapshot;
        cachedAt = now();
        return snapshot;
      });
    try {
      return await pendingSnapshot;
    } finally {
      pendingSnapshot = null;
    }
  };
}

function useDocumentVisibility(): boolean {
  const readVisibility = (): boolean =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible';
  const [visible, setVisible] = useState(readVisibility);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const handleVisibilityChange = (): void => {
      setVisible(readVisibility());
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return visible;
}

function useRecentUserInputMsReader(): () => number | null {
  const lastInputRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const recordInput = (): void => {
      lastInputRef.current = Date.now();
    };
    const inputEvents = ['keydown', 'pointerdown', 'wheel'] as const;
    for (const eventName of inputEvents) {
      window.addEventListener(eventName, recordInput, { passive: true });
    }
    return () => {
      for (const eventName of inputEvents) {
        window.removeEventListener(eventName, recordInput);
      }
    };
  }, []);

  return useCallback((): number | null => {
    const lastInputAt = lastInputRef.current;
    if (lastInputAt === null) {
      return null;
    }
    const inputAgeMs = Math.max(0, Date.now() - lastInputAt);
    return inputAgeMs > RECENT_USER_INPUT_WINDOW_MS ? null : inputAgeMs;
  }, []);
}

export function WorkspaceCollectionSyncProvider({
  children,
}: WorkspaceCollectionSyncProviderProps) {
  const { fileSystemAdapter } = useAdapters();
  const { isAccessLoading, rootDirectoryHandle, rootDirectoryHandles, rootIdByPath } =
    useFileSystem();
  const fileTreeContext = useOptionalFileTreeContext();
  const workspaceRootsDbClient = useWorkspaceRootsDbClient();
  const db = useModelRegistryDbClient();
  const profileBootstrapReport = useOptionalProfileBootstrapReport();
  const runtimeEngine: BootstrapRuntimeEngine = profileBootstrapReport?.runtime.engine ?? 'unknown';
  const pgliteDb = runtimeEngine === 'pglite' ? db : null;
  const tursoDb = runtimeEngine === 'turso' ? db : null;
  const tursoExecutionClient = useMemo(
    () => (runtimeEngine === 'turso' && db ? extractDbExecutionClient(db) : null),
    [db, runtimeEngine]
  );

  // Root registry: ensure a DB roots row exists for every adapter root.
  // Runs once per boot, before the first sync cycle writes file records.
  // Errors are logged and swallowed — must never block boot.
  // The returned callbacks are ref-stable: identity does not change when the
  // reconciliation map resolves, so the service useMemo is not reconstructed.
  const { registerRoot, resolveDbRootId, dbRootIdByAdapterRootId } = useRootsReconciliation({
    adapter: fileSystemAdapter,
    dbClient: workspaceRootsDbClient,
  });

  // Mid-session root registration (phase 5): roots added via Add Folder get
  // their DB roots row at add time, so their imports write real root_id values
  // immediately instead of NULL-until-next-boot. registerRoot awaits the boot
  // settle and no-ops on already-mapped paths, so calling it for boot-restored
  // handles is safe — this ref only prevents duplicate CALLS per rootId.
  //
  // NOTE: this effect is declared BEFORE the triggerSync effect below so the
  // registration is enqueued before the sync loop starts; resolveDbRootId
  // awaits enqueued registrations, so the new root's first import sees its id.
  const registrationAttemptedRootIdsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const handle of rootDirectoryHandles) {
      // Prefer the stamped handle.rootId — the path→id map collides for
      // same-named web roots, so it would mis-attribute one root's imports.
      const rootId = handle.rootId ?? rootIdByPath.get(handle.path);
      if (rootId === undefined || registrationAttemptedRootIdsRef.current.has(rootId)) {
        // No durable identity yet (legacy setRoot path) → nothing to register;
        // the boot reconcile owns identity for restored roots.
        continue;
      }
      registrationAttemptedRootIdsRef.current.add(rootId);
      // Fire-and-forget: registerRoot never rejects (failures are logged and
      // swallowed inside the hook). The cost of a failed registration is that
      // THIS session's imports for the root write root_id = NULL (no retry —
      // the rootId stays in the attempted set above); the boot reconcile
      // self-heals it next launch, since it reconciles ALL adapter roots.
      void registerRoot({
        displayName: handle.name,
        handle,
        kind: fileSystemAdapter.platform === 'electron' ? 'path' : 'fsa',
        // The handle is live in this session: the only routes into
        // rootDirectoryHandles are addRoot / restoreRoots-driven flows the
        // user has just granted.
        permissionState: 'granted',
        // The useFileSystem surface does not expose per-root persisted state,
        // so reconstruct it: handles reach this list via addRoot or the
        // restore flows, and both persist the handle to the backing store in
        // the normal case. The one exception — web addRoot returning
        // persisted:false after a failed IndexedDB write — is invisible here,
        // so such a root may be registered even though its id won't survive
        // reload (worst case: one orphaned roots row, no cascade impact).
        // Accepted tradeoff per the phase 5 plan.
        persisted: true,
        rootId,
      });
    }
  }, [fileSystemAdapter, registerRoot, rootDirectoryHandles, rootIdByPath]);

  const backgroundDb = useMemo(() => {
    const runtimeDb = pgliteDb ?? tursoDb;
    return runtimeDb ? createPriorityDbHandle(runtimeDb, 'background') : null;
  }, [pgliteDb, tursoDb]);
  const waitForBackgroundPermit = useMemo(
    () => (backgroundDb ? createWaitForBackgroundPermit(backgroundDb) : null),
    [backgroundDb]
  );
  const readDatabasePressure = useMemo(
    () => (backgroundDb ? createReadDatabasePressure(backgroundDb) : null),
    [backgroundDb]
  );
  const readPipelineInputs = useMemo(
    () =>
      backgroundDb && isBackgroundIndexingRuntimeEngine(runtimeEngine)
        ? createReadPipelineInputs(backgroundDb, runtimeEngine)
        : null,
    [backgroundDb, runtimeEngine]
  );
  const readPowerSnapshot = useMemo(() => createReadPowerSnapshot(), []);
  const backgroundRepositories = useMemo(() => {
    if (!backgroundDb) {
      return null;
    }
    if (runtimeEngine === 'turso') {
      if (!tursoExecutionClient) {
        return null;
      }
      const backgroundTursoExecutionClient = createBackgroundTursoExecutionClient(backgroundDb);
      const tursoChunkRepository = new TursoFileChunkRepository(backgroundTursoExecutionClient);
      return {
        chunkRepository: createTursoBackgroundChunkRepository(tursoChunkRepository),
        embeddingSetsRepository: new TursoEmbeddingSetsRepository(backgroundTursoExecutionClient),
        fileRecordRepository: new TursoFileRecordRepository(backgroundTursoExecutionClient),
      };
    }
    if (runtimeEngine !== 'pglite') {
      return null;
    }
    const repositoryDb = createBackgroundRepositoryDb(backgroundDb);
    return {
      chunkRepository: new ElectronFileChunkRepository(repositoryDb),
      embeddingSetsRepository: new ElectronEmbeddingSetsRepository(repositoryDb),
      fileRecordRepository: new ElectronFileRecordRepository(repositoryDb),
    };
  }, [backgroundDb, runtimeEngine, tursoExecutionClient]);
  const { ensureStarted: ensureChunkingWorker } = useChunkingWorkerContext();
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const storeHasHydrated = useBackgroundIndexingPreferencesStore((state) => state.hasHydrated);
  const persistHasHydrated = useSyncExternalStore(
    subscribeToBackgroundIndexingPreferencesPersistHydration,
    readBackgroundIndexingPreferencesPersistHydrated,
    () => false
  );
  const hasHydrated = storeHasHydrated || persistHasHydrated;
  const managedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const setManagedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.setManagedCollectionId
  );
  const indexingPolicyPreset = useBackgroundIndexingPreferencesStore(
    (state) => state.indexingPolicyPreset
  );
  const setIndexingPolicyPreset = useBackgroundIndexingPreferencesStore(
    (state) => state.setIndexingPolicyPreset
  );
  const paused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const setSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.setStatus);
  const resetSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.reset);
  const selectedDevicePreference = useVectorPreferencesStore((state) => ({
    devicePref: state.devicePref,
    devicePrefConfigured: state.devicePrefConfigured,
    hasHydrated: state.hasHydrated,
    reinitEveryN: state.reinitEveryN,
    verboseOrtLogs: state.verboseOrtLogs,
  }));
  const { controller: runtimeController, service: vectorQueueService } =
    useSharedEmbeddingRuntime();
  const windowVisible = useDocumentVisibility();
  const readRecentUserInputMs = useRecentUserInputMsReader();
  const windowVisibleRef = useRef(windowVisible);
  windowVisibleRef.current = windowVisible;
  const workspaceIndexBootstrapInFlightRef = useRef(false);
  // Stale-loop guard for sequential multi-root sync: incremented each time
  // triggerSync fires so that an older loop can detect it is superseded and
  // stop iterating before feeding more roots to service.sync.
  const syncLoopGenerationRef = useRef(0);
  const syncLoopDebugRef = useRef<Record<string, unknown>>({ state: 'not-started' });
  const syncLoopActiveRef = useRef(false);
  const pendingSyncScopeRef = useRef<TriggerSyncScope | null>(null);
  const replayPendingSyncRef = useRef<(scope: TriggerSyncScope) => void>(() => {});
  const backgroundWorkSnapshot = useSyncExternalStore(
    subscribeToBackgroundWorkArbiter,
    getBackgroundWorkArbiterSnapshot,
    getBackgroundWorkArbiterSnapshot
  );
  const reportAsyncError = useCallback(
    (operation: string, error: unknown): void => {
      logger.error(`Workspace collection sync ${operation} failed`, { error });
      if (isWorkspaceIndexBlockedError(error)) {
        setSyncStatus({
          state: 'blocked',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle?.path ?? null,
          ...createClearedProgressPatch(),
          blockedReason: error.blockedReason,
          lastError: error.message,
        });
        return;
      }
      setSyncStatus({
        state: 'error',
        blockedReason: null,
        managedCollectionId,
        managedCollectionName: null,
        activeRootPath: rootDirectoryHandle?.path ?? null,
        currentFilePath: null,
        queuedFiles: 0,
        processedFiles: 0,
        lastError: error instanceof Error ? error.message : String(error),
      });
    },
    [managedCollectionId, rootDirectoryHandle?.path, setSyncStatus]
  );
  useEffect(() => {
    if (storeHasHydrated) {
      return;
    }
    let disposed = false;
    void ensureBackgroundIndexingPreferencesHydrated().catch((error) => {
      if (!disposed) {
        reportAsyncError('preferences hydration', error);
      }
    });
    return () => {
      disposed = true;
    };
  }, [reportAsyncError, storeHasHydrated]);

  const treeRestorationSettled =
    fileTreeContext === null ||
    (!(fileTreeContext.isLoading || fileTreeContext.isRestoringExpandedPaths) &&
      fileTreeContext.isRestorationSettled);
  // The background indexer scans the filesystem directly, and resolveDbRootId
  // already awaits root reconciliation, so the file-tree UI restoration is a
  // convenience gate, NOT a correctness prerequisite. Wait for it briefly (so a
  // fast restoration completes first) but never block indefinitely: a very large
  // root can keep the tree loading for minutes, which must not wedge a
  // freshly-added folder in "waiting" forever (the real "added a folder, nothing
  // happened" cause). After the grace window, index regardless of tree state.
  //
  // A ref (not state) holds the expired flag: it gates triggerSync but is never
  // rendered, so flipping it must not re-render. The grace timer (wired below,
  // after triggerSyncFromEvent exists) re-runs the sync explicitly when it fires.
  const treeRestorationGraceExpiredRef = useRef(false);

  const validateHostedProviderAccess = useCallback(
    async (embeddingSetId: string): Promise<void> => {
      if (!vectorQueueService) {
        throw new Error('Vector queue service is unavailable.');
      }
      const validation = await vectorQueueService.validateApiKeyForSet(embeddingSetId);
      if (!validation.valid) {
        if (validation.reason === 'missing-provider-key') {
          throw new WorkspaceIndexBlockedError('missing-provider-key', validation.message);
        }
        throw new Error(validation.message);
      }
    },
    [vectorQueueService]
  );

  const ensureEmbeddingRuntimeStarted = useCallback(async (): Promise<void> => {
    const status = await runtimeController.ensureStarted();
    if (status.state === 'error') {
      throw new Error(status.lastError ?? 'Embedding runtime is unavailable.');
    }
  }, [runtimeController]);

  // useState lazy initializer guarantees one transition tracker per provider
  // instance: the sync loop re-resolves the QoS policy every cycle, and the
  // tracker logs only (state, reason) transitions instead of every resolution.
  const [observeQosTransition] = useState(() =>
    createWorkspaceIndexingQosTransitionLogger('app-shell-sync')
  );

  const resolveQosPolicy = useCallback(
    async (options?: {
      foregroundDbPressureStarvationBypass?: boolean;
    }): Promise<WorkspaceIndexingQosPolicy> => {
      if (!(readDatabasePressure && readPipelineInputs)) {
        throw new Error('Workspace Index QoS requires database scheduler snapshots.');
      }
      const powerSnapshot = readPowerSnapshot ? await readPowerSnapshot() : null;
      const latestBackgroundWorkSnapshot = getBackgroundWorkArbiterSnapshot();
      const policy = resolveWorkspaceIndexingQosPolicy({
        dbPressure: await readDatabasePressure(),
        foregroundDbPressureStarvationBypass:
          options?.foregroundDbPressureStarvationBypass ?? false,
        // Coarse app-shell signal: this spans the full assistant turn so background
        // indexing yields while tool/LLM work is active. The desktop hidden-host
        // ForegroundEmbeddingGate remains the embedding-scoped GPU coordination path.
        foregroundQueryActive: getAssistantForegroundActivitySnapshot(),
        idleState: powerSnapshot?.idleState ?? 'unknown',
        idleTimeMs: powerSnapshot?.idleTimeMs ?? null,
        manualPaused: latestBackgroundWorkSnapshot.backgroundIndexingPaused,
        pipeline: await readPipelineInputs(),
        powerSource: powerSnapshot?.powerSource ?? 'unknown',
        // TODO(workspace-index-qos): wire hosted provider rate-limit telemetry when
        // backfill exposes provider throttling as durable state.
        providerRateLimited: false,
        recentUserInputMs: readRecentUserInputMs(),
        thermalState: powerSnapshot?.thermalState ?? 'unknown',
        windowVisible: windowVisibleRef.current,
      });
      observeQosTransition(policy);
      return policy;
    },
    [
      observeQosTransition,
      readDatabasePressure,
      readPipelineInputs,
      readPowerSnapshot,
      readRecentUserInputMs,
    ]
  );

  const missingRuntimeDependencies = useMemo(
    () =>
      collectMissingRuntimeDependencies({
        backgroundDb,
        backgroundRepositories,
        db,
        fileSystemAdapter,
        runtimeEngine,
        tursoExecutionClient,
        waitForBackgroundPermit,
      }),
    [
      backgroundDb,
      backgroundRepositories,
      db,
      fileSystemAdapter,
      runtimeEngine,
      tursoExecutionClient,
      waitForBackgroundPermit,
    ]
  );

  const service = useMemo(() => {
    if (
      !(
        db &&
        backgroundDb &&
        waitForBackgroundPermit &&
        backgroundRepositories &&
        fileSystemAdapter &&
        backgroundRepositories.fileRecordRepository &&
        backgroundRepositories.chunkRepository &&
        backgroundRepositories.embeddingSetsRepository &&
        isBackgroundIndexingRuntimeEngine(runtimeEngine)
      )
    ) {
      return null;
    }
    const recordSyncDependencyStage = (stage: string, extra?: Record<string, unknown>): void => {
      syncLoopDebugRef.current = {
        ...syncLoopDebugRef.current,
        ...(extra ?? {}),
        dependencyStage: stage,
        dependencyUpdatedAt: new Date().toISOString(),
      };
    };
    // Always-on, ref-only diagnostics keep production failures explainable.
    // The data is exposed only when the Workspace Index debug API is enabled.
    const embeddingSetsRepository = new Proxy(backgroundRepositories.embeddingSetsRepository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'getById' || typeof value !== 'function') {
          return value;
        }
        return async (...args: unknown[]) => {
          recordSyncDependencyStage('embeddingSetsRepository.getById:start', {
            embeddingSetId: args[0],
          });
          try {
            const result = await value.apply(target, args);
            recordSyncDependencyStage('embeddingSetsRepository.getById:done', {
              embeddingSetFound: Boolean(result),
              embeddingSetId: args[0],
            });
            return result;
          } catch (error) {
            recordSyncDependencyStage('embeddingSetsRepository.getById:error', {
              embeddingSetId: args[0],
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        };
      },
    }) as typeof backgroundRepositories.embeddingSetsRepository;
    return new WorkspaceCollectionSyncService({
      applyManagedCacheBatch: async (args) => {
        const electronApplyManagedCacheBatch = window.electronAPI?.db?.applyManagedCacheBatch;
        if (electronApplyManagedCacheBatch) {
          await electronApplyManagedCacheBatch(args, BACKGROUND_DATABASE_WORK_OPTIONS);
          return;
        }
        if (runtimeEngine === 'turso') {
          throw new Error('Turso background indexing requires desktop managed-cache IPC support.');
        }
        await applyManagedCacheBatchLocally(backgroundDb, args);
      },
      invalidateManagedCacheEntriesByIdentity: async (args) => {
        const electronInvalidateManagedCacheEntries =
          window.electronAPI?.db?.invalidateManagedCacheEntriesByIdentity;
        if (electronInvalidateManagedCacheEntries) {
          return await electronInvalidateManagedCacheEntries(
            args,
            BACKGROUND_DATABASE_WORK_OPTIONS
          );
        }
        if (runtimeEngine === 'turso') {
          throw new Error(
            'Turso background indexing requires desktop managed-cache invalidation IPC support.'
          );
        }
        return await invalidateManagedCacheEntriesByIdentityLocally(backgroundDb, args);
      },
      cancelBackfill: async (embeddingSetId) => {
        recordSyncDependencyStage('cancelBackfill:start', { embeddingSetId });
        try {
          await runtimeController.cancelBackfill(embeddingSetId);
          recordSyncDependencyStage('cancelBackfill:done', { embeddingSetId });
        } catch (error) {
          recordSyncDependencyStage('cancelBackfill:error', {
            embeddingSetId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      chunkRepository: backgroundRepositories.chunkRepository,
      db: backgroundDb,
      embeddingSetsRepository,
      enqueueBackfill: async (embeddingSetId, options) =>
        await runtimeController.enqueueBackfill(embeddingSetId, options),
      ensureChunkingWorker,
      ensureEmbeddingRuntimeStarted,
      fileSystemAdapter,
      fileRecordRepository: backgroundRepositories.fileRecordRepository,
      getBackfillsInFlight: async () => {
        recordSyncDependencyStage('getBackfillsInFlight:start');
        try {
          const result = await runtimeController.getBackfillsInFlight();
          recordSyncDependencyStage('getBackfillsInFlight:done', {
            inFlightBackfillCount: result.length,
          });
          return result;
        } catch (error) {
          recordSyncDependencyStage('getBackfillsInFlight:error', {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      log: logger,
      onDebugStage: (stage, details) => {
        syncLoopDebugRef.current = {
          ...syncLoopDebugRef.current,
          ...(details ?? {}),
          serviceStage: stage,
          serviceStageUpdatedAt: new Date().toISOString(),
        };
      },
      onManagedCollectionMissing: (missingCollectionId) => {
        if (
          useBackgroundIndexingPreferencesStore.getState().managedCollectionId ===
          missingCollectionId
        ) {
          setManagedCollectionId(null);
        }
      },
      resolveDbRootId,
      resolveQosPolicy,
      runtimeEngine,
      // Background indexing must NOT raise the foreground `isImporting` pause flag:
      // that flag gates the collection selector + count live queries
      // (liveQueryEnabled = !isImporting), so toggling it freezes the file/chunk
      // counts the user is watching at 0/0 for the whole import. Background progress
      // is reported through the workspace-sync status store instead.
      setImporting: NOOP_SET_IMPORTING,
      setStatus: setSyncStatus,
      subscribeToBackfillProgress: (callback) => runtimeController.onBackfillProgress(callback),
      validateHostedProviderAccess,
      waitForBackgroundPermit,
    });
  }, [
    backgroundDb,
    backgroundRepositories,
    db,
    ensureEmbeddingRuntimeStarted,
    ensureChunkingWorker,
    fileSystemAdapter,
    resolveDbRootId,
    resolveQosPolicy,
    runtimeEngine,
    runtimeController,
    setManagedCollectionId,
    setSyncStatus,
    validateHostedProviderAccess,
    waitForBackgroundPermit,
  ]);

  const triggerWorkspaceIndexBootstrap = useCallback((): boolean => {
    if (!(enabled && managedCollectionId === null)) {
      return false;
    }
    if (workspaceIndexBootstrapInFlightRef.current) {
      return true;
    }

    const embeddingSetsRepository = backgroundRepositories?.embeddingSetsRepository;
    if (!embeddingSetsRepository) {
      reportAsyncError(
        'bootstrap',
        new Error('Background indexing embedding set repository is unavailable.')
      );
      return true;
    }

    workspaceIndexBootstrapInFlightRef.current = true;
    void bootstrapWorkspaceIndexCollection(
      { enabled, managedCollectionId },
      {
        embeddingSetsRepository,
        setManagedCollectionId,
      }
    )
      .then((collection) => {
        if (!collection) {
          return;
        }
        const latestBackgroundWorkSnapshot = getBackgroundWorkArbiterSnapshot();
        if (latestBackgroundWorkSnapshot.backgroundIndexingPaused) {
          setSyncStatus({
            state: 'paused',
            managedCollectionId: collection.id,
            managedCollectionName: collection.name ?? null,
            activeRootPath: rootDirectoryHandle?.path ?? null,
            currentFilePath: null,
            queuedFiles: 0,
            processedFiles: 0,
            lastError: null,
            pauseReasons: [
              ...(latestBackgroundWorkSnapshot.manualPause ? ['Paused manually'] : []),
              ...getBackgroundWorkPauseReasonLabels(
                latestBackgroundWorkSnapshot.automaticPauseReasons
              ),
            ],
          });
          return;
        }
        setSyncStatus({
          state: 'waiting',
          managedCollectionId: collection.id,
          managedCollectionName: collection.name ?? null,
          activeRootPath: rootDirectoryHandle?.path ?? null,
          currentFilePath: null,
          queuedFiles: 0,
          processedFiles: 0,
          lastError: null,
          pauseReasons: [],
        });
      })
      .catch((error) => {
        reportAsyncError('bootstrap', error);
      })
      .finally(() => {
        workspaceIndexBootstrapInFlightRef.current = false;
      });
    return true;
  }, [
    backgroundRepositories,
    enabled,
    managedCollectionId,
    reportAsyncError,
    rootDirectoryHandle?.path,
    setManagedCollectionId,
    setSyncStatus,
  ]);

  const triggerSync = useCallback(
    (scope: TriggerSyncScope = { mode: 'full' }, options: TriggerSyncOptions = {}) => {
      if (!hasHydrated) {
        return;
      }

      if (!service) {
        if (enabled) {
          setSyncStatus({
            state: 'waiting',
            managedCollectionId,
            managedCollectionName: null,
            activeRootPath: rootDirectoryHandle?.path ?? null,
            currentFilePath: null,
            queuedFiles: 0,
            processedFiles: 0,
            lastError: null,
          });
        } else {
          resetSyncStatus();
        }
        return;
      }

      if (triggerWorkspaceIndexBootstrap()) {
        return;
      }

      // Read the arbiter snapshot LIVE rather than as a hook dependency: its
      // QoS/pressure/pause-reason churn must not change triggerSync's identity,
      // because that re-runs the owning effect whose cleanup cancels the
      // in-flight sync — which would abort a newly added root mid-import. The
      // pause/resume EDGE is wired explicitly via subscribeToBackgroundWorkArbiter
      // below (a non-cancelling re-trigger).
      const latestBackgroundWorkSnapshot = getBackgroundWorkArbiterSnapshot();
      if (latestBackgroundWorkSnapshot.backgroundIndexingPaused) {
        syncLoopGenerationRef.current += 1;
        syncLoopActiveRef.current = false;
        pendingSyncScopeRef.current = null;
        void service.cancel().catch((error) => {
          reportAsyncError('cancel', error);
        });
        setSyncStatus({
          state: 'paused',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle?.path ?? null,
          currentFilePath: null,
          lastError: null,
          pauseReasons: [
            ...(latestBackgroundWorkSnapshot.manualPause ? ['Paused manually'] : []),
            ...getBackgroundWorkPauseReasonLabels(
              latestBackgroundWorkSnapshot.automaticPauseReasons
            ),
          ],
        });
        return;
      }

      if (!(enabled && managedCollectionId && rootDirectoryHandle)) {
        invalidateActiveSyncLoop({
          pendingSyncScopeRef,
          reportCancelError: (error) => {
            reportAsyncError('cancel', error);
          },
          service,
          syncLoopActiveRef,
          syncLoopGenerationRef,
        });
        void service
          .sync({
            enabled,
            indexingPolicyPreset,
            managedCollectionId,
            rootDirectoryHandle,
            scope: { mode: 'full' },
          })
          .catch((error) => {
            reportAsyncError('sync', error);
          });
        return;
      }

      if (isAccessLoading) {
        syncLoopGenerationRef.current += 1;
        syncLoopActiveRef.current = false;
        pendingSyncScopeRef.current = null;
        void service.cancel();
        setSyncStatus({
          state: 'waiting',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle.path,
          currentFilePath: null,
          queuedFiles: 0,
          processedFiles: 0,
          lastError: null,
        });
        return;
      }

      // Read the grace flag from the ref at call time (never stale): the gate
      // passes once the tree settles OR the grace timer has fired.
      const isTreeRestorationReady =
        treeRestorationSettled || treeRestorationGraceExpiredRef.current;
      if (!isTreeRestorationReady) {
        syncLoopGenerationRef.current += 1;
        syncLoopActiveRef.current = false;
        pendingSyncScopeRef.current = null;
        void service.cancel();
        setSyncStatus({
          state: 'waiting',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle.path,
          currentFilePath: null,
          queuedFiles: 0,
          processedFiles: 0,
          lastError: null,
        });
        return;
      }

      const targets = buildSyncLoopTargets({
        rootDirectoryHandle,
        rootDirectoryHandles,
        rootIdByPath,
        scope,
      });
      if (
        handleActiveSyncLoopRequest({
          options,
          pendingSyncScopeRef,
          reportCancelError: (error) => {
            reportAsyncError('cancel', error);
          },
          scope,
          service,
          syncLoopActiveRef,
          syncLoopDebugRef,
          syncLoopGenerationRef,
        })
      ) {
        return;
      }

      // Bump the generation only when starting a real loop. Requests that arrive
      // while a loop is active are serialized through pendingSyncScopeRef so the
      // active import is not cancelled and overlapped by the follow-up pass.
      syncLoopGenerationRef.current += 1;
      const myGeneration = syncLoopGenerationRef.current;
      syncLoopActiveRef.current = true;
      syncLoopDebugRef.current = {
        generation: myGeneration,
        scope: scope.mode,
        state: 'resolving-targets',
        targetCount: targets.length,
        targetPaths: targets.map((target) => target.handle.path),
        updatedAt: new Date().toISOString(),
      };

      void (async () => {
        if (syncLoopGenerationRef.current !== myGeneration) {
          syncLoopDebugRef.current = {
            ...syncLoopDebugRef.current,
            generation: myGeneration,
            state: 'cancelled-before-resolve',
            updatedAt: new Date().toISOString(),
          };
          return;
        }
        // eslint-disable-next-line react-doctor/async-defer-await -- the post-await generation guard prevents stale loops from syncing after cancellation during root-id resolution.
        const resolvedTargets = await Promise.all(
          targets.map(async (target): Promise<SyncLoopTarget & { dbRootId: string | null }> => {
            const adapterRootId = target.handle.rootId ?? rootIdByPath.get(target.handle.path);
            const dbRootId = await resolveDbRootId(target.handle.path, adapterRootId);
            return { ...target, dbRootId };
          })
        );
        if (syncLoopGenerationRef.current !== myGeneration) {
          syncLoopDebugRef.current = {
            ...syncLoopDebugRef.current,
            generation: myGeneration,
            resolvedTargetCount: resolvedTargets.length,
            resolvedTargets: resolvedTargets.map((target) => ({
              dbRootId: target.dbRootId,
              path: target.handle.path,
            })),
            state: 'cancelled-after-resolve',
            updatedAt: new Date().toISOString(),
          };
          return;
        }

        const syncableTargets = resolvedTargets.filter(hasResolvedDbRootId);
        // Order by ACTUAL indexed coverage: least-indexed roots sync first. A
        // folder you just added (0 files), or one whose earlier pass imported
        // nothing, is processed before a giant repo that is only partway through
        // its import — so one huge root can never block the others, and a newly
        // added root indexes promptly instead of waiting in line behind a
        // 20k-file import. Falls back to discovery order if the query fails.
        // eslint-disable-next-line react-doctor/async-defer-await -- the post-await generation guard prevents stale loops from syncing after cancellation during coverage read.
        const orderedTargets = await loadOrderedSyncTargets({
          backgroundDb,
          managedCollectionId,
          runtimeEngine,
          syncableTargets,
        });
        if (syncLoopGenerationRef.current !== myGeneration) {
          return;
        }
        syncLoopDebugRef.current = {
          ...syncLoopDebugRef.current,
          generation: myGeneration,
          resolvedTargetCount: resolvedTargets.length,
          resolvedTargets: resolvedTargets.map((target) => ({
            dbRootId: target.dbRootId,
            path: target.handle.path,
          })),
          state: orderedTargets.length > 0 ? 'syncing' : 'no-syncable-targets',
          syncableTargetCount: orderedTargets.length,
          syncableTargetPaths: orderedTargets.map((target) => target.handle.path),
          updatedAt: new Date().toISOString(),
        };

        for (const [targetIndex, target] of orderedTargets.entries()) {
          const targetPath = target.handle.path;
          // Stale-loop guard: a newer triggerSync has fired — stop immediately.
          if (syncLoopGenerationRef.current !== myGeneration) {
            syncLoopDebugRef.current = {
              ...syncLoopDebugRef.current,
              generation: myGeneration,
              state: 'cancelled-before-service-sync',
              updatedAt: new Date().toISOString(),
            };
            return;
          }
          syncLoopDebugRef.current = {
            ...syncLoopDebugRef.current,
            activeTargetPath: targetPath,
            generation: myGeneration,
            state: 'service-sync-started',
            updatedAt: new Date().toISOString(),
          };
          // backfillMode: only the LAST (most-covered) root enqueues the embedding
          // backfill; earlier roots defer so a freshly added root's import is not
          // stuck behind a giant repo's backfill enqueue.
          // eslint-disable-next-line react-doctor/async-defer-await, react-doctor/async-await-in-loop -- root sync is intentionally serial so cancellation cannot overlap root mutations.
          await service
            .sync({
              backfillMode: targetIndex === orderedTargets.length - 1 ? 'enqueue' : 'defer',
              dbRootId: target.dbRootId,
              enabled,
              indexingPolicyPreset,
              managedCollectionId,
              rootDirectoryHandle: target.handle,
              scope:
                target.scope.mode === 'paths'
                  ? { mode: 'paths', changes: target.scope.changes ?? [] }
                  : { mode: 'full' },
            })
            .catch((error) => {
              syncLoopDebugRef.current = {
                ...syncLoopDebugRef.current,
                activeTargetPath: targetPath,
                error: error instanceof Error ? error.message : String(error),
                generation: myGeneration,
                state: 'service-sync-error',
                updatedAt: new Date().toISOString(),
              };
              reportAsyncError('sync', error);
            });
          syncLoopDebugRef.current = {
            ...syncLoopDebugRef.current,
            activeTargetPath: targetPath,
            completedTargetPath: targetPath,
            generation: myGeneration,
            state: 'service-sync-completed',
            updatedAt: new Date().toISOString(),
          };
        }
      })()
        .catch((error) => {
          syncLoopDebugRef.current = {
            ...syncLoopDebugRef.current,
            error: error instanceof Error ? error.message : String(error),
            generation: myGeneration,
            state: 'sync-loop-error',
            updatedAt: new Date().toISOString(),
          };
          reportAsyncError('sync loop', error);
        })
        .finally(() => {
          if (syncLoopGenerationRef.current === myGeneration) {
            syncLoopActiveRef.current = false;
          }
          const pendingScope = pendingSyncScopeRef.current;
          pendingSyncScopeRef.current = null;
          if (pendingScope) {
            replayPendingSyncRef.current(pendingScope);
          }
        });
    },
    [
      backgroundDb,
      enabled,
      hasHydrated,
      indexingPolicyPreset,
      isAccessLoading,
      managedCollectionId,
      reportAsyncError,
      resetSyncStatus,
      resolveDbRootId,
      rootDirectoryHandle,
      rootDirectoryHandles,
      rootIdByPath,
      runtimeEngine,
      service,
      setSyncStatus,
      treeRestorationSettled,
      triggerWorkspaceIndexBootstrap,
    ]
  );
  useEffect(() => {
    replayPendingSyncRef.current = (scope: TriggerSyncScope) => {
      triggerSync(scope);
    };
    return () => {
      replayPendingSyncRef.current = () => {};
    };
  }, [triggerSync]);
  const triggerSyncFromEvent = useEffectEvent(triggerSync);

  // After the grace window, proceed even if file-tree restoration never settles.
  // The ref-held flag gates triggerSync (never rendered), and the timer re-runs
  // the sync explicitly so a freshly-added root indexes instead of waiting
  // forever (a giant tree can keep restoration in flight for minutes). Once
  // expired it stays expired for the session.
  useEffect(() => {
    if (treeRestorationSettled || treeRestorationGraceExpiredRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      treeRestorationGraceExpiredRef.current = true;
      logger.warn(
        'File explorer restoration did not settle within the grace window; starting background indexing anyway',
        { graceMs: TREE_RESTORATION_GRACE_MS }
      );
      triggerSyncFromEvent();
    }, TREE_RESTORATION_GRACE_MS);
    return () => clearTimeout(timer);
  }, [treeRestorationSettled]);

  // Re-run the sync when background-work state changes (pause -> cancel + paused
  // status; resume -> sync). This replaces the old backgroundWorkSnapshot
  // triggerSync dependency: re-triggering via triggerSyncFromEvent does NOT run
  // the owning effect's service.cancel() cleanup, so benign churn no longer
  // aborts an in-flight sync (only the in-handler pause guard cancels, which is
  // correct). Subscribed once; triggerSyncFromEvent is identity-stable.
  useEffect(
    () =>
      subscribeToBackgroundWorkArbiter(() => {
        triggerSyncFromEvent();
      }),
    []
  );

  useEffect(() => {
    let disposed = false;
    let activeAuditToken: symbol | null = null;
    let inFlightAuditKey: string | null = null;
    let verifiedAuditKey: string | null = null;

    const launchCoverageAudit = (args: {
      activeRootPath: string | null;
      auditKey: string;
      collectionId: string;
      db: DbHandle;
      fileSystemAdapter: NonNullable<ReturnType<typeof useAdapters>['fileSystemAdapter']>;
      handles: readonly DirectoryHandle[];
      runtimeEngine: BackgroundIndexingRuntimeEngine;
    }): void => {
      const auditToken = Symbol('workspace-coverage-audit');
      activeAuditToken = auditToken;
      inFlightAuditKey = args.auditKey;
      setSyncStatus(
        createCoverageStatusPatch({
          activeRootPath: args.activeRootPath,
          collectionId: args.collectionId,
          lastError: WORKSPACE_COVERAGE_AUDIT_MESSAGE,
          state: 'waiting',
        })
      );

      void startWorkspaceCoverageAudit({
        activeRootPath: args.activeRootPath,
        auditKey: args.auditKey,
        clearInFlightAudit: (completedAuditKey) => {
          if (!(disposed || inFlightAuditKey !== completedAuditKey)) {
            inFlightAuditKey = null;
          }
        },
        collectionId: args.collectionId,
        db: args.db,
        fileSystemAdapter: args.fileSystemAdapter,
        handles: args.handles,
        isCurrent: () => !disposed && activeAuditToken === auditToken,
        markAuditVerified: (verifiedKey) => {
          if (!disposed) {
            verifiedAuditKey = verifiedKey;
          }
        },
        policyPreset: indexingPolicyPreset,
        resolveDbRootId,
        rootIdByPath,
        runtimeEngine: args.runtimeEngine,
        setStatus: setSyncStatus,
      }).then((requiresRecoverySync) => {
        if (!disposed && requiresRecoverySync) {
          triggerSyncFromEvent({ mode: 'full' });
        }
      });
    };

    const maybeAuditIdleCoverage = (
      status: ReturnType<typeof useWorkspaceCollectionSyncStatusStore.getState>
    ): void => {
      if (shouldResetCoverageAuditTracking(status)) {
        activeAuditToken = null;
        inFlightAuditKey = null;
        verifiedAuditKey = null;
        return;
      }
      const auditRequest = createIdleCoverageAuditRequest({
        backgroundDb,
        enabled,
        fileSystemAdapter,
        indexingPolicyPreset,
        managedCollectionId,
        rootDirectoryHandle,
        rootDirectoryHandles,
        rootIdByPath,
        runtimeEngine,
        status,
      });
      if (!auditRequest) {
        return;
      }
      if (
        verifiedAuditKey === auditRequest.auditKey ||
        inFlightAuditKey === auditRequest.auditKey
      ) {
        return;
      }

      launchCoverageAudit(auditRequest);
    };

    maybeAuditIdleCoverage(useWorkspaceCollectionSyncStatusStore.getState());
    const unsubscribe = useWorkspaceCollectionSyncStatusStore.subscribe(maybeAuditIdleCoverage);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [
    backgroundDb,
    enabled,
    fileSystemAdapter,
    indexingPolicyPreset,
    managedCollectionId,
    resolveDbRootId,
    rootDirectoryHandle,
    rootDirectoryHandles,
    rootIdByPath,
    runtimeEngine,
    setSyncStatus,
  ]);

  const readDatabaseSchedulerSnapshot = useCallback(async (): Promise<unknown> => {
    if (backgroundDb) {
      const scheduler = getDatabaseWorkScheduler(backgroundDb);
      if (scheduler) {
        return scheduler.getSnapshot();
      }
    }
    const schedulerSnapshot =
      typeof window === 'undefined' ? undefined : window.electronAPI?.db?.schedulerSnapshot;
    return schedulerSnapshot ? await schedulerSnapshot() : null;
  }, [backgroundDb]);

  const countExpectedDebugRoots = useCallback(async () => {
    const handles =
      rootDirectoryHandles.length > 0
        ? rootDirectoryHandles
        : rootDirectoryHandle
          ? [rootDirectoryHandle]
          : [];
    return await Promise.all(
      handles.map((handle) =>
        countExpectedWorkspaceIndexFiles({
          fileSystemAdapter,
          policyPreset: indexingPolicyPreset,
          rootHandle: handle,
        })
      )
    );
  }, [fileSystemAdapter, indexingPolicyPreset, rootDirectoryHandle, rootDirectoryHandles]);

  const readDebugHostStatus = useCallback(async (bridgeName: 'chunkingHost' | 'embeddingHost') => {
    const bridge = (window as unknown as Record<typeof bridgeName, unknown>)[bridgeName] as
      | { getStatus?: () => Promise<unknown> }
      | undefined;
    if (typeof bridge?.getStatus !== 'function') {
      return {
        available: false,
        reason: `${bridgeName} bridge unavailable`,
      };
    }
    try {
      return {
        available: true,
        status: await bridge.getStatus(),
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }, []);

  const readDebugSnapshot = useCallback(async (): Promise<WorkspaceIndexDebugSnapshot> => {
    const accessIssues: Array<{ reason: string; source: string }> = [];
    const electronQuery = typeof window === 'undefined' ? undefined : window.electronAPI?.db?.query;
    const query =
      typeof electronQuery === 'function'
        ? (((sql: string, params?: unknown[]) =>
            electronQuery(sql, params, BACKGROUND_DATABASE_WORK_OPTIONS) as Promise<{
              rows?: unknown[];
            }>) satisfies WorkspaceIndexDebugDbQuery)
        : (backgroundDb?.query as WorkspaceIndexDebugDbQuery | undefined);
    const debugSqlRuntime: WorkspaceIndexDebugSqlRuntime =
      runtimeEngine === 'turso' ? 'turso' : 'pglite';
    const collectionFilter = buildWorkspaceIndexDebugCollectionFilter(
      debugSqlRuntime,
      'embedding_set_id'
    );
    const fileRecordCollectionFilter = buildWorkspaceIndexDebugCollectionFilter(
      debugSqlRuntime,
      'fr.embedding_set_id'
    );
    const chunkCollectionFilter = buildWorkspaceIndexDebugCollectionFilter(
      debugSqlRuntime,
      'fc.embedding_set_id'
    );
    const runAtParameter = getWorkspaceIndexDebugSqlParameter(debugSqlRuntime, 2);
    const [
      expectedCounts,
      roots,
      fileRecordsByRoot,
      chunkedRecordsByRoot,
      chunkStatsByRoot,
      chunkStatsByRootAndSet,
      jobQueue,
      jobQueueReadiness,
      recentEmbeddingCompletions,
      recentEmbeddingFailures,
      databaseScheduler,
      chunkingHostStatus,
      embeddingHostStatus,
    ] = await Promise.all([
      countExpectedDebugRoots(),
      readWorkspaceIndexDebugRows(
        query,
        'SELECT id, path, display_name, kind, status, created_at, last_verified_at FROM roots ORDER BY created_at ASC',
        [],
        accessIssues,
        'roots'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `SELECT root_id, CAST(COUNT(*) AS INTEGER) AS file_count,
                CAST(SUM(CASE WHEN chunks_processed_at IS NOT NULL THEN 1 ELSE 0 END) AS INTEGER) AS chunked_file_count,
                CAST(SUM(CASE WHEN chunks_processed_at IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS unchunked_file_count
           FROM file_records
          WHERE ${collectionFilter}
          GROUP BY root_id
          ORDER BY root_id`,
        [managedCollectionId],
        accessIssues,
        'file_records_by_root'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* chunked_records_by_root_query_marker */
         SELECT fr.root_id,
                fr.id,
                fr.path AS relative_path,
                fr.chunks_processed_at,
                CAST(COUNT(fc.id) AS INTEGER) AS chunk_count
           FROM file_records fr
           LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
          WHERE ${fileRecordCollectionFilter}
            AND fr.chunks_processed_at IS NOT NULL
          GROUP BY fr.root_id, fr.id, fr.path, fr.chunks_processed_at
          ORDER BY fr.root_id, fr.path`,
        [managedCollectionId],
        accessIssues,
        'chunked_records_by_root'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `SELECT fr.root_id,
                CAST(COUNT(fc.id) AS INTEGER) AS chunk_count,
                CAST(COUNT(fc.embedding) AS INTEGER) AS embedded_chunk_count,
                CAST(SUM(CASE WHEN fc.embedding IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS pending_chunk_count
           FROM file_chunks fc
           JOIN file_records fr ON fr.id = fc.file_record_id
          WHERE ${chunkCollectionFilter}
          GROUP BY fr.root_id
          ORDER BY fr.root_id`,
        [managedCollectionId],
        accessIssues,
        'chunks_by_root'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* chunks_by_root_and_set_query_marker */
         SELECT fr.root_id,
                fc.embedding_set_id,
                CAST(COUNT(fc.id) AS INTEGER) AS chunk_count,
                CAST(COUNT(fc.embedding) AS INTEGER) AS embedded_chunk_count,
                CAST(SUM(CASE WHEN fc.embedding IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS pending_chunk_count
           FROM file_chunks fc
           JOIN file_records fr ON fr.id = fc.file_record_id
          WHERE ${fileRecordCollectionFilter}
          GROUP BY fr.root_id, fc.embedding_set_id
          ORDER BY fr.root_id, fc.embedding_set_id`,
        [managedCollectionId],
        accessIssues,
        'chunks_by_root_and_set'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `SELECT queue, job_type, state, CAST(COUNT(*) AS INTEGER) AS count,
                MIN(updated_at) AS oldest_updated_at,
                MAX(updated_at) AS newest_updated_at
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND ${collectionFilter}
          GROUP BY queue, job_type, state
          ORDER BY queue, job_type, state`,
        [managedCollectionId],
        accessIssues,
        'job_queue'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* job_queue_readiness_query_marker */
         SELECT state,
                CAST(SUM(CASE WHEN run_at <= ${runAtParameter} THEN 1 ELSE 0 END) AS INTEGER) AS due_count,
                CAST(SUM(CASE WHEN run_at > ${runAtParameter} THEN 1 ELSE 0 END) AS INTEGER) AS future_count,
                MIN(run_at) AS oldest_run_at,
                MAX(run_at) AS newest_run_at,
                MIN(updated_at) AS oldest_updated_at,
                MAX(updated_at) AS newest_updated_at
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND ${collectionFilter}
          GROUP BY state
          ORDER BY state`,
        [managedCollectionId, new Date().toISOString()],
        accessIssues,
        'job_queue_readiness'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `SELECT id, state, worker_id, attempts, updated_at, payload
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND state = 'succeeded'
            AND ${collectionFilter}
          ORDER BY updated_at DESC
          LIMIT 10`,
        [managedCollectionId],
        accessIssues,
        'recent_embedding_completions'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* recent_embedding_failures_query_marker */
         SELECT id, state, worker_id, attempts, max_attempts, run_at, leased_until, error, updated_at, payload
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND state = 'failed'
            AND ${collectionFilter}
          ORDER BY updated_at DESC
          LIMIT 20`,
        [managedCollectionId],
        accessIssues,
        'recent_embedding_failures'
      ),
      readDatabaseSchedulerSnapshot(),
      readDebugHostStatus('chunkingHost'),
      readDebugHostStatus('embeddingHost'),
    ]);
    const debugSyncHandles = getActiveRootHandles({ rootDirectoryHandle, rootDirectoryHandles });
    const syncTargets = await Promise.all(
      debugSyncHandles.map(async (handle) => {
        const adapterRootId = handle.rootId ?? rootIdByPath.get(handle.path) ?? null;
        const dbRootId = await resolveDbRootId(handle.path, adapterRootId);
        return {
          adapterRootId,
          dbRootId,
          name: handle.name,
          path: handle.path,
        };
      })
    );

    return {
      ...(accessIssues.length > 0 ? { accessIssues } : {}),
      backgroundEffectiveHasHydrated: hasHydrated,
      backgroundPersistHasHydrated: readBackgroundIndexingPreferencesPersistHydrated(),
      backgroundPreferences: useBackgroundIndexingPreferencesStore.getState(),
      chunkingHostStatus,
      chunkStatsByRoot,
      chunkStatsByRootAndSet,
      chunkedRecordsByRoot,
      databaseScheduler,
      embeddingHostStatus: {
        ...((embeddingHostStatus && typeof embeddingHostStatus === 'object'
          ? embeddingHostStatus
          : {}) as Record<string, unknown>),
        recentEmbeddingCompletions,
      },
      expectedCounts,
      fileRecordsByRoot,
      jobQueue,
      jobQueueReadiness,
      managedCollectionId,
      memorySample: readWorkspaceIndexMemorySample(),
      recentEmbeddingFailures,
      roots,
      runtimeReadiness: {
        message: service ? null : createRuntimeUnavailableMessage(missingRuntimeDependencies),
        missingDependencies: missingRuntimeDependencies,
        serviceAvailable: Boolean(service),
      },
      selectedDevicePreference,
      syncLoop: syncLoopDebugRef.current,
      syncReadiness: {
        enabled,
        hasHydrated,
        hasManagedCollectionId: Boolean(managedCollectionId),
        hasRootDirectoryHandle: Boolean(rootDirectoryHandle),
        isAccessLoading,
        isTreeRestorationReady: treeRestorationSettled,
        rootDirectoryHandlePath: rootDirectoryHandle?.path ?? null,
        rootDirectoryHandles: rootDirectoryHandles.map((handle) => ({
          path: handle.path,
          rootId: handle.rootId ?? rootIdByPath.get(handle.path) ?? null,
        })),
        serviceAvailable: Boolean(service),
      },
      syncTargets,
      syncStatus: useWorkspaceCollectionSyncStatusStore.getState(),
    };
  }, [
    backgroundDb,
    countExpectedDebugRoots,
    enabled,
    hasHydrated,
    isAccessLoading,
    managedCollectionId,
    missingRuntimeDependencies,
    readDatabaseSchedulerSnapshot,
    treeRestorationSettled,
    readDebugHostStatus,
    resolveDbRootId,
    rootDirectoryHandle,
    rootDirectoryHandles,
    rootIdByPath,
    runtimeEngine,
    selectedDevicePreference,
    service,
  ]);

  const readDebugSummary = useCallback(async (): Promise<WorkspaceIndexDebugSummary> => {
    const accessIssues: Array<{ reason: string; source: string }> = [];
    const electronQuery = typeof window === 'undefined' ? undefined : window.electronAPI?.db?.query;
    const query =
      typeof electronQuery === 'function'
        ? (((sql: string, params?: unknown[]) =>
            electronQuery(sql, params, BACKGROUND_DATABASE_WORK_OPTIONS) as Promise<{
              rows?: unknown[];
            }>) satisfies WorkspaceIndexDebugDbQuery)
        : (backgroundDb?.query as WorkspaceIndexDebugDbQuery | undefined);
    const debugSqlRuntime: WorkspaceIndexDebugSqlRuntime =
      runtimeEngine === 'turso' ? 'turso' : 'pglite';
    const collectionFilter = buildWorkspaceIndexDebugCollectionFilter(
      debugSqlRuntime,
      'embedding_set_id'
    );
    const fileRecordCollectionFilter = buildWorkspaceIndexDebugCollectionFilter(
      debugSqlRuntime,
      'fr.embedding_set_id'
    );
    const runAtParameter = getWorkspaceIndexDebugSqlParameter(debugSqlRuntime, 2);
    const [
      roots,
      fileRecordsByRoot,
      chunkStatsByRootAndSet,
      jobQueue,
      jobQueueReadiness,
      recentEmbeddingFailures,
      databaseScheduler,
      embeddingHostStatus,
    ] = await Promise.all([
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_roots_marker */
         SELECT id, path, display_name, kind, status, created_at, last_verified_at
           FROM roots
          ORDER BY created_at ASC`,
        [],
        accessIssues,
        'summary_roots'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_file_records_marker */
         SELECT root_id, CAST(COUNT(*) AS INTEGER) AS file_count,
                CAST(SUM(CASE WHEN chunks_processed_at IS NOT NULL THEN 1 ELSE 0 END) AS INTEGER) AS chunked_file_count,
                CAST(SUM(CASE WHEN chunks_processed_at IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS unchunked_file_count
           FROM file_records
          WHERE ${collectionFilter}
          GROUP BY root_id
          ORDER BY root_id`,
        [managedCollectionId],
        accessIssues,
        'summary_file_records_by_root'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_chunks_marker */
         SELECT fr.root_id,
                fc.embedding_set_id,
                CAST(COUNT(fc.id) AS INTEGER) AS chunk_count,
                CAST(COUNT(fc.embedding) AS INTEGER) AS embedded_chunk_count,
                CAST(SUM(CASE WHEN fc.embedding IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS pending_chunk_count
           FROM file_chunks fc
           JOIN file_records fr ON fr.id = fc.file_record_id
          WHERE ${fileRecordCollectionFilter}
          GROUP BY fr.root_id, fc.embedding_set_id
          ORDER BY fr.root_id, fc.embedding_set_id`,
        [managedCollectionId],
        accessIssues,
        'summary_chunks_by_root_and_set'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_job_queue_marker */
         SELECT queue, job_type, state, CAST(COUNT(*) AS INTEGER) AS count,
                MIN(updated_at) AS oldest_updated_at,
                MAX(updated_at) AS newest_updated_at
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND ${collectionFilter}
          GROUP BY queue, job_type, state
          ORDER BY queue, job_type, state`,
        [managedCollectionId],
        accessIssues,
        'summary_job_queue'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_job_queue_readiness_marker */
         SELECT state,
                CAST(SUM(CASE WHEN run_at <= ${runAtParameter} THEN 1 ELSE 0 END) AS INTEGER) AS due_count,
                CAST(SUM(CASE WHEN run_at > ${runAtParameter} THEN 1 ELSE 0 END) AS INTEGER) AS future_count,
                MIN(run_at) AS oldest_run_at,
                MAX(run_at) AS newest_run_at,
                MIN(updated_at) AS oldest_updated_at,
                MAX(updated_at) AS newest_updated_at
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND ${collectionFilter}
          GROUP BY state
          ORDER BY state`,
        [managedCollectionId, new Date().toISOString()],
        accessIssues,
        'summary_job_queue_readiness'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_recent_embedding_failures_marker */
         SELECT id, state, worker_id, attempts, max_attempts, run_at, leased_until, error, updated_at, payload
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND state = 'failed'
            AND ${collectionFilter}
          ORDER BY updated_at DESC
          LIMIT 20`,
        [managedCollectionId],
        accessIssues,
        'summary_recent_embedding_failures'
      ),
      readDatabaseSchedulerSnapshot(),
      readDebugHostStatus('embeddingHost'),
    ]);

    return {
      ...(accessIssues.length > 0 ? { accessIssues } : {}),
      backgroundPreferences: useBackgroundIndexingPreferencesStore.getState(),
      chunkStatsByRootAndSet,
      databaseScheduler,
      embeddingHostStatus,
      fileRecordsByRoot,
      jobQueue,
      jobQueueReadiness,
      managedCollectionId,
      memorySample: readWorkspaceIndexMemorySample(),
      recentEmbeddingFailures,
      roots,
      selectedDevicePreference,
      syncStatus: useWorkspaceCollectionSyncStatusStore.getState(),
    };
  }, [
    backgroundDb,
    managedCollectionId,
    readDatabaseSchedulerSnapshot,
    readDebugHostStatus,
    runtimeEngine,
    selectedDevicePreference,
  ]);

  const benchmarkDebugStage: WorkspaceIndexDebugApi['benchmarkStage'] = useCallback(
    async (request) => {
      const electronRunTransaction =
        typeof window === 'undefined'
          ? undefined
          : (
              window.electronAPI?.db as
                | {
                    runTransaction?: (
                      statements: Array<{ params?: unknown[]; sql: string }>,
                      resultIndex: number,
                      options?: unknown
                    ) => Promise<{ rows?: unknown[] }>;
                  }
                | undefined
            )?.runTransaction;
      const chunkingHost =
        typeof window === 'undefined'
          ? undefined
          : (
              window as Window & {
                chunkingHost?: {
                  chunkBatch?: (request: {
                    files: readonly {
                      content: string;
                      fileName: string;
                      filePath: string;
                      fileRecordId: string;
                    }[];
                    kind: 'chunk-batch';
                    options: {
                      allowLargeFiles: boolean;
                      forceStrategy: boolean;
                      ignoreFileTypeRecommendations: boolean;
                      maxTokens: number;
                      overlap: number;
                      requestedStrategy: 'recursive';
                      tokenTrueSizing: boolean;
                    };
                    requestId: string;
                  }) => Promise<readonly unknown[]>;
                };
              }
            ).chunkingHost;
      const embeddingHost =
        typeof window === 'undefined'
          ? undefined
          : (
              window as Window & {
                embeddingHost?: {
                  getStatus?: () => Promise<unknown>;
                  queryEmbedding?: (payload: {
                    dimensions: number;
                    modelId: string;
                    modelKey: string;
                    query: string;
                  }) => Promise<readonly number[]>;
                };
              }
            ).embeddingHost;
      const applyManagedCacheBatch = async (
        args: Parameters<typeof applyManagedCacheBatchLocally>[1]
      ) => {
        const electronApplyManagedCacheBatch = window.electronAPI?.db?.applyManagedCacheBatch;
        if (electronApplyManagedCacheBatch) {
          await electronApplyManagedCacheBatch(args, BACKGROUND_DATABASE_WORK_OPTIONS);
          return;
        }
        if (!backgroundDb) {
          throw new Error('Workspace Index stage benchmark requires managed-cache apply support.');
        }
        if (runtimeEngine === 'turso') {
          if (!tursoExecutionClient) {
            throw new Error('Turso stage benchmark requires an execution client.');
          }
          await applyTursoManagedCacheBatch(tursoExecutionClient, args);
          return;
        }
        await applyManagedCacheBatchLocally(backgroundDb, args);
      };
      if (request.mode === 'db-completion-ceiling' && !(backgroundDb || electronRunTransaction)) {
        throw new Error('Workspace Index stage benchmark requires transactional database support.');
      }
      return await runWorkspaceIndexStageBenchmark({
        applyManagedCacheBatch,
        chunkingHost,
        db: backgroundDb,
        embeddingHost,
        electronRunTransaction,
        electronTransactionOptions: BACKGROUND_DATABASE_WORK_OPTIONS,
        request,
      });
    },
    [backgroundDb, runtimeEngine, tursoExecutionClient]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const env = (
      import.meta as ImportMeta & {
        env?: Record<string, unknown>;
      }
    ).env;
    if (!shouldExposeWorkspaceIndexDebugApi(env)) {
      window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ = undefined;
      return;
    }
    const workspaceIndexDebugApi = Object.freeze<WorkspaceIndexDebugApi>({
      benchmarkStage: benchmarkDebugStage,
      configure: ({ policyPreset }) => {
        if (policyPreset) {
          setIndexingPolicyPreset(policyPreset);
        }
      },
      countExpected: countExpectedDebugRoots,
      snapshot: readDebugSnapshot,
      summary: readDebugSummary,
      triggerFullSync: () => {
        triggerSync({ mode: 'full' });
      },
    });
    window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ = workspaceIndexDebugApi;
    return () => {
      if (window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ === workspaceIndexDebugApi) {
        window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ = undefined;
      }
    };
  }, [
    benchmarkDebugStage,
    countExpectedDebugRoots,
    readDebugSnapshot,
    readDebugSummary,
    setIndexingPolicyPreset,
    triggerSync,
  ]);

  const invalidateActiveSyncLoopFromEffect = useEffectEvent(() => {
    syncLoopGenerationRef.current += 1;
  });

  useEffect(() => {
    setBackgroundWorkManualPause(paused);
    return () => {
      setBackgroundWorkManualPause(false);
    };
  }, [paused]);

  useEffect(() => {
    if (!service) {
      return;
    }
    return registerBackgroundWorkPauseHandler('background-indexing', {
      pause: async () => {
        invalidateActiveSyncLoopFromEffect();
        await service.cancel();
      },
    });
  }, [service]);

  useEffect(() => {
    triggerSync({ mode: 'full' }, { restartActive: true });
  }, [backgroundWorkSnapshot, triggerSync]);

  useEffect(
    () => () => {
      invalidateActiveSyncLoopFromEffect();
      void service?.cancel().catch((error) => {
        reportAsyncError('cancel', error);
      });
    },
    [reportAsyncError, service]
  );

  useEffect(() => {
    const handleRefresh = (event: Event): void => {
      triggerSyncFromEvent(parseRefreshSyncScope(event));
    };

    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    };
  }, []);

  useEffect(() => {
    const handleQueueDrained = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        return;
      }
      const detail = event.detail as { embeddingSetId?: unknown; queue?: unknown } | null;
      if (
        detail?.queue !== 'embeddings' ||
        typeof detail.embeddingSetId !== 'string' ||
        detail.embeddingSetId !== managedCollectionId
      ) {
        return;
      }
      triggerSyncFromEvent({ mode: 'full' });
    };

    window.addEventListener(QUEUE_DRAINED_EVENT, handleQueueDrained);
    return () => {
      window.removeEventListener(QUEUE_DRAINED_EVENT, handleQueueDrained);
    };
  }, [managedCollectionId]);

  // Recovery point for a backfill killed while the window was hidden (e.g. a
  // top-level navigation mid-backfill): re-sync on return to visibility so the
  // 0-changes coverage check can re-enqueue any missing embedding work.
  useResyncOnReturnToVisibility(triggerSync);

  return (
    <RootIdentityProvider dbRootIdByAdapterRootId={dbRootIdByAdapterRootId}>
      {children}
    </RootIdentityProvider>
  );
}
