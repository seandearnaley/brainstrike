import type {
  ApplyManagedCacheBatchArgs,
  ChunkingStrategy,
  DbHandle,
  EmbeddingSet,
  FileImportResult,
  ImportProgress,
  ManagedCacheBatchMutation,
  ManagedCacheEntryMetadata,
} from '@brainstrike/db';
import {
  createFileContentProcessor,
  type FileContentProcessor,
  type FileContentRequest,
} from '@brainstrike/file-explorer-hooks';
import {
  backfillEmbeddingSetAssignments,
  type ChunkingWorkerPort,
  type EnhancedImportProgress,
  type FileImportChunkRepository,
  type FileImportFileRecordRepository,
  runEnhancedImport,
} from '@brainstrike/file-import';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { generateContentHash } from '@brainstrike/utils';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import type { WorkspaceIndexingQosPolicy } from '@brainstrike/utils/workspace-indexing-qos';
import { buildRootFolderCacheIdentityKey } from './root-folder-cache-reconciliation';
import {
  buildBatchImportErrors,
  buildNormalizedChunkingProgress,
  throwIfAborted,
} from './workspace-collection-sync-progress';

type WorkspaceIndexingImportQosPolicy = Pick<
  WorkspaceIndexingQosPolicy,
  'allowNewWork' | 'contentReadBatchSize' | 'contentReadConcurrency' | 'importBatchSize'
>;

function assertPositiveQosCapacity(value: number, label: string): void {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(`Workspace Index QoS ${label} must be a positive integer.`);
  }
}

