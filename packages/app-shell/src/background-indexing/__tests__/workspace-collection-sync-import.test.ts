import type {
  ApplyManagedCacheBatchArgs,
  EmbeddingSet,
  ManagedCacheEntryMetadata,
} from '@brainstrike/db';
import type { FileContentProcessor, FileContentRequest } from '@brainstrike/file-explorer-hooks';
import { runEnhancedImport } from '@brainstrike/file-import';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/utils/logger';
import { describe, expect, it, vi } from 'vitest';
import { buildRootFolderCacheIdentityKey } from '../root-folder-cache-reconciliation';
import {
  collectPreparedChangesInBatches,
  type PreparedCacheChange,
  partitionPreparationsByStatCache,
  runRootFolderCacheImport,
} from '../workspace-collection-sync-import';

vi.mock('@brainstrike/file-import', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/file-import')>();
  return {
    ...original,
    backfillEmbeddingSetAssignments: vi.fn().mockResolvedValue(undefined),
    runEnhancedImport: vi.fn(
      async ({
        baseImportRunner,
        request,
      }: {
        baseImportRunner: (args: {
          fileContents: Record<string, string>;
          fileTree: IFileNode[];
          onProgress: (p: unknown) => void;
          selectedFilePaths: Set<string>;
        }) => Promise<Array<{ id: string; imported: boolean; existed: boolean }>>;
        request: {
          fileContents: Record<string, string>;
          fileTree: IFileNode[];
          selectedFilePaths: Set<string>;
        };
      }) => {
        const results = await baseImportRunner({
          fileContents: request.fileContents,
          fileTree: request.fileTree,
          onProgress: () => {},
          selectedFilePaths: request.selectedFilePaths,
        });
        return results.map((r) => ({ ...r, chunksCreated: 0 }));
      }
    ),
  };
});

const ROOT = '/workspace/root';

interface TestPreparation {
  mtimeMs: number | null;
  relativePath: string;
  size: number;
}

function prep(relativePath: string, size: number, mtimeMs: number | null): TestPreparation {
  return { mtimeMs, relativePath, size };
}

