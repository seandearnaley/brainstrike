import type {
  ApplyManagedCacheBatchArgs,
  ChunkingStrategy,
  DbHandle,
  EmbeddingSet,
  FileImportResult,
  IEmbeddingSetsRepository,
  IFileRecordRepository,
  ImportProgress,
  ManagedCacheBatchMutation,
  ManagedCacheEntryMetadata,
} from '@brainstrike/db';
import {
  createFileContentProcessor,
  type FileContentProcessor,
  type FileContentRequest,
} from '@brainstrike/file-explorer-hooks';
import { readFullTreeWithOptions } from '@brainstrike/file-explorer-ui/tree';
import {
  backfillEmbeddingSetAssignments,
  type ChunkingWorkerPort,
  type EnhancedImportProgress,
  type FileImportChunkRepository,
  type FileImportFileRecordRepository,
  runEnhancedImport,
} from '@brainstrike/file-import';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import {
  type EmbeddingProviderType,
  isLocalProviderType,
  parseEmbeddingProviderModelKey,
} from '@brainstrike/indexing-contract';
import type {
  WorkspaceCollectionSyncChunkingProgress,
  WorkspaceCollectionSyncEmbeddingProgress,
  WorkspaceCollectionSyncImportProgress,
  WorkspaceCollectionSyncQueueProgress,
  WorkspaceCollectionSyncScanSummary,
  WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import type { IFileNode } from '@brainstrike/types';
import {
  type BackgroundIndexingPolicyPreset,
  createBackgroundIndexingEntryPolicy,
  generateContentHash,
} from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import {
  buildRootFolderCacheIdentityKey,
  validateRootFolderCacheRequest,
} from './root-folder-cache-reconciliation';

const logger = createLogger('WorkspaceCollectionSyncService');

const FILE_CONTENT_BATCH_SIZE = 24;
const IMPORT_BATCH_SIZE = 24;
const PROCESSOR_CONCURRENCY = 4;
const SCANNING_STATUS_THROTTLE_MS = 100;
const DEFAULT_BACKFILL_DRAIN_TIMEOUT_MS = 10 * 60 * 1000;
const BACKFILL_DRAIN_POLL_BASE_MS = 250;
const BACKFILL_DRAIN_POLL_MAX_MS = 2000;

interface RootDirectoryHandle {
  _internal?: unknown;
  kind: 'directory';
  name: string;
  path: string;
  platform: 'electron' | 'web';
}

interface RootFolderCacheMutableRecord {
  content: string;
  contentHash: string;
  id: string;
  name: string;
  path: string;
  processedAt: string;
  size: number;
  sourceRootPath: string;
  tokenCount: number;
  updatedAt: string;
}

type BackgroundManagedCacheBatchMutation =
  | {
      mode: 'import';
      relativePath: string;
      mutation: Extract<ManagedCacheBatchMutation, { mode: 'import' }>;
    }
  | {
      mode: 'replace';
      relativePath: string;
      mutation: Extract<ManagedCacheBatchMutation, { mode: 'replace' }>;
    };

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
  ) => Promise<{ requestId: string }>;
  ensureChunkingWorker: () => Promise<ChunkingWorkerPort>;
  ensureEmbeddingRuntimeStarted: () => Promise<void>;
  fileContentProcessor?: FileContentProcessor;
  fileRecordRepository: FileImportFileRecordRepository &
    Pick<IFileRecordRepository, 'listManagedCacheEntryMetadata'>;
  fileSystemAdapter: FileSystemAdapter;
  getBackfillsInFlight: () => Promise<
    Array<{
      embeddingSetId: string;
      progress: { current: number; total: number } | null;
      requestId: string;
    }>
  >;
  log?: typeof logger;
  onManagedCollectionMissing?: (managedCollectionId: string) => void;
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
  enabled: boolean;
  indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  managedCollectionId: string | null;
  rootDirectoryHandle: RootDirectoryHandle | null;
}

interface WorkspaceCollectionSyncProgressStatusBase {
  activeRootPath: string;
  chunkingProgress: WorkspaceCollectionSyncChunkingProgress | null;
  embeddingProgress: WorkspaceCollectionSyncEmbeddingProgress | null;
  importProgress: WorkspaceCollectionSyncImportProgress;
  lastError: string | null;
  managedCollectionId: string;
  managedCollectionName: string | null;
  queueProgress: WorkspaceCollectionSyncQueueProgress | null;
  scanSummary: WorkspaceCollectionSyncScanSummary;
}

interface PreparedCacheChange {
  compositeKey: string;
  contentHash: string;
  id: string;
  mode: 'import' | 'replace';
  name: string;
  relativePath: string;
  request: FileContentRequest;
  size: number;
  sourceRootPath: string;
}

