import type {
  WorkspaceCollectionSyncChunkingProgress,
  WorkspaceCollectionSyncScanSummary,
  WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import type {
  ApplyManagedCacheBatchArgs,
  ApplyManagedCacheInvalidationsArgs,
  EmbeddingSet,
  IEmbeddingSetsRepository,
  IFileRecordRepository,
  ManagedCacheInvalidationResult,
} from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import type { FileContentProcessor } from '@brainstrike/file-explorer-hooks';
import type {
  ChunkingWorkerPort,
  EnhancedImportProgress,
  FileImportChunkRepository,
  FileImportFileRecordRepository,
  FileImportSymbolRepository,
} from '@brainstrike/file-import';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import {
  type EmbeddingProviderType,
  isLocalProviderType,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import type { WorkspaceIndexingQosPolicy } from '@brainstrike/indexing-contract/workspace-indexing-qos';
import { createLogger } from '@brainstrike/logging';
import {
  getSupersededBackgroundBackfillIds,
  needsEmbeddingBackfill,
  selectRecoverableBackgroundBackfill,
} from '@brainstrike/pipeline';
import type { FileSystemChange } from '@brainstrike/types';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import { validateRootFolderCacheRequest } from './root-folder-cache-reconciliation';
import {
  type ChunkingRedispatchTerminalError,
  ChunkingRedispatchTracker,
  type PreparedChangesSummary,
  runRootFolderCacheImport,
} from './workspace-collection-sync-import';
import {
  createAbortError,
  createThrottledProgressReporter,
  dispatchQueueDrainedEvent,
  isAbortError,
  mapBackfillProgressToStatus,
  mapEnhancedProgressToStatus,
  throwIfAborted,
  toWorkspaceCollectionSyncChunkingProgress,
  waitForAbortableDelay,
} from './workspace-collection-sync-progress';

/**
 * Import-progress status writes are throttled to this cadence (progress fires
 * once per file read; every status write re-renders all store subscribers).
 * Matches SCANNING_STATUS_THROTTLE_MS.
 */
const IMPORT_STATUS_THROTTLE_MS = 100;

import {
  collectPreparedWorkspaceSyncChanges,
  type PreparedSyncChanges,
} from './workspace-collection-sync-scan';
import { isWorkspaceIndexBlockedError } from './workspace-index-blocked-error';

const logger = createLogger('WorkspaceCollectionSyncService');

const QOS_RETRY_LABELS = {
  backfill: 'Workspace Index backfill',
  import: 'Workspace Index import',
  scan: 'Workspace Index scan',
} as const;

type WorkspaceIndexingQosPhase = keyof typeof QOS_RETRY_LABELS;

// Max time a single sync phase yields to `foreground-db-pressure` before it
// proceeds with gentle, constrained batches. Bounds the starvation of a
// newly-added root caused by a lagging/self-inflicted foreground-latency signal
// (the indexer's own writes refire foreground `live` queries). Genuine
// `foreground-query` activity is NOT bypassed — it keeps yielding fully.
const FOREGROUND_DB_PRESSURE_STARVATION_MS = 5000;

// Upper bound on targets per managed-cache invalidation REQUEST. The desktop
// DB host serializes whole IPC requests, so this — not the DB layer's
// internal transaction batching — is what keeps a huge invalidation (e.g. a
// deleted worktree) from monopolizing the host and starving other queries.
const INVALIDATION_TARGETS_PER_REQUEST = 1000;

function createRunOwnedProgressReporter<T>(args: {
  canPublish: () => boolean;
  emit: (value: T) => void;
  throttleMs: number;
}): {
  finish: () => void;
  report: (value: T) => void;
} {
  const reporter = createThrottledProgressReporter((value: T) => {
    if (args.canPublish()) {
      args.emit(value);
    }
  }, args.throttleMs);
  return {
    finish: () => {
      if (args.canPublish()) {
        reporter.flush();
      }
      reporter.dispose();
    },
    report: (value) => {
      if (!args.canPublish()) {
        return;
      }
      reporter.report(value);
    },
  };
}

interface RootDirectoryHandle {
  _internal?: unknown;
  kind: 'directory';
  name: string;
  path: string;
  platform: 'electron' | 'web';
  rootId?: string;
}

export interface WorkspaceCollectionSyncServiceDependencies {
  applyManagedCacheBatch: (args: ApplyManagedCacheBatchArgs) => Promise<void>;
  cancelBackfill: (embeddingSetId: string) => Promise<void>;
  chunkRepository: FileImportChunkRepository & {
    deleteByFileRecordId: (fileRecordId: string) => Promise<unknown>;
    getCoverageForSet: (
      embeddingSetId: string
    ) => Promise<{ chunksWithEmbeddingsForSet: number; totalChunks: number }>;
  };
  db: DbHandle;
  embeddingSetsRepository: IEmbeddingSetsRepository;
  enqueueBackfill: (
    embeddingSetId: string,
    options: { signal?: AbortSignal; source: 'background-indexing' }
    // { canceled: true } when the backfill was deliberately canceled before it
    // started (desktop main resolves this instead of rejecting the IPC call).
  ) => Promise<{ requestId: string } | { canceled: true }>;
  ensureChunkingWorker: () => Promise<ChunkingWorkerPort>;
  ensureEmbeddingRuntimeStarted: () => Promise<void>;
  fileContentProcessor?: FileContentProcessor;
  fileRecordRepository: FileImportFileRecordRepository &
    Pick<IFileRecordRepository, 'listManagedCacheEntryMetadata' | 'updateStatMetadata'>;
  fileSystemAdapter: FileSystemAdapter;
  getBackfillsInFlight: () => Promise<
    Array<{
      embeddingSetId: string;
      progress: { current: number; total: number } | null;
      requestId: string;
    }>
  >;
  invalidateManagedCacheEntriesByIdentity: (
    args: ApplyManagedCacheInvalidationsArgs
  ) => Promise<ManagedCacheInvalidationResult>;
  log?: typeof logger;
  onDebugStage?: (stage: string, details?: Record<string, unknown>) => void;
  onManagedCollectionMissing?: (managedCollectionId: string) => void;
  /**
   * Maps a root directory path to the canonical DB root id from the `roots`
   * table, awaiting the reconciliation result. Returns `null` if the path is
   * not mapped (logs once per path). ALWAYS settles — never hangs.
   */
  resolveDbRootId: (rootPath: string, adapterRootId?: string | null) => Promise<string | null>;
  resolveQosPolicy: (options?: {
    foregroundDbPressureStarvationBypass?: boolean;
  }) => Promise<WorkspaceIndexingQosPolicy> | WorkspaceIndexingQosPolicy;
  setImporting: (importing: boolean) => void;
  setStatus: (progress: WorkspaceCollectionSyncStatusPatch) => void;
  subscribeToBackfillProgress: (
    callback: (progress: {
      current: number;
      embeddingSetId: string;
      message?: string;
      requestId: string;
      source?: string;
      stage?: string;
      total: number;
    }) => void
  ) => () => void;
  /** Symbol-graph sink (BST-919); optional, absent = no graph. */
  symbolRepository?: FileImportSymbolRepository | null;
  validateHostedProviderAccess: (embeddingSetId: string) => Promise<void>;
  waitForBackgroundPermit: (options: { readonly label: string }) => Promise<void>;
}

export interface WorkspaceCollectionSyncRequest {
  adapterRootId?: string | null;
  backfillMode?: 'defer' | 'enqueue';
  dbRootId?: string | null;
  enabled: boolean;
  indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  managedCollectionId: string | null;
  rootDirectoryHandle: RootDirectoryHandle | null;
  scope?: WorkspaceCollectionSyncScope;
}

export type WorkspaceCollectionSyncScope =
  | {
      mode: 'full';
    }
  | {
      changes: readonly FileSystemChange[];
      mode: 'paths';
    };

interface ResolvedSyncContext {
  activeRootPath: string;
  adapterRootId: string | null;
  collection: EmbeddingSet;
  /** DB root id from the `roots` table, or null if the path is unmapped. */
  dbRootId: string | null;
  provider: EmbeddingProviderType;
  rootPath: string;
}

interface ActiveBackfillTracking {
  embeddingSetId: string;
  requestId: string;
  rootPath: string;
  unsubscribe: (() => void) | null;
}

interface TerminalChunkingErrorScope {
  context: ResolvedSyncContext;
  errors: readonly ChunkingRedispatchTerminalError[];
}

export class WorkspaceCollectionSyncService {
  private activeBackfill: ActiveBackfillTracking | null = null;
  private readonly chunkingRedispatchTracker = new ChunkingRedispatchTracker();
  private readonly terminalChunkingErrorsByScope = new Map<string, TerminalChunkingErrorScope>();
  private currentAbortController: AbortController | null = null;
  private runId = 0;

  constructor(private readonly deps: WorkspaceCollectionSyncServiceDependencies) {}

  reconcileMountedRoots(
    collectionId: string | null,
    mountedRoots: readonly {
      adapterRootId: string | null;
      dbRootId: string | null;
      rootPath: string;
    }[]
  ): void {
    for (const [scopeKey, scope] of this.terminalChunkingErrorsByScope) {
      const remainsMounted = mountedRoots.some((root) => {
        if (root.rootPath !== scope.context.rootPath) {
          return false;
        }
        if (scope.context.adapterRootId !== null) {
          return root.adapterRootId === scope.context.adapterRootId;
        }
        return root.dbRootId === null || root.dbRootId === scope.context.dbRootId;
      });
      if (scope.context.collection.id !== collectionId || !remainsMounted) {
        this.terminalChunkingErrorsByScope.delete(scopeKey);
      }
    }
  }

  /**
   * Deliberate stop — pause, disable, or a restart that must not overlap the
   * previous pass. Aborts the renderer-side loop, cancels the host-owned
   * backfill this service enqueued, AND cancels any `background-indexing` run
   * the host still has in flight that nothing is tracking (BST-1654).
   */
  async cancel(): Promise<void> {
    this.runId += 1;
    await this.resetActiveWork({ cancelTrackedBackfill: true });
    await this.cancelUntrackedBackgroundBackfills();
  }

  /**
   * The requester is going away (BST-1654). A `source: 'background-indexing'`
   * backfill is owned by the host runtime, not by the React tree that asked for
   * it, so tearing that tree down must release only what is local: the
   * in-flight renderer loop and this service's progress subscription. The
   * durable run keeps going and is re-attached by the next `sync()` via
   * `selectRecoverableBackgroundBackfill`.
   *
   * Using `cancel()` here is what silently killed a user's backfill on
   * navigation — and, because the owning effect's cleanup also re-runs on
   * service-identity churn, on ordinary dependency changes too.
   *
   * Detaching drops tracking, never authority: `cancel()` and the disabled
   * `sync()` path enumerate the host's in-flight runs, so a pause or disable
   * arriving on a later instance still stops a run detached from here.
   */
  async detach(): Promise<void> {
    this.runId += 1;
    await this.resetActiveWork({ cancelTrackedBackfill: false });
  }

  private isCancelled(runId: number): boolean {
    return runId !== this.runId;
  }

  private createClearedProgressState(): Pick<
    WorkspaceCollectionSyncStatusPatch,
    | 'blockedReason'
    | 'backfillRequestId'
    | 'chunkingProgress'
    | 'currentFilePath'
    | 'embeddingProgress'
    | 'importProgress'
    | 'lastError'
    | 'pauseReasons'
    | 'processedFiles'
    | 'queuedFiles'
    | 'queueProgress'
    | 'scanSummary'
  > {
    return {
      backfillRequestId: null,
      blockedReason: null,
      chunkingProgress: null,
      currentFilePath: null,
      embeddingProgress: null,
      importProgress: null,
      lastError: null,
      pauseReasons: [],
      processedFiles: 0,
      queuedFiles: 0,
      queueProgress: null,
      scanSummary: null,
    };
  }

  private setDisabledStatus(request: WorkspaceCollectionSyncRequest): void {
    this.deps.setStatus({
      activeRootPath: request.rootDirectoryHandle?.path ?? null,
      managedCollectionId: request.managedCollectionId,
      managedCollectionName: null,
      state: 'disabled',
      ...this.createClearedProgressState(),
    });
  }

  private createScanSummary(
    prepared: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'truncatedDirectoryPaths' | 'unchangedCount'
    >
  ): WorkspaceCollectionSyncScanSummary {
    return {
      changedFiles: prepared.changes.length,
      discoveredFiles: prepared.totalFiles,
      excludedEntries: prepared.excludedEntries,
      truncatedDirectories: prepared.truncatedDirectoryPaths.length,
      unchangedFiles: prepared.unchangedCount,
    };
  }

  private async resetActiveWork(options: { cancelTrackedBackfill: boolean }): Promise<void> {
    this.currentAbortController?.abort();
    this.currentAbortController = null;

    const trackedBackfill = this.activeBackfill;
    this.activeBackfill = null;
    trackedBackfill?.unsubscribe?.();

    if (!(options.cancelTrackedBackfill && trackedBackfill)) {
      return;
    }

    try {
      await this.deps.cancelBackfill(trackedBackfill.embeddingSetId);
    } catch (error) {
      this.deps.log?.warn('Failed to cancel tracked background backfill', {
        embeddingSetId: trackedBackfill.embeddingSetId,
        error: error instanceof Error ? error.message : String(error),
        requestId: trackedBackfill.requestId,
      });
    }
  }

  private setErrorStatus(args: {
    activeRootPath: string | null;
    managedCollectionId: string | null;
    managedCollectionName: string | null;
    message: string;
  }): void {
    this.deps.setStatus({
      activeRootPath: args.activeRootPath,
      blockedReason: null,
      lastError: args.message,
      managedCollectionId: args.managedCollectionId,
      managedCollectionName: args.managedCollectionName,
      pauseReasons: [],
      state: 'error',
    });
  }

  /**
   * No root folder or managed collection has been selected — setup is incomplete, not a
   * failure (BST-1335). Logged at info (never durably persisted, unlike the
   * warn+ `errorTransitionLogger` chokepoint the status store owns for
   * genuine `error`/`blocked` transitions) and carries no `lastError`, so the
   * store's durable-logging subscription never fires for it.
   */
  private setUnconfiguredStatus(args: {
    activeRootPath: string | null;
    managedCollectionId: string | null;
    reason: string;
  }): void {
    this.deps.log?.info('Workspace collection sync is unconfigured', {
      activeRootPath: args.activeRootPath,
      managedCollectionId: args.managedCollectionId,
      reason: args.reason,
    });
    this.deps.setStatus({
      activeRootPath: args.activeRootPath,
      managedCollectionId: args.managedCollectionId,
      managedCollectionName: null,
      state: 'unconfigured',
      ...this.createClearedProgressState(),
    });
  }

  private async cancelHostBackgroundBackfills(args: {
    exceptEmbeddingSetId?: string;
    inFlightBackfills: Array<{
      embeddingSetId: string;
      progress: { current: number; total: number } | null;
      requestId: string;
    }>;
  }): Promise<void> {
    for (const embeddingSetId of getSupersededBackgroundBackfillIds(args)) {
      await this.deps.cancelBackfill(embeddingSetId);
    }
  }

  /**
   * Cancellation authority must not live in `this.activeBackfill` (BST-1654).
   * `detach()` deliberately drops local tracking while the host run continues,
   * so an explicit stop that arrives afterwards — a pause or a disable, usually
   * on a fresh provider instance that never enqueued anything — has nothing
   * tracked to kill. Ask the host what is still running instead and cancel
   * every `source: 'background-indexing'` run it reports; runs owned by anyone
   * else (manual backfills, request ids without the background prefix) are left
   * alone. Without this, a user's explicit stop leaves embedding and database
   * work burning, which is the failure the workspace-indexing contract forbids.
   *
   * Rejects rather than degrading: a stop that could not be delivered must
   * surface at the caller, never look like it worked.
   */
  private async cancelUntrackedBackgroundBackfills(): Promise<void> {
    const inFlightBackfills = await this.deps.getBackfillsInFlight();
    await this.cancelHostBackgroundBackfills({ inFlightBackfills });
  }

  /**
   * Missing setup is unconfigured (BST-1340). The provider waits for database
   * initialization before constructing this service; a missing required DB here
   * is an invalid dependency and remains an error.
   */
  private handleInvalidRequest(args: {
    rootPath: string | null;
    validation: Extract<ReturnType<typeof validateRootFolderCacheRequest>, { ok: false }>;
    managedCollectionId: string | null;
  }): void {
    if (
      args.validation.code === 'no-root-folder' ||
      args.validation.code === 'no-managed-collection'
    ) {
      this.setUnconfiguredStatus({
        activeRootPath: args.rootPath,
        managedCollectionId: args.managedCollectionId,
        reason: args.validation.reason,
      });
      return;
    }
    this.setErrorStatus({
      activeRootPath: args.rootPath,
      managedCollectionId: args.managedCollectionId,
      managedCollectionName: null,
      message: args.validation.reason,
    });
  }

  private async resolveContext(
    request: WorkspaceCollectionSyncRequest
  ): Promise<ResolvedSyncContext | null> {
    const rootPath = request.rootDirectoryHandle?.path ?? null;
    const validation = validateRootFolderCacheRequest({
      dbReady: Boolean(this.deps.db),
      managedCollectionId: request.managedCollectionId,
      rootPath,
    });

    if (!validation.ok) {
      this.handleInvalidRequest({
        managedCollectionId: request.managedCollectionId,
        rootPath,
        validation,
      });
      return null;
    }

    const managedCollectionId = request.managedCollectionId;
    const collection = managedCollectionId
      ? await this.deps.embeddingSetsRepository.getById(managedCollectionId)
      : null;
    if (!collection) {
      if (managedCollectionId) {
        this.deps.onManagedCollectionMissing?.(managedCollectionId);
      }
      this.setErrorStatus({
        activeRootPath: rootPath,
        managedCollectionId,
        managedCollectionName: null,
        message: 'Managed collection was not found. Select a new collection in Settings.',
      });
      return null;
    }

    if (!(collection.modelKey && collection.modelId && collection.dimensions > 0)) {
      this.setErrorStatus({
        activeRootPath: rootPath,
        managedCollectionId: request.managedCollectionId,
        managedCollectionName: collection.name ?? null,
        message: 'Managed collection metadata is invalid.',
      });
      return null;
    }

    const provider = parseEmbeddingProviderModelKey(collection.modelKey)?.provider ?? null;
    if (!provider) {
      this.setErrorStatus({
        activeRootPath: rootPath,
        managedCollectionId: collection.id,
        managedCollectionName: collection.name ?? null,
        message: 'Managed collection metadata is invalid.',
      });
      return null;
    }

    // Short-circuit: '' is never a valid lookup key, and passing it would
    // pollute the warn-once set with a misleading entry on path-less runs.
    const adapterRootId =
      request.adapterRootId === undefined
        ? (request.rootDirectoryHandle?.rootId ?? null)
        : request.adapterRootId;
    const dbRootId =
      request.dbRootId === undefined
        ? rootPath
          ? await this.deps.resolveDbRootId(rootPath, adapterRootId)
          : null
        : request.dbRootId;
    return {
      activeRootPath: rootPath ?? '',
      adapterRootId,
      collection,
      dbRootId,
      provider,
      rootPath: rootPath ?? '',
    };
  }

  private async ensureCollectionAccess(context: ResolvedSyncContext): Promise<void> {
    await this.ensureProviderAccess(context);
    await this.deps.ensureEmbeddingRuntimeStarted();
  }

  private async ensureProviderAccess(context: ResolvedSyncContext): Promise<void> {
    if (!isLocalProviderType(context.provider)) {
      await this.deps.validateHostedProviderAccess(context.collection.id);
    }
  }

  private setScanningStatus(
    context: ResolvedSyncContext,
    currentFilePath: string | null,
    options?: { resetProgress?: boolean }
  ): void {
    this.deps.setStatus({
      activeRootPath: context.rootPath,
      currentFilePath,
      lastError: null,
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      pauseReasons: [],
      state: 'scanning',
      ...(options?.resetProgress ? this.createClearedProgressState() : {}),
    });
  }

  private setQosWaitingStatus(context: ResolvedSyncContext): void {
    this.deps.setStatus({
      activeRootPath: context.rootPath,
      currentFilePath: null,
      lastError: null,
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      pauseReasons: [],
      state: 'waiting',
    });
  }

  private async resolveQosPolicyForNewWork(args: {
    abortSignal: AbortSignal;
    context: ResolvedSyncContext;
    phase: WorkspaceIndexingQosPhase;
  }): Promise<WorkspaceIndexingQosPolicy> {
    const yieldDeadline = Date.now() + FOREGROUND_DB_PRESSURE_STARVATION_MS;
    let starvationBypassed = false;
    let qosPolicy = await this.deps.resolveQosPolicy();
    this.deps.onDebugStage?.(`qos:${args.phase}:resolved`, {
      allowNewWork: qosPolicy.allowNewWork,
      interBatchDelayMs: qosPolicy.interBatchDelayMs,
      qosReason: qosPolicy.reason,
      qosState: qosPolicy.state,
    });
    while (!qosPolicy.allowNewWork && qosPolicy.state === 'foreground-yielding') {
      throwIfAborted(args.abortSignal);
      this.deps.onDebugStage?.(`qos:${args.phase}:waiting`, {
        interBatchDelayMs: qosPolicy.interBatchDelayMs,
        qosReason: qosPolicy.reason,
        qosState: qosPolicy.state,
      });
      this.setQosWaitingStatus(args.context);
      await this.deps.waitForBackgroundPermit({
        label: QOS_RETRY_LABELS[args.phase],
      });
      this.deps.onDebugStage?.(`qos:${args.phase}:permit`, {
        interBatchDelayMs: qosPolicy.interBatchDelayMs,
        qosReason: qosPolicy.reason,
        qosState: qosPolicy.state,
      });
      throwIfAborted(args.abortSignal);
      await waitForAbortableDelay(Math.max(1, qosPolicy.interBatchDelayMs), args.abortSignal);
      throwIfAborted(args.abortSignal);
      // After the starvation bound, request the foreground-db-pressure bypass so
      // a starved pass downgrades to gentle constrained work instead of yielding
      // forever. The resolver ignores the bypass for genuine foreground-query
      // activity, which keeps yielding fully.
      const foregroundDbPressureStarvationBypass = Date.now() >= yieldDeadline;
      if (foregroundDbPressureStarvationBypass && !starvationBypassed) {
        starvationBypassed = true;
        this.deps.log?.warn(
          'Workspace Index sync exceeded the foreground-db-pressure starvation bound; proceeding with constrained work',
          {
            phase: args.phase,
            rootPath: args.context.rootPath,
            starvationMs: FOREGROUND_DB_PRESSURE_STARVATION_MS,
          }
        );
      }
      qosPolicy = await this.deps.resolveQosPolicy({ foregroundDbPressureStarvationBypass });
      this.deps.onDebugStage?.(`qos:${args.phase}:resolved`, {
        allowNewWork: qosPolicy.allowNewWork,
        interBatchDelayMs: qosPolicy.interBatchDelayMs,
        qosReason: qosPolicy.reason,
        qosState: qosPolicy.state,
      });
    }
    if (!qosPolicy.allowNewWork && qosPolicy.state === 'paused') {
      throw createAbortError('Workspace Index sync paused.');
    }
    if (!qosPolicy.allowNewWork) {
      // Invariant: production QoS only blocks new work for foreground-yielding
      // or paused states. Guard injected/future states before scan/import/backfill
      // helpers can surface a hard "does not permit work" error.
      throw createAbortError('Workspace Index sync paused by QoS policy.');
    }
    return qosPolicy;
  }

  private async collectPreparedChanges(args: {
    request: WorkspaceCollectionSyncRequest;
    context: ResolvedSyncContext;
    abortSignal: AbortSignal;
    qosPolicy: WorkspaceIndexingQosPolicy;
    runId: number;
  }): Promise<PreparedSyncChanges> {
    return await collectPreparedWorkspaceSyncChanges({
      abortSignal: args.abortSignal,
      context: {
        activeRootPath: args.context.activeRootPath,
        collectionId: args.context.collection.id,
        dbRootId: args.context.dbRootId,
        rootPath: args.context.rootPath,
      },
      deps: {
        chunkingRedispatchTracker: this.chunkingRedispatchTracker,
        fileRecordRepository: this.deps.fileRecordRepository,
        fileSystemAdapter: this.deps.fileSystemAdapter,
        onScanningPath: (path) => {
          if (this.isCancelled(args.runId) || args.abortSignal.aborted) {
            return;
          }
          this.setScanningStatus(args.context, path);
        },
        ...(this.deps.fileContentProcessor
          ? { fileContentProcessor: this.deps.fileContentProcessor }
          : {}),
      },
      qosPolicy: args.qosPolicy,
      request: args.request,
    });
  }

  private setScanSummary(
    context: ResolvedSyncContext,
    prepared: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'truncatedDirectoryPaths' | 'unchangedCount'
    >
  ): void {
    this.deps.setStatus({
      activeRootPath: context.rootPath,
      lastError: null,
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      pauseReasons: [],
      processedFiles: prepared.unchangedCount,
      queuedFiles: prepared.changes.length,
      scanSummary: this.createScanSummary(prepared),
    });
  }

  private updateTerminalChunkingRedispatchErrors(
    context: ResolvedSyncContext,
    prepared: PreparedChangesSummary,
    request: WorkspaceCollectionSyncRequest
  ): void {
    const scopeKey = JSON.stringify([context.collection.id, context.dbRootId, context.rootPath]);
    const previous = this.terminalChunkingErrorsByScope.get(scopeKey);
    const partialChanges = request.scope?.mode === 'paths' ? request.scope.changes : null;
    const inaccessiblePaths = new Set(prepared.inaccessiblePaths);
    const previousErrors = previous?.errors ?? [];
    const retainedErrors = partialChanges
      ? previousErrors.filter(
          (error) =>
            inaccessiblePaths.has(error.relativePath) ||
            !partialChanges.some((change) => {
              const normalizedChangePath = change.path.replace(/\\/g, '/').replace(/\/+$/u, '');
              const normalizedRootPath = context.rootPath.replace(/\\/g, '/').replace(/\/+$/u, '');
              if (normalizedChangePath === normalizedRootPath) {
                return false;
              }
              const relativePath = normalizeSelectionPathForFolder(
                normalizedChangePath,
                context.rootPath,
                { label: 'Workspace Index watcher path' }
              );
              return change.kind === 'directory'
                ? error.relativePath === relativePath ||
                    error.relativePath.startsWith(`${relativePath}/`)
                : error.relativePath === relativePath;
            })
        )
      : previousErrors.filter((error) => inaccessiblePaths.has(error.relativePath));
    const errorsByPath = new Map(
      [...retainedErrors, ...prepared.terminalChunkingErrors].map((error) => [
        error.relativePath,
        error,
      ])
    );
    const errors = [...errorsByPath.values()];
    if (errors.length === 0) {
      this.terminalChunkingErrorsByScope.delete(scopeKey);
      return;
    }
    this.terminalChunkingErrorsByScope.set(scopeKey, {
      context,
      errors,
    });
  }

  private retainTerminalChunkingErrorsForCollection(collectionId: string | null): void {
    for (const [scopeKey, scope] of this.terminalChunkingErrorsByScope) {
      if (scope.context.collection.id !== collectionId) {
        this.terminalChunkingErrorsByScope.delete(scopeKey);
      }
    }
  }

  private surfaceTerminalChunkingRedispatchError(): boolean {
    const scopes = [...this.terminalChunkingErrorsByScope.values()];
    const firstScope = scopes[0];
    const terminalError = firstScope?.errors[0];
    if (!terminalError) {
      return false;
    }
    const allErrors = scopes.flatMap((scope) => scope.errors);
    const additionalErrors = allErrors.slice(1);
    const listedPaths = additionalErrors.slice(0, 5).map((error) => `"${error.relativePath}"`);
    const unlistedCount = Math.max(0, additionalErrors.length - listedPaths.length);
    const additionalDetail =
      listedPaths.length === 0
        ? ''
        : ` Additional exhausted files: ${listedPaths.join(', ')}${
            unlistedCount > 0 ? `, plus ${unlistedCount} more` : ''
          }.`;
    this.setErrorStatus({
      activeRootPath: firstScope.context.rootPath,
      managedCollectionId: firstScope.context.collection.id,
      managedCollectionName: firstScope.context.collection.name ?? null,
      message: `${terminalError.message}${additionalDetail}`,
    });
    return true;
  }

  private setIdleStatus(args: {
    collection: EmbeddingSet;
    rootPath: string;
    summary?: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'truncatedDirectoryPaths' | 'unchangedCount'
    >;
  }): void {
    this.deps.setStatus({
      activeRootPath: args.rootPath,
      backfillRequestId: null,
      currentFilePath: null,
      lastError: null,
      managedCollectionId: args.collection.id,
      managedCollectionName: args.collection.name ?? null,
      pauseReasons: [],
      state: 'idle',
      ...(args.summary
        ? {
            processedFiles: args.summary.totalFiles,
            queuedFiles: 0,
            scanSummary: this.createScanSummary(args.summary),
          }
        : {
            queuedFiles: 0,
          }),
    });
  }

  /**
   * Stamp scanned (size, mtime) onto hash-confirmed-unchanged rows whose stored
   * stats are missing/stale, so the NEXT sync stat-skips them. Pre-migration
   * rows never write otherwise, which would leave them re-read + re-hashed on
   * every sync forever. Best-effort: the stamp is an optimization, so a failure
   * must not fail the sync — but it is logged loudly, never swallowed.
   */
  private async persistStatRefreshes(
    statRefreshes: PreparedChangesSummary['statRefreshes']
  ): Promise<void> {
    if (statRefreshes.length === 0) {
      return;
    }
    try {
      await this.deps.fileRecordRepository.updateStatMetadata(statRefreshes);
    } catch (error) {
      this.deps.log?.warn('Failed to persist stat-cache refreshes', {
        count: statRefreshes.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async collectionNeedsBackfill(collectionId: string): Promise<boolean> {
    const coverage = await this.deps.chunkRepository.getCoverageForSet(collectionId);
    return needsEmbeddingBackfill(coverage);
  }

  private setEmbeddingPendingStatus(args: {
    backfillRequestId: string;
    chunkingProgress: WorkspaceCollectionSyncChunkingProgress | null;
    collection: EmbeddingSet;
    rootPath: string;
    summary: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'truncatedDirectoryPaths' | 'unchangedCount'
    >;
  }): void {
    this.deps.setStatus({
      activeRootPath: args.rootPath,
      backfillRequestId: args.backfillRequestId,
      chunkingProgress: args.chunkingProgress,
      currentFilePath: null,
      embeddingProgress: null,
      lastError: null,
      managedCollectionId: args.collection.id,
      managedCollectionName: args.collection.name ?? null,
      pauseReasons: [],
      processedFiles: args.summary.totalFiles,
      queuedFiles: 0,
      queueProgress: null,
      scanSummary: this.createScanSummary(args.summary),
      state: 'embedding',
    });
  }

  private async enqueueManagedBackfill(args: {
    abortSignal: AbortSignal;
    chunkingProgress: WorkspaceCollectionSyncChunkingProgress | null;
    collection: EmbeddingSet;
    qosPolicy: WorkspaceIndexingQosPolicy;
    rootPath: string;
    summary: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'truncatedDirectoryPaths' | 'unchangedCount'
    >;
  }): Promise<void> {
    if (!args.qosPolicy.allowNewWork) {
      throw createAbortError('Workspace Index QoS policy does not permit backfill enqueue work.');
    }
    const pendingRequestId = `pending:${args.collection.id}:${Date.now()}`;
    let unsubscribeBackfillProgress: (() => void) | null = null;
    let terminalBackfillRequestId: string | null = null;

    unsubscribeBackfillProgress = this.deps.subscribeToBackfillProgress((progress) => {
      if (progress.embeddingSetId !== args.collection.id) {
        return;
      }
      this.activeBackfill = {
        embeddingSetId: args.collection.id,
        requestId: progress.requestId,
        rootPath: args.rootPath,
        unsubscribe: unsubscribeBackfillProgress,
      };
      if (progress.stage === 'error') {
        terminalBackfillRequestId = progress.requestId;
        this.activeBackfill?.unsubscribe?.();
        this.activeBackfill = null;
        this.setErrorStatus({
          activeRootPath: args.rootPath,
          managedCollectionId: args.collection.id,
          managedCollectionName: args.collection.name ?? null,
          message: progress.message ?? 'Embedding backfill failed.',
        });
        return;
      }
      this.deps.setStatus(
        mapBackfillProgressToStatus({
          chunkingProgress: args.chunkingProgress,
          collection: args.collection,
          current: progress.current,
          managedCollectionName: args.collection.name ?? null,
          requestId: progress.requestId,
          rootPath: args.rootPath,
          scanSummary: this.createScanSummary(args.summary),
          state: 'embedding',
          total: progress.total,
          ...(progress.message ? { message: progress.message } : {}),
        })
      );
      // Backfill is intentionally allowed to continue for healthy chunks, but
      // its asynchronous progress must not hide a terminal chunking failure.
      this.surfaceTerminalChunkingRedispatchError();
      if (progress.stage === 'complete') {
        terminalBackfillRequestId = progress.requestId;
        this.activeBackfill?.unsubscribe?.();
        this.activeBackfill = null;
        dispatchQueueDrainedEvent(args.collection.id);
      }
    });
    this.activeBackfill = {
      embeddingSetId: args.collection.id,
      requestId: pendingRequestId,
      rootPath: args.rootPath,
      unsubscribe: unsubscribeBackfillProgress,
    };

    const enqueueResult = await this.deps.enqueueBackfill(args.collection.id, {
      signal: args.abortSignal,
      source: 'background-indexing',
    });
    if ('canceled' in enqueueResult) {
      this.activeBackfill?.unsubscribe?.();
      this.activeBackfill = null;
      // Desktop main now resolves a benign { canceled: true } for a deliberate
      // cancellation instead of rejecting the IPC call. Re-raise it locally as an
      // abort so the existing upstream cancellation handling (isAbortError →
      // benign, never handleSyncFailure) is byte-identical to the prior
      // reject-on-cancel behavior; only the spurious main-process handler-error
      // log is gone.
      throw createAbortError('Embedding backfill was canceled before it started.');
    }
    const { requestId } = enqueueResult;
    if (terminalBackfillRequestId === requestId) {
      throwIfAborted(args.abortSignal);
      return;
    }
    this.activeBackfill = {
      embeddingSetId: args.collection.id,
      requestId,
      rootPath: args.rootPath,
      unsubscribe: unsubscribeBackfillProgress,
    };
    this.setEmbeddingPendingStatus({
      backfillRequestId: requestId,
      chunkingProgress: args.chunkingProgress,
      collection: args.collection,
      rootPath: args.rootPath,
      summary: args.summary,
    });
    throwIfAborted(args.abortSignal);
  }

  private shouldEnqueueBackfill(request: WorkspaceCollectionSyncRequest): boolean {
    return request.backfillMode !== 'defer';
  }

  private setImportingStatus(
    context: ResolvedSyncContext,
    summary: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'truncatedDirectoryPaths' | 'unchangedCount'
    >
  ): void {
    this.deps.setStatus({
      activeRootPath: context.rootPath,
      backfillRequestId: null,
      chunkingProgress: null,
      currentFilePath: null,
      embeddingProgress: null,
      importProgress: {
        completed: 0,
        current: null,
        errorCount: 0,
        total: summary.changes.length,
      },
      lastError: null,
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      pauseReasons: [],
      processedFiles: summary.unchangedCount,
      queuedFiles: summary.changes.length,
      queueProgress: null,
      scanSummary: this.createScanSummary(summary),
      state: 'importing',
    });
  }

  private handleSyncFailure(args: {
    collection: EmbeddingSet;
    error: unknown;
    rootPath: string;
  }): void {
    const message = args.error instanceof Error ? args.error.message : String(args.error);
    if (isWorkspaceIndexBlockedError(args.error)) {
      this.deps.setStatus({
        activeRootPath: args.rootPath,
        managedCollectionId: args.collection.id,
        managedCollectionName: args.collection.name ?? null,
        state: 'blocked',
        ...this.createClearedProgressState(),
        blockedReason: args.error.blockedReason,
        lastError: message,
      });
      return;
    }

    // No direct log call: the status store's subscription durably logs the
    // error transition set below (BST-1257) — logging here too recorded every
    // incident twice under different scopes.
    this.setErrorStatus({
      activeRootPath: args.rootPath,
      managedCollectionId: args.collection.id,
      managedCollectionName: args.collection.name ?? null,
      message,
    });
  }

  private async cancelTrackedBackfill(
    trackedBackfill: ActiveBackfillTracking | null
  ): Promise<void> {
    if (!trackedBackfill) {
      return;
    }
    await this.deps.cancelBackfill(trackedBackfill.embeddingSetId);
  }

  private async prepareSyncContext(args: {
    currentRunId: number;
    previousTrackedBackfill: ActiveBackfillTracking | null;
    request: WorkspaceCollectionSyncRequest;
  }): Promise<ResolvedSyncContext | null> {
    if (!args.request.enabled) {
      // Disabling is an explicit stop, so it cannot return before asking the
      // host what is in flight (BST-1654): the run this provider instance
      // detached from is not in `previousTrackedBackfill`.
      await this.cancelTrackedBackfill(args.previousTrackedBackfill);
      await this.cancelUntrackedBackgroundBackfills();
      this.setDisabledStatus(args.request);
      return null;
    }

    const context = await this.resolveContext(args.request);
    if (!context) {
      await this.cancelTrackedBackfill(args.previousTrackedBackfill);
      return null;
    }
    if (this.isCancelled(args.currentRunId)) {
      return null;
    }
    return context;
  }

  private async cancelSupersededTrackedBackfill(args: {
    canReusePreviousBackfill: boolean;
    previousTrackedBackfill: ActiveBackfillTracking | null;
  }): Promise<void> {
    if (!(args.previousTrackedBackfill && !args.canReusePreviousBackfill)) {
      return;
    }
    await this.deps.cancelBackfill(args.previousTrackedBackfill.embeddingSetId);
  }

  /** Optional-dep normalization kept OUT of runSyncPass: that method sits at
   * the cognitive-complexity ceiling and a `??` inside it tips the lint. */
  private symbolSink(): FileImportSymbolRepository | null {
    return this.deps.symbolRepository ?? null;
  }

  private async finishSyncWithoutChanges(args: {
    abortSignal: AbortSignal;
    context: ResolvedSyncContext;
    prepared: PreparedChangesSummary;
    request: WorkspaceCollectionSyncRequest;
  }): Promise<void> {
    const needsBackfill = await this.collectionNeedsBackfill(args.context.collection.id);
    throwIfAborted(args.abortSignal);
    if (!(needsBackfill && this.shouldEnqueueBackfill(args.request))) {
      this.setIdleStatus({
        collection: args.context.collection,
        rootPath: args.context.rootPath,
        summary: args.prepared,
      });
      this.surfaceTerminalChunkingRedispatchError();
      return;
    }
    await this.ensureCollectionAccess(args.context);
    throwIfAborted(args.abortSignal);
    await this.enqueueManagedBackfill({
      abortSignal: args.abortSignal,
      chunkingProgress: null,
      collection: args.context.collection,
      qosPolicy: await this.resolveQosPolicyForNewWork({
        abortSignal: args.abortSignal,
        context: args.context,
        phase: 'backfill',
      }),
      rootPath: args.context.rootPath,
      summary: args.prepared,
    });
    this.surfaceTerminalChunkingRedispatchError();
  }

  private async runSyncPass(args: {
    abortSignal: AbortSignal;
    context: ResolvedSyncContext;
    request: WorkspaceCollectionSyncRequest;
    runId: number;
  }): Promise<void> {
    // Cache identity is the durable root_id (source_root_path is retired): an
    // import with no resolvable root_id would persist rows with no stable
    // identity — un-dedupable orphans the next sync re-imports forever. Skip
    // BEFORE the scan: collectPreparedChanges walks the tree and reads+hashes
    // every changed file (identity key on an empty root_id matches nothing, so
    // all files become "changes"), and the import is then skipped anyway — a
    // null root would pay full content-read cost every sync to persist nothing.
    // resolveDbRootId already warned once. Unregistered roots (session-only /
    // storage-failed) are the only ones that land here.
    if (args.context.dbRootId === null) {
      this.setIdleStatus({
        collection: args.context.collection,
        rootPath: args.context.rootPath,
      });
      return;
    }

    const scanQosPolicy = await this.resolveQosPolicyForNewWork({
      abortSignal: args.abortSignal,
      context: args.context,
      phase: 'scan',
    });
    const syncChanges = await this.collectPreparedChanges({
      abortSignal: args.abortSignal,
      context: args.context,
      qosPolicy: scanQosPolicy,
      request: args.request,
      runId: args.runId,
    });
    throwIfAborted(args.abortSignal);
    const { invalidationTargets, prepared } = syncChanges;
    this.updateTerminalChunkingRedispatchErrors(args.context, prepared, args.request);
    this.setScanSummary(args.context, prepared);
    if (invalidationTargets.length > 0) {
      // The desktop DB host executes ONE IPC request at a time, so a single
      // invalidate request covering every target would monopolize the host
      // for its full duration (and can outlive the request timeout) no matter
      // how the DB layer batches transactions internally. Bounded requests
      // let search/status/live-query traffic interleave between chunks;
      // invalidation is idempotent, so a failure between chunks leaves the
      // committed chunks valid and the next sync pass retries the rest.
      for (
        let offset = 0;
        offset < invalidationTargets.length;
        offset += INVALIDATION_TARGETS_PER_REQUEST
      ) {
        await this.deps.invalidateManagedCacheEntriesByIdentity({
          embeddingSetId: args.context.collection.id,
          targets: invalidationTargets.slice(offset, offset + INVALIDATION_TARGETS_PER_REQUEST),
        });
        throwIfAborted(args.abortSignal);
      }
    }
    await this.persistStatRefreshes(prepared.statRefreshes);
    throwIfAborted(args.abortSignal);

    if (prepared.changes.length === 0) {
      await this.finishSyncWithoutChanges({
        abortSignal: args.abortSignal,
        context: args.context,
        prepared,
        request: args.request,
      });
      return;
    }

    await this.ensureCollectionAccess(args.context);
    throwIfAborted(args.abortSignal);

    const chunkingWorkerPort = await this.deps.ensureChunkingWorker();
    throwIfAborted(args.abortSignal);

    const importQosPolicy = await this.resolveQosPolicyForNewWork({
      abortSignal: args.abortSignal,
      context: args.context,
      phase: 'import',
    });
    this.setImportingStatus(args.context, prepared);
    const scanSummary = this.createScanSummary(prepared);
    let latestImportProgress: EnhancedImportProgress | null = null;

    // Progress fires once per FILE READ — thousands of times on a large
    // workspace. Throttle the status-store writes (each one re-renders every
    // subscriber) to the same cadence the scanning phase uses; the flush in
    // `finally` guarantees the final progress state always lands.
    const importStatusReporter = createRunOwnedProgressReporter<EnhancedImportProgress>({
      canPublish: () => !(this.isCancelled(args.runId) || args.abortSignal.aborted),
      emit: (progress) => {
        this.deps.setStatus(
          mapEnhancedProgressToStatus(
            progress,
            args.context.collection.id,
            args.context.collection.name ?? null,
            args.context.rootPath,
            scanSummary
          )
        );
      },
      throttleMs: IMPORT_STATUS_THROTTLE_MS,
    });
    try {
      throwIfAborted(args.abortSignal);
      await runRootFolderCacheImport({
        abortSignal: args.abortSignal,
        applyManagedCacheBatch: this.deps.applyManagedCacheBatch,
        changes: prepared.changes,
        chunkingWorkerPort,
        chunkRepository: this.deps.chunkRepository,
        collection: args.context.collection,
        db: this.deps.db,
        symbolRepository: this.symbolSink(),
        ...(this.deps.fileContentProcessor
          ? { fileContentProcessor: this.deps.fileContentProcessor }
          : {}),
        fileRecordRepository: this.deps.fileRecordRepository,
        onChunkingBatchStart: (batch) => {
          this.chunkingRedispatchTracker.recordDispatches(batch);
        },
        onProgress: (progress) => {
          latestImportProgress = progress;
          importStatusReporter.report(progress);
        },
        qosPolicy: importQosPolicy,
        rootId: args.context.dbRootId,
        setImporting: this.deps.setImporting,
        waitForBackgroundPermit: this.deps.waitForBackgroundPermit,
      });
    } finally {
      importStatusReporter.finish();
    }
    throwIfAborted(args.abortSignal);

    const chunkingProgress = latestImportProgress
      ? toWorkspaceCollectionSyncChunkingProgress(latestImportProgress)
      : null;
    if (!this.shouldEnqueueBackfill(args.request)) {
      this.setIdleStatus({
        collection: args.context.collection,
        rootPath: args.context.rootPath,
        summary: prepared,
      });
      this.surfaceTerminalChunkingRedispatchError();
      return;
    }
    await this.enqueueManagedBackfill({
      abortSignal: args.abortSignal,
      chunkingProgress,
      collection: args.context.collection,
      qosPolicy: await this.resolveQosPolicyForNewWork({
        abortSignal: args.abortSignal,
        context: args.context,
        phase: 'backfill',
      }),
      rootPath: args.context.rootPath,
      summary: prepared,
    });
    this.surfaceTerminalChunkingRedispatchError();
    if (this.isCancelled(args.runId) || args.abortSignal.aborted) {
    }
  }

  async sync(request: WorkspaceCollectionSyncRequest): Promise<void> {
    const currentRunId = ++this.runId;
    this.retainTerminalChunkingErrorsForCollection(
      request.enabled ? request.managedCollectionId : null
    );
    this.deps.onDebugStage?.('sync:start', { runId: currentRunId });
    const previousTrackedBackfill = this.activeBackfill;
    this.currentAbortController?.abort();
    this.currentAbortController = null;
    this.activeBackfill = null;
    previousTrackedBackfill?.unsubscribe?.();

    const context = await this.prepareSyncContext({
      currentRunId,
      previousTrackedBackfill,
      request,
    });
    this.deps.onDebugStage?.('sync:context', {
      contextResolved: Boolean(context),
      isCancelled: this.isCancelled(currentRunId),
      runId: currentRunId,
    });
    if (!context) {
      return;
    }

    try {
      await this.ensureProviderAccess(context);
    } catch (error) {
      if (this.isCancelled(currentRunId) || isAbortError(error)) {
        return;
      }
      await this.cancelTrackedBackfill(previousTrackedBackfill);
      this.handleSyncFailure({
        collection: context.collection,
        error,
        rootPath: context.rootPath,
      });
      return;
    }
    if (this.isCancelled(currentRunId)) {
      this.deps.onDebugStage?.('sync:cancelled-after-access', { runId: currentRunId });
      return;
    }

    const inFlightBackfills = await this.deps.getBackfillsInFlight();
    this.deps.onDebugStage?.('sync:in-flight-backfills', {
      count: inFlightBackfills.length,
      isCancelled: this.isCancelled(currentRunId),
      runId: currentRunId,
    });
    const recoveredBackfill = selectRecoverableBackgroundBackfill({
      embeddingSetId: context.collection.id,
      inFlightBackfills,
    });
    const canReusePreviousBackfill =
      previousTrackedBackfill !== null &&
      recoveredBackfill !== null &&
      previousTrackedBackfill.embeddingSetId === context.collection.id &&
      previousTrackedBackfill.rootPath === context.rootPath &&
      previousTrackedBackfill.requestId === recoveredBackfill.requestId;

    await this.cancelSupersededTrackedBackfill({
      canReusePreviousBackfill,
      previousTrackedBackfill,
    });
    await this.cancelHostBackgroundBackfills({
      inFlightBackfills,
      ...(recoveredBackfill ? { exceptEmbeddingSetId: context.collection.id } : {}),
    });
    if (this.isCancelled(currentRunId)) {
      this.deps.onDebugStage?.('sync:cancelled-before-scanning', { runId: currentRunId });
      return;
    }

    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.deps.onDebugStage?.('sync:set-scanning-status', { runId: currentRunId });
    this.setScanningStatus(context, null, { resetProgress: true });

    try {
      await this.runSyncPass({
        abortSignal: abortController.signal,
        context,
        request,
        runId: currentRunId,
      });
    } catch (error) {
      if (this.isCancelled(currentRunId) || isAbortError(error)) {
        return;
      }
      this.handleSyncFailure({
        collection: context.collection,
        error,
        rootPath: context.rootPath,
      });
    } finally {
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
  }
}
