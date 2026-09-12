import type {
  ApplyManagedCacheBatchArgs,
  EmbeddingSet,
  ManagedCacheEntryMetadata,
} from '@brainstrike/db';
import type {
  FileContentProcessor,
  FileContentRequest,
  FileContentResult,
} from '@brainstrike/file-explorer-hooks';
import { runEnhancedImport } from '@brainstrike/file-import';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { buildRootFolderCacheIdentityKey } from '../root-folder-cache-reconciliation';
import {
  ChunkingRedispatchTracker,
  collectPreparedChangesInBatches,
  flattenFileNodes,
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
        onChunkingStart,
        request,
      }: {
        baseImportRunner: (args: {
          fileContents: Record<string, string>;
          fileTree: IFileNode[];
          onProgress: (p: unknown) => void;
          selectedFilePaths: Set<string>;
        }) => Promise<Array<{ id: string; imported: boolean; existed: boolean }>>;
        onChunkingStart?: (
          baseResults: readonly { id: string; imported: boolean; existed: boolean }[]
        ) => void;
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
        onChunkingStart?.(results);
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
    chunksCount: 1,
    chunksProcessedAt: '2026-06-09T00:00:00.000Z',
    contentHash: 'hash',
    embeddingSetId: 'set-1',
    fileRecordId: `rec-${relativePath}`,
    mtimeMs: 1000,
    relativePath,
    rootId: ROOT,
    size: 42,
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
          chunksProcessedAt: '2026-06-09T00:00:00.000Z',
          mtimeMs: 1000,
          size: 42,
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
          chunksProcessedAt: null,
          mtimeMs: 1000,
          size: 42,
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
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { mtimeMs: 1000, size: 42 })]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files whose mtime matches but size differs', () => {
    const preparations = [prep('a.ts', 99, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { mtimeMs: 1000, size: 42 })]),
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
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { mtimeMs: null, size: 42 })]),
      preparations,
      rootId: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files when the scan did not capture an mtime (null prep mtime)', () => {
    const preparations = [prep('a.ts', 42, null)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { mtimeMs: 1000, size: 42 })]),
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
        existingEntry('keep.ts', { mtimeMs: 1000, size: 42 }),
        existingEntry('edited.ts', { mtimeMs: 1000, size: 42 }),
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

function makeDirectoryNode(name: string, depth: number, children: IFileNode[]): IFileNode {
  return {
    children,
    depth,
    handle: {} as never,
    name,
    path: `${ROOT}/${name}`,
    rootFolderId: ROOT,
    selectionState: 'checked',
    type: 'directory',
  };
}

