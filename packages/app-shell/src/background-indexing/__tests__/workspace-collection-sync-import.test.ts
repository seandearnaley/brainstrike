import type { ManagedCacheEntryMetadata } from '@brainstrike/db';
import type { FileContentProcessor, FileContentRequest } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/utils/logger';
import { describe, expect, it, vi } from 'vitest';
import { buildRootFolderCacheIdentityKey } from '../root-folder-cache-reconciliation';
import {
  collectPreparedChangesInBatches,
  partitionPreparationsByStatCache,
} from '../workspace-collection-sync-import';

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
    embeddingSetId: 'set-1',
    fileRecordId: `rec-${relativePath}`,
    mtimeMs: 1000,
    relativePath,
    size: 42,
    sourceRootPath: ROOT,
    updatedAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  };
}

function existingByIdentity(
  entries: readonly ManagedCacheEntryMetadata[]
): Map<string, ManagedCacheEntryMetadata> {
  return new Map(
    entries.map((entry) => [
      buildRootFolderCacheIdentityKey(entry.sourceRootPath, entry.relativePath),
      entry,
    ])
  );
}

describe('partitionPreparationsByStatCache', () => {
  it('skips files whose size AND mtime both match the stored entry', () => {
    const preparations = [prep('a.ts', 42, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { size: 42, mtimeMs: 1000 })]),
      preparations,
      rootPath: ROOT,
    });

    expect(result.skippedUnchanged).toEqual(preparations);
    expect(result.needsRead).toEqual([]);
  });

  it('reads files whose size matches but mtime differs', () => {
    const preparations = [prep('a.ts', 42, 2000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { size: 42, mtimeMs: 1000 })]),
      preparations,
      rootPath: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files whose mtime matches but size differs', () => {
    const preparations = [prep('a.ts', 99, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { size: 42, mtimeMs: 1000 })]),
      preparations,
      rootPath: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files with no existing cache entry', () => {
    const preparations = [prep('new.ts', 42, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([]),
      preparations,
      rootPath: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files when the stored entry predates the mtime column (null mtimeMs)', () => {
    const preparations = [prep('a.ts', 42, 1000)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { size: 42, mtimeMs: null })]),
      preparations,
      rootPath: ROOT,
    });

    expect(result.skippedUnchanged).toEqual([]);
    expect(result.needsRead).toEqual(preparations);
  });

  it('reads files when the scan did not capture an mtime (null prep mtime)', () => {
    const preparations = [prep('a.ts', 42, null)];
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([existingEntry('a.ts', { size: 42, mtimeMs: 1000 })]),
      preparations,
      rootPath: ROOT,
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
      sourceRootPath: ROOT,
      updatedAt: '2026-06-09T00:00:00.000Z',
    };
    const result = partitionPreparationsByStatCache({
      existingByIdentity: existingByIdentity([noSizeEntry]),
      preparations,
      rootPath: ROOT,
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
      rootPath: ROOT,
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
        existingEntry('unchanged.ts', { size: 42, mtimeMs: 1000, contentHash: 'stale-hash' }),
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
      rootPath: ROOT,
    });

    expect(readPaths()).toEqual([`${ROOT}/fresh.ts`]);
    expect(result.unchangedCount).toBe(1);
    expect(result.changes.map((change) => change.relativePath)).toEqual(['fresh.ts']);
    expect(result.totalFiles).toBe(2);
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
      rootPath: ROOT,
    });

    expect(readPaths()).toEqual([]);
    expect(result.unchangedCount).toBe(1);
    expect(result.changes).toEqual([]);
  });
});
