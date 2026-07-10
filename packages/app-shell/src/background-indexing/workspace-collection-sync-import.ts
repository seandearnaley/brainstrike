import type {
  ApplyManagedCacheBatchArgs,
  ChunkingStrategy,
  DbHandle,
  EmbeddingSet,
  FileImportResult,
  IDatabase,
  ImportProgress,
  ManagedCacheBatchMutation,
  ManagedCacheEntryMetadata,
} from '@brainstrike/db';
import { JobQueue } from '@brainstrike/db';
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
import { createEmbeddingJobQueuePort } from '@brainstrike/pipeline';
import type { IFileNode } from '@brainstrike/types';
import { generateContentHash } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import type { WorkspaceIndexingQosPolicy } from '@brainstrike/utils/workspace-indexing-qos';
import { buildRootFolderCacheIdentityKey } from './root-folder-cache-reconciliation';
import {
  buildBatchImportErrors,
  buildNormalizedChunkingProgress,
  throwIfAborted,
} from './workspace-collection-sync-progress';

const logger = createLogger('WorkspaceCollectionSyncImport');
const TRANSACTIONAL_CHUNK_JOB_ENQUEUE_REQUIRED_ERROR =
  'Workspace Index background import requires transactional chunk/job enqueue support.';

interface FirstEmbedChunkJobEnqueueMarker {
  batchNumber: number;
  chunkCount: number;
  fileRecordId: string;
}

function hasTransactionalChunkJobEnqueueSupport(db: DbHandle): boolean {
  return (
    typeof db.transaction === 'function' ||
    typeof db.insertChunksAndEnqueueEmbeddingJobs === 'function'
  );
}

type WorkspaceIndexingImportQosPolicy = Pick<
  WorkspaceIndexingQosPolicy,
  'allowNewWork' | 'contentReadBatchSize' | 'contentReadConcurrency' | 'importBatchSize'
>;

function assertPositiveQosCapacity(value: number, label: string): void {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(`Workspace Index QoS ${label} must be a positive integer.`);
  }
}

function assertManagedCollectionModelKey(modelKey: string): void {
  if (modelKey.trim().length === 0) {
    throw new Error(
      'Workspace Index managed collection requires a model key before chunk embedding jobs can be enqueued.'
    );
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
  rootId: string;
  size: number;
}

interface FileBatchPreparation {
  mtimeMs: number | null;
  relativePath: string;
  request: FileContentRequest;
  size: number;
}

export interface StatMetadataRefresh {
  fileRecordId: string;
  mtimeMs: number;
  size: number;
}

export interface PreparedChangesSummary {
  changes: PreparedCacheChange[];
  excludedEntries: number;
  /**
   * Hash-confirmed-unchanged rows whose stored (size, mtimeMs) are missing or
   * stale. Unchanged files never take a write path, so without this stamp a
   * pre-migration row (NULL mtime_ms) would be re-read + re-hashed on EVERY
   * sync forever — persisting these lets the next sync stat-skip them.
   */
  statRefreshes: StatMetadataRefresh[];
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
  rootId: string;
  size: number;
}

const INACCESSIBLE_CONTENT_PREFIXES = ['File not accessible', 'File too large:'] as const;
const INACCESSIBLE_CONTENT_VALUES = new Set([
  'Binary file - preview not available',
  'Error accessing file',
]);
const NULL_BYTE_CONTENT_ERROR = 'File contains null bytes and cannot be indexed.';

export function getContentIndexingError(content: string): string | null {
  if (INACCESSIBLE_CONTENT_VALUES.has(content)) {
    return content;
  }
  const inaccessiblePrefix = INACCESSIBLE_CONTENT_PREFIXES.find((prefix) =>
    content.startsWith(prefix)
  );
  if (inaccessiblePrefix) {
    return content;
  }
  if (content.includes('\0')) {
    return NULL_BYTE_CONTENT_ERROR;
  }
  return null;
}

function isContentAccessible(content: string): boolean {
  return getContentIndexingError(content) === null;
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
    completed: 0,
    current: '',
    errors: [],
    total,
  };
}