interface ResolvedSyncContext {
  activeRootPath: string;
  collection: EmbeddingSet;
  provider: EmbeddingProviderType;
  rootPath: string;
}

interface FileBatchPreparation {
  relativePath: string;
  request: FileContentRequest;
  size: number;
}

interface PreparedChangesSummary {
  changes: PreparedCacheChange[];
  excludedEntries: number;
  totalFiles: number;
  unchangedCount: number;
}

interface DiscoveredPreparedFile {
  compositeKey: string;
  contentHash: string;
  name: string;
  relativePath: string;
  request: FileContentRequest;
  size: number;
  sourceRootPath: string;
}

interface ActiveBackfillTracking {
  embeddingSetId: string;
  requestId: string;
  rootPath: string;
  unsubscribe: (() => void) | null;
}

const INACCESSIBLE_CONTENT_PREFIXES = ['File not accessible', 'File too large:'] as const;
const INACCESSIBLE_CONTENT_VALUES = new Set([
  'Binary file - preview not available',
  'Error accessing file',
]);

function isContentAccessible(content: string): boolean {
  if (INACCESSIBLE_CONTENT_VALUES.has(content)) {
    return false;
  }
  return !INACCESSIBLE_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function flattenFileNodes(nodes: readonly IFileNode[]): IFileNode[] {
  const fileNodes: IFileNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      fileNodes.push(node);
      continue;
    }
    if (node.children && node.children.length > 0) {
      fileNodes.push(...flattenFileNodes(node.children));
    }
  }
  return fileNodes;
}

function createInitialImportProgress(total: number): ImportProgress {
  return {
    total,
    completed: 0,
    current: '',
    errors: [],
  };
}

function buildImportProgress(
  total: number,
  completed: number,
  current?: string,
  errors: ImportProgress['errors'] = []
): ImportProgress {
  return {
    total,
    completed,
    current: current ?? '',
    errors,
  };
}