function existingEntry(
  relativePath: string,
  overrides: Partial<ManagedCacheEntryMetadata> = {}
): ManagedCacheEntryMetadata {
  return {
    contentHash: 'hash',
    chunksCount: 1,
    chunksProcessedAt: '2026-06-09T00:00:00.000Z',
    embeddingSetId: 'set-1',
    fileRecordId: `rec-${relativePath}`,
    mtimeMs: 1000,
    relativePath,
    size: 42,
    rootId: ROOT,
    updatedAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

function existingByIdentity(
  entries: readonly ManagedCacheEntryMetadata[]
): Map<string, ManagedCacheEntryMetadata> {
  return new Map(
    entries.map((entry) => [
      buildRootFolderCacheIdentityKey(entry.rootId, entry.relativePath),
      entry,
    ])
  );
}

describe('partitionPreparationsByStatCache', () => {
  it('skips files whose size AND mtime both match the stored entry', () => {
    const preparations = [prep('a.ts', 42, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([
        existingEntry('a.ts', {
          size: 42,
          mtimeMs: 1000,
          chunksProcessedAt: '2026-06-09T00:00:00.000Z',
        }),
      ]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual(preparations);
    expect(result.needsRead).toEqual([]);
  });

  it('reads files whose stat metadata matches but chunking has never completed', () => {
    const preparations = [prep('a.ts', 42, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([
        existingEntry('a.ts', {
          size: 42,
          mtimeMs: 1000,
          chunksProcessedAt: null,
        }),
      ]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files whose size matches but mtime differs', () => {
    const preparations = [prep('a.ts', 42, 2000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { size: 42, mtimeMs: 1000 })]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files whose mtime matches but size differs', () => {
    const preparations = [prep('a.ts', 99, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { size: 42, mtimeMs: 1000 })]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files with no existing cache entry', () => {
    const preparations = [prep('new.ts', 42, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files when the stored entry predates the mtime column (null mtimeMs)', () => {
    const preparations = [prep('a.ts', 42, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { size: 42, mtimeMs: null })]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files when the scan did not capture an mtime (null prep mtime)', () => {
    const preparations = [prep('a.ts', 42, null)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { size: 42, mtimeMs: 1000 })]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files when the stored entry has no size (absent)', () => {
    const preparations = [prep('a.ts', 42, 1000)];
    const noSizeEntry: ManagedCacheEntryMetadata = {
      contentHash: 'hash',
      embeddingSetId: 'set-1',
      fileRecordId: 'rec-a.ts',
      mtimeMs: 1000,
      relativePath: 'a.ts',
      rootId: ROOT,
      updatedAt: '2026-06-09T00:00:00.000Z',
    };
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([noSizeEntry]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('partitions a mixed batch, preserving order within each group', () => {
    const unchanged = prep('keep.ts', 42, 1000);
    const editedMtime = prep('edited.ts', 42, 5000);
    const fresh = prep('fresh.ts', 10, 1000);
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([
        existingEntry('keep.ts', { size: 42, mtimeMs: 1000 }),
        existingEntry('edited.ts', { size: 42, mtimeMs: 1000 }),
      ]),
      preparations: [unchanged, editedMtime, fresh],
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([unchanged]);
    expect(result.needsRead).toEqual([editedMtime, fresh]);
  });
});

function makeFileNode(relativePath: string, size: number, mtimeMs: number | null): IFileNode {
  const node: IFileNode = {
    depth: 1,
    handle: {} as never,
    name: relativePath.split('/').pop() ?? relativePath,
    path: `${ROOT}/${relativePath}`,
    rootFolderId: ROOT,
    selectionState: 'checked',
    size,
    type: 'file',
  };
  if (mtimeMs !== null) {
    node.lastModified = mtimeMs;
  }
  return node;
}

async function hashForRecordedContent(relativePath: string): Promise<string> {
  const { generateContentHash } = await import('@brainstrike/utils');
  return await generateContentHash(`content-of-${ROOT}/${relativePath}`);
}

function createRecordingProcessor(): {
  processor: FileContentProcessor;
  readPaths: () => string[];
} {
  const seen: string[] = [];
  const processFiles = vi.fn(
    async (requests: readonly FileContentRequest[]): Promise<Record<string, string>> => {
      const contents: Record<string, string> = {};
      for (const request of requests) {
        seen.push(request.fileNode.path);
        contents[request.compositeKey] = `content-of-${request.fileNode.path}`;
      }
      return contents;
    }
  );
  return {
    processor: { processFiles } as unknown as FileContentProcessor,
    readPaths: () => seen,
  };
}

describe('collectPreparedChangesInBatches stat-cache short-circuit', () => {
  it('skips reading files whose size and mtime match the stored entry', async () => {
    const { processor, readPaths } = createRecordingProcessor();
    // The unchanged entry deliberately stores a NON-matching content hash to prove
    // the skip is purely stat-based: a working stat-cache never reads or hashes it.
    const result = await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      existingEntries: [
        existingEntry('unchanged.ts', {
          size: 42,
          mtimeMs: 1000,
          contentHash: 'stale-hash',
          chunksProcessedAt: '2026-06-09T00:00:00.000Z',
        }),
      ],
      fileContentProcessor: processor,
      fileNodes: [makeFileNode('unchanged.ts', 42, 1000), makeFileNode('fresh.ts', 10, 2000)],
      fileSystemAdapter: {} as FileSystemAdapter,
      onCurrentFile: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 10,
      },
      rootId: ROOT,
      rootPath: ROOT,
    });

    expect(readPaths()).toEqual([`${ROOT}/fresh.ts`]);
    expect(result.unchangedCount).toBe(1);
    expect(result.changes.map((change) => change.relativePath)).toEqual(['fresh.ts']);
    expect(result.totalFiles).toBe(2);
  });

  it('requeues hash-unchanged files whose file record was imported but never chunked', async () => {
    const { processor, readPaths } = createRecordingProcessor();
    const result = await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      existingEntries: [
        existingEntry('unchunked.ts', {
          contentHash: await hashForRecordedContent('unchunked.ts'),
          size: 42,
          mtimeMs: 1000,
          chunksProcessedAt: null,
        }),
      ],
      fileContentProcessor: processor,
      fileNodes: [makeFileNode('unchunked.ts', 42, 1000)],
      fileSystemAdapter: {} as FileSystemAdapter,
      onCurrentFile: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 10,
      },
      rootId: ROOT,
      rootPath: ROOT,
    });

    expect(readPaths()).toEqual([`${ROOT}/unchunked.ts`]);
    expect(result.unchangedCount).toBe(0);
    expect(result.statRefreshes).toEqual([]);
    expect(result.changes).toEqual([
      expect.objectContaining({
        id: 'rec-unchunked.ts',
        mode: 'replace',
        relativePath: 'unchunked.ts',
      }),
    ]);
  });

  it('emits stat refreshes for hash-unchanged files whose stored stats are missing or stale', async () => {
    // Pre-migration rows (NULL mtime_ms) never take a write path when their
    // content is unchanged, so without this stamp they would be re-read and
    // re-hashed on EVERY sync forever — the exact cost the stat-cache removes.
    const { processor } = createRecordingProcessor();
    const result = await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      existingEntries: [
        // Stored hash matches what the recording processor returns for the path.
        existingEntry('legacy.ts', {
          contentHash: await hashForRecordedContent('legacy.ts'),
          mtimeMs: null,
        }),
      ],
      fileContentProcessor: processor,
      fileNodes: [makeFileNode('legacy.ts', 42, 1000)],
      fileSystemAdapter: {} as FileSystemAdapter,
      onCurrentFile: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 10,
      },
      rootId: ROOT,
      rootPath: ROOT,
    });

    expect(result.changes).toEqual([]);
    expect(result.unchangedCount).toBe(1);
    expect(result.statRefreshes).toEqual([
      { fileRecordId: 'rec-legacy.ts', mtimeMs: 1000, size: 42 },
    ]);
  });

  it('does not emit stat refreshes when the stored stats already match or the file changed', async () => {
    const { processor } = createRecordingProcessor();
    const result = await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      existingEntries: [
        // Stat-cache hit: skipped entirely, no refresh needed.
        existingEntry('hit.ts', {
          size: 42,
          mtimeMs: 1000,
          chunksProcessedAt: '2026-06-09T00:00:00.000Z',
        }),
        // Content changed: goes through replace, which persists stats itself.
        existingEntry('changed.ts', { contentHash: 'old-hash', mtimeMs: null }),
      ],
      fileContentProcessor: processor,
      fileNodes: [makeFileNode('hit.ts', 42, 1000), makeFileNode('changed.ts', 10, 2000)],
      fileSystemAdapter: {} as FileSystemAdapter,
      onCurrentFile: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 10,
      },
      rootId: ROOT,
      rootPath: ROOT,
    });

    expect(result.changes.map((change) => change.relativePath)).toEqual(['changed.ts']);
    expect(result.statRefreshes).toEqual([]);
  });

  it('logs the stat-cache skip count so skipped files leave a diagnostic trace', async () => {
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceCollectionSyncImport') {
        captured.push(record);
      }
    });

    try {
      const { processor } = createRecordingProcessor();
      await collectPreparedChangesInBatches({
        abortSignal: new AbortController().signal,
        existingEntries: [existingEntry('unchanged.ts', { size: 42, mtimeMs: 1000 })],
        fileContentProcessor: processor,
        fileNodes: [makeFileNode('unchanged.ts', 42, 1000), makeFileNode('fresh.ts', 10, 2000)],
        fileSystemAdapter: {} as FileSystemAdapter,
        onCurrentFile: () => {},
        qosPolicy: {
          allowNewWork: true,
          contentReadBatchSize: 10,
          contentReadConcurrency: 1,
          importBatchSize: 10,
        },
        rootId: ROOT,
        rootPath: ROOT,
      });

      const skipLogs = captured.filter((record) => record.message?.includes('Stat-cache skipped'));
      expect(skipLogs).toHaveLength(1);
      expect(skipLogs[0]?.args).toContainEqual(
        expect.objectContaining({ statCacheSkipped: 1, totalFiles: 2 })
      );
    } finally {
      removeListener();
    }
  });

  it('floors sub-millisecond mtime so a stored integer mtime still hits the stat-cache', async () => {
    const { processor, readPaths } = createRecordingProcessor();
    // The persisted mtime is a floored integer (BIGINT column); the live file
    // reports the same instant with sub-ms jitter (stat.mtimeMs is fractional).
    // Flooring at capture must make this a hit, not a needless re-read.
    const result = await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      existingEntries: [existingEntry('jitter.ts', { size: 42, mtimeMs: 1000 })],
      fileContentProcessor: processor,
      fileNodes: [makeFileNode('jitter.ts', 42, 1000.7)],
      fileSystemAdapter: {} as FileSystemAdapter,
      onCurrentFile: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 10,
      },
      rootId: ROOT,
      rootPath: ROOT,
    });

    expect(readPaths()).toEqual([]);
    expect(result.unchangedCount).toBe(1);
    expect(result.changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runRootFolderCacheImport — rootId threading
// ---------------------------------------------------------------------------

const COMPOSITE_KEY = `${ROOT}::a.ts`;

function makeMinimalDb() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return {
    query,
    transaction: vi.fn(async (fn) => fn({ query })),
  };
}

