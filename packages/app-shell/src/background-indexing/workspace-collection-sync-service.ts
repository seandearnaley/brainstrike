import type {
  ApplyManagedCacheBatchArgs,
  ApplyManagedCacheInvalidationsArgs,
  DbHandle,
  EmbeddingSet,
  IEmbeddingSetsRepository,
  IFileRecordRepository,
  ManagedCacheInvalidationResult,
} from '@brainstrike/db';
import type { FileContentProcessor } from '@brainstrike/file-explorer-hooks';
import type {
  ChunkingWorkerPort,
  EnhancedImportProgress,
  FileImportChunkRepository,
  FileImportFileRecordRepository,
} from '@brainstrike/file-import';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import {
  type EmbeddingProviderType,
  isLocalProviderType,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import {
  getSupersededBackgroundBackfillIds,
  needsEmbeddingBackfill,
  selectRecoverableBackgroundBackfill,
} from '@brainstrike/pipeline';
import type {
  WorkspaceCollectionSyncChunkingProgress,
  WorkspaceCollectionSyncScanSummary,
  WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import type { FileSystemChange } from '@brainstrike/types';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import type { WorkspaceIndexingQosPolicy } from '@brainstrike/utils/workspace-indexing-qos';
import { validateRootFolderCacheRequest } from './root-folder-cache-reconciliation';
import {
  type PreparedChangesSummary,
  runRootFolderCacheImport,
} from './workspace-collection-sync-import';
import {
  createAbortError,
  dispatchQueueDrainedEvent,
  getBackfillDrainPollDelayMs,
  isAbortError,
  mapBackfillProgressToStatus,
  mapEnhancedProgressToStatus,
  throwIfAborted,
  toWorkspaceCollectionSyncChunkingProgress,
  toWorkspaceCollectionSyncImportProgress,
  waitForAbortableDelay,
} from './workspace-collection-sync-progress';
import {
  collectPreparedWorkspaceSyncChanges,
  type PreparedSyncChanges,
} from './workspace-collection-sync-scan';
import { isWorkspaceIndexBlockedError } from './workspace-index-blocked-error';

const logger = createLogger('WorkspaceCollectionSyncService');

const DEFAULT_BACKFILL_DRAIN_TIMEOUT_MS = 10 * 60 * 1000;
const QOS_RETRY_LABELS = {
  backfill: 'Workspace Index backfill',
  import: 'Workspace Index import',
  scan: 'Workspace Index scan',
} as const;

type WorkspaceIndexingQosPhase = keyof typeof QOS_RETRY_LABELS;

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
  backfillDrainTimeoutMs?: number;
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
  onManagedCollectionMissing?: (managedCollectionId: string) => void;
  /**
   * Maps a root directory path to the canonical DB root id from the `roots`
   * table, awaiting the reconciliation result. Returns `null` if the path is
   * not mapped (logs once per path). ALWAYS settles — never hangs.
   */
  resolveDbRootId: (rootPath: string, adapterRootId?: string | null) => Promise<string | null>;
  resolveQosPolicy: () => Promise<WorkspaceIndexingQosPolicy> | WorkspaceIndexingQosPolicy;
  setImporting: (importing: boolean) => void;
  setStatus: (progress: WorkspaceCollectionSyncStatusPatch) => void;
  subscribeToBackfillProgress: (
    callback: (progress: {
      current: number;
      embeddingSetId: string;
      message?: string;
      requestId: string;
      total: number;
    }) => void
  ) => () => void;
  validateHostedProviderAccess: (embeddingSetId: string) => Promise<void>;
  waitForBackgroundPermit: (options: { readonly label: string }) => Promise<void>;
}

export interface WorkspaceCollectionSyncRequest {
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

export class WorkspaceCollectionSyncService {
  private activeBackfill: ActiveBackfillTracking | null = null;
  private currentAbortController: AbortController | null = null;
  private runId = 0;

  constructor(private readonly deps: WorkspaceCollectionSyncServiceDependencies) {}

  async cancel(): Promise<void> {
    this.runId += 1;
    await this.resetActiveWork({ cancelTrackedBackfill: true });
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

  private setDisabledStatus(request: WorkspaceCollectionSyncRequest): void {
    this.deps.setStatus({
      state: 'disabled',
      managedCollectionId: request.managedCollectionId,
      managedCollectionName: null,
      activeRootPath: request.rootDirectoryHandle?.path ?? null,
      ...this.createClearedProgressState(),
    });
  }

  private createScanSummary(
    prepared: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'unchangedCount'
    >
  ): WorkspaceCollectionSyncScanSummary {
    return {
      discoveredFiles: prepared.totalFiles,
      changedFiles: prepared.changes.length,
      excludedEntries: prepared.excludedEntries,
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
        requestId: trackedBackfill.requestId,
        error: error instanceof Error ? error.message : String(error),
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
      state: 'error',
      blockedReason: null,
      managedCollectionId: args.managedCollectionId,
      managedCollectionName: args.managedCollectionName,
      activeRootPath: args.activeRootPath,
      lastError: args.message,
      pauseReasons: [],
    });
  }

  private trackBackfill(args: {
    collection: EmbeddingSet;
    managedCollectionName: string | null;
    requestId: string;
    rootPath: string;
    scanSummary?: WorkspaceCollectionSyncScanSummary;
    state: 'embedding' | 'recovering';
    chunkingProgress: WorkspaceCollectionSyncChunkingProgress | null;
  }): void {
    this.activeBackfill?.unsubscribe?.();
    const unsubscribe = this.deps.subscribeToBackfillProgress((progress) => {
      if (progress.embeddingSetId !== args.collection.id || progress.requestId !== args.requestId) {
        return;
      }
      this.deps.setStatus(
        mapBackfillProgressToStatus({
          collection: args.collection,
          managedCollectionName: args.managedCollectionName,
          rootPath: args.rootPath,
          chunkingProgress: args.chunkingProgress,
          current: progress.current,
          total: progress.total,
          requestId: progress.requestId,
          state: args.state,
          ...(args.scanSummary ? { scanSummary: args.scanSummary } : {}),
          ...(progress.message ? { message: progress.message } : {}),
        })
      );
    });
    this.activeBackfill = {
      embeddingSetId: args.collection.id,
      requestId: args.requestId,
      rootPath: args.rootPath,
      unsubscribe,
    };
  }

  private async cancelSupersededBackgroundBackfills(args: {
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

  private async waitForBackfillToDrain(args: {
    abortSignal: AbortSignal;
    collectionId: string;
    requestId: string;
  }): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = this.deps.backfillDrainTimeoutMs ?? DEFAULT_BACKFILL_DRAIN_TIMEOUT_MS;
    let attempt = 0;
    while (true) {
      throwIfAborted(args.abortSignal);
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Timed out waiting for background indexing backfill to drain for collection ${args.collectionId}.`
        );
      }
      const inFlight = await this.deps.getBackfillsInFlight();
      const matching = inFlight.find(
        (backfill) =>
          backfill.embeddingSetId === args.collectionId && backfill.requestId === args.requestId
      );
      if (!matching) {
        return;
      }
      await waitForAbortableDelay(getBackfillDrainPollDelayMs(attempt), args.abortSignal);
      attempt += 1;
    }
  }

  private setRecoveringStatus(args: {
    collection: EmbeddingSet;
    rootPath: string;
    requestId: string;
  }): void {
    this.deps.setStatus({
      state: 'recovering',
      managedCollectionId: args.collection.id,
      managedCollectionName: args.collection.name ?? null,
      activeRootPath: args.rootPath,
      backfillRequestId: args.requestId,
      currentFilePath: null,
      lastError: null,
      pauseReasons: [],
    });
  }

  private async resolveContext(
    request: WorkspaceCollectionSyncRequest
  ): Promise<ResolvedSyncContext | null> {
    const rootPath = request.rootDirectoryHandle?.path ?? null;
    const validation = validateRootFolderCacheRequest({
      managedCollectionId: request.managedCollectionId,
      rootPath,
      dbReady: Boolean(this.deps.db),
    });

    if (!validation.ok) {
      this.setErrorStatus({
        activeRootPath: rootPath,
        managedCollectionId: request.managedCollectionId,
        managedCollectionName: null,
        message: validation.reason,
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
    const dbRootId =
      request.dbRootId === undefined
        ? rootPath
          ? await this.deps.resolveDbRootId(rootPath, request.rootDirectoryHandle?.rootId)
          : null
        : request.dbRootId;
    return {
      collection,
      activeRootPath: rootPath ?? '',
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
      state: 'scanning',
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      activeRootPath: context.rootPath,
      currentFilePath,
      lastError: null,
      pauseReasons: [],
      ...(options?.resetProgress ? this.createClearedProgressState() : {}),
    });
  }

  private setQosWaitingStatus(context: ResolvedSyncContext): void {
    this.deps.setStatus({
      state: 'waiting',
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      activeRootPath: context.rootPath,
      currentFilePath: null,
      lastError: null,
      pauseReasons: [],
    });
  }

  private async resolveQosPolicyForNewWork(args: {
    abortSignal: AbortSignal;
    context: ResolvedSyncContext;
    phase: WorkspaceIndexingQosPhase;
  }): Promise<WorkspaceIndexingQosPolicy> {
    let qosPolicy = await this.deps.resolveQosPolicy();
    while (!qosPolicy.allowNewWork && qosPolicy.state === 'foreground-yielding') {
      throwIfAborted(args.abortSignal);
      this.setQosWaitingStatus(args.context);
      await this.deps.waitForBackgroundPermit({
        label: QOS_RETRY_LABELS[args.phase],
      });
      throwIfAborted(args.abortSignal);
      await waitForAbortableDelay(Math.max(1, qosPolicy.interBatchDelayMs), args.abortSignal);
      throwIfAborted(args.abortSignal);
      qosPolicy = await this.deps.resolveQosPolicy();
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
        fileRecordRepository: this.deps.fileRecordRepository,
        fileSystemAdapter: this.deps.fileSystemAdapter,
        onScanningPath: (path) => {
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
      'changes' | 'excludedEntries' | 'totalFiles' | 'unchangedCount'
    >
  ): void {
    this.deps.setStatus({
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      activeRootPath: context.rootPath,
      scanSummary: this.createScanSummary(prepared),
      processedFiles: prepared.unchangedCount,
      queuedFiles: prepared.changes.length,
      lastError: null,
      pauseReasons: [],
    });
  }

  private setIdleStatus(args: {
    collection: EmbeddingSet;
    rootPath: string;
    summary?: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'unchangedCount'
    >;
  }): void {
    this.deps.setStatus({
      state: 'idle',
      managedCollectionId: args.collection.id,
      managedCollectionName: args.collection.name ?? null,
      activeRootPath: args.rootPath,
      currentFilePath: null,
      backfillRequestId: null,
      lastError: null,
      pauseReasons: [],
      ...(args.summary
        ? {
            scanSummary: this.createScanSummary(args.summary),
            processedFiles: args.summary.totalFiles,
            queuedFiles: 0,
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
      'changes' | 'excludedEntries' | 'totalFiles' | 'unchangedCount'
    >;
  }): void {
    this.deps.setStatus({
      state: 'embedding',
      managedCollectionId: args.collection.id,
      managedCollectionName: args.collection.name ?? null,
      activeRootPath: args.rootPath,
      backfillRequestId: args.backfillRequestId,
      currentFilePath: null,
      scanSummary: this.createScanSummary(args.summary),
      chunkingProgress: args.chunkingProgress,
      embeddingProgress: null,
      queueProgress: null,
      lastError: null,
      pauseReasons: [],
      processedFiles: args.summary.totalFiles,
      queuedFiles: 0,
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
      'changes' | 'excludedEntries' | 'totalFiles' | 'unchangedCount'
    >;
  }): Promise<void> {
    if (!args.qosPolicy.allowNewWork) {
      throw createAbortError('Workspace Index QoS policy does not permit backfill enqueue work.');
    }
    const pendingRequestId = `pending:${args.collection.id}:${Date.now()}`;
    let resolvedRequestId = pendingRequestId;
    let unsubscribeBackfillProgress: (() => void) | null = null;

    unsubscribeBackfillProgress = this.deps.subscribeToBackfillProgress((progress) => {
      if (progress.embeddingSetId !== args.collection.id) {
        return;
      }
      resolvedRequestId = progress.requestId;
      this.activeBackfill = {
        embeddingSetId: args.collection.id,
        requestId: progress.requestId,
        rootPath: args.rootPath,
        unsubscribe: unsubscribeBackfillProgress,
      };
      this.deps.setStatus(
        mapBackfillProgressToStatus({
          collection: args.collection,
          managedCollectionName: args.collection.name ?? null,
          rootPath: args.rootPath,
          scanSummary: this.createScanSummary(args.summary),
          chunkingProgress: args.chunkingProgress,
          current: progress.current,
          total: progress.total,
          requestId: progress.requestId,
          state: 'embedding',
          ...(progress.message ? { message: progress.message } : {}),
        })
      );
    });
    this.activeBackfill = {
      embeddingSetId: args.collection.id,
      requestId: pendingRequestId,
      rootPath: args.rootPath,
      unsubscribe: unsubscribeBackfillProgress,
    };

    try {
      const enqueueResult = await this.deps.enqueueBackfill(args.collection.id, {
        signal: args.abortSignal,
        source: 'background-indexing',
      });
      if ('canceled' in enqueueResult) {
        // Desktop main now resolves a benign { canceled: true } for a deliberate
        // cancellation instead of rejecting the IPC call. Re-raise it locally as an
        // abort so the existing upstream cancellation handling (isAbortError →
        // benign, never handleSyncFailure) is byte-identical to the prior
        // reject-on-cancel behavior; only the spurious main-process handler-error
        // log is gone.
        throw createAbortError('Embedding backfill was canceled before it started.');
      }
      const { requestId } = enqueueResult;
      resolvedRequestId = requestId;
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
      await this.waitForBackfillToDrain({
        abortSignal: args.abortSignal,
        collectionId: args.collection.id,
        requestId,
      });
      dispatchQueueDrainedEvent(args.collection.id);
      throwIfAborted(args.abortSignal);
    } finally {
      if (
        this.activeBackfill?.requestId === resolvedRequestId ||
        resolvedRequestId === pendingRequestId
      ) {
        this.activeBackfill?.unsubscribe?.();
        this.activeBackfill = null;
      }
    }
  }

  private setImportingStatus(
    context: ResolvedSyncContext,
    summary: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'unchangedCount'
    >
  ): void {
    this.deps.setStatus({
      state: 'importing',
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      activeRootPath: context.rootPath,
      currentFilePath: null,
      backfillRequestId: null,
      scanSummary: this.createScanSummary(summary),
      importProgress: {
        completed: 0,
        total: summary.changes.length,
        current: null,
        errorCount: 0,
      },
      chunkingProgress: null,
      embeddingProgress: null,
      queueProgress: null,
      queuedFiles: summary.changes.length,
      processedFiles: summary.unchangedCount,
      lastError: null,
      pauseReasons: [],
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
        state: 'blocked',
        managedCollectionId: args.collection.id,
        managedCollectionName: args.collection.name ?? null,
        activeRootPath: args.rootPath,
        ...this.createClearedProgressState(),
        blockedReason: args.error.blockedReason,
        lastError: message,
      });
      return;
    }

    this.deps.log?.error('Workspace collection sync failed', {
      error: message,
      managedCollectionId: args.collection.id,
      rootPath: args.rootPath,
    });
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
      await this.cancelTrackedBackfill(args.previousTrackedBackfill);
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

  private async handleRecoveredSync(args: {
    abortController: AbortController;
    context: ResolvedSyncContext;
    currentRunId: number;
    recoveredBackfill: {
      embeddingSetId: string;
      progress: { current: number; total: number } | null;
      requestId: string;
    };
    request: WorkspaceCollectionSyncRequest;
  }): Promise<boolean> {
    const { abortController, context, currentRunId, recoveredBackfill, request } = args;
    const { signal } = abortController;
    try {
      await this.recoverInFlightBackfill({
        abortSignal: signal,
        backfill: recoveredBackfill,
        context,
      });
      if (!(this.isCancelled(currentRunId) || signal.aborted)) {
        this.setScanningStatus(context, null, { resetProgress: false });
        await this.runSyncPass({
          abortSignal: signal,
          context,
          request,
          runId: currentRunId,
        });
      }
    } catch (error) {
      if (this.isCancelled(currentRunId) || isAbortError(error)) {
        return true;
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
    return true;
  }

  private async recoverInFlightBackfill(args: {
    abortSignal: AbortSignal;
    backfill: {
      embeddingSetId: string;
      progress: { current: number; total: number } | null;
      requestId: string;
    };
    context: ResolvedSyncContext;
  }): Promise<void> {
    this.setRecoveringStatus({
      collection: args.context.collection,
      rootPath: args.context.rootPath,
      requestId: args.backfill.requestId,
    });
    this.trackBackfill({
      collection: args.context.collection,
      managedCollectionName: args.context.collection.name ?? null,
      requestId: args.backfill.requestId,
      rootPath: args.context.rootPath,
      state: 'recovering',
      chunkingProgress: null,
    });
    await this.waitForBackfillToDrain({
      abortSignal: args.abortSignal,
      collectionId: args.context.collection.id,
      requestId: args.backfill.requestId,
    });
    this.activeBackfill?.unsubscribe?.();
    this.activeBackfill = null;
    dispatchQueueDrainedEvent(args.context.collection.id);
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
      request: args.request,
      context: args.context,
      abortSignal: args.abortSignal,
      qosPolicy: scanQosPolicy,
    });
    const { invalidationTargets, prepared } = syncChanges;
    this.setScanSummary(args.context, prepared);
    if (invalidationTargets.length > 0) {
      await this.deps.invalidateManagedCacheEntriesByIdentity({
        embeddingSetId: args.context.collection.id,
        targets: invalidationTargets,
      });
      throwIfAborted(args.abortSignal);
    }
    await this.persistStatRefreshes(prepared.statRefreshes);

    if (prepared.changes.length === 0) {
      if (await this.collectionNeedsBackfill(args.context.collection.id)) {
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
          summary: prepared,
        });
        if (this.isCancelled(args.runId) || args.abortSignal.aborted) {
          return;
        }
      }
      this.setIdleStatus({
        collection: args.context.collection,
        rootPath: args.context.rootPath,
        summary: prepared,
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
    let sawCompleteProgress = false;
    let latestImportProgress: EnhancedImportProgress | null = null;

    await runRootFolderCacheImport({
      applyManagedCacheBatch: this.deps.applyManagedCacheBatch,
      abortSignal: args.abortSignal,
      changes: prepared.changes,
      chunkRepository: this.deps.chunkRepository,
      chunkingWorkerPort,
      collection: args.context.collection,
      db: this.deps.db,
      ...(this.deps.fileContentProcessor
        ? { fileContentProcessor: this.deps.fileContentProcessor }
        : {}),
      fileRecordRepository: this.deps.fileRecordRepository,
      rootId: args.context.dbRootId,
      onProgress: (progress) => {
        latestImportProgress = progress;
        if (progress.phase === 'complete') {
          sawCompleteProgress = true;
        }
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
      qosPolicy: importQosPolicy,
      setImporting: this.deps.setImporting,
      waitForBackgroundPermit: this.deps.waitForBackgroundPermit,
    });
    throwIfAborted(args.abortSignal);

    const chunkingProgress = latestImportProgress
      ? toWorkspaceCollectionSyncChunkingProgress(latestImportProgress)
      : null;
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
    if (this.isCancelled(args.runId) || args.abortSignal.aborted) {
      return;
    }

    this.setIdleStatus({
      collection: args.context.collection,
      rootPath: args.context.rootPath,
      summary: prepared,
    });
    if (!sawCompleteProgress && latestImportProgress) {
      this.deps.setStatus({
        chunkingProgress: toWorkspaceCollectionSyncChunkingProgress(latestImportProgress),
        importProgress: toWorkspaceCollectionSyncImportProgress(latestImportProgress),
        scanSummary,
      });
    }
  }

  async sync(request: WorkspaceCollectionSyncRequest): Promise<void> {
    const currentRunId = ++this.runId;
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
    if (!context) {
      return;
    }

    try {
      await this.ensureProviderAccess(context);
    } catch (error) {
      if (this.isCancelled(currentRunId) || isAbortError(error)) {
        return;
      }
      this.handleSyncFailure({
        collection: context.collection,
        error,
        rootPath: context.rootPath,
      });
      return;
    }
    if (this.isCancelled(currentRunId)) {
      return;
    }

    const inFlightBackfills = await this.deps.getBackfillsInFlight();
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
    await this.cancelSupersededBackgroundBackfills({
      inFlightBackfills,
      ...(recoveredBackfill ? { exceptEmbeddingSetId: context.collection.id } : {}),
    });
    if (this.isCancelled(currentRunId)) {
      return;
    }

    const abortController = new AbortController();
    this.currentAbortController = abortController;
    if (recoveredBackfill) {
      await this.handleRecoveredSync({
        abortController,
        context,
        currentRunId,
        recoveredBackfill,
        request,
      });
      return;
    }

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
