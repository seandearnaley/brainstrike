import type {
  DbHandle,
  EmbeddingSet,
  FileImportResult,
  IEmbeddingSetsRepository,
  IFileRecordRepository,
  ImportProgress,
  ManagedCacheEntryMetadata,
} from '@brainstrike/db';
import { isLocalProviderType, parseProviderModelKey } from '@brainstrike/embeddings/provider-core';
import {
  createFileContentProcessor,
  type FileContentProcessor,
  type FileContentRequest,
} from '@brainstrike/file-explorer-hooks';
import { readFullTreeWithOptions } from '@brainstrike/file-explorer-ui';
import {
  backfillEmbeddingSetAssignments,
  type ChunkingWorkerPort,
  type EnhancedImportProgress,
  runEnhancedImport,
} from '@brainstrike/file-import';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import {
  type BackgroundIndexingPolicyPreset,
  createBackgroundIndexingEntryPolicy,
  generateContentHash,
} from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import {
  buildRootFolderCacheIdentityKey,
  validateRootFolderCacheRequest,
} from './root-folder-cache-reconciliation';

const logger = createLogger('WorkspaceCollectionSyncService');

const FILE_CONTENT_BATCH_SIZE = 24;
const PROCESSOR_CONCURRENCY = 4;
const SCANNING_STATUS_THROTTLE_MS = 100;

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

export interface WorkspaceCollectionSyncServiceDependencies {
  chunkRepository: {
    deleteByFileRecordId: (fileRecordId: string) => Promise<unknown>;
  };
  db: DbHandle;
  embeddingSetsRepository: IEmbeddingSetsRepository;
  enqueueBackfill: (
    embeddingSetId: string,
    onProgress: (progress: { current: number; message?: string; total: number }) => void
  ) => Promise<void>;
  ensureChunkingWorker: () => Promise<ChunkingWorkerPort>;
  ensureEmbeddingRuntimeStarted: () => Promise<void>;
  fileContentProcessor?: FileContentProcessor;
  fileRecordRepository: Pick<
    IFileRecordRepository,
    'createWithContent' | 'listManagedCacheEntryMetadata' | 'update'
  >;
  fileSystemAdapter: FileSystemAdapter;
  log?: typeof logger;
  setImporting: (importing: boolean) => void;
  setStatus: (progress: WorkspaceCollectionSyncProgressUpdate) => void;
  validateHostedProviderAccess: (embeddingSetId: string) => Promise<void>;
}

export interface WorkspaceCollectionSyncRequest {
  enabled: boolean;
  indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  managedCollectionId: string | null;
  rootDirectoryHandle: RootDirectoryHandle | null;
}

export type WorkspaceCollectionSyncState =
  | 'disabled'
  | 'idle'
  | 'scanning'
  | 'importing'
  | 'chunking'
  | 'embedding'
  | 'error';

interface WorkspaceCollectionSyncScanSummary {
  changedFiles: number;
  discoveredFiles: number;
  excludedEntries: number;
  unchangedFiles: number;
}

type WorkspaceCollectionSyncChunkingProgress = NonNullable<
  NonNullable<WorkspaceCollectionSyncProgressUpdate['chunkingProgress']>
>;
type WorkspaceCollectionSyncEmbeddingProgress = NonNullable<
  NonNullable<WorkspaceCollectionSyncProgressUpdate['embeddingProgress']>
>;
type WorkspaceCollectionSyncImportProgress = NonNullable<
  NonNullable<WorkspaceCollectionSyncProgressUpdate['importProgress']>
>;
type WorkspaceCollectionSyncQueueProgress = NonNullable<
  NonNullable<WorkspaceCollectionSyncProgressUpdate['queueProgress']>
>;

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

