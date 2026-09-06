import { describe, expect, it } from 'vitest';
import { __workspaceCollectionSyncScanInternalsForTests } from '../workspace-collection-sync-scan';
import { toRootAnchoredPath, toRootRelativePath } from '../workspace-collection-sync-scan-paths';

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

describe('scoped scan root anchoring', () => {
  it('anchors web cache identities without doubling and joins desktop relatives', () => {
    const cases = [
      // Web: identity is already root-anchored -> returned unchanged.
      { anchored: 'workspace/fresh.md', identity: 'workspace/fresh.md', root: 'workspace' },
      // Web, child directory sharing the root's name: still already anchored.
      {
        anchored: 'workspace/workspace/a.ts',
        identity: 'workspace/workspace/a.ts',
        root: 'workspace',
      },
      // Web, a genuinely root-relative identity still gets joined.
      { anchored: 'workspace/fresh.md', identity: 'fresh.md', root: 'workspace' },
      // Desktop: absolute root, identity is root-relative -> joined.
      {
        anchored: '/workspace/root/nested/a.ts',
        identity: 'nested/a.ts',
        root: '/workspace/root',
      },
      // Trailing slashes on the root must not defeat the anchoring check.
      { anchored: 'workspace/fresh.md', identity: 'workspace/fresh.md', root: 'workspace/' },
    ];
    for (const { root, identity, anchored } of cases) {
      expect(toRootAnchoredPath(root, identity), `${root} + ${identity}`).toBe(anchored);
    }
  });

  it('computes the path relative to the root handle', () => {
    const cases = [
      { nodePath: 'workspace/fresh.md', relative: 'fresh.md', root: 'workspace' },
      // The root-named child keeps its inner segment.
      { nodePath: 'workspace/workspace/a.ts', relative: 'workspace/a.ts', root: 'workspace' },
      { nodePath: '/workspace/root/nested/a.ts', relative: 'nested/a.ts', root: '/workspace/root' },
      // The root itself has no relative path.
      { nodePath: 'workspace', relative: '', root: 'workspace' },
      // Already relative -> unchanged.
      { nodePath: 'fresh.md', relative: 'fresh.md', root: 'workspace' },
    ];
    for (const { root, nodePath, relative } of cases) {
      expect(toRootRelativePath(root, nodePath), `${root} + ${nodePath}`).toBe(relative);
    }
  });
});
