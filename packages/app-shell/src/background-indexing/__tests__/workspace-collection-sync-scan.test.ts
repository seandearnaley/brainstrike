import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { ChunkingRedispatchTracker } from '../workspace-collection-sync-import';
import {
  __workspaceCollectionSyncScanInternalsForTests,
  collectPreparedWorkspaceSyncChanges,
} from '../workspace-collection-sync-scan';
import { BALANCED_QOS_POLICY } from './workspace-collection-sync-service-test-helpers';

describe('workspace collection sync scan path helpers', () => {
  it('extracts names and depths without changing split/filter path semantics', () => {
    const cases = [
      { depth: 2, name: 'index.ts', path: 'src/index.ts' },
      { depth: 3, name: 'Button.tsx', path: '/src//components/Button.tsx/' },
      { depth: 1, name: 'README.md', path: 'README.md' },
      { depth: 0, name: '', path: '' },
      { depth: 0, name: '///', path: '///' },
    ];

    for (const { path, depth, name } of cases) {
      expect(
        __workspaceCollectionSyncScanInternalsForTests.countRelativePathSegments(path),
        path
      ).toBe(depth);
      expect(__workspaceCollectionSyncScanInternalsForTests.getPathName(path), path).toBe(name);
    }
  });

  it('does not exact-invalidate entries under a truncated directory listing', () => {
    // Third branch of the scoped removal reconciliation: a removed directory
    // with live descendants invalidates cached entries that were not observed
    // live. A truncated re-listing hides entries past the cap, so their
    // absence from the live set is not evidence of deletion.
    const targets =
      __workspaceCollectionSyncScanInternalsForTests.collectScopedRemovalInvalidations({
        existingEntries: [
          {
            contentHash: 'hash-a',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-a',
            mtimeMs: 1,
            relativePath: 'big/a.ts',
            rootId: 'root-1',
            size: 1,
            updatedAt: '2026-08-13T00:00:00.000Z',
          },
          {
            contentHash: 'hash-z',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-z',
            mtimeMs: 1,
            relativePath: 'big/z.ts',
            rootId: 'root-1',
            size: 1,
            updatedAt: '2026-08-13T00:00:00.000Z',
          },
        ],
        liveFilePaths: new Set(['big/a.ts']),
        pendingRemovals: [
          {
            change: { kind: 'directory', path: '/workspace/root/big', type: 'removed' },
            relativePath: 'big',
          },
        ],
        rootId: 'root-1',
        truncatedDirectoryPrefixes: ['big'],
      });
    expect(targets).toEqual([]);

    const untruncated =
      __workspaceCollectionSyncScanInternalsForTests.collectScopedRemovalInvalidations({
        existingEntries: [
          {
            contentHash: 'hash-z',
            embeddingSetId: 'set-1',
            fileRecordId: 'file-z',
            mtimeMs: 1,
            relativePath: 'big/z.ts',
            rootId: 'root-1',
            size: 1,
            updatedAt: '2026-08-13T00:00:00.000Z',
          },
        ],
        liveFilePaths: new Set(['big/a.ts']),
        pendingRemovals: [
          {
            change: { kind: 'directory', path: '/workspace/root/big', type: 'removed' },
            relativePath: 'big',
          },
        ],
        rootId: 'root-1',
        truncatedDirectoryPrefixes: [],
      });
    expect(untruncated).toEqual([
      expect.objectContaining({ mode: 'exact', relativePath: 'big/z.ts' }),
    ]);
  });

  it('iterates relative path segments without materializing split/filter arrays', () => {
    const cases = [
      { path: 'src/components/Button.tsx', segments: ['src', 'components', 'Button.tsx'] },
      { path: '/src//components/Button.tsx/', segments: ['src', 'components', 'Button.tsx'] },
      { path: 'README.md', segments: ['README.md'] },
      { path: '', segments: [] },
      { path: '///', segments: [] },
    ];

    for (const { path, segments } of cases) {
      expect([
        ...__workspaceCollectionSyncScanInternalsForTests.iterRelativePathSegments(path),
      ]).toEqual(segments);
    }
  });
});

describe('workspace collection scoped traversal', () => {
  it('preserves the durable rootId on rebuilt directory handles', async () => {
    const rootHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
      rootId: 'outer-root-id',
    };
    const readDirectory = vi.fn(async (handle: DirectoryHandle): Promise<IFileNode[]> => {
      if (handle.path === rootHandle.path) {
        return [
          {
            children: [],
            depth: 0,
            handle: {
              kind: 'directory',
              name: 'nested-root',
              path: '/workspace/root/nested-root',
              platform: 'electron',
              rootId: 'outer-root-id',
            } as unknown as IFileNode['handle'],
            name: 'nested-root',
            path: '/workspace/root/nested-root',
            rootFolderId: 'outer-root-id',
            selectionState: 'unchecked',
            type: 'directory',
          },
        ];
      }
      return [];
    });
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;

    await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: rootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'outer-root-id',
        rootPath: rootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [
            {
              kind: 'directory',
              path: '/workspace/root/nested-root',
              type: 'modified',
            },
          ],
          mode: 'paths',
        },
      },
    });

    expect(readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/root/nested-root',
        rootId: 'outer-root-id',
      }),
      expect.any(Object)
    );
  });
});
