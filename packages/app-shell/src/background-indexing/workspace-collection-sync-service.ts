import type {
  DbHandle,
  EmbeddingSet,
  FileChunk,
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
  type ChunkingWorkerPort,
  createBrowserEmbeddingQueuePort,
  type EmbeddingJobQueuePort,
  type EnhancedImportProgress,
  runEnhancedImport,
} from '@brainstrike/file-import';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { EmbeddingDeviceHint, QueueAdapter } from '@brainstrike/queue';
import type { IFileNode } from '@brainstrike/types';
import { generateContentHash } from '@brainstrike/utils';
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
  chunkingWorkerPort: ChunkingWorkerPort | null;
  chunkRepository: {
    deleteByFileRecordId: (fileRecordId: string) => Promise<unknown>;
    update: (chunk: {
      id: string;
      embedding?: number[];
      embeddingHash?: string;
      embeddingSetId?: string;
      embeddingUpdatedAt?: string;
      updatedAt: string;
    }) => Promise<FileChunk | null>;
  };
  db: DbHandle;
  embeddingDeviceHint: EmbeddingDeviceHint;
  embeddingSetsRepository: IEmbeddingSetsRepository;
  fileContentProcessor?: FileContentProcessor;
  fileRecordRepository: Pick<
    IFileRecordRepository,
    'createWithContent' | 'listManagedCacheEntryMetadata' | 'update'
  >;
  fileSystemAdapter: FileSystemAdapter;
  loadEmbeddingQueue: () => Promise<QueueAdapter>;
  log?: typeof logger;
  setImporting: (importing: boolean) => void;
  setStatus: (progress: WorkspaceCollectionSyncProgressUpdate) => void;
  validateHostedProviderAccess: (embeddingSetId: string) => Promise<void>;
  validateLocalRuntime: (collection: EmbeddingSet) => Promise<void>;
}

export interface WorkspaceCollectionSyncRequest {
  enabled: boolean;
  managedCollectionId: string | null;
  rootDirectoryHandle: RootDirectoryHandle | null;
}

export type WorkspaceCollectionSyncState =
  | 'disabled'
  | 'idle'
  | 'scanning'
  | 'importing'
  | 'embedding'
  | 'error';

export interface WorkspaceCollectionSyncProgressUpdate {
  activeRootPath?: string | null;
  currentFilePath?: string | null;
  lastError?: string | null;
  managedCollectionId?: string | null;
  managedCollectionName?: string | null;
  processedFiles?: number;
  queuedFiles?: number;
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
  managedCollectionName: string | null
): WorkspaceCollectionSyncProgressUpdate {
  if (progress.phase === 'complete') {
    return {
      state: 'idle',
      managedCollectionId,
      managedCollectionName,
      processedFiles: progress.total,
      queuedFiles: 0,
      currentFilePath: null,
      lastError: progress.errors[0]?.error ?? null,
    };
  }

  if (progress.phase === 'embedding') {
    return {
      state: 'embedding',
      managedCollectionId,
      managedCollectionName,
      processedFiles: progress.embeddingProgress?.chunksProcessed ?? progress.completed,
      queuedFiles: progress.queueProgress?.pending ?? progress.total,
      currentFilePath: progress.embeddingProgress?.currentChunk ?? progress.current ?? null,
      lastError: progress.errors[0]?.error ?? null,
    };
  }

  return {
    state: 'importing',
    managedCollectionId,
    managedCollectionName,
    processedFiles: progress.chunkingProgress?.filesProcessed ?? progress.completed,
    queuedFiles: Math.max(0, progress.total - progress.completed),
    currentFilePath: progress.chunkingProgress?.currentFile ?? progress.current ?? null,
    lastError: progress.errors[0]?.error ?? null,
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
}): Promise<{ changes: PreparedCacheChange[]; unchangedCount: number }> {
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
    unchangedCount,
  };
}

