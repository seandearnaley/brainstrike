import { encodeFileSelection, isPathSelectedInFolder } from '@brainstrike/file-explorer/selection';
import {
  createEmptySelectionModel,
  type FileExplorerState,
  type IFileNode,
  type QuerySelectionManifest,
  type SelectionModel,
  type SelectionQueryDescriptor,
} from '@brainstrike/types';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  collectTreePaths,
  createSelectedPathAncestorResolver,
  getWorkspaceSelectionPathCandidates,
  isSameOrDescendantSelectionPath,
  isWorkspaceNodeSelected,
  useSelectedDirectoryCounts,
} from '../optimized-file-tree-selection-counts';

const folderId = '/workspace/project';

function createSelectionKey(path: string): string {
  return `${folderId}|@|${path}`;
}

function createExplicitSelectionModel(): SelectionModel {
  return createEmptySelectionModel();
}

function createQueryDescriptor(
  overrides: Partial<SelectionQueryDescriptor> = {}
): SelectionQueryDescriptor {
  return {
    coveredDirectoryPaths: [],
    excludedPaths: [],
    excludeFilters: [],
    folderId,
    includedPaths: [],
    includeFilters: [],
    kind: 'recursive-folder',
    manifestFingerprint: 'fingerprint',
    manifestSnapshotId: 'snapshot',
    rootPath: 'src',
    totalSelectedCount: 1,
    useRegex: false,
    ...overrides,
  };
}