function makeMinimalChange(): PreparedCacheChange {
  return {
    compositeKey: COMPOSITE_KEY,
    contentHash: 'hash-a',
    id: 'file-id-a',
    mode: 'import',
    mtimeMs: 1000,
    name: 'a.ts',
    relativePath: 'a.ts',
    request: {
      compositeKey: COMPOSITE_KEY,
      fileNode: makeFileNode('a.ts', 42, 1000),
      fileSystemAdapter: {} as FileSystemAdapter,
    },
    size: 42,
    rootId: ROOT,
  };
}

function makeMinimalCollection(): EmbeddingSet {
  return {
    createdAt: '2026-06-10T00:00:00.000Z',
    dimensions: 384,
    distance: 'cosine',
    id: 'collection-1',
    modelId: 'model-1',
    modelKey: 'local:model-1',
  };
}

function makeMinimalFileContentProcessor(change: PreparedCacheChange): FileContentProcessor {
  const processFiles = vi.fn(
    async (requests: readonly FileContentRequest[]): Promise<Record<string, string>> => {
      const contents: Record<string, string> = {};
      for (const request of requests) {
        contents[request.compositeKey] = `content-of-${request.fileNode.path}`;
      }
      return contents;
    }
  );
  void change;
  return { processFiles } as unknown as FileContentProcessor;
}

