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