describe('optimized file tree selection counts', () => {
  describe('selected path ancestor resolver cache identity', () => {
    it('returns the input cache by identity when no paths were resolved', () => {
      const inputCache = new Map<string, string[]>();
      const resolver = createSelectedPathAncestorResolver(folderId, inputCache);

      expect(resolver.getResolvedCache()).toBe(inputCache);
    });

    it('returns a clone after a cache hit without mutating the input cache', () => {
      const firstAncestors = ['src'];
      const secondAncestors = ['docs'];
      const inputCache = new Map<string, string[]>([
        ['src/index.ts', firstAncestors],
        ['docs/guide.md', secondAncestors],
      ]);
      const resolver = createSelectedPathAncestorResolver(folderId, inputCache);

      expect(resolver.getAncestorPaths('src/index.ts')).toBe(firstAncestors);

      const resolvedCache = resolver.getResolvedCache();
      const secondResolvedCache = resolver.getResolvedCache();
      expect(resolvedCache).not.toBe(inputCache);
      expect(secondResolvedCache).not.toBe(resolvedCache);
      expect([...inputCache.keys()]).toEqual(['src/index.ts', 'docs/guide.md']);
      expect([...resolvedCache.keys()]).toEqual(['docs/guide.md', 'src/index.ts']);
      expect([...secondResolvedCache.keys()]).toEqual(['docs/guide.md', 'src/index.ts']);
    });

    it('keeps one cloned working cache identity across misses', () => {
      const inputCache = new Map<string, string[]>();
      const resolver = createSelectedPathAncestorResolver(folderId, inputCache);

      resolver.getAncestorPaths('src/index.ts');
      const firstResolvedCache = resolver.getResolvedCache();
      resolver.getAncestorPaths('docs/guide.md');

      expect(resolver.getResolvedCache()).toBe(firstResolvedCache);
      expect(inputCache.size).toBe(0);
      expect([...firstResolvedCache.keys()]).toEqual(['src/index.ts', 'docs/guide.md']);
    });
  });

  it('returns absolute, rooted-relative, and bare-relative selection candidates', () => {
    expect(
      getWorkspaceSelectionPathCandidates(folderId, '/workspace/project/src/index.ts')
    ).toEqual(['/workspace/project/src/index.ts', '/src/index.ts', 'src/index.ts']);
    expect(getWorkspaceSelectionPathCandidates(folderId, '/outside/index.ts')).toEqual([
      '/outside/index.ts',
    ]);
    expect(getWorkspaceSelectionPathCandidates('relative-root', 'src/index.ts')).toEqual([
      'src/index.ts',
    ]);
  });

  it.each([
    { candidatePath: '', expected: true, path: 'src/index.ts' },
    { candidatePath: '/', expected: true, path: '/workspace/project/src/index.ts' },
    { candidatePath: '/', expected: false, path: 'workspace/project/src/index.ts' },
    { candidatePath: 'src', expected: true, path: 'src/index.ts' },
    { candidatePath: 'src/', expected: true, path: 'src/index.ts' },
    { candidatePath: 'src', expected: false, path: 'source/index.ts' },
    { candidatePath: 'C:\\repo\\src', expected: true, path: 'C:/repo/src/index.ts' },
  ])(
    'checks descendant selection paths for $candidatePath',
    ({ candidatePath, expected, path }) => {
      expect(isSameOrDescendantSelectionPath(path, candidatePath)).toBe(expected);
    }
  );

  it('matches workspace selections through absolute and relative candidates', () => {
    const selectedFilePaths = new Set([
      createSelectionKey('src/index.ts'),
      createSelectionKey('/docs/guide.md'),
    ]);

    expect(
      isWorkspaceNodeSelected(selectedFilePaths, folderId, {
        path: '/workspace/project/src/index.ts',
      })
    ).toBe(true);
    expect(
      isWorkspaceNodeSelected(selectedFilePaths, folderId, {
        path: '/workspace/project/docs/guide.md',
      })
    ).toBe(true);
    expect(
      isWorkspaceNodeSelected(selectedFilePaths, folderId, {
        path: '/workspace/project/src/other.ts',
      })
    ).toBe(false);
  });

  it.each([
    ['/workspace/project', '/workspace/project/src/index.ts'],
    ['C:\\repo', 'C:\\repo\\src\\index.ts'],
  ])('matches canonical selection membership for %s aliases', (currentFolderId, path) => {
    const node = { path };
    const candidates = getWorkspaceSelectionPathCandidates(currentFolderId, path);
    const selections = [
      new Set<string>(),
      new Set([encodeFileSelection('other-root', path)]),
      new Set([encodeFileSelection(currentFolderId, `${path}/`)]),
      ...candidates.map((candidate) => new Set([encodeFileSelection(currentFolderId, candidate)])),
    ];

    // Keep one node through every selection revision to cover the cached path
    // as well as its first read. The core predicate is the membership oracle.
    for (const selected of selections) {
      const expected = candidates.some((candidate) =>
        isPathSelectedInFolder(selected, currentFolderId, candidate)
      );
      expect(isWorkspaceNodeSelected(selected, currentFolderId, node)).toBe(expected);
    }
  });

  it('collects paths from a nested tree', () => {
    const pathSet = new Set<string>();
    const nodes: IFileNode[] = [
      {
        children: [
          {
            name: 'index.ts',
            path: 'src/index.ts',
            type: 'file',
          } as IFileNode,
        ],
        name: 'src',
        path: 'src',
        type: 'directory',
      } as IFileNode,
    ];

    collectTreePaths(nodes, pathSet);

    expect([...pathSet].sort()).toEqual(['src', 'src/index.ts']);
  });

  it('builds and diffs selected directory counts for explicit selections', () => {
    const selectionModel = createExplicitSelectionModel();
    const firstSelection = new Set([
      createSelectionKey('src/components/Button.tsx'),
      createSelectionKey('src/index.ts'),
      '/other-folder|@|src/ignored.ts',
      createSelectionKey(''),
    ]);
    const nextSelection = new Set([
      createSelectionKey('src/index.ts'),
      createSelectionKey('docs/guide.md'),
    ]);

    const { result, rerender } = renderHook(
      ({ selectedFilePaths }) =>
        useSelectedDirectoryCounts(selectedFilePaths, folderId, selectionModel, null),
      {
        initialProps: {
          selectedFilePaths: firstSelection,
        },
      }
    );

    expect(result.current.get('')).toBe(2);
    expect(result.current.get('src')).toBe(2);
    expect(result.current.get('src/components')).toBe(1);
    expect(result.current.get('/workspace/project')).toBe(2);
    expect(result.current.get('/workspace/project/src')).toBe(2);

    const stableCounts = result.current;
    rerender({ selectedFilePaths: firstSelection });
    expect(result.current).toBe(stableCounts);

    rerender({ selectedFilePaths: nextSelection });

    expect(result.current.get('')).toBe(2);
    expect(result.current.get('src')).toBe(1);
    expect(result.current.get('src/components')).toBeUndefined();
    expect(result.current.get('docs')).toBe(1);
    expect(result.current.get('/workspace/project/src')).toBe(1);
    expect(result.current.get('/workspace/project/docs')).toBe(1);
  });

  it('clears counts when folder id changes to an empty value', () => {
    const selectionModel = createExplicitSelectionModel();
    const selectedFilePaths = new Set([createSelectionKey('src/index.ts')]);
    const { result, rerender } = renderHook(
      ({ currentFolderId }) =>
        useSelectedDirectoryCounts(selectedFilePaths, currentFolderId, selectionModel, null),
      {
        initialProps: {
          currentFolderId: folderId,
        },
      }
    );

    expect(result.current.size).toBeGreaterThan(0);

    rerender({ currentFolderId: '' });

    expect(result.current.size).toBe(0);
  });

  it('rebuilds observable counts when the active folder changes', () => {
    const selectionModel = createExplicitSelectionModel();
    const firstFolderId = '/workspace/first-project';
    const nextFolderId = '/workspace/next-project';
    const firstSelectedFilePaths = new Set([`${firstFolderId}|@|src/first.ts`]);
    const nextSelectedFilePaths = new Set([`${nextFolderId}|@|docs/next.md`]);
    const { result, rerender } = renderHook(
      ({ currentFolderId, selectedFilePaths }) =>
        useSelectedDirectoryCounts(selectedFilePaths, currentFolderId, selectionModel, null),
      {
        initialProps: {
          currentFolderId: firstFolderId,
          selectedFilePaths: firstSelectedFilePaths,
        },
      }
    );

    expect(result.current.get('src')).toBe(1);

    rerender({
      currentFolderId: nextFolderId,
      selectedFilePaths: nextSelectedFilePaths,
    });

    expect(result.current.get('src')).toBeUndefined();
    expect(result.current.get('docs')).toBe(1);
    expect(result.current.get(nextFolderId)).toBe(1);
    expect(result.current.get(firstFolderId)).toBeUndefined();
  });

  it('returns query manifest directory counts in query selection mode', () => {
    const queryDirectoryCounts = new Map([['src', 3]]);
    const queryDescriptor = createQueryDescriptor({
      includedPaths: ['src/index.ts'],
      totalSelectedCount: 3,
    });
    const selectionModel: FileExplorerState['selectionModel'] = {
      ...createEmptySelectionModel(),
      mode: 'query',
      queryDescriptor,
    };
    const querySelectionManifest: QuerySelectionManifest = {
      directoryCounts: queryDirectoryCounts,
      errorMessage: null,
      filePaths: ['src/index.ts'],
      fingerprint: 'fingerprint',
      pathSet: new Set(['src/index.ts']),
      snapshotId: 'snapshot',
      status: 'ready',
    };

    const { result } = renderHook(() =>
      useSelectedDirectoryCounts(new Set(), folderId, selectionModel, querySelectionManifest)
    );

    expect(result.current).toEqual(queryDirectoryCounts);
  });
});