describe('runRootFolderCacheImport — rootId threading', () => {
  it('rejects missing collection model keys before file import starts', async () => {
    vi.mocked(runEnhancedImport).mockClear();
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const change = makeMinimalChange();
    const collection = {
      ...makeMinimalCollection(),
      modelKey: '   ',
    };

    await expect(
      runRootFolderCacheImport({
        applyManagedCacheBatch,
        abortSignal: new AbortController().signal,
        changes: [change],
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
        } as never,
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        collection,
        db: makeMinimalDb() as never,
        fileContentProcessor: makeMinimalFileContentProcessor(change),
        fileRecordRepository: {
          findByCollectionId: vi.fn().mockResolvedValue([]),
          upsertFileRecord: vi.fn().mockResolvedValue({ id: 'file-id-a' }),
        } as never,
        onProgress: () => {},
        qosPolicy: {
          allowNewWork: true,
          contentReadBatchSize: 10,
          contentReadConcurrency: 1,
          importBatchSize: 10,
        },
        rootId: 'root-db-1',
        setImporting: () => {},
        waitForBackgroundPermit: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow(
      'Workspace Index managed collection requires a model key before chunk embedding jobs can be enqueued.'
    );

    expect(runEnhancedImport).not.toHaveBeenCalled();
    expect(applyManagedCacheBatch).not.toHaveBeenCalled();
  });

  it('passes a durable embedding queue port so chunking can enqueue jobs before final backfill', async () => {
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const change = makeMinimalChange();
    const collection = makeMinimalCollection();

    await runRootFolderCacheImport({
      applyManagedCacheBatch,
      abortSignal: new AbortController().signal,
      changes: [change],
      chunkRepository: {
        deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
        deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
        insertChunks: vi.fn().mockResolvedValue(undefined),
        findByFileRecordId: vi.fn().mockResolvedValue([]),
      } as never,
      chunkingWorkerPort: {
        chunkBatch: vi.fn().mockResolvedValue([]),
        chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
        isReady: vi.fn().mockReturnValue(true),
        transportKind: 'local',
      } as never,
      collection,
      db: makeMinimalDb() as never,
      fileContentProcessor: makeMinimalFileContentProcessor(change),
      fileRecordRepository: {
        upsertFileRecord: vi.fn().mockResolvedValue({ id: 'file-id-a' }),
        findByCollectionId: vi.fn().mockResolvedValue([]),
      } as never,
      onProgress: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 10,
      },
      rootId: 'root-db-1',
      setImporting: () => {},
      waitForBackgroundPermit: vi.fn().mockResolvedValue(undefined),
    });

    expect(vi.mocked(runEnhancedImport)).toHaveBeenCalledWith(
      expect.objectContaining({
        embedding: expect.objectContaining({
          enabled: true,
          resolveTargetEmbeddingSetId: expect.any(Function),
        }),
        ports: expect.objectContaining({
          embeddingQueue: expect.objectContaining({
            enqueueBatch: expect.any(Function),
          }),
          sql: expect.objectContaining({
            runInTransaction: expect.any(Function),
          }),
        }),
      })
    );
  });

  it('passes rootId to applyManagedCacheBatch when rootId is provided', async () => {
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const change = makeMinimalChange();
    const collection = makeMinimalCollection();

    await runRootFolderCacheImport({
      applyManagedCacheBatch,
      abortSignal: new AbortController().signal,
      changes: [change],
      chunkRepository: {
        deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
        deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
        insertChunks: vi.fn().mockResolvedValue(undefined),
        findByFileRecordId: vi.fn().mockResolvedValue([]),
      } as never,
      chunkingWorkerPort: {
        chunkBatch: vi.fn().mockResolvedValue([]),
        chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
        isReady: vi.fn().mockReturnValue(true),
        transportKind: 'local',
      } as never,
      collection,
      db: makeMinimalDb() as never,
      fileContentProcessor: makeMinimalFileContentProcessor(change),
      fileRecordRepository: {
        upsertFileRecord: vi.fn().mockResolvedValue({ id: 'file-id-a' }),
        findByCollectionId: vi.fn().mockResolvedValue([]),
      } as never,
      onProgress: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 10,
      },
      rootId: 'root-db-1',
      setImporting: () => {},
      waitForBackgroundPermit: vi.fn().mockResolvedValue(undefined),
    });

    expect(applyManagedCacheBatch).toHaveBeenCalledOnce();
    expect(applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({ rootId: 'root-db-1' })
    );
  });

  it('passes rootId: null to applyManagedCacheBatch when rootId is absent', async () => {
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const change = makeMinimalChange();
    const collection = makeMinimalCollection();

    await runRootFolderCacheImport({
      applyManagedCacheBatch,
      abortSignal: new AbortController().signal,
      changes: [change],
      chunkRepository: {
        deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
        deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
        insertChunks: vi.fn().mockResolvedValue(undefined),
        findByFileRecordId: vi.fn().mockResolvedValue([]),
      } as never,
      chunkingWorkerPort: {
        chunkBatch: vi.fn().mockResolvedValue([]),
        chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
        isReady: vi.fn().mockReturnValue(true),
        transportKind: 'local',
      } as never,
      collection,
      db: makeMinimalDb() as never,
      fileContentProcessor: makeMinimalFileContentProcessor(change),
      fileRecordRepository: {
        upsertFileRecord: vi.fn().mockResolvedValue({ id: 'file-id-a' }),
        findByCollectionId: vi.fn().mockResolvedValue([]),
      } as never,
      onProgress: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 10,
      },
      // rootId deliberately absent
      setImporting: () => {},
      waitForBackgroundPermit: vi.fn().mockResolvedValue(undefined),
    });

    expect(applyManagedCacheBatch).toHaveBeenCalledOnce();
    expect(applyManagedCacheBatch).toHaveBeenCalledWith(expect.objectContaining({ rootId: null }));
  });
});
