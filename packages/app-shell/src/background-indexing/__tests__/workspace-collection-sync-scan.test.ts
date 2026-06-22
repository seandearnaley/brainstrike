import { describe, expect, it } from 'vitest';
import { __workspaceCollectionSyncScanInternalsForTests } from '../workspace-collection-sync-scan';

describe('workspace collection sync scan path helpers', () => {
  it('extracts names and depths without changing split/filter path semantics', () => {
    const cases = [
      { path: 'src/index.ts', depth: 2, name: 'index.ts' },
      { path: '/src//components/Button.tsx/', depth: 3, name: 'Button.tsx' },
      { path: 'README.md', depth: 1, name: 'README.md' },
      { path: '', depth: 0, name: '' },
      { path: '///', depth: 0, name: '///' },
    ];

    for (const { path, depth, name } of cases) {
      expect(
        __workspaceCollectionSyncScanInternalsForTests.countRelativePathSegments(path),
        path
      ).toBe(depth);
      expect(__workspaceCollectionSyncScanInternalsForTests.getPathName(path), path).toBe(name);
    }
  });
});