export interface WorkspaceCollectionSyncProgressUpdate {
  activeRootPath?: string | null;
  chunkingProgress?: {
    chunksCreated: number;
    currentFile: string | null;
    filesProcessed: number;
    strategyUsed: string | null;
    totalFiles: number;
  } | null;
  currentFilePath?: string | null;
  embeddingProgress?: {
    chunksProcessed: number;
    currentChunk: string | null;
    modelName: string | null;
    totalChunks: number;
  } | null;
  importProgress?: {
    completed: number;
    current: string | null;
    errorCount: number;
    total: number;
  } | null;
  lastError?: string | null;
  managedCollectionId?: string | null;
  managedCollectionName?: string | null;
  processedFiles?: number;
  queuedFiles?: number;
  queueProgress?: {
    failed: number;
    lastError: string | null;
    lastEvent: {
      chunkId: string;
      elapsedMs?: number;
      errorMessage?: string;
      model: string;
      status: 'queued' | 'completed' | 'error';
    } | null;
    pending: number;
    processed: number;
    totalQueued: number;
  } | null;
  scanSummary?: WorkspaceCollectionSyncScanSummary | null;
  state?: WorkspaceCollectionSyncState;
}

interface PreparedCacheChange {
  compositeKey: string;
  content: string;
  contentHash: string;
  id: string;
  mode: 'import' | 'replace';
  name: string;
  relativePath: string;
  size: number;
  sourceRootPath: string;
}