// Background indexing only needs a stable approximate token count for progress
// and coarse sizing; exact tokenization is intentionally deferred.
function estimateTokenCount(content: string): number {
  return Math.ceil(content.length / 4);
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(
  signal?: AbortSignal,
  message = 'Workspace collection sync was cancelled.'
): void {
  if (signal?.aborted) {
    throw createAbortError(message);
  }
}

function createScanningStatusReporter(
  emit: (path: string | null) => void,
  throttleMs = SCANNING_STATUS_THROTTLE_MS
): {
  dispose: () => void;
  flush: (path?: string | null) => void;
  report: (path: string | null) => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingPath: string | null = null;
  let lastEmitAt = 0;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const emitNow = (path: string | null): void => {
    clearTimer();
    pendingPath = null;
    lastEmitAt = Date.now();
    emit(path);
  };

  return {
    report(path) {
      pendingPath = path;
      const now = Date.now();
      if (now - lastEmitAt >= throttleMs) {
        emitNow(path);
        return;
      }
      if (timer !== null) {
        return;
      }
      timer = setTimeout(
        () => {
          emitNow(pendingPath);
        },
        Math.max(0, throttleMs - (now - lastEmitAt))
      );
    },
    flush(path = pendingPath) {
      emitNow(path ?? null);
    },
    dispose() {
      clearTimer();
      pendingPath = null;
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError('Workspace collection sync was cancelled.'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getBackfillDrainPollDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, attempt);
  return Math.min(BACKFILL_DRAIN_POLL_MAX_MS, BACKFILL_DRAIN_POLL_BASE_MS * 2 ** safeAttempt);
}

function dispatchQueueDrainedEvent(embeddingSetId: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent('brainstrike:queue-drained', {
      detail: { embeddingSetId, queue: 'embeddings' as const },
    })
  );
}

async function toMutableRecord(
  change: PreparedCacheChange,
  content: string
): Promise<RootFolderCacheMutableRecord> {
  const now = new Date().toISOString();
  return {
    id: change.id,
    name: change.name,
    path: change.relativePath,
    size: change.size,
    sourceRootPath: change.sourceRootPath,
    updatedAt: now,
    processedAt: now,
    content,
    contentHash: await generateContentHash(content),
    tokenCount: estimateTokenCount(content),
  };
}

function mapEnhancedProgressToStatus(
  progress: EnhancedImportProgress,
  managedCollectionId: string,
  managedCollectionName: string | null,
  rootPath: string,
  summary: WorkspaceCollectionSyncScanSummary
): WorkspaceCollectionSyncStatusPatch {
  const base = buildEnhancedProgressStatusBase(
    progress,
    managedCollectionId,
    managedCollectionName,
    rootPath,
    summary
  );

  switch (progress.phase) {
    case 'complete':
      return {
        ...base,
        state: 'idle',
        pauseReasons: [],
        processedFiles: progress.total,
        queuedFiles: base.queueProgress?.pending ?? 0,
        currentFilePath: null,
      };
    case 'embedding':
      return {
        ...base,
        state: 'embedding',
        pauseReasons: [],
        processedFiles: progress.embeddingProgress?.chunksProcessed ?? progress.completed,
        queuedFiles: progress.queueProgress?.pending ?? 0,
        currentFilePath: progress.embeddingProgress?.currentChunk ?? progress.current ?? null,
      };
    case 'chunking':
      return {
        ...base,
        state: 'chunking',
        pauseReasons: [],
        processedFiles: progress.chunkingProgress?.filesProcessed ?? progress.completed,
        queuedFiles: 0,
        currentFilePath: progress.chunkingProgress?.currentFile ?? progress.current ?? null,
      };
    default:
      return {
        ...base,
        state: 'importing',
        pauseReasons: [],
        processedFiles: progress.completed,
        queuedFiles: Math.max(0, progress.total - progress.completed),
        currentFilePath: progress.current ?? null,
      };
  }
}

function buildEnhancedProgressStatusBase(
  progress: EnhancedImportProgress,
  managedCollectionId: string,
  managedCollectionName: string | null,
  rootPath: string,
  summary: WorkspaceCollectionSyncScanSummary
): WorkspaceCollectionSyncProgressStatusBase {
  return {
    activeRootPath: rootPath,
    managedCollectionId,
    managedCollectionName,
    scanSummary: summary,
    importProgress: toWorkspaceCollectionSyncImportProgress(progress),
    chunkingProgress: toWorkspaceCollectionSyncChunkingProgress(progress),
    embeddingProgress: toWorkspaceCollectionSyncEmbeddingProgress(progress),
    queueProgress: toWorkspaceCollectionSyncQueueProgress(progress),
    lastError: progress.errors[0]?.error ?? null,
  };
}

function mapBackfillProgressToStatus(args: {
  chunkingProgress: WorkspaceCollectionSyncChunkingProgress | null;
  collection: EmbeddingSet;
  current?: number;
  managedCollectionName: string | null;
  message?: string;
  requestId?: string | null;
  rootPath: string;
  scanSummary?: WorkspaceCollectionSyncScanSummary;
  state?: 'embedding' | 'recovering';
  total?: number;
}): WorkspaceCollectionSyncStatusPatch {
  const totalChunks = Math.max(0, args.total ?? 0);
  const processedChunks = Math.min(totalChunks, Math.max(0, args.current ?? 0));
  const currentMessage = args.message?.trim() ? args.message : null;

  return {
    state: args.state ?? 'embedding',
    pauseReasons: [],
    managedCollectionId: args.collection.id,
    managedCollectionName: args.managedCollectionName,
    backfillRequestId: args.requestId ?? null,
    activeRootPath: args.rootPath,
    currentFilePath: currentMessage,
    lastError: null,
    ...(args.scanSummary
      ? {
          scanSummary: args.scanSummary,
          importProgress: {
            completed: args.scanSummary.changedFiles,
            total: args.scanSummary.changedFiles,
            current: null,
            errorCount: 0,
          },
          processedFiles: args.scanSummary.discoveredFiles,
        }
      : {}),
    chunkingProgress: args.chunkingProgress,
    embeddingProgress: {
      chunksProcessed: processedChunks,
      totalChunks,
      currentChunk: currentMessage,
      modelName: args.collection.modelId,
    },
    queueProgress: {
      failed: 0,
      lastError: null,
      lastEvent: null,
      pending: Math.max(0, totalChunks - processedChunks),
      processed: processedChunks,
      totalQueued: totalChunks,
    },
    queuedFiles: Math.max(0, totalChunks - processedChunks),
  };
}

function toWorkspaceCollectionSyncImportProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncImportProgress {
  return {
    completed: progress.completed,
    total: progress.total,
    current: progress.current ?? null,
    errorCount: progress.errors.length,
  };
}

function toWorkspaceCollectionSyncChunkingProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncChunkingProgress | null {
  if (!progress.chunkingProgress) {
    return null;
  }
  return {
    filesProcessed: progress.chunkingProgress.filesProcessed,
    totalFiles: progress.chunkingProgress.totalFiles,
    currentFile: progress.chunkingProgress.currentFile ?? null,
    chunksCreated: progress.chunkingProgress.chunksCreated,
    strategyUsed: progress.chunkingProgress.strategyUsed ?? null,
  };
}

function toWorkspaceCollectionSyncEmbeddingProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncEmbeddingProgress | null {
  if (!progress.embeddingProgress) {
    return null;
  }
  return {
    chunksProcessed: progress.embeddingProgress.chunksProcessed,
    totalChunks: progress.embeddingProgress.totalChunks,
    currentChunk: progress.embeddingProgress.currentChunk ?? null,
    modelName: progress.embeddingProgress.modelName ?? null,
  };
}

function toWorkspaceCollectionSyncQueueProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncQueueProgress | null {
  if (!progress.queueProgress) {
    return null;
  }
  return {
    pending: progress.queueProgress.pending,
    processed: progress.queueProgress.processed,
    failed: progress.queueProgress.failed,
    totalQueued: progress.queueProgress.totalQueued,
    lastError: progress.queueProgress.lastError,
    lastEvent: progress.queueProgress.lastEvent ?? null,
  };
}

function buildNormalizedChunkingProgress(args: {
  batchChunking: EnhancedImportProgress['chunkingProgress'] | undefined;
  cumulativeChunksCreated: number;
  cumulativeFilesChunked: number;
  latestChunkingProgress: EnhancedImportProgress['chunkingProgress'] | null;
  latestStrategyUsed: ChunkingStrategy | null;
  totalFiles: number;
}): EnhancedImportProgress['chunkingProgress'] | undefined {
  if (args.batchChunking) {
    return {
      ...args.batchChunking,
      filesProcessed: args.cumulativeFilesChunked + args.batchChunking.filesProcessed,
      totalFiles: args.totalFiles,
      chunksCreated: args.cumulativeChunksCreated + args.batchChunking.chunksCreated,
      ...(args.batchChunking.strategyUsed
        ? { strategyUsed: args.batchChunking.strategyUsed }
        : args.latestStrategyUsed
          ? { strategyUsed: args.latestStrategyUsed }
          : {}),
    };
  }
  if (!args.latestChunkingProgress) {
    return;
  }
  return {
    ...args.latestChunkingProgress,
    filesProcessed: args.cumulativeFilesChunked,
    totalFiles: args.totalFiles,
    chunksCreated: args.cumulativeChunksCreated,
    ...(args.latestStrategyUsed ? { strategyUsed: args.latestStrategyUsed } : {}),
  };
}

function buildBatchImportErrors(
  progress: EnhancedImportProgress,
  cumulativeErrorCount: number
): EnhancedImportProgress['errors'] {
  return Array.from({ length: cumulativeErrorCount + progress.errors.length }, (_, errorIndex) => {
    const batchError = progress.errors[errorIndex - cumulativeErrorCount];
    return (
      batchError ?? {
        file: `batch:${errorIndex}`,
        error: 'Background cache import error.',
      }
    );
  });
}

async function collectDiscoveredPreparedFiles(args: {
  fileContents: Record<string, string>;
  metadataByKey: Map<string, FileBatchPreparation>;
  rootPath: string;
}): Promise<Array<DiscoveredPreparedFile | null>> {
  const discoveredFiles: Array<DiscoveredPreparedFile | null> = [];
  for (const [compositeKey, content] of Object.entries(args.fileContents)) {
    if (!isContentAccessible(content)) {
      discoveredFiles.push(null);
      continue;
    }
    const metadata = args.metadataByKey.get(compositeKey);
    if (!metadata) {
      discoveredFiles.push(null);
      continue;
    }
    discoveredFiles.push({
      compositeKey,
      contentHash: await generateContentHash(content),
      name: metadata.request.fileNode.name,
      relativePath: metadata.relativePath,
      request: metadata.request,
      size: metadata.size > 0 ? metadata.size : content.length,
      sourceRootPath: args.rootPath,
    });
  }
  return discoveredFiles;
}

function applyDiscoveredPreparedFiles(args: {
  changes: PreparedCacheChange[];
  discoveredFiles: ReadonlyArray<DiscoveredPreparedFile | null>;
  existingByIdentity: Map<string, ManagedCacheEntryMetadata>;
  unchangedCount: number;
}): number {
  let unchangedCount = args.unchangedCount;
  for (const discovered of args.discoveredFiles) {
    if (!discovered) {
      continue;
    }
    const identity = buildRootFolderCacheIdentityKey(
      discovered.sourceRootPath,
      discovered.relativePath
    );
    const existing = args.existingByIdentity.get(identity);
    if (!existing) {
      args.changes.push({
        ...discovered,
        id: crypto.randomUUID(),
        mode: 'import',
      });
      continue;
    }
    if (existing.contentHash === discovered.contentHash) {
      unchangedCount += 1;
      continue;
    }
    args.changes.push({
      ...discovered,
      id: existing.fileRecordId,
      mode: 'replace',
    });
  }
  return unchangedCount;
}

async function buildBackgroundImportBatchMutations(args: {
  batch: readonly PreparedCacheChange[];
  batchContents: Record<string, string>;
}): Promise<BackgroundManagedCacheBatchMutation[]> {
  const mutations: BackgroundManagedCacheBatchMutation[] = [];
  const batchCreatedAt = new Date().toISOString();
  for (const change of args.batch) {
    const content = args.batchContents[change.compositeKey];
    if (content === undefined) {
      continue;
    }
    const mutableRecord = await toMutableRecord(change, content);
    if (change.mode === 'replace') {
      mutations.push({
        mode: 'replace',
        relativePath: change.relativePath,
        mutation: {
          mode: 'replace',
          record: {
            ...mutableRecord,
          },
        },
      });
      continue;
    }
    mutations.push({
      mode: 'import',
      relativePath: change.relativePath,
      mutation: {
        mode: 'import',
        record: {
          ...mutableRecord,
          createdAt: batchCreatedAt,
        },
      },
    });
  }
  return mutations;
}

async function applyBackgroundImportBatch(args: {
  applyManagedCacheBatch: (args: ApplyManagedCacheBatchArgs) => Promise<void>;
  batch: readonly PreparedCacheChange[];
  batchContents: Record<string, string>;
  collectionId: string;
  waitForBackgroundPermit: (options: { readonly label: string }) => Promise<void>;
}): Promise<{
  errors: Array<{ error: string; file: string }>;
  results: FileImportResult[];
}> {
  const skippedResults: FileImportResult[] = [];
  const skippedErrors: Array<{ error: string; file: string }> = [];
  for (const change of args.batch) {
    if (args.batchContents[change.compositeKey] !== undefined) {
      continue;
    }
    const message = 'Background cache import descriptor is missing.';
    skippedErrors.push({
      file: change.relativePath,
      error: message,
    });
    skippedResults.push({
      id: change.id,
      imported: false,
      existed: false,
      error: message,
    });
  }
  const mutations = await buildBackgroundImportBatchMutations({
    batch: args.batch,
    batchContents: args.batchContents,
  });
  if (mutations.length === 0) {
    return { errors: skippedErrors, results: skippedResults };
  }

  try {
    await args.waitForBackgroundPermit({ label: 'background import batch' });
    await args.applyManagedCacheBatch({
      embeddingSetId: args.collectionId,
      changes: mutations.map((entry) => entry.mutation),
    });
    return {
      errors: skippedErrors,
      results: [
        ...skippedResults,
        ...mutations.map((entry) => ({
          id: entry.mutation.record.id,
          imported: true,
          existed: false,
        })),
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      errors: [
        ...skippedErrors,
        ...mutations.map((entry) => ({
          file: entry.relativePath,
          error: message,
        })),
      ],
      results: [
        ...skippedResults,
        ...mutations.map((entry) => ({
          id: entry.mutation.record.id,
          imported: false,
          existed: false,
          error: message,
        })),
      ],
    };
  }
}

function buildBatchedEnhancedImportProgress(args: {
  cumulativeChunksCreated: number;
  cumulativeCompleted: number;
  cumulativeErrorCount: number;
  cumulativeFilesChunked: number;
  latestChunkingProgress: EnhancedImportProgress['chunkingProgress'] | null;
  latestStrategyUsed: ChunkingStrategy | null;
  progress: EnhancedImportProgress;
  totalFiles: number;
}): EnhancedImportProgress {
  return {
    ...args.progress,
    completed: args.cumulativeCompleted + args.progress.completed,
    total: args.totalFiles,
    errors: buildBatchImportErrors(args.progress, args.cumulativeErrorCount),
    ...(() => {
      const chunkingProgress = buildNormalizedChunkingProgress({
        batchChunking: args.progress.chunkingProgress,
        cumulativeChunksCreated: args.cumulativeChunksCreated,
        cumulativeFilesChunked: args.cumulativeFilesChunked,
        latestChunkingProgress: args.latestChunkingProgress,
        latestStrategyUsed: args.latestStrategyUsed,
        totalFiles: args.totalFiles,
      });
      return chunkingProgress ? { chunkingProgress } : {};
    })(),
  };
}

function createFileBatchPreparations(
  fileNodes: readonly IFileNode[],
  fileSystemAdapter: FileSystemAdapter,
  rootPath: string
): FileBatchPreparation[] {
  return fileNodes.map((node) => {
    const relativePath = normalizeSelectionPathForFolder(node.path, rootPath, {
      label: 'Background cache file path',
    });
    const compositeKey = encodeFileSelection(rootPath, relativePath);
    return {
      request: {
        compositeKey,
        fileNode: node,
        fileSystemAdapter,
      },
      relativePath,
      size: node.size ?? 0,
    };
  });
}

async function collectPreparedChangesInBatches(args: {
  abortSignal: AbortSignal;
  existingEntries: readonly ManagedCacheEntryMetadata[];
  fileContentProcessor?: FileContentProcessor;
  fileNodes: readonly IFileNode[];
  fileSystemAdapter: FileSystemAdapter;
  onCurrentFile: (path: string | null) => void;
  rootPath: string;
}): Promise<PreparedChangesSummary> {
  const {
    abortSignal,
    existingEntries,
    fileContentProcessor,
    fileNodes,
    fileSystemAdapter,
    onCurrentFile,
    rootPath,
  } = args;
  const processor =
    fileContentProcessor ??
    createFileContentProcessor(fileSystemAdapter, {
      concurrency: PROCESSOR_CONCURRENCY,
    });
  const preparations = createFileBatchPreparations(fileNodes, fileSystemAdapter, rootPath);
  const existingByIdentity = new Map(
    existingEntries.map((entry) => [
      buildRootFolderCacheIdentityKey(entry.sourceRootPath, entry.relativePath),
      entry,
    ])
  );
  const changes: PreparedCacheChange[] = [];
  let unchangedCount = 0;

  for (let index = 0; index < preparations.length; index += FILE_CONTENT_BATCH_SIZE) {
    throwIfAborted(abortSignal);
    const batch = preparations.slice(index, index + FILE_CONTENT_BATCH_SIZE);
    const metadataByKey = new Map(
      batch.map((entry) => [entry.request.compositeKey, entry] as const)
    );
    const fileContents = await processor.processFiles(
      batch.map((entry) => entry.request),
      ({ key }) => {
        onCurrentFile(metadataByKey.get(key)?.relativePath ?? null);
      },
      { abortSignal }
    );
    throwIfAborted(abortSignal);

    const discoveredFiles = await collectDiscoveredPreparedFiles({
      fileContents,
      metadataByKey,
      rootPath,
    });
    throwIfAborted(abortSignal);
    unchangedCount = applyDiscoveredPreparedFiles({
      changes,
      discoveredFiles,
      existingByIdentity,
      unchangedCount,
    });
  }

  return {
    changes,
    excludedEntries: 0,
    totalFiles: fileNodes.length,
    unchangedCount,
  };
}

async function runRootFolderCacheImport(args: {
  applyManagedCacheBatch: (args: ApplyManagedCacheBatchArgs) => Promise<void>;
  abortSignal: AbortSignal;
  changes: readonly PreparedCacheChange[];
  chunkRepository: FileImportChunkRepository & {
    deleteByFileRecordId: (fileRecordId: string) => Promise<unknown>;
  };
  chunkingWorkerPort: ChunkingWorkerPort;
  collection: EmbeddingSet;
  db: DbHandle;
  fileContentProcessor?: FileContentProcessor;
  fileRecordRepository: FileImportFileRecordRepository;
  onProgress: (progress: EnhancedImportProgress) => void;
  setImporting: (importing: boolean) => void;
  waitForBackgroundPermit: (options: { readonly label: string }) => Promise<void>;
}): Promise<void> {
  const {
    applyManagedCacheBatch,
    abortSignal,
    changes,
    chunkRepository,
    chunkingWorkerPort,
    collection,
    db,
    fileContentProcessor,
    fileRecordRepository,
    onProgress,
    setImporting,
    waitForBackgroundPermit,
  } = args;

  if (changes.length === 0) {
    return;
  }

  throwIfAborted(abortSignal, 'Background cache import was cancelled.');
  const firstChange = changes[0];
  if (!firstChange) {
    return;
  }
  const embeddingConfig = {
    enabled: false,
    service: null,
    chunkRepository,
    resolveTargetEmbeddingSetId: () => collection.id,
  };
  const processor =
    fileContentProcessor ??
    createFileContentProcessor(firstChange.request.fileSystemAdapter, {
      concurrency: PROCESSOR_CONCURRENCY,
    });
  let cumulativeCompleted = 0;
  let cumulativeErrorCount = 0;
  let cumulativeChunksCreated = 0;
  let cumulativeFilesChunked = 0;
  let latestStrategyUsed: ChunkingStrategy | null = null;
  let latestChunkingProgress: EnhancedImportProgress['chunkingProgress'] | null = null;

  setImporting(true);
  try {
    for (let index = 0; index < changes.length; index += IMPORT_BATCH_SIZE) {
      throwIfAborted(abortSignal, 'Background cache import was cancelled.');
      const batch = changes.slice(index, index + IMPORT_BATCH_SIZE);
      const batchMetadataByKey = new Map(
        batch.map(
          (change) =>
            [
              change.compositeKey,
              {
                relativePath: change.relativePath,
                request: change.request,
              },
            ] as const
        )
      );
      const batchContents = await processor.processFiles(
        batch
          .map((change) => batchMetadataByKey.get(change.compositeKey)?.request)
          .filter((request): request is FileContentRequest => request !== undefined),
        ({ key }) => {
          onProgress({
            phase: 'importing',
            completed: cumulativeCompleted,
            total: changes.length,
            current: batchMetadataByKey.get(key)?.relativePath ?? null,
            errors: [],
          } as EnhancedImportProgress);
        },
        { abortSignal }
      );
      throwIfAborted(abortSignal, 'Background cache import was cancelled.');

      const fileContents = Object.fromEntries(
        batch
          .map((change) => {
            const content = batchContents[change.compositeKey];
            return content !== undefined && isContentAccessible(content)
              ? ([change.compositeKey, content] as const)
              : null;
          })
          .filter((entry): entry is readonly [string, string] => entry !== null)
      );
      const selectedFilePaths = new Set(Object.keys(fileContents));
      const batchResults = await runEnhancedImport<IFileNode>({
        abortSignal,
        request: {
          selectedFilePaths,
          fileTree: [],
          fileContents,
        },
        baseImportRunner: async ({
          selectedFilePaths: selectedKeys,
          onProgress: emitImportProgress,
        }: {
          fileContents: Record<string, string>;
          fileTree: IFileNode[];
          onProgress: (progress: ImportProgress) => void;
          selectedFilePaths: Set<string>;
        }): Promise<FileImportResult[]> => {
          const results: FileImportResult[] = [];
          const total = batch.length;
          const errors: ImportProgress['errors'] = [];

          let completed = 0;
          emitImportProgress(createInitialImportProgress(total));
          if (selectedKeys.size > 0) {
            const selectedBatch = batch.filter((change) => selectedKeys.has(change.compositeKey));
            const selectedBatchById = new Map(
              selectedBatch.map((change) => [change.id, change] as const)
            );
            throwIfAborted(abortSignal, 'Background cache import was cancelled.');
            const batchOutcome = await applyBackgroundImportBatch({
              applyManagedCacheBatch,
              batch: selectedBatch,
              batchContents: fileContents,
              collectionId: collection.id,
              waitForBackgroundPermit,
            });
            errors.push(...batchOutcome.errors);
            for (const result of batchOutcome.results) {
              results.push(result);
              completed += 1;
              const matchingChange = selectedBatchById.get(result.id);
              emitImportProgress(
                buildImportProgress(total, completed, matchingChange?.relativePath, errors)
              );
            }
          }

          for (const change of batch) {
            if (!selectedKeys.has(change.compositeKey)) {
              const content = batchContents[change.compositeKey];
              const message =
                content === undefined ? 'Background cache import descriptor is missing.' : content;
              errors.push({
                file: change.relativePath,
                error: message,
              });
              results.push({
                id: change.id,
                imported: false,
                existed: false,
                error: message,
              });
              completed += 1;
              emitImportProgress(
                buildImportProgress(total, completed, change.relativePath, errors)
              );
            }
          }

          return results;
        },
        chunking: {
          enabled: true,
          deps: {
            repository: fileRecordRepository,
            chunkRepository,
          },
          chunkingWorkerPort,
        },
        embedding: embeddingConfig,
        progressHandlers: {
          emit: (progress) => {
            const batchChunking = progress.chunkingProgress;
            latestChunkingProgress = batchChunking ?? latestChunkingProgress;
            if (batchChunking?.strategyUsed) {
              latestStrategyUsed = batchChunking.strategyUsed;
            }
            onProgress(
              buildBatchedEnhancedImportProgress({
                cumulativeChunksCreated,
                cumulativeCompleted,
                cumulativeErrorCount,
                cumulativeFilesChunked,
                latestChunkingProgress,
                latestStrategyUsed,
                progress,
                totalFiles: changes.length,
              })
            );
          },
          update: () => null,
        },
      });
      await waitForBackgroundPermit({ label: 'background import assignment' });
      await backfillEmbeddingSetAssignments(
        { query: db.query.bind(db) },
        collection.id,
        batchResults.filter((result) => result.imported).map((result) => result.id)
      );
      cumulativeCompleted += batch.length;
      cumulativeErrorCount += batchResults.filter((result) => !result.imported).length;
      const finalChunkingProgress = latestChunkingProgress as NonNullable<
        EnhancedImportProgress['chunkingProgress']
      > | null;
      if (finalChunkingProgress) {
        cumulativeFilesChunked += finalChunkingProgress.filesProcessed;
        cumulativeChunksCreated += finalChunkingProgress.chunksCreated;
      }
    }
  } finally {
    setImporting(false);
  }
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

  private isBackgroundIndexingBackfillRequestId(requestId: string): boolean {
    return requestId.startsWith('background-indexing-backfill:');
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
    for (const backfill of args.inFlightBackfills) {
      if (!this.isBackgroundIndexingBackfillRequestId(backfill.requestId)) {
        continue;
      }
      if (backfill.embeddingSetId === args.exceptEmbeddingSetId) {
        continue;
      }
      await this.deps.cancelBackfill(backfill.embeddingSetId);
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

    return {
      collection,
      activeRootPath: rootPath ?? '',
      provider,
      rootPath: rootPath ?? '',
    };
  }

  private async ensureCollectionAccess(context: ResolvedSyncContext): Promise<void> {
    if (!isLocalProviderType(context.provider)) {
      await this.deps.validateHostedProviderAccess(context.collection.id);
    }
    await this.deps.ensureEmbeddingRuntimeStarted();
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

  private async collectPreparedChanges(args: {
    request: WorkspaceCollectionSyncRequest;
    context: ResolvedSyncContext;
    abortSignal: AbortSignal;
  }): Promise<PreparedChangesSummary> {
    const { request, context, abortSignal } = args;
    const entryPolicy = createBackgroundIndexingEntryPolicy({
      preset: request.indexingPolicyPreset,
    });
    const statusReporter = createScanningStatusReporter((path) => {
      this.setScanningStatus(context, path);
    });
    let excludedEntries = 0;

    try {
      const tree = await readFullTreeWithOptions(
        this.deps.fileSystemAdapter,
        request.rootDirectoryHandle as RootDirectoryHandle,
        {
          abortSignal,
          entryPolicy,
          onEntrySkipped: (entry) => {
            if (entry.reason === 'entry-policy') {
              excludedEntries += 1;
            }
          },
          updateProgress: (path?: string) => {
            statusReporter.report(path ?? null);
          },
        }
      );
      throwIfAborted(abortSignal);

      const existingEntries = await this.deps.fileRecordRepository.listManagedCacheEntryMetadata(
        context.collection.id
      );
      throwIfAborted(abortSignal);

      const prepared = await collectPreparedChangesInBatches({
        abortSignal,
        existingEntries,
        fileNodes: flattenFileNodes(tree),
        fileSystemAdapter: this.deps.fileSystemAdapter,
        onCurrentFile: (path) => {
          statusReporter.report(path);
        },
        rootPath: context.activeRootPath,
        ...(this.deps.fileContentProcessor
          ? { fileContentProcessor: this.deps.fileContentProcessor }
          : {}),
      });
      statusReporter.flush(null);
      return {
        ...prepared,
        excludedEntries,
      };
    } finally {
      statusReporter.dispose();
    }
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

  private async collectionNeedsBackfill(collectionId: string): Promise<boolean> {
    const coverage = await this.deps.chunkRepository.getCoverageForSet(collectionId);
    return coverage.totalChunks > 0 && coverage.chunksWithEmbeddingsForSet < coverage.totalChunks;
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
    rootPath: string;
    summary: Pick<
      PreparedChangesSummary,
      'changes' | 'excludedEntries' | 'totalFiles' | 'unchangedCount'
    >;
  }): Promise<void> {
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
      const { requestId } = await this.deps.enqueueBackfill(args.collection.id, {
        signal: args.abortSignal,
        source: 'background-indexing',
      });
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
    const prepared = await this.collectPreparedChanges({
      request: args.request,
      context: args.context,
      abortSignal: args.abortSignal,
    });
    this.setScanSummary(args.context, prepared);

    if (prepared.changes.length === 0) {
      if (await this.collectionNeedsBackfill(args.context.collection.id)) {
        await this.ensureCollectionAccess(args.context);
        throwIfAborted(args.abortSignal);
        await this.enqueueManagedBackfill({
          abortSignal: args.abortSignal,
          chunkingProgress: null,
          collection: args.context.collection,
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

    const inFlightBackfills = await this.deps.getBackfillsInFlight();
    const recoveredBackfill = inFlightBackfills.find(
      (backfill) =>
        backfill.embeddingSetId === context.collection.id &&
        this.isBackgroundIndexingBackfillRequestId(backfill.requestId)
    );
    const canReusePreviousBackfill =
      previousTrackedBackfill !== null &&
      recoveredBackfill !== undefined &&
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