interface RootFolderCacheMutableRecord {
  content: string;
  contentHash: string;
  id: string;
  mtimeMs: number | null;
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

export interface PreparedCacheChange {
  compositeKey: string;
  contentHash: string;
  id: string;
  mode: 'import' | 'replace';
  mtimeMs: number | null;
  name: string;
  relativePath: string;
  request: FileContentRequest;
  size: number;
  sourceRootPath: string;
}

interface FileBatchPreparation {
  mtimeMs: number | null;
  relativePath: string;
  request: FileContentRequest;
  size: number;
}

export interface PreparedChangesSummary {
  changes: PreparedCacheChange[];
  excludedEntries: number;
  totalFiles: number;
  unchangedCount: number;
}

interface DiscoveredPreparedFile {
  compositeKey: string;
  contentHash: string;
  mtimeMs: number | null;
  name: string;
  relativePath: string;
  request: FileContentRequest;
  size: number;
  sourceRootPath: string;
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

export function flattenFileNodes(nodes: readonly IFileNode[]): IFileNode[] {
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

async function toMutableRecord(
  change: PreparedCacheChange,
  content: string
): Promise<RootFolderCacheMutableRecord> {
  const now = new Date().toISOString();
  return {
    id: change.id,
    mtimeMs: change.mtimeMs,
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
      mtimeMs: metadata.mtimeMs,
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
      mtimeMs: typeof node.lastModified === 'number' ? node.lastModified : null,
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

/**
 * Stat-cache fast-path for change detection: partition prepared files into those
 * that can be skipped (size AND mtime both match the stored entry, so the content
 * is unchanged) and those that must be read + hashed.
 *
 * This is the git/rsync-style optimization that avoids reading and SHA-256-hashing
 * every file on every sync. It is deliberately conservative — a skip requires BOTH
 * stored stats present (size + non-null mtimeMs; mtimeMs is null for rows written
 * before the mtime column existed) AND the scan to have captured the file's mtime.
 * Any gap or mismatch falls through to the existing read+hash path, so a stale
 * stat can only ever cost an extra read, never a missed real change — except the
 * well-known stat-cache residual (same byte size + preserved mtime + different
 * content), which self-heals the next time the file's mtime changes.
 */
export function partitionPreparationsByStatCache<
  T extends { mtimeMs: number | null; relativePath: string; size: number },
>(args: {
  existingByIdentity: ReadonlyMap<string, ManagedCacheEntryMetadata>;
  preparations: readonly T[];
  rootPath: string;
}): { needsRead: T[]; skippedUnchanged: T[] } {
  const needsRead: T[] = [];
  const skippedUnchanged: T[] = [];
  for (const preparation of args.preparations) {
    const existing = args.existingByIdentity.get(
      buildRootFolderCacheIdentityKey(args.rootPath, preparation.relativePath)
    );
    if (isStatCacheHit(preparation, existing)) {
      skippedUnchanged.push(preparation);
      continue;
    }
    needsRead.push(preparation);
  }
  return { needsRead, skippedUnchanged };
}

function isStatCacheHit(
  preparation: { mtimeMs: number | null; size: number },
  existing: ManagedCacheEntryMetadata | undefined
): boolean {
  if (!existing) {
    return false;
  }
  if (typeof existing.size !== 'number' || typeof existing.mtimeMs !== 'number') {
    return false;
  }
  if (preparation.mtimeMs === null) {
    return false;
  }
  return existing.size === preparation.size && existing.mtimeMs === preparation.mtimeMs;
}

export async function collectPreparedChangesInBatches(args: {
  abortSignal: AbortSignal;
  existingEntries: readonly ManagedCacheEntryMetadata[];
  fileContentProcessor?: FileContentProcessor;
  fileNodes: readonly IFileNode[];
  fileSystemAdapter: FileSystemAdapter;
  onCurrentFile: (path: string | null) => void;
  qosPolicy: WorkspaceIndexingImportQosPolicy;
  rootPath: string;
}): Promise<PreparedChangesSummary> {
  const {
    abortSignal,
    existingEntries,
    fileContentProcessor,
    fileNodes,
    fileSystemAdapter,
    onCurrentFile,
    qosPolicy,
    rootPath,
  } = args;
  if (!qosPolicy.allowNewWork) {
    throw new Error('Workspace Index QoS policy does not permit scan work.');
  }
  assertPositiveQosCapacity(qosPolicy.contentReadBatchSize, 'contentReadBatchSize');
  assertPositiveQosCapacity(qosPolicy.contentReadConcurrency, 'contentReadConcurrency');
  const processor =
    fileContentProcessor ??
    createFileContentProcessor(fileSystemAdapter, {
      concurrency: qosPolicy.contentReadConcurrency,
    });
  const allPreparations = createFileBatchPreparations(fileNodes, fileSystemAdapter, rootPath);
  const existingByIdentity = new Map(
    existingEntries.map((entry) => [
      buildRootFolderCacheIdentityKey(entry.sourceRootPath, entry.relativePath),
      entry,
    ])
  );
  // Stat-cache fast-path: drop files whose size+mtime already match the stored
  // entry before any content read, so unchanged files cost a stat lookup instead
  // of a full read + SHA-256 hash. Skipped files count as unchanged directly.
  const { needsRead: preparations, skippedUnchanged } = partitionPreparationsByStatCache({
    existingByIdentity,
    preparations: allPreparations,
    rootPath,
  });
  const changes: PreparedCacheChange[] = [];
  let unchangedCount = skippedUnchanged.length;

  for (let index = 0; index < preparations.length; index += qosPolicy.contentReadBatchSize) {
    throwIfAborted(abortSignal);
    const batch = preparations.slice(index, index + qosPolicy.contentReadBatchSize);
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

export async function runRootFolderCacheImport(args: {
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
  qosPolicy: WorkspaceIndexingImportQosPolicy;
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
    qosPolicy,
    setImporting,
    waitForBackgroundPermit,
  } = args;

  if (changes.length === 0) {
    return;
  }
  if (!qosPolicy.allowNewWork) {
    throw new Error('Workspace Index QoS policy does not permit import work.');
  }
  assertPositiveQosCapacity(qosPolicy.contentReadConcurrency, 'contentReadConcurrency');
  assertPositiveQosCapacity(qosPolicy.importBatchSize, 'importBatchSize');

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
      concurrency: qosPolicy.contentReadConcurrency,
    });
  let cumulativeCompleted = 0;
  let cumulativeErrorCount = 0;
  let cumulativeChunksCreated = 0;
  let cumulativeFilesChunked = 0;
  let latestStrategyUsed: ChunkingStrategy | null = null;
  let latestChunkingProgress: EnhancedImportProgress['chunkingProgress'] | null = null;

  setImporting(true);
  try {
    for (let index = 0; index < changes.length; index += qosPolicy.importBatchSize) {
      throwIfAborted(abortSignal, 'Background cache import was cancelled.');
      const batch = changes.slice(index, index + qosPolicy.importBatchSize);
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
