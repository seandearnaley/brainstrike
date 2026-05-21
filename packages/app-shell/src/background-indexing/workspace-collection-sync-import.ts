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
import { buildRootFolderCacheIdentityKey } from './root-folder-cache-reconciliation';
import {
  buildBatchImportErrors,
  buildNormalizedChunkingProgress,
  throwIfAborted,
} from './workspace-collection-sync-progress';

const FILE_CONTENT_BATCH_SIZE = 24;
const IMPORT_BATCH_SIZE = 24;
const PROCESSOR_CONCURRENCY = 4;

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

export interface PreparedCacheChange {
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

interface FileBatchPreparation {
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

export async function collectPreparedChangesInBatches(args: {
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