async function runRootFolderCacheImport(args: {
  abortSignal: AbortSignal;
  changes: readonly PreparedCacheChange[];
  chunkRepository: {
    deleteByFileRecordId: (fileRecordId: string) => Promise<unknown>;
    update: (chunk: {
      id: string;
      embedding?: number[];
      embeddingHash?: string;
      embeddingSetId?: string;
      embeddingUpdatedAt?: string;
      updatedAt: string;
    }) => Promise<FileChunk | null>;
  };
  chunkingWorkerPort: ChunkingWorkerPort;
  collection: EmbeddingSet;
  db: DbHandle;
  fileRecordRepository: Pick<IFileRecordRepository, 'createWithContent' | 'update'>;
  loadEmbeddingQueue: () => Promise<QueueAdapter>;
  onProgress: (progress: EnhancedImportProgress) => void;
  setImporting: (importing: boolean) => void;
  embeddingDeviceHint: EmbeddingDeviceHint;
}): Promise<void> {
  const {
    abortSignal,
    changes,
    chunkRepository,
    chunkingWorkerPort,
    collection,
    db,
    fileRecordRepository,
    loadEmbeddingQueue,
    onProgress,
    setImporting,
    embeddingDeviceHint,
  } = args;

  if (changes.length === 0) {
    return;
  }

  throwIfAborted(abortSignal, 'Background cache import was cancelled.');
  const queue = await loadEmbeddingQueue();
  const queuePort: EmbeddingJobQueuePort = createBrowserEmbeddingQueuePort({
    queue,
    chunkRepository,
    deviceHint: embeddingDeviceHint,
  });
  queuePort.resetProgress?.();

  const selectedFilePaths = new Set(changes.map((change) => change.compositeKey));
  const fileContents = Object.fromEntries(
    changes.map((change) => [change.compositeKey, change.content] as const)
  );

  let latestProgress: EnhancedImportProgress | null = null;
  const embeddingProvider = parseProviderModelKey(collection.modelKey)?.provider;
  const embeddingConfig = {
    enabled: true,
    service: null,
    chunkRepository: chunkRepository as never,
    model: collection.modelId,
    resolveTargetEmbeddingSetId: () => collection.id,
    ...(embeddingProvider ? { provider: embeddingProvider } : {}),
  };
  const runInTransaction = db.transaction;
  const sqlPort = {
    query: db.query.bind(db),
    ...(runInTransaction
      ? {
          runInTransaction: async <T>(fn: (tx: DbHandle) => Promise<T>) => runInTransaction(fn),
        }
      : {}),
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
    await runEnhancedImport<IFileNode>({
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
      ports: {
        embeddingQueue: queuePort,
        sql: sqlPort,
      },
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

  private setDisabledStatus(request: WorkspaceCollectionSyncRequest): void {
    this.deps.setStatus({
      state: 'disabled',
      managedCollectionId: request.managedCollectionId,
      managedCollectionName: null,
      activeRootPath: request.rootDirectoryHandle?.path ?? null,
      currentFilePath: null,
      queuedFiles: 0,
      processedFiles: 0,
      lastError: null,
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
      currentFilePath: null,
      queuedFiles: 0,
      processedFiles: 0,
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
    if (isLocalProviderType(context.provider)) {
      await this.deps.validateLocalRuntime(context.collection);
      return;
    }
    await this.deps.validateHostedProviderAccess(context.collection.id);
  }

  private setScanningStatus(context: ResolvedSyncContext, currentFilePath: string | null): void {
    this.deps.setStatus({
      state: 'scanning',
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      activeRootPath: context.rootPath,
      currentFilePath,
      queuedFiles: 0,
      processedFiles: 0,
      lastError: null,
    });
  }

  private async collectPreparedChanges(args: {
    request: WorkspaceCollectionSyncRequest;
    context: ResolvedSyncContext;
    abortSignal: AbortSignal;
  }): Promise<{ changes: PreparedCacheChange[]; unchangedCount: number }> {
    const { request, context, abortSignal } = args;
    const statusReporter = createScanningStatusReporter((path) => {
      this.setScanningStatus(context, path);
    });

    try {
      const tree = await readFullTreeWithOptions(
        this.deps.fileSystemAdapter,
        request.rootDirectoryHandle as RootDirectoryHandle,
        {
          abortSignal,
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
      return prepared;
    } finally {
      statusReporter.dispose();
    }
  }

  private setIdleStatus(args: {
    collection: EmbeddingSet;
    processedFiles: number;
    rootPath: string;
  }): void {
    this.deps.setStatus({
      state: 'idle',
      managedCollectionId: args.collection.id,
      managedCollectionName: args.collection.name ?? null,
      activeRootPath: args.rootPath,
      currentFilePath: null,
      queuedFiles: 0,
      processedFiles: args.processedFiles,
      lastError: null,
    });
  }

  private setImportingStatus(context: ResolvedSyncContext, queuedFiles: number): void {
    this.deps.setStatus({
      state: 'importing',
      managedCollectionId: context.collection.id,
      managedCollectionName: context.collection.name ?? null,
      activeRootPath: context.rootPath,
      currentFilePath: null,
      queuedFiles,
      processedFiles: 0,
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
    this.setScanningStatus(context, null);

    try {
      const prepared = await this.collectPreparedChanges({
        request,
        context,
        abortSignal: signal,
      });

      if (prepared.changes.length === 0) {
        this.setIdleStatus({
          collection: context.collection,
          processedFiles: prepared.unchangedCount,
          rootPath: context.rootPath,
        });
        return;
      }

      await this.ensureCollectionAccess(context);
      throwIfAborted(signal);

      if (!this.deps.chunkingWorkerPort) {
        throw new Error('Chunking worker is unavailable.');
      }

      this.setImportingStatus(context, prepared.changes.length);

      await runRootFolderCacheImport({
        abortSignal: signal,
        changes: prepared.changes,
        chunkRepository: this.deps.chunkRepository,
        chunkingWorkerPort: this.deps.chunkingWorkerPort,
        collection: context.collection,
        db: this.deps.db,
        fileRecordRepository: this.deps.fileRecordRepository,
        loadEmbeddingQueue: this.deps.loadEmbeddingQueue,
        onProgress: (progress) =>
          this.deps.setStatus(
            mapEnhancedProgressToStatus(
              progress,
              context.collection.id,
              context.collection.name ?? null
            )
          ),
        setImporting: this.deps.setImporting,
        embeddingDeviceHint: this.deps.embeddingDeviceHint,
      });
      throwIfAborted(signal);

      this.setIdleStatus({
        collection: context.collection,
        processedFiles: prepared.changes.length + prepared.unchangedCount,
        rootPath: context.rootPath,
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
