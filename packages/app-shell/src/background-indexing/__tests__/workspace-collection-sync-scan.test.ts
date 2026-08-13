import { describe, expect, it } from 'vitest';
import { __workspaceCollectionSyncScanInternalsForTests } from '../workspace-collection-sync-scan';

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
