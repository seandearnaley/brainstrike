import type {
  DbHandle,
  EmbeddingSet,
  FileChunk,
  FileImportResult,
  FileRecord,
  IEmbeddingSetsRepository,
  IFileRecordRepository,
  ImportProgress,
} from '@brainstrike/db';
import { isLocalProviderType, parseProviderModelKey } from '@brainstrike/embeddings/provider-core';
import {
  createFileContentProcessor,
  type FileContentRequest,
} from '@brainstrike/file-explorer-hooks';
import { readFullTree } from '@brainstrike/file-explorer-ui';
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
  planRootFolderCacheReconciliation,
  validateRootFolderCacheRequest,
} from './root-folder-cache-reconciliation';

const logger = createLogger('WorkspaceCollectionSyncService');

const PROCESSOR_CONCURRENCY = 4;

interface RootDirectoryHandle {
  _internal?: unknown;
  kind: 'directory';
  name: string;
  path: string;
  platform: 'electron' | 'web';
}

interface FileDescriptor {
  compositeKey: string;
  content: string;
  name: string;
  node: IFileNode;
  relativePath: string;
  size: number;
  sourceRootPath: string;
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
  fileContentProcessor?: ReturnType<typeof createFileContentProcessor>;
  fileRecordRepository: Pick<
    IFileRecordRepository,
    'createWithContent' | 'listManagedCacheEntries' | 'update'
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
  rootPath: string;
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

async function prepareFileDescriptors(
  fileNodes: readonly IFileNode[],
  fileSystemAdapter: FileSystemAdapter,
  rootPath: string,
  onCurrentFile: (path: string | null) => void
): Promise<FileDescriptor[]> {
  const processor = createFileContentProcessor(fileSystemAdapter, {
    concurrency: PROCESSOR_CONCURRENCY,
  });
  const requests: FileContentRequest[] = [];
  const metadataByKey = new Map<
    string,
    {
      name: string;
      node: IFileNode;
      relativePath: string;
      size: number;
      sourceRootPath: string;
    }
  >();

  for (const node of fileNodes) {
    const relativePath = normalizeSelectionPathForFolder(node.path, rootPath, {
      label: 'Background cache file path',
    });
    const compositeKey = encodeFileSelection(rootPath, relativePath);
    requests.push({
      compositeKey,
      fileNode: node,
      fileSystemAdapter,
    });
    metadataByKey.set(compositeKey, {
      node,
      relativePath,
      name: node.name,
      size: node.size ?? 0,
      sourceRootPath: rootPath,
    });
  }

  const fileContents = await processor.processFiles(requests, ({ key }) => {
    const metadata = metadataByKey.get(key);
    onCurrentFile(metadata?.relativePath ?? null);
  });

  const descriptors: FileDescriptor[] = [];
  for (const [compositeKey, content] of Object.entries(fileContents)) {
    if (!isContentAccessible(content)) {
      continue;
    }
    const metadata = metadataByKey.get(compositeKey);
    if (!metadata) {
      continue;
    }
    descriptors.push({
      compositeKey,
      content,
      name: metadata.name,
      node: metadata.node,
      relativePath: metadata.relativePath,
      size: metadata.size > 0 ? metadata.size : content.length,
      sourceRootPath: metadata.sourceRootPath,
    });
  }

  return descriptors;
}

async function buildPreparedChanges(
  descriptors: readonly FileDescriptor[],
  existingRecords: FileRecord[]
): Promise<{
  unchangedCount: number;
  changes: PreparedCacheChange[];
}> {
  const discoveredFiles = await Promise.all(
    descriptors.map(async (descriptor) => ({
      sourceRootPath: descriptor.sourceRootPath,
      relativePath: descriptor.relativePath,
      contentHash: await generateContentHash(descriptor.content),
      size: descriptor.size,
      name: descriptor.name,
    }))
  );

  const plan = planRootFolderCacheReconciliation({
    discoveredFiles,
    existingFiles: existingRecords
      .filter((record): record is typeof record & { contentHash: string; embeddingSetId: string } =>
        Boolean(record.contentHash && record.embeddingSetId && record.sourceRootPath)
      )
      .map((record) => ({
        fileRecordId: record.id,
        embeddingSetId: record.embeddingSetId,
        sourceRootPath: record.sourceRootPath as string,
        relativePath: record.path,
        contentHash: record.contentHash,
      })),
  });

  const discoveredByIdentity = new Map(
    descriptors.map((descriptor) => [
      `${descriptor.sourceRootPath}::${descriptor.relativePath}`,
      descriptor,
    ])
  );

  const changes: PreparedCacheChange[] = [];

  for (const entry of plan.toImport) {
    const descriptor = discoveredByIdentity.get(`${entry.sourceRootPath}::${entry.relativePath}`);
    if (!descriptor) {
      continue;
    }
    changes.push({
      compositeKey: descriptor.compositeKey,
      content: descriptor.content,
      contentHash: entry.contentHash,
      id: crypto.randomUUID(),
      mode: 'import',
      name: descriptor.name,
      relativePath: descriptor.relativePath,
      size: descriptor.size,
      sourceRootPath: descriptor.sourceRootPath,
    });
  }

  for (const entry of plan.toReplace) {
    const descriptor = discoveredByIdentity.get(`${entry.sourceRootPath}::${entry.relativePath}`);
    if (!descriptor) {
      continue;
    }
    changes.push({
      compositeKey: descriptor.compositeKey,
      content: descriptor.content,
      contentHash: entry.nextContentHash,
      id: entry.existingFileRecordId,
      mode: 'replace',
      name: descriptor.name,
      relativePath: descriptor.relativePath,
      size: descriptor.size,
      sourceRootPath: descriptor.sourceRootPath,
    });
  }

  return {
    unchangedCount: plan.unchanged.length,
    changes,
  };
}

async function runRootFolderCacheImport(args: {
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
  fileRecordRepository: Pick<
    IFileRecordRepository,
    'createWithContent' | 'listManagedCacheEntries' | 'update'
  >;
  loadEmbeddingQueue: () => Promise<QueueAdapter>;
  onProgress: (progress: EnhancedImportProgress) => void;
  setImporting: (importing: boolean) => void;
  embeddingDeviceHint: EmbeddingDeviceHint;
}): Promise<void> {
  const {
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
          await chunkRepository.deleteByFileRecordId(change.id);
          await fileRecordRepository.update(change.id, {
            ...toMutableRecord(change),
            embeddingSetId: collection.id,
          });
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
  private runId = 0;

  constructor(private readonly deps: WorkspaceCollectionSyncServiceDependencies) {}

  cancel(): void {
    this.runId += 1;
  }

  private isCancelled(runId: number): boolean {
    return runId !== this.runId;
  }

  private createAbortIfCancelled(runId: number): () => void {
    return () => {
      if (this.isCancelled(runId)) {
        throw new Error('Workspace collection sync was cancelled.');
      }
    };
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

    if (isLocalProviderType(provider)) {
      await this.deps.validateLocalRuntime(collection);
    } else {
      await this.deps.validateHostedProviderAccess(collection.id);
    }

    return {
      collection,
      activeRootPath: rootPath ?? '',
      rootPath: rootPath ?? '',
    };
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
    abortIfCancelled: () => void;
  }): Promise<{ changes: PreparedCacheChange[]; unchangedCount: number }> {
    const { request, context, abortIfCancelled } = args;
    const tree = await readFullTree(
      this.deps.fileSystemAdapter,
      request.rootDirectoryHandle as RootDirectoryHandle,
      request.rootDirectoryHandle as RootDirectoryHandle,
      '',
      true,
      undefined,
      (path?: string) => {
        this.setScanningStatus(context, path ?? null);
      }
    );
    abortIfCancelled();

    const fileNodes = flattenFileNodes(tree);
    const descriptors = await prepareFileDescriptors(
      fileNodes,
      this.deps.fileSystemAdapter,
      context.activeRootPath,
      (path) => this.setScanningStatus(context, path)
    );
    abortIfCancelled();

    const existingRecords = await this.deps.fileRecordRepository.listManagedCacheEntries(
      context.collection.id
    );
    const prepared = await buildPreparedChanges(descriptors, existingRecords);
    abortIfCancelled();
    return prepared;
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
    const currentRunId = ++this.runId;
    const abortIfCancelled = this.createAbortIfCancelled(currentRunId);

    if (!request.enabled) {
      this.setDisabledStatus(request);
      return;
    }

    const context = await this.resolveContext(request);
    if (!context) {
      return;
    }
    this.setScanningStatus(context, null);

    try {
      const prepared = await this.collectPreparedChanges({
        request,
        context,
        abortIfCancelled,
      });

      if (prepared.changes.length === 0) {
        this.setIdleStatus({
          collection: context.collection,
          processedFiles: prepared.unchangedCount,
          rootPath: context.rootPath,
        });
        return;
      }

      if (!this.deps.chunkingWorkerPort) {
        throw new Error('Chunking worker is unavailable.');
      }

      this.setImportingStatus(context, prepared.changes.length);

      await runRootFolderCacheImport({
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
      abortIfCancelled();

      this.setIdleStatus({
        collection: context.collection,
        processedFiles: prepared.changes.length + prepared.unchangedCount,
        rootPath: context.rootPath,
      });
    } catch (error) {
      if (this.isCancelled(currentRunId)) {
        return;
      }
      this.handleSyncFailure({
        collection: context.collection,
        error,
        rootPath: context.rootPath,
      });
    }
  }
}