function buildImportProgress(
  total: number,
  completed: number,
  current?: string,
  errors: ImportProgress['errors'] = []
): ImportProgress {
  return {
    completed,
    current: current ?? '',
    errors,
    total,
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
    content,
    contentHash: await generateContentHash(content),
    id: change.id,
    mtimeMs: change.mtimeMs,
    name: change.name,
    path: change.relativePath,
    processedAt: now,
    size: change.size,
    tokenCount: estimateTokenCount(content),
    updatedAt: now,
  };
}

async function collectDiscoveredPreparedFiles(args: {
  fileContents: Record<string, string>;
  metadataByKey: Map<string, FileBatchPreparation>;
  rootId: string;
}): Promise<{
  excludedEntries: number;
  files: Array<DiscoveredPreparedFile | null>;
}> {
  const discoveredFiles: Array<DiscoveredPreparedFile | null> = [];
  let excludedEntries = 0;
  for (const [compositeKey, content] of Object.entries(args.fileContents)) {
    const metadata = args.metadataByKey.get(compositeKey);
    if (!metadata) {
      discoveredFiles.push(null);
      continue;
    }
    const indexingError = getContentIndexingError(content);
    if (indexingError) {
      excludedEntries += 1;
      logger.debug('Workspace Index skipped file content that cannot be indexed', {
        reason: indexingError,
        relativePath: metadata.relativePath,
      });
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
      rootId: args.rootId,
      // The content.length fallback (UTF-16 code units, not bytes) deliberately
      // diverges from the scan's byte size: a file imported without a stat size
      // will mismatch the stat-cache comparison on later syncs and re-hash every
      // time. That is the SAFE direction (extra read, never a false skip) — do
      // not "fix" this by making the comparison tolerate the fallback value.
      size: metadata.size > 0 ? metadata.size : content.length,
    });
  }
  return { excludedEntries, files: discoveredFiles };
}

function applyDiscoveredPreparedFiles(args: {
  changes: PreparedCacheChange[];
  discoveredFiles: ReadonlyArray<DiscoveredPreparedFile | null>;
  existingByIdentity: Map<string, ManagedCacheEntryMetadata>;
  statRefreshes: StatMetadataRefresh[];
  unchangedCount: number;
}): number {
  let unchangedCount = args.unchangedCount;
  for (const discovered of args.discoveredFiles) {
    if (!discovered) {
      continue;
    }
    const identity = buildRootFolderCacheIdentityKey(discovered.rootId, discovered.relativePath);
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
      if (!hasCompletedChunking(existing)) {
        args.changes.push({
          ...discovered,
          id: existing.fileRecordId,
          mode: 'replace',
        });
        continue;
      }
      unchangedCount += 1;
      // Unchanged rows never write, so stamp missing/stale stats here or
      // pre-migration rows miss the stat-cache on every future sync.
      if (
        discovered.mtimeMs !== null &&
        (existing.mtimeMs !== discovered.mtimeMs || existing.size !== discovered.size)
      ) {
        args.statRefreshes.push({
          fileRecordId: existing.fileRecordId,
          mtimeMs: discovered.mtimeMs,
          size: discovered.size,
        });
      }
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
        mutation: {
          mode: 'replace',
          record: {
            ...mutableRecord,
          },
        },
        relativePath: change.relativePath,
      });
      continue;
    }
    mutations.push({
      mode: 'import',
      mutation: {
        mode: 'import',
        record: {
          ...mutableRecord,
          createdAt: batchCreatedAt,
        },
      },
      relativePath: change.relativePath,
    });
  }
  return mutations;
}