interface ResolvedSyncContext {
  activeRootPath: string;
  collection: EmbeddingSet;
  provider: NonNullable<ReturnType<typeof parseProviderModelKey>>['provider'];
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

function isContentAccessible(content: string): boolean {
  return !(
    content.startsWith('Error accessing file') ||
    content.includes('Binary file') ||
    content.includes('not accessible') ||
    content.includes('File too large')
  );
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

function toMutableRecord(change: PreparedCacheChange): RootFolderCacheMutableRecord {
  const now = new Date().toISOString();
  return {
    id: change.id,
    name: change.name,
    path: change.relativePath,
    size: change.size,
    sourceRootPath: change.sourceRootPath,
    updatedAt: now,
    processedAt: now,
    content: change.content,
    contentHash: change.contentHash,
    tokenCount: estimateTokenCount(change.content),
  };
}

function mapEnhancedProgressToStatus(
  progress: EnhancedImportProgress,
  managedCollectionId: string,
  managedCollectionName: string | null,
  rootPath: string,
  summary: WorkspaceCollectionSyncScanSummary
): WorkspaceCollectionSyncProgressUpdate {
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
        processedFiles: progress.total,
        queuedFiles: base.queueProgress?.pending ?? 0,
        currentFilePath: null,
      };
    case 'embedding':
      return {
        ...base,
        state: 'embedding',
        processedFiles: progress.embeddingProgress?.chunksProcessed ?? progress.completed,
        queuedFiles: progress.queueProgress?.pending ?? 0,
        currentFilePath: progress.embeddingProgress?.currentChunk ?? progress.current ?? null,
      };
    case 'chunking':
      return {
        ...base,
        state: 'chunking',
        processedFiles: progress.chunkingProgress?.filesProcessed ?? progress.completed,
        queuedFiles: 0,
        currentFilePath: progress.chunkingProgress?.currentFile ?? progress.current ?? null,
      };
    default:
      return {
        ...base,
        state: 'importing',
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
  rootPath: string;
  scanSummary: WorkspaceCollectionSyncScanSummary;
  total?: number;
}): WorkspaceCollectionSyncProgressUpdate {
  const totalChunks = Math.max(0, args.total ?? 0);
  const processedChunks = Math.min(totalChunks, Math.max(0, args.current ?? 0));
  const currentMessage = args.message?.trim() ? args.message : null;

  return {
    state: 'embedding',
    managedCollectionId: args.collection.id,
    managedCollectionName: args.managedCollectionName,
    activeRootPath: args.rootPath,
    currentFilePath: currentMessage,
    lastError: null,
    scanSummary: args.scanSummary,
    importProgress: {
      completed: args.scanSummary.changedFiles,
      total: args.scanSummary.changedFiles,
      current: null,
      errorCount: 0,
    },
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
    processedFiles: args.scanSummary.discoveredFiles,
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

    const discoveredFiles = await Promise.all(
      Object.entries(fileContents).map(async ([compositeKey, content]) => {
        if (!isContentAccessible(content)) {
          return null;
        }
        const metadata = metadataByKey.get(compositeKey);
        if (!metadata) {
          return null;
        }
        return {
          compositeKey,
          content,
          contentHash: await generateContentHash(content),
          name: metadata.request.fileNode.name,
          relativePath: metadata.relativePath,
          size: metadata.size > 0 ? metadata.size : content.length,
          sourceRootPath: rootPath,
        };
      })
    );
    throwIfAborted(abortSignal);

    for (const discovered of discoveredFiles) {
      if (!discovered) {
        continue;
      }
      const identity = buildRootFolderCacheIdentityKey(
        discovered.sourceRootPath,
        discovered.relativePath
      );
      const existing = existingByIdentity.get(identity);
      if (!existing) {
        changes.push({
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
      changes.push({
        ...discovered,
        id: existing.fileRecordId,
        mode: 'replace',
      });
    }
  }

  return {
    changes,
    excludedEntries: 0,
    totalFiles: fileNodes.length,
    unchangedCount,
  };
}

async function runRootFolderCacheImport(args: {
  abortSignal: AbortSignal;
  changes: readonly PreparedCacheChange[];
  chunkRepository: {
    deleteByFileRecordId: (fileRecordId: string) => Promise<unknown>;
  };
  chunkingWorkerPort: ChunkingWorkerPort;
  collection: EmbeddingSet;
  db: DbHandle;
  fileRecordRepository: Pick<IFileRecordRepository, 'createWithContent' | 'update'>;
  onProgress: (progress: EnhancedImportProgress) => void;
  setImporting: (importing: boolean) => void;
}): Promise<void> {
  const {
    abortSignal,
    changes,
    chunkRepository,
    chunkingWorkerPort,
    collection,
    db,
    fileRecordRepository,
    onProgress,
    setImporting,
  } = args;

  if (changes.length === 0) {
    return;
  }

  throwIfAborted(abortSignal, 'Background cache import was cancelled.');
  const selectedFilePaths = new Set(changes.map((change) => change.compositeKey));
  const fileContents = Object.fromEntries(
    changes.map((change) => [change.compositeKey, change.content] as const)
  );

  let latestProgress: EnhancedImportProgress | null = null;
  const embeddingConfig = {
    enabled: false,
    service: null,
    chunkRepository: chunkRepository as never,
    resolveTargetEmbeddingSetId: () => collection.id,
  };

  const baseImportRunner = async ({
    selectedFilePaths: selectedKeys,
    onProgress,
  }: {
    fileContents: Record<string, string>;
    fileTree: IFileNode[];
    onProgress: (progress: ImportProgress) => void;
    selectedFilePaths: Set<string>;
  }): Promise<FileImportResult[]> => {
    const changeByKey = new Map(changes.map((change) => [change.compositeKey, change]));
    const results: FileImportResult[] = [];
    const total = selectedKeys.size;
    const errors: ImportProgress['errors'] = [];

    onProgress(createInitialImportProgress(total));

    let completed = 0;
    for (const compositeKey of selectedKeys) {
      throwIfAborted(abortSignal, 'Background cache import was cancelled.');
      const change = changeByKey.get(compositeKey);
      if (!change) {
        errors.push({
          file: compositeKey,
          error: 'Background cache import descriptor is missing.',
        });
        completed += 1;
        onProgress(buildImportProgress(total, completed, compositeKey, errors));
        continue;
      }

      try {
        if (change.mode === 'replace') {
          const replacementRecordUpdate = {
            ...toMutableRecord(change),
            chunksCount: 0,
            chunksProcessedAt: undefined,
            chunkingStrategy: undefined,
            embeddingSetId: collection.id,
          } as unknown as Parameters<typeof fileRecordRepository.update>[1];
          await chunkRepository.deleteByFileRecordId(change.id);
          await fileRecordRepository.update(change.id, replacementRecordUpdate);
        } else {
          await fileRecordRepository.createWithContent({
            ...toMutableRecord(change),
            createdAt: new Date().toISOString(),
            embeddingSetId: collection.id,
          });
        }

        results.push({
          id: change.id,
          imported: true,
          existed: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
      }

      completed += 1;
      const { path } = decodeFileSelection(compositeKey);
      onProgress(buildImportProgress(total, completed, path, errors));
    }

    return results;
  };

  setImporting(true);
  try {
    const results = await runEnhancedImport<IFileNode>({
      abortSignal,
      request: {
        selectedFilePaths,
        fileTree: [],
        fileContents,
      },
      baseImportRunner,
      chunking: {
        enabled: true,
        deps: {
          repository: fileRecordRepository as never,
          chunkRepository: chunkRepository as never,
        },
        chunkingWorkerPort: chunkingWorkerPort as never,
      },
      embedding: embeddingConfig,
      progressHandlers: {
        emit: onProgress,
        update: (updater) => {
          const next = updater(latestProgress);
          if (next) {
            latestProgress = next;
            onProgress(next);
          }
        },
      },
    });
    await backfillEmbeddingSetAssignments(
      { query: db.query.bind(db) },
      collection.id,
      results.map((result) => result.id)
    );
  } finally {
    setImporting(false);
  }
}

export class WorkspaceCollectionSyncService {
  private currentAbortController: AbortController | null = null;
  private runId = 0;

  constructor(private readonly deps: WorkspaceCollectionSyncServiceDependencies) {}

  cancel(): void {
    this.currentAbortController?.abort();
    this.currentAbortController = null;
    this.runId += 1;
  }

  private isCancelled(runId: number): boolean {
    return runId !== this.runId;
  }

  private createClearedProgressState(): Pick<
    WorkspaceCollectionSyncProgressUpdate,
    | 'chunkingProgress'
    | 'currentFilePath'
    | 'embeddingProgress'
    | 'importProgress'
    | 'lastError'
    | 'processedFiles'
    | 'queuedFiles'
    | 'queueProgress'
    | 'scanSummary'
  > {
    return {
      currentFilePath: null,
      scanSummary: null,
      importProgress: null,
      chunkingProgress: null,
      embeddingProgress: null,
      queueProgress: null,
      queuedFiles: 0,
      processedFiles: 0,
      lastError: null,
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
      collectionModelKey: request.managedCollectionId ? '' : null,
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

    const collection = request.managedCollectionId
      ? await this.deps.embeddingSetsRepository.getById(request.managedCollectionId)
      : null;
    if (!(collection?.modelKey && collection.modelId && collection.dimensions > 0)) {
      this.setErrorStatus({
        activeRootPath: rootPath,
        managedCollectionId: request.managedCollectionId,
        managedCollectionName: collection?.name ?? null,
        message: 'Managed collection metadata is invalid.',
      });
      return null;
    }

    const provider = parseProviderModelKey(collection.modelKey)?.provider ?? null;
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
      scanSummary: {
        discoveredFiles: prepared.totalFiles,
        changedFiles: prepared.changes.length,
        excludedEntries: prepared.excludedEntries,
        unchangedFiles: prepared.unchangedCount,
      },
      processedFiles: prepared.unchangedCount,
      queuedFiles: prepared.changes.length,
      lastError: null,
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
      lastError: null,
      ...(args.summary
        ? {
            scanSummary: {
              discoveredFiles: args.summary.totalFiles,
              changedFiles: args.summary.changes.length,
              excludedEntries: args.summary.excludedEntries,
              unchangedFiles: args.summary.unchangedCount,
            },
            processedFiles: args.summary.totalFiles,
            queuedFiles: 0,
          }
        : {
            queuedFiles: 0,
          }),
    });
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
      scanSummary: {
        discoveredFiles: summary.totalFiles,
        changedFiles: summary.changes.length,
        excludedEntries: summary.excludedEntries,
        unchangedFiles: summary.unchangedCount,
      },
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

  async sync(request: WorkspaceCollectionSyncRequest): Promise<void> {
    this.currentAbortController?.abort();
    this.currentAbortController = null;
    const currentRunId = ++this.runId;

    if (!request.enabled) {
      this.setDisabledStatus(request);
      return;
    }

    const context = await this.resolveContext(request);
    if (!context) {
      return;
    }
    if (this.isCancelled(currentRunId)) {
      return;
    }
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    const { signal } = abortController;
    this.setScanningStatus(context, null, { resetProgress: true });

    try {
      const prepared = await this.collectPreparedChanges({
        request,
        context,
        abortSignal: signal,
      });
      this.setScanSummary(context, prepared);

      if (prepared.changes.length === 0) {
        this.setIdleStatus({
          collection: context.collection,
          rootPath: context.rootPath,
          summary: prepared,
        });
        return;
      }

      await this.ensureCollectionAccess(context);
      throwIfAborted(signal);

      const chunkingWorkerPort = await this.deps.ensureChunkingWorker();
      throwIfAborted(signal);

      this.setImportingStatus(context, prepared);
      const scanSummary: WorkspaceCollectionSyncScanSummary = {
        discoveredFiles: prepared.totalFiles,
        changedFiles: prepared.changes.length,
        excludedEntries: prepared.excludedEntries,
        unchangedFiles: prepared.unchangedCount,
      };
      let sawCompleteProgress = false;
      let latestImportProgress: EnhancedImportProgress | null = null;

      await runRootFolderCacheImport({
        abortSignal: signal,
        changes: prepared.changes,
        chunkRepository: this.deps.chunkRepository,
        chunkingWorkerPort,
        collection: context.collection,
        db: this.deps.db,
        fileRecordRepository: this.deps.fileRecordRepository,
        onProgress: (progress) => {
          latestImportProgress = progress;
          if (progress.phase === 'complete') {
            sawCompleteProgress = true;
          }
          this.deps.setStatus(
            mapEnhancedProgressToStatus(
              progress,
              context.collection.id,
              context.collection.name ?? null,
              context.rootPath,
              scanSummary
            )
          );
        },
        setImporting: this.deps.setImporting,
      });
      throwIfAborted(signal);

      const chunkingProgress = latestImportProgress
        ? toWorkspaceCollectionSyncChunkingProgress(latestImportProgress)
        : null;
      this.deps.setStatus(
        mapBackfillProgressToStatus({
          collection: context.collection,
          managedCollectionName: context.collection.name ?? null,
          rootPath: context.rootPath,
          scanSummary,
          chunkingProgress,
          current: 0,
          total: 0,
        })
      );
      await this.deps.enqueueBackfill(context.collection.id, (progress) => {
        if (this.isCancelled(currentRunId) || signal.aborted) {
          return;
        }
        this.deps.setStatus(
          mapBackfillProgressToStatus({
            collection: context.collection,
            managedCollectionName: context.collection.name ?? null,
            rootPath: context.rootPath,
            scanSummary,
            chunkingProgress,
            current: progress.current,
            total: progress.total,
            ...(progress.message ? { message: progress.message } : {}),
          })
        );
      });
      dispatchQueueDrainedEvent(context.collection.id);
      throwIfAborted(signal);

      this.setIdleStatus({
        collection: context.collection,
        rootPath: context.rootPath,
        summary: prepared,
      });
      if (!sawCompleteProgress && latestImportProgress) {
        this.deps.setStatus({
          chunkingProgress: toWorkspaceCollectionSyncChunkingProgress(latestImportProgress),
          importProgress: toWorkspaceCollectionSyncImportProgress(latestImportProgress),
          scanSummary,
        });
      }
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