describe('flattenFileNodes', () => {
  it('preserves depth-first file traversal order', () => {
    const first = makeFileNode('first.ts', 1, null);
    const nestedFirst = makeFileNode('nested/first.ts', 1, null);
    const nestedSecond = makeFileNode('nested/second.ts', 1, null);
    const last = makeFileNode('last.ts', 1, null);

    expect(
      flattenFileNodes([first, makeDirectoryNode('nested', 1, [nestedFirst, nestedSecond]), last])
    ).toEqual([first, nestedFirst, nestedSecond, last]);
  });

  it('flattens a deeply nested tree without overflowing the call stack', () => {
    const leaf = makeFileNode('deep.ts', 1, null);
    let tree: IFileNode[] = [leaf];

    for (let depth = 100_000; depth > 0; depth -= 1) {
      tree = [makeDirectoryNode(`directory-${depth}`, depth, tree)];
    }

    expect(flattenFileNodes(tree)).toEqual([leaf]);
  });

  it('flattens a wide directory without exceeding the function argument limit', () => {
    const children = Array.from({ length: 100_000 }, (_, index) =>
      makeFileNode(`wide/file-${index}.ts`, 1, null)
    );

    expect(flattenFileNodes([makeDirectoryNode('wide', 1, children)])).toEqual(children);
  });
});

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
    async (requests: readonly FileContentRequest[]): Promise<Record<string, FileContentResult>> => {
      const contents: Record<string, FileContentResult> = {};
      for (const request of requests) {
        seen.push(request.fileNode.path);
        contents[request.compositeKey] = {
          content: `content-of-${request.fileNode.path}`,
          status: 'accessible',
        };
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
  it('indexes accessible scan content even when its prose resembles the old inaccessible sentinel', async () => {
    const node = makeFileNode('accessibility-notes.txt', 42, 1000);
    const processFiles = vi.fn(
      async (requests: readonly FileContentRequest[]): Promise<Record<string, FileContentResult>> =>
        Object.fromEntries(
          requests.map((request) => [
            request.compositeKey,
            {
              content: 'File not accessible - explain this status to users',
              status: 'accessible' as const,
            },
          ])
        )
    );

    const result = await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      existingEntries: [],
      fileContentProcessor: { processFiles },
      fileNodes: [node],
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

    expect(result.excludedEntries).toBe(0);
    expect(result.changes).toEqual([
      expect.objectContaining({ relativePath: 'accessibility-notes.txt' }),
    ]);
  });

  it('excludes an inaccessible scan result even when its message is empty', async () => {
    const processFiles = vi.fn(
      async (requests: readonly FileContentRequest[]): Promise<Record<string, FileContentResult>> =>
        Object.fromEntries(
          requests.map((request) => [
            request.compositeKey,
            { message: '', status: 'inaccessible' as const },
          ])
        )
    );

    const result = await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      existingEntries: [],
      fileContentProcessor: { processFiles },
      fileNodes: [makeFileNode('empty-message.txt', 42, 1000)],
      fileSystemAdapter: {} as FileSystemAdapter,
      onCurrentFile: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 1,
        contentReadConcurrency: 1,
        importBatchSize: 1,
      },
      rootId: ROOT,
      rootPath: ROOT,
    });

    expect(result).toMatchObject({ changes: [], excludedEntries: 1 });
  });

  it('fails closed when the content processor omits a requested scan result', async () => {
    const processFiles = vi.fn(async () => ({}));

    await expect(
      collectPreparedChangesInBatches({
        abortSignal: new AbortController().signal,
        existingEntries: [],
        fileContentProcessor: { processFiles },
        fileNodes: [makeFileNode('changed.ts', 42, 1000)],
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
      })
    ).rejects.toThrow('File content processor omitted scan result');
  });

  it('fails closed when the content processor returns a malformed scan result', async () => {
    const processFiles = vi.fn(async (requests: readonly FileContentRequest[]) => ({
      [requests[0]?.compositeKey ?? 'missing']: { status: 'accessible' },
    })) as unknown as FileContentProcessor['processFiles'];

    await expect(
      collectPreparedChangesInBatches({
        abortSignal: new AbortController().signal,
        existingEntries: [],
        fileContentProcessor: { processFiles },
        fileNodes: [makeFileNode('changed.ts', 42, 1000)],
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
      })
    ).rejects.toThrow('File content processor returned malformed scan result');
  });

  it('skips reading files whose size and mtime match the stored entry', async () => {
    const { processor, readPaths } = createRecordingProcessor();
    // The unchanged entry deliberately stores a NON-matching content hash to prove
    // the skip is purely stat-based: a working stat-cache never reads or hashes it.
    const result = await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      existingEntries: [
        existingEntry('unchanged.ts', {
          chunksProcessedAt: '2026-06-09T00:00:00.000Z',
          contentHash: 'stale-hash',
          mtimeMs: 1000,
          size: 42,
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
          chunksProcessedAt: null,
          contentHash: await hashForRecordedContent('unchunked.ts'),
          mtimeMs: 1000,
          size: 42,
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

  it('caps hash-unchanged chunking redispatches and returns a terminal visible error', async () => {
    const { processor } = createRecordingProcessor();
    const tracker = new ChunkingRedispatchTracker(2);
    const contentHash = await hashForRecordedContent('missing-row.ts');
    const collect = async (chunksProcessedAt: string | null) =>
      await collectPreparedChangesInBatches({
        abortSignal: new AbortController().signal,
        chunkingRedispatchTracker: tracker,
        existingEntries: [
          existingEntry('missing-row.ts', {
            chunksProcessedAt,
            contentHash,
            mtimeMs: 1000,
            size: 42,
          }),
        ],
        fileContentProcessor: processor,
        fileNodes: [makeFileNode('missing-row.ts', 42, 1000)],
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

    const firstDispatch = await collect(null);
    expect(firstDispatch.changes).toHaveLength(1);
    tracker.recordDispatches(firstDispatch.changes);
    const secondDispatch = await collect(null);
    expect(secondDispatch.changes).toHaveLength(1);
    tracker.recordDispatches(secondDispatch.changes);

    const exhausted = await collect(null);
    expect(exhausted.changes).toEqual([]);
    expect(exhausted.unchangedCount).toBe(1);
    expect(exhausted.terminalChunkingErrors).toEqual([
      expect.objectContaining({
        attempts: 2,
        fileRecordId: 'rec-missing-row.ts',
        message: expect.stringContaining('stopped re-dispatching "missing-row.ts" after 2'),
        relativePath: 'missing-row.ts',
      }),
    ]);

    expect((await collect('2026-08-11T00:00:00.000Z')).terminalChunkingErrors).toEqual([]);
    expect((await collect(null)).changes).toHaveLength(1);
  });

  it('keeps redispatch budgets isolated between collections sharing a root and path', async () => {
    const { processor } = createRecordingProcessor();
    const tracker = new ChunkingRedispatchTracker(1);
    const contentHash = await hashForRecordedContent('shared.ts');
    const collect = async (collectionId: string) =>
      await collectPreparedChangesInBatches({
        abortSignal: new AbortController().signal,
        chunkingRedispatchTracker: tracker,
        existingEntries: [
          existingEntry('shared.ts', {
            chunksProcessedAt: null,
            contentHash,
            embeddingSetId: collectionId,
            mtimeMs: 1000,
            size: 42,
          }),
        ],
        fileContentProcessor: processor,
        fileNodes: [makeFileNode('shared.ts', 42, 1000)],
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

    const collectionA = await collect('set-a');
    tracker.recordDispatches(collectionA.changes);

    expect((await collect('set-b')).changes).toHaveLength(1);
  });

  it('prunes retry state for paths absent from a full collection scan', async () => {
    const { processor } = createRecordingProcessor();
    const tracker = new ChunkingRedispatchTracker(1);
    const contentHash = await hashForRecordedContent('deleted.ts');
    const existing = existingEntry('deleted.ts', {
      chunksProcessedAt: null,
      contentHash,
      embeddingSetId: 'set-a',
      mtimeMs: 1000,
      size: 42,
    });
    const collectFile = async () =>
      await collectPreparedChangesInBatches({
        abortSignal: new AbortController().signal,
        chunkingRedispatchTracker: tracker,
        existingEntries: [existing],
        fileContentProcessor: processor,
        fileNodes: [makeFileNode('deleted.ts', 42, 1000)],
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

    const first = await collectFile();
    tracker.recordDispatches(first.changes);
    await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      chunkingRedispatchTracker: tracker,
      collectionId: 'set-a',
      existingEntries: [existing],
      fileContentProcessor: processor,
      fileNodes: [],
      fileSystemAdapter: {} as FileSystemAdapter,
      onCurrentFile: () => {},
      pruneMissingRedispatchEntries: true,
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 10,
      },
      rootId: ROOT,
      rootPath: ROOT,
    });

    expect((await collectFile()).changes).toHaveLength(1);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    'rejects invalid chunking redispatch attempt cap %s',
    (attemptCap) => {
      expect(() => new ChunkingRedispatchTracker(attemptCap)).toThrow(
        'attempt cap must be a positive integer'
      );
    }
  );

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
          chunksProcessedAt: '2026-06-09T00:00:00.000Z',
          mtimeMs: 1000,
          size: 42,
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
        existingEntries: [existingEntry('unchanged.ts', { mtimeMs: 1000, size: 42 })],
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
      existingEntries: [existingEntry('jitter.ts', { mtimeMs: 1000, size: 42 })],
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

  it('keeps a large workspace scan moving when one text file contains a late null byte', async () => {
    const fileCount = 15_134;
    const invalidIndex = 12_345;
    const fileNodes = Array.from({ length: fileCount }, (_, index) =>
      makeFileNode(`large/file-${index}.txt`, 32, 2000 + index)
    );
    const processFiles = vi.fn(
      async (
        requests: readonly FileContentRequest[]
      ): Promise<Record<string, FileContentResult>> => {
        const contents: Record<string, FileContentResult> = {};
        for (const request of requests) {
          contents[request.compositeKey] = {
            content: request.fileNode.path.endsWith(`file-${invalidIndex}.txt`)
              ? `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`
              : `content-of-${request.fileNode.path}`,
            status: 'accessible',
          };
        }
        return contents;
      }
    );

    const result = await collectPreparedChangesInBatches({
      abortSignal: new AbortController().signal,
      existingEntries: [],
      fileContentProcessor: { processFiles } as unknown as FileContentProcessor,
      fileNodes,
      fileSystemAdapter: {} as FileSystemAdapter,
      onCurrentFile: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 500,
        contentReadConcurrency: 4,
        importBatchSize: 500,
      },
      rootId: ROOT,
      rootPath: ROOT,
    });

    expect(result.totalFiles).toBe(fileCount);
    expect(result.excludedEntries).toBe(1);
    expect(result.changes).toHaveLength(fileCount - 1);
    expect(result.changes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: `large/file-${invalidIndex}.txt` }),
      ])
    );
    expect(processFiles).toHaveBeenCalledTimes(Math.ceil(fileCount / 500));
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

function makeMinimalIpcDbWithoutCallbackTransaction() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { query };
}

const TRANSACTIONAL_ENQUEUE_REQUIRED_ERROR =
  'Workspace Index background import requires transactional chunk/job enqueue support.';

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
    rootId: ROOT,
    size: 42,
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
    async (requests: readonly FileContentRequest[]): Promise<Record<string, FileContentResult>> => {
      const contents: Record<string, FileContentResult> = {};
      for (const request of requests) {
        contents[request.compositeKey] = {
          content: `content-of-${request.fileNode.path}`,
          status: 'accessible',
        };
      }
      return contents;
    }
  );
  void change;
  return { processFiles } as unknown as FileContentProcessor;
}

describe('runRootFolderCacheImport — rootId threading', () => {
  it('records redispatch handoff only for the batch that reaches chunking', async () => {
    const firstChange = makeMinimalChange();
    const secondChange: PreparedCacheChange = {
      ...makeMinimalChange(),
      compositeKey: `${ROOT}::b.ts`,
      id: 'file-id-b',
      name: 'b.ts',
      relativePath: 'b.ts',
      request: {
        compositeKey: `${ROOT}::b.ts`,
        fileNode: makeFileNode('b.ts', 42, 1000),
        fileSystemAdapter: {} as FileSystemAdapter,
      },
    };
    const thirdChange: PreparedCacheChange = {
      ...makeMinimalChange(),
      compositeKey: `${ROOT}::c.ts`,
      id: 'file-id-c',
      name: 'c.ts',
      relativePath: 'c.ts',
      request: {
        compositeKey: `${ROOT}::c.ts`,
        fileNode: makeFileNode('c.ts', 42, 1000),
        fileSystemAdapter: {} as FileSystemAdapter,
      },
    };
    const onChunkingBatchStart = vi.fn();
    vi.mocked(runEnhancedImport).mockImplementationOnce(
      async ({ baseImportRunner, onChunkingStart, request }) => {
        const baseResults = await baseImportRunner({
          fileContents: request.fileContents,
          fileTree: request.fileTree,
          onProgress: () => {},
          selectedFilePaths: request.selectedFilePaths,
        });
        onChunkingStart?.(baseResults);
        throw new Error('first chunking batch failed');
      }
    );

    await expect(
      runRootFolderCacheImport({
        abortSignal: new AbortController().signal,
        applyManagedCacheBatch: vi.fn(async () => {}),
        changes: [firstChange, secondChange, thirdChange],
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
        } as never,
        collection: makeMinimalCollection(),
        db: makeMinimalDb() as never,
        fileContentProcessor: {
          processFiles: vi.fn(async (requests: readonly FileContentRequest[]) =>
            Object.fromEntries(
              requests.map((request) => [
                request.compositeKey,
                request.compositeKey === secondChange.compositeKey
                  ? { message: 'temporarily unreadable', status: 'inaccessible' as const }
                  : {
                      content: `content-of-${request.fileNode.path}`,
                      status: 'accessible' as const,
                    },
              ])
            )
          ),
        } as unknown as FileContentProcessor,
        fileRecordRepository: {
          findByCollectionId: vi.fn().mockResolvedValue([]),
          upsertFileRecord: vi.fn().mockResolvedValue({ id: 'file-id-a' }),
        } as never,
        onChunkingBatchStart,
        onProgress: () => {},
        qosPolicy: {
          allowNewWork: true,
          contentReadBatchSize: 10,
          contentReadConcurrency: 1,
          importBatchSize: 2,
        },
        rootId: 'root-db-1',
        setImporting: () => {},
        waitForBackgroundPermit: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow('first chunking batch failed');

    expect(onChunkingBatchStart).toHaveBeenCalledOnce();
    expect(onChunkingBatchStart).toHaveBeenCalledWith([firstChange]);
  });

  it('does not record redispatch handoff when managed-cache apply fails', async () => {
    const change = makeMinimalChange();
    const onChunkingBatchStart = vi.fn();

    await runRootFolderCacheImport({
      abortSignal: new AbortController().signal,
      applyManagedCacheBatch: vi.fn().mockRejectedValue(new Error('database host timed out')),
      changes: [change],
      chunkingWorkerPort: {
        chunkBatch: vi.fn().mockResolvedValue([]),
        chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
        isReady: vi.fn().mockReturnValue(true),
        transportKind: 'local',
      } as never,
      chunkRepository: {
        deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
        deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
        findByFileRecordId: vi.fn().mockResolvedValue([]),
        insertChunks: vi.fn().mockResolvedValue(undefined),
      } as never,
      collection: makeMinimalCollection(),
      db: makeMinimalDb() as never,
      fileContentProcessor: makeMinimalFileContentProcessor(change),
      fileRecordRepository: {
        findByCollectionId: vi.fn().mockResolvedValue([]),
        upsertFileRecord: vi.fn().mockResolvedValue({ id: change.id }),
      } as never,
      onChunkingBatchStart,
      onProgress: () => {},
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: 10,
        contentReadConcurrency: 1,
        importBatchSize: 1,
      },
      rootId: 'root-db-1',
      setImporting: () => {},
      waitForBackgroundPermit: vi.fn().mockResolvedValue(undefined),
    });

    expect(onChunkingBatchStart).not.toHaveBeenCalled();
  });

  it('does not record redispatch handoff when enhanced import fails before chunking', async () => {
    const change = makeMinimalChange();
    const onChunkingBatchStart = vi.fn();
    vi.mocked(runEnhancedImport).mockImplementationOnce(async ({ baseImportRunner, request }) => {
      await baseImportRunner({
        fileContents: request.fileContents,
        fileTree: request.fileTree,
        onProgress: () => {},
        selectedFilePaths: request.selectedFilePaths,
      });
      throw new Error('model resolution failed before chunking');
    });

    await expect(
      runRootFolderCacheImport({
        abortSignal: new AbortController().signal,
        applyManagedCacheBatch: vi.fn().mockResolvedValue(undefined),
        changes: [change],
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
        } as never,
        collection: makeMinimalCollection(),
        db: makeMinimalDb() as never,
        fileContentProcessor: makeMinimalFileContentProcessor(change),
        fileRecordRepository: {
          findByCollectionId: vi.fn().mockResolvedValue([]),
          upsertFileRecord: vi.fn().mockResolvedValue({ id: change.id }),
        } as never,
        onChunkingBatchStart,
        onProgress: () => {},
        qosPolicy: {
          allowNewWork: true,
          contentReadBatchSize: 10,
          contentReadConcurrency: 1,
          importBatchSize: 1,
        },
        rootId: 'root-db-1',
        setImporting: () => {},
        waitForBackgroundPermit: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow('model resolution failed before chunking');

    expect(onChunkingBatchStart).not.toHaveBeenCalled();
  });

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
        abortSignal: new AbortController().signal,
        applyManagedCacheBatch,
        changes: [change],
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
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
      abortSignal: new AbortController().signal,
      applyManagedCacheBatch,
      changes: [change],
      chunkingWorkerPort: {
        chunkBatch: vi.fn().mockResolvedValue([]),
        chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
        isReady: vi.fn().mockReturnValue(true),
        transportKind: 'local',
      } as never,
      chunkRepository: {
        deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
        deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
        findByFileRecordId: vi.fn().mockResolvedValue([]),
        insertChunks: vi.fn().mockResolvedValue(undefined),
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
    });

    expect(vi.mocked(runEnhancedImport)).toHaveBeenCalledWith(
      expect.objectContaining({
        embedding: expect.objectContaining({
          enabled: true,
          resolveTargetEmbeddingSetId: expect.any(Function),
          targetDimension: collection.dimensions,
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

  it('logs the managed import batch lifecycle and first durable enqueue marker', async () => {
    vi.mocked(runEnhancedImport).mockImplementationOnce(async (params) => {
      const results = await params.baseImportRunner({
        fileContents: params.request.fileContents,
        fileTree: params.request.fileTree,
        onProgress: () => {},
        selectedFilePaths: params.request.selectedFilePaths,
      });
      await params.ports?.sql?.insertChunksAndEnqueueEmbeddingJobs?.(
        [
          {
            chunkIndex: 0,
            chunkSize: 7,
            chunkType: 'sentence',
            content: 'content',
            contentHash: 'chunk-hash-1',
            embeddingSetId: 'collection-1',
            endLine: 1,
            endOffset: 7,
            fileRecordId: 'file-id-a',
            id: 'chunk-1',
            startLine: 1,
            startOffset: 0,
            tokenCount: 1,
          },
        ] as never,
        'file-id-a',
        {
          model: 'local:model-1',
          targetEmbeddingSetId: 'collection-1',
        }
      );
      return results.map((result) => ({ ...result, chunksCreated: 1 }));
    });
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceCollectionSyncImport') {
        captured.push(record);
      }
    });
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const change = makeMinimalChange();

    try {
      await runRootFolderCacheImport({
        abortSignal: new AbortController().signal,
        applyManagedCacheBatch,
        changes: [change],
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
        } as never,
        collection: makeMinimalCollection(),
        db: {
          ...makeMinimalIpcDbWithoutCallbackTransaction(),
          insertChunksAndEnqueueEmbeddingJobs: vi.fn().mockResolvedValue(undefined),
        } as never,
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
      });
    } finally {
      removeListener();
    }

    const messages = captured.map((record) => record.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Workspace Index import batch content read started',
        'Workspace Index import batch managed-cache apply started',
        'Workspace Index import batch chunking started',
        'Workspace Index first durable embed_chunk job enqueued',
        'Workspace Index import batch chunking completed',
        'Workspace Index import batch assignment reconciliation requested',
      ])
    );
    expect(
      messages.indexOf('Workspace Index first durable embed_chunk job enqueued')
    ).toBeGreaterThan(messages.indexOf('Workspace Index import batch chunking started'));
    expect(messages.indexOf('Workspace Index first durable embed_chunk job enqueued')).toBeLessThan(
      messages.indexOf('Workspace Index import batch chunking completed')
    );
  });

  it('skips null-byte content as a per-file import error without poisoning the batch', async () => {
    vi.mocked(runEnhancedImport).mockClear();
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceCollectionSyncImport') {
        captured.push(record);
      }
    });
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const cleanChange = makeMinimalChange();
    const invalidCompositeKey = `${ROOT}::late-null.txt`;
    const invalidChange: PreparedCacheChange = {
      ...makeMinimalChange(),
      compositeKey: invalidCompositeKey,
      contentHash: 'hash-late-null',
      id: 'file-id-late-null',
      name: 'late-null.txt',
      relativePath: 'late-null.txt',
      request: {
        compositeKey: invalidCompositeKey,
        fileNode: makeFileNode('late-null.txt', 620, 1000),
        fileSystemAdapter: {} as FileSystemAdapter,
      },
      size: 620,
    };
    const processFiles = vi.fn(
      async (
        requests: readonly FileContentRequest[]
      ): Promise<Record<string, FileContentResult>> => {
        const contents: Record<string, FileContentResult> = {};
        for (const request of requests) {
          contents[request.compositeKey] = {
            content:
              request.compositeKey === invalidCompositeKey
                ? `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`
                : `content-of-${request.fileNode.path}`,
            status: 'accessible',
          };
        }
        return contents;
      }
    );

    try {
      await runRootFolderCacheImport({
        abortSignal: new AbortController().signal,
        applyManagedCacheBatch,
        changes: [cleanChange, invalidChange],
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
        } as never,
        collection: makeMinimalCollection(),
        db: makeMinimalDb() as never,
        fileContentProcessor: { processFiles } as unknown as FileContentProcessor,
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
      });
    } finally {
      removeListener();
    }

    expect(applyManagedCacheBatch).toHaveBeenCalledOnce();
    expect(applyManagedCacheBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          expect.objectContaining({
            record: expect.objectContaining({ id: cleanChange.id }),
          }),
        ],
      })
    );
    const enhancedImportResult = await vi.mocked(runEnhancedImport).mock.results[0]?.value;
    expect(enhancedImportResult).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: cleanChange.id, imported: true }),
        expect.objectContaining({
          error: 'File contains null bytes and cannot be indexed.',
          id: invalidChange.id,
          imported: false,
        }),
      ])
    );
    expect(captured).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: LogLevel.WARN,
          message: 'Workspace Index skipped file content that cannot be indexed',
        }),
      ])
    );
  });

  it('skips a file that becomes inaccessible between scan and import using its structured status', async () => {
    vi.mocked(runEnhancedImport).mockClear();
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const change = makeMinimalChange();
    const message = '';
    const processFiles = vi.fn(
      async (): Promise<Record<string, FileContentResult>> => ({
        [change.compositeKey]: { message, status: 'inaccessible' },
      })
    );

    await runRootFolderCacheImport({
      abortSignal: new AbortController().signal,
      applyManagedCacheBatch,
      changes: [change],
      chunkingWorkerPort: {
        chunkBatch: vi.fn().mockResolvedValue([]),
        chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
        isReady: vi.fn().mockReturnValue(true),
        transportKind: 'local',
      } as never,
      chunkRepository: {
        deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
        deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
        findByFileRecordId: vi.fn().mockResolvedValue([]),
        insertChunks: vi.fn().mockResolvedValue(undefined),
      } as never,
      collection: makeMinimalCollection(),
      db: makeMinimalDb() as never,
      fileContentProcessor: { processFiles },
      fileRecordRepository: {
        findByCollectionId: vi.fn().mockResolvedValue([]),
        upsertFileRecord: vi.fn().mockResolvedValue({ id: change.id }),
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

    expect(applyManagedCacheBatch).not.toHaveBeenCalled();
    const enhancedImportResult = await vi.mocked(runEnhancedImport).mock.results[0]?.value;
    expect(enhancedImportResult).toEqual([
      expect.objectContaining({ error: message, id: change.id, imported: false }),
    ]);
  });

  it('uses desktop atomic chunk/job enqueue when callback transactions are unavailable', async () => {
    vi.mocked(runEnhancedImport).mockClear();
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      captured.push(record);
    });
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const insertChunksAndEnqueueEmbeddingJobs = vi.fn().mockResolvedValue(undefined);
    const change = makeMinimalChange();
    const collection = makeMinimalCollection();

    try {
      await runRootFolderCacheImport({
        abortSignal: new AbortController().signal,
        applyManagedCacheBatch,
        changes: [change],
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
          insertMany: vi.fn().mockResolvedValue([]),
        } as never,
        collection,
        db: {
          ...makeMinimalIpcDbWithoutCallbackTransaction(),
          insertChunksAndEnqueueEmbeddingJobs,
        } as never,
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
      });
    } finally {
      removeListener();
    }

    const enhancedImportCall = vi.mocked(runEnhancedImport).mock.calls[0]?.[0];
    expect(enhancedImportCall).toEqual(
      expect.objectContaining({
        ports: expect.objectContaining({
          embeddingQueue: expect.objectContaining({
            enqueueBatch: expect.any(Function),
          }),
          sql: expect.objectContaining({
            insertChunksAndEnqueueEmbeddingJobs: expect.any(Function),
          }),
        }),
      })
    );
    await enhancedImportCall?.ports?.sql?.insertChunksAndEnqueueEmbeddingJobs?.([], 'file-id-a', {
      model: collection.modelKey,
      targetEmbeddingSetId: collection.id,
    });
    expect(insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith([], 'file-id-a', {
      model: collection.modelKey,
      targetEmbeddingSetId: collection.id,
    });
    expect(captured).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            'Workspace Index import DB handle does not expose callback transactions; chunk/job recovery relies on backfill reconciliation.',
        }),
      ])
    );
  });

  it('rejects DB handles without atomic chunk/job enqueue support before import starts', async () => {
    vi.mocked(runEnhancedImport).mockClear();
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const change = makeMinimalChange();

    await expect(
      runRootFolderCacheImport({
        abortSignal: new AbortController().signal,
        applyManagedCacheBatch,
        changes: [change],
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
        } as never,
        collection: makeMinimalCollection(),
        db: makeMinimalIpcDbWithoutCallbackTransaction() as never,
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
    ).rejects.toThrow(TRANSACTIONAL_ENQUEUE_REQUIRED_ERROR);

    expect(runEnhancedImport).not.toHaveBeenCalled();
    expect(applyManagedCacheBatch).not.toHaveBeenCalled();
  });

  it('logs managed-cache batch failures with root-relative file context', async () => {
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceCollectionSyncImport') {
        captured.push(record);
      }
    });
    const dbTimeout = new Error(
      "Error invoking remote method 'db:query': Error: DB host request timed out: query"
    );
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {
        throw dbTimeout;
      }
    );
    const firstChange = makeMinimalChange();
    const secondCompositeKey = `${ROOT}::nested/b.ts`;
    const secondChange: PreparedCacheChange = {
      ...makeMinimalChange(),
      compositeKey: secondCompositeKey,
      contentHash: 'hash-b',
      id: 'file-id-b',
      name: 'b.ts',
      relativePath: 'nested/b.ts',
      request: {
        compositeKey: secondCompositeKey,
        fileNode: makeFileNode('nested/b.ts', 50, 1001),
        fileSystemAdapter: {} as FileSystemAdapter,
      },
      size: 50,
    };

    try {
      await runRootFolderCacheImport({
        abortSignal: new AbortController().signal,
        applyManagedCacheBatch,
        changes: [firstChange, secondChange],
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
        } as never,
        collection: makeMinimalCollection(),
        db: makeMinimalDb() as never,
        fileContentProcessor: makeMinimalFileContentProcessor(firstChange),
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
      });

      const failureLog = captured.find((record) =>
        record.message?.includes('Workspace Index managed-cache batch import failed')
      );
      expect(failureLog).toBeDefined();
      expect(failureLog?.args ?? []).toContainEqual(
        expect.objectContaining({
          batchFileCount: 2,
          collectionId: 'collection-1',
          error: dbTimeout.message,
          mutationModes: { import: 2, replace: 0 },
          rootId: 'root-db-1',
          sampleRelativePaths: ['a.ts', 'nested/b.ts'],
        })
      );
    } finally {
      removeListener();
    }
  });

  it.each(['callback-owned content', ''])(
    'imports callback-supplied content %j with the durable rootId',
    async (selectedContent) => {
      vi.mocked(runEnhancedImport).mockImplementationOnce(async (params) => {
        const results = await params.baseImportRunner({
          fileContents: { [COMPOSITE_KEY]: selectedContent },
          fileTree: params.request.fileTree,
          onProgress: () => {},
          selectedFilePaths: params.request.selectedFilePaths,
        });
        return results.map((result) => ({ ...result, chunksCreated: 0 }));
      });
      const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
        async () => {}
      );
      const change = makeMinimalChange();
      const collection = makeMinimalCollection();

      await runRootFolderCacheImport({
        abortSignal: new AbortController().signal,
        applyManagedCacheBatch,
        changes: [change],
        chunkingWorkerPort: {
          chunkBatch: vi.fn().mockResolvedValue([]),
          chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
          isReady: vi.fn().mockReturnValue(true),
          transportKind: 'local',
        } as never,
        chunkRepository: {
          deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
          deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
          findByFileRecordId: vi.fn().mockResolvedValue([]),
          insertChunks: vi.fn().mockResolvedValue(undefined),
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
      });

      expect(applyManagedCacheBatch).toHaveBeenCalledOnce();
      expect(applyManagedCacheBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          changes: [
            expect.objectContaining({
              record: expect.objectContaining({ content: selectedContent }),
            }),
          ],
          rootId: 'root-db-1',
        })
      );
    }
  );

  it('passes rootId: null to applyManagedCacheBatch when rootId is absent', async () => {
    const applyManagedCacheBatch = vi.fn<(args: ApplyManagedCacheBatchArgs) => Promise<void>>(
      async () => {}
    );
    const change = makeMinimalChange();
    const collection = makeMinimalCollection();

    await runRootFolderCacheImport({
      abortSignal: new AbortController().signal,
      applyManagedCacheBatch,
      changes: [change],
      chunkingWorkerPort: {
        chunkBatch: vi.fn().mockResolvedValue([]),
        chunkFile: vi.fn().mockResolvedValue({ chunks: [] }),
        isReady: vi.fn().mockReturnValue(true),
        transportKind: 'local',
      } as never,
      chunkRepository: {
        deleteByFileRecordId: vi.fn().mockResolvedValue(undefined),
        deleteChunksByFileRecordId: vi.fn().mockResolvedValue(undefined),
        findByFileRecordId: vi.fn().mockResolvedValue([]),
        insertChunks: vi.fn().mockResolvedValue(undefined),
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
      // rootId deliberately absent
      setImporting: () => {},
      waitForBackgroundPermit: vi.fn().mockResolvedValue(undefined),
    });

    expect(applyManagedCacheBatch).toHaveBeenCalledOnce();
    expect(applyManagedCacheBatch).toHaveBeenCalledWith(expect.objectContaining({ rootId: null }));
  });
});