async function applyBackgroundImportBatch(args: {
  applyManagedCacheBatch: (args: ApplyManagedCacheBatchArgs) => Promise<void>;
  batch: readonly PreparedCacheChange[];
  batchContents: Record<string, string>;
  collectionId: string;
  rootId?: string | null;
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
      error: message,
      file: change.relativePath,
    });
    skippedResults.push({
      error: message,
      existed: false,
      id: change.id,
      imported: false,
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
    logger.info('Workspace Index import batch managed-cache apply started', {
      batchFileCount: mutations.length,
      collectionId: args.collectionId,
      rootId: args.rootId ?? null,
    });
    await args.applyManagedCacheBatch({
      changes: mutations.map((entry) => entry.mutation),
      embeddingSetId: args.collectionId,
      rootId: args.rootId ?? null,
    });
    return {
      errors: skippedErrors,
      results: [
        ...skippedResults,
        ...mutations.map((entry) => ({
          existed: false,
          id: entry.mutation.record.id,
          imported: true,
        })),
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sampleRelativePaths = mutations.slice(0, 10).map((entry) => entry.relativePath);
    logger.warn('Workspace Index managed-cache batch import failed', {
      batchFileCount: mutations.length,
      collectionId: args.collectionId,
      error: message,
      mutationModes: {
        import: mutations.filter((entry) => entry.mode === 'import').length,
        replace: mutations.filter((entry) => entry.mode === 'replace').length,
      },
      rootId: args.rootId ?? null,
      sampleRelativePaths,
      truncatedRelativePathCount: Math.max(0, mutations.length - sampleRelativePaths.length),
    });
    return {
      errors: [
        ...skippedErrors,
        ...mutations.map((entry) => ({
          error: message,
          file: entry.relativePath,
        })),
      ],
      results: [
        ...skippedResults,
        ...mutations.map((entry) => ({
          error: message,
          existed: false,
          id: entry.mutation.record.id,
          imported: false,
        })),
      ],
    };
  }
}

function getSkippedBatchContentError(
  change: PreparedCacheChange,
  batchContents: Readonly<Record<string, string>>
): string {
  const content = batchContents[change.compositeKey];
  if (content === undefined) {
    return 'Background cache import descriptor is missing.';
  }
  return getContentIndexingError(content) ?? content;
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
    errors: buildBatchImportErrors(args.progress, args.cumulativeErrorCount),
    total: args.totalFiles,
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
      // Floor to integer ms: stat.mtimeMs is fractional, but the persisted
      // mtime_ms is a BIGINT (stored floored). Flooring here keeps the stat-cache
      // comparison consistent with the stored value AND keeps the DB write valid.
      mtimeMs: typeof node.lastModified === 'number' ? Math.floor(node.lastModified) : null,
      relativePath,
      request: {
        compositeKey,
        fileNode: node,
        fileSystemAdapter,
      },
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
 * stat-cache residual. Be precise about its shape: the skip requires the disk
 * (size, floored-mtime) pair to EQUAL the values stored at index time, so
 * restoring an older same-size revision via `cp -p`/`rsync --times`/archive
 * restore is CAUGHT (the restored file carries the other revision's mtime, which
 * differs from the indexed one), and stock `git checkout` writes fresh mtimes —
 * also caught. The residual bites only when new content lands with the indexed
 * pair exactly: `touch -r` against the indexed state, in-place tools that
 * restore the original mtime after writing, or a same-size rewrite within the
 * same floored millisecond. Such a file is never re-embedded by sync alone;
 * recovery today is re-creating the collection (or factory reset), and a
 * targeted force-rehash affordance is tracked as follow-up work (a periodic
 * full rehash was considered and declined for this change's scope).
 */
export function partitionPreparationsByStatCache<
  T extends { mtimeMs: number | null; relativePath: string; size: number },
>(args: {
  existingByIdentity: ReadonlyMap<string, ManagedCacheEntryMetadata>;
  preparations: readonly T[];
  rootId: string;
}): { needsRead: T[]; skippedUnchanged: T[] } {
  const needsRead: T[] = [];
  const skippedUnchanged: T[] = [];
  for (const preparation of args.preparations) {
    const existing = args.existingByIdentity.get(
      buildRootFolderCacheIdentityKey(args.rootId, preparation.relativePath)
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
  if (!hasCompletedChunking(existing)) {
    return false;
  }
  return existing.size === preparation.size && existing.mtimeMs === preparation.mtimeMs;
}

function hasCompletedChunking(existing: ManagedCacheEntryMetadata): boolean {
  if (existing.chunksProcessedAt === undefined) {
    return true;
  }
  if (existing.chunksProcessedAt === null) {
    return false;
  }
  return typeof existing.chunksProcessedAt === 'string' && existing.chunksProcessedAt.length > 0;
}

export async function collectPreparedChangesInBatches(args: {
  abortSignal: AbortSignal;
  existingEntries: readonly ManagedCacheEntryMetadata[];
  fileContentProcessor?: FileContentProcessor;
  fileNodes: readonly IFileNode[];
  fileSystemAdapter: FileSystemAdapter;
  forceReadRelativePaths?: ReadonlySet<string>;
  onCurrentFile: (path: string | null) => void;
  qosPolicy: WorkspaceIndexingImportQosPolicy;
  // rootPath drives path normalization / composite keys; rootId is the durable
  // managed-cache dedup identity (since the source_root_path retirement).
  rootId: string;
  rootPath: string;
}): Promise<PreparedChangesSummary> {
  const {
    abortSignal,
    existingEntries,
    fileContentProcessor,
    fileNodes,
    fileSystemAdapter,
    forceReadRelativePaths,
    onCurrentFile,
    qosPolicy,
    rootId,
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
      buildRootFolderCacheIdentityKey(entry.rootId, entry.relativePath),
      entry,
    ])
  );
  // Stat-cache fast-path: drop files whose size+mtime already match the stored
  // entry before any content read, so unchanged files cost a stat lookup instead
  // of a full read + SHA-256 hash. Skipped files count as unchanged directly.
  const statCacheEligiblePreparations =
    forceReadRelativePaths && forceReadRelativePaths.size > 0
      ? allPreparations.filter(
          (preparation) => !forceReadRelativePaths.has(preparation.relativePath)
        )
      : allPreparations;
  const forceReadPreparations =
    forceReadRelativePaths && forceReadRelativePaths.size > 0
      ? allPreparations.filter((preparation) =>
          forceReadRelativePaths.has(preparation.relativePath)
        )
      : [];
  const { needsRead, skippedUnchanged } = partitionPreparationsByStatCache({
    existingByIdentity,
    preparations: statCacheEligiblePreparations,
    rootId,
  });
  const needsReadIdentities = new Set(
    [...forceReadPreparations, ...needsRead].map((preparation) => preparation.relativePath)
  );
  const preparations = allPreparations.filter((preparation) =>
    needsReadIdentities.has(preparation.relativePath)
  );
  if (skippedUnchanged.length > 0) {
    // One line per scan: without this, a stat-skipped file leaves no trace at
    // all, which makes "why didn't my edit get indexed" undiagnosable.
    logger.info('Stat-cache skipped unchanged files without re-reading', {
      statCacheSkipped: skippedUnchanged.length,
      totalFiles: allPreparations.length,
    });
  }
  const changes: PreparedCacheChange[] = [];
  const statRefreshes: StatMetadataRefresh[] = [];
  let excludedEntries = 0;
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

    const discovered = await collectDiscoveredPreparedFiles({
      fileContents,
      metadataByKey,
      rootId,
    });
    excludedEntries += discovered.excludedEntries;
    throwIfAborted(abortSignal);
    unchangedCount = applyDiscoveredPreparedFiles({
      changes,
      discoveredFiles: discovered.files,
      existingByIdentity,
      statRefreshes,
      unchangedCount,
    });
  }

  return {
    changes,
    excludedEntries,
    statRefreshes,
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
  rootId?: string | null;
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
    rootId,
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
  assertManagedCollectionModelKey(collection.modelKey);
  if (!hasTransactionalChunkJobEnqueueSupport(db)) {
    throw new Error(TRANSACTIONAL_CHUNK_JOB_ENQUEUE_REQUIRED_ERROR);
  }
  const firstEmbedChunkJobEnqueueRef: { current: FirstEmbedChunkJobEnqueueMarker | null } = {
    current: null,
  };
  const logFirstEmbedChunkJobEnqueued = (args: {
    batchNumber: number;
    chunkCount: number;
    fileRecordId: string;
  }): void => {
    if (firstEmbedChunkJobEnqueueRef.current || args.chunkCount <= 0) {
      return;
    }
    firstEmbedChunkJobEnqueueRef.current = args;
    logger.info('Workspace Index first durable embed_chunk job enqueued', {
      batchNumber: args.batchNumber,
      chunkCount: args.chunkCount,
      collectionId: collection.id,
      fileRecordId: args.fileRecordId,
      rootId: rootId ?? null,
    });
  };
  const insertChunksAndEnqueueEmbeddingJobs = db.insertChunksAndEnqueueEmbeddingJobs
    ? db.insertChunksAndEnqueueEmbeddingJobs.bind(db)
    : null;
  let activeBatchNumber = 0;
  const sql = {
    query: db.query.bind(db),
    ...(insertChunksAndEnqueueEmbeddingJobs
      ? {
          insertChunksAndEnqueueEmbeddingJobs: (async (chunks, fileRecordId, options) => {
            await insertChunksAndEnqueueEmbeddingJobs(chunks, fileRecordId, options);
            logFirstEmbedChunkJobEnqueued({
              batchNumber: activeBatchNumber,
              chunkCount: chunks.length,
              fileRecordId,
            });
          }) satisfies NonNullable<typeof db.insertChunksAndEnqueueEmbeddingJobs>,
        }
      : {}),
    ...(db.transaction ? { runInTransaction: db.transaction.bind(db) } : {}),
  };
  const rawEmbeddingQueue = createEmbeddingJobQueuePort<IDatabase>({
    createQueue: (executor) => new JobQueue(executor),
    db,
    defaultExpectedDimension: collection.dimensions,
  });
  const embeddingQueue = {
    ...rawEmbeddingQueue,
    enqueueBatch: async (...params: Parameters<typeof rawEmbeddingQueue.enqueueBatch>) => {
      const [chunks, fileRecordId] = params;
      await rawEmbeddingQueue.enqueueBatch(...params);
      logFirstEmbedChunkJobEnqueued({
        batchNumber: activeBatchNumber,
        chunkCount: chunks.length,
        fileRecordId,
      });
    },
  };
  const embeddingConfig = {
    chunkRepository,
    enabled: true,
    model: collection.modelKey,
    resolveTargetEmbeddingSetId: () => collection.id,
    service: null,
    targetDimension: collection.dimensions,
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
      const batchNumber = Math.floor(index / qosPolicy.importBatchSize) + 1;
      activeBatchNumber = batchNumber;
      firstEmbedChunkJobEnqueueRef.current = null;
      logger.info('Workspace Index import batch content read started', {
        batchFileCount: batch.length,
        batchNumber,
        collectionId: collection.id,
        rootId: rootId ?? null,
        totalFiles: changes.length,
      });
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
            completed: cumulativeCompleted,
            current: batchMetadataByKey.get(key)?.relativePath ?? null,
            errors: [],
            phase: 'importing',
            total: changes.length,
          } as EnhancedImportProgress);
        },
        { abortSignal }
      );
      throwIfAborted(abortSignal, 'Background cache import was cancelled.');
      logger.info('Workspace Index import batch content read completed', {
        batchFileCount: batch.length,
        batchNumber,
        collectionId: collection.id,
        contentEntries: Object.keys(batchContents).length,
        rootId: rootId ?? null,
        totalFiles: changes.length,
      });

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
      logger.info('Workspace Index import batch chunking started', {
        batchFileCount: batch.length,
        batchNumber,
        collectionId: collection.id,
        indexableFileCount: selectedFilePaths.size,
        rootId: rootId ?? null,
        totalFiles: changes.length,
      });
      const batchResults = await runEnhancedImport<IFileNode>({
        abortSignal,
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
              rootId: rootId ?? null,
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
              const message = getSkippedBatchContentError(change, batchContents);
              errors.push({
                error: message,
                file: change.relativePath,
              });
              results.push({
                error: message,
                existed: false,
                id: change.id,
                imported: false,
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
          chunkingWorkerPort,
          deps: {
            chunkRepository,
            repository: fileRecordRepository,
          },
          enabled: true,
        },
        embedding: embeddingConfig,
        ports: {
          embeddingQueue,
          sql,
        },
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
        request: {
          fileContents,
          fileTree: [],
          selectedFilePaths,
        },
      });
      logger.info('Workspace Index import batch chunking completed', {
        batchFileCount: batch.length,
        batchNumber,
        chunksCreated: batchResults.reduce((sum, result) => sum + result.chunksCreated, 0),
        collectionId: collection.id,
        importedFiles: batchResults.filter((result) => result.imported).length,
        rootId: rootId ?? null,
        totalFiles: changes.length,
      });
      await waitForBackgroundPermit({ label: 'background import assignment' });
      logger.info('Workspace Index import batch assignment reconciliation requested', {
        batchNumber,
        collectionId: collection.id,
        importedFiles: batchResults.filter((result) => result.imported).length,
        rootId: rootId ?? null,
      });
      await backfillEmbeddingSetAssignments(
        sql,
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
