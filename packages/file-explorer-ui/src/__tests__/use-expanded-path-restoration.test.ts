import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __getAllAncestorDirectories,
  __resetRestorationLock,
  MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS,
  useExpandedPathRestoration,
  useExpandSelectedFileParentDirectories,
} from '../use-expanded-path-restoration';

function createDirectoryNode(path: string): IFileNode {
  return {
    children: [],
    depth: path.split('/').filter(Boolean).length,
    handle: {} as IFileNode['handle'],
    name: path.split('/').pop() ?? path,
    path,
    rootFolderId: '/workspace',
    selectionState: 'unchecked',
    type: 'directory',
  } satisfies IFileNode;
}

function createStoreState(overrides: Partial<FileExplorerState> = {}): FileExplorerState {
  return {
    expandedDirectoryPaths: new Set<string>(),
    selectedFilePaths: new Set<string>(),
    selectionModel: {
      explicitPaths: new Set<string>(),
      materializedAt: null,
      materializedPaths: null,
      mode: 'explicit',
      queryDescriptor: null,
    },
    ...overrides,
  } as FileExplorerState;
}

describe('useExpandedPathRestoration', () => {
  beforeEach(() => {
    __resetRestorationLock();
  });

  it('uses a stable folder-scoped restoration key without re-running on selection changes', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set(['src']),
        })
      ),
    };

    const { rerender } = renderHook(
      (props: { restorationKey: string }) =>
        useExpandedPathRestoration({
          currentRootFolderId: '/workspace',
          fileTree: [createDirectoryNode('src')],
          isTreeLoading: false,
          loadSpecificPaths,
          restorationKey: props.restorationKey,
          setExpandedPaths,
          store,
        }),
      { initialProps: { restorationKey: '/workspace' } }
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledTimes(1);
    });

    rerender({ restorationKey: '/workspace' });

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledTimes(1);
    });
  });

  it('restores persisted expanded directories after the root folder is available', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set(['src', 'src/components']),
        })
      ),
    };

    renderHook(() =>
      useExpandedPathRestoration({
        currentRootFolderId: '/workspace',
        fileTree: [createDirectoryNode('src')],
        isTreeLoading: false,
        loadSpecificPaths,
        restorationKey: '/workspace',
        setExpandedPaths,
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(
        ['src', 'src/components'],
        expect.any(Function)
      );
      expect(setExpandedPaths).toHaveBeenCalledWith(new Set(['src', 'src/components']));
    });
  });

  it('restores only paths owned by the current root in a multi-root workspace', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set([
            '/workspace-a/src',
            '/workspace-a/src/components',
            '/workspace-b/downloads',
          ]),
        })
      ),
    };

    renderHook(() =>
      useExpandedPathRestoration({
        currentRootFolderId: 'root-a',
        currentRootPath: '/workspace-a',
        fileTree: [createDirectoryNode('/workspace-a/src')],
        isTreeLoading: false,
        loadSpecificPaths,
        restorationKey: 'root-a',
        setExpandedPaths,
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(
        ['/workspace-a/src', '/workspace-a/src/components'],
        expect.any(Function)
      );
    });
  });

  it('restores root-relative web paths without loading stale absolute paths', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set(['src', 'src/components', '/other-workspace/downloads']),
        })
      ),
    };

    renderHook(() =>
      useExpandedPathRestoration({
        currentRootFolderId: 'web-root-id',
        currentRootPath: 'workspace',
        fileTree: [createDirectoryNode('src')],
        isTreeLoading: false,
        loadSpecificPaths,
        restorationKey: 'web-root-id',
        setExpandedPaths,
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(
        ['src', 'src/components'],
        expect.any(Function)
      );
      expect(setExpandedPaths).toHaveBeenCalledWith(
        new Set(['src', 'src/components', '/other-workspace/downloads'])
      );
    });
  });

  it('restores Windows descendants without loading paths from another root', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set([
            'C:\\repo\\src',
            'C:\\repo\\src\\components',
            'D:\\other-workspace\\downloads',
          ]),
          selectedFilePaths: new Set(['root-a|@|C:\\repo\\src\\components\\Button.tsx']),
        })
      ),
    };

    renderHook(() =>
      useExpandedPathRestoration({
        currentRootFolderId: 'root-a',
        currentRootPath: 'c:\\repo',
        fileTree: [createDirectoryNode('C:\\repo\\src')],
        isTreeLoading: false,
        loadSpecificPaths,
        restorationKey: 'root-a',
        setExpandedPaths,
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(
        ['C:\\repo', 'C:\\repo\\src', 'C:\\repo\\src\\components'],
        expect.any(Function)
      );
      expect(setExpandedPaths).toHaveBeenCalledWith(
        new Set([
          'C:\\repo',
          'C:\\repo\\src',
          'C:\\repo\\src\\components',
          'D:\\other-workspace\\downloads',
        ])
      );
    });
  });

  it.each([
    {
      currentRootFolderId: 'posix-root',
      currentRootPath: '/',
      expectedPaths: ['/src', '/src/components'],
    },
    {
      currentRootFolderId: 'windows-drive-root',
      currentRootPath: 'C:\\',
      expectedPaths: ['C:\\repo', 'C:\\repo\\src'],
    },
    {
      currentRootFolderId: 'unc-share-root',
      currentRootPath: '\\\\server\\share\\',
      expectedPaths: ['\\\\server\\share\\repo', '\\\\server\\share\\repo\\src'],
    },
  ])('restores descendants when $currentRootPath is the selected filesystem root', async ({
    currentRootFolderId,
    currentRootPath,
    expectedPaths,
  }) => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set(expectedPaths),
        })
      ),
    };

    renderHook(() =>
      useExpandedPathRestoration({
        currentRootFolderId,
        currentRootPath,
        fileTree: [createDirectoryNode(expectedPaths[0] ?? currentRootPath)],
        isTreeLoading: false,
        loadSpecificPaths,
        restorationKey: currentRootFolderId,
        setExpandedPaths: vi.fn(),
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(expectedPaths, expect.any(Function));
    });
  });

  it('does not restore a drive-relative sentinel beneath a Windows drive root', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set(['C:\\repo', 'C:\\repo\\src']),
          selectedFilePaths: new Set(['windows-drive-root|@|C:\\repo\\src\\Button.tsx']),
        })
      ),
    };

    renderHook(() =>
      useExpandedPathRestoration({
        currentRootFolderId: 'windows-drive-root',
        currentRootPath: 'C:\\',
        fileTree: [createDirectoryNode('C:\\repo')],
        isTreeLoading: false,
        loadSpecificPaths,
        restorationKey: 'windows-drive-root',
        setExpandedPaths,
        store,
      })
    );

    const expectedPaths = ['C:\\repo', 'C:\\repo\\src'];
    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(expectedPaths, expect.any(Function));
      expect(setExpandedPaths).toHaveBeenCalledWith(new Set(expectedPaths));
    });
  });

  it('bounds automatic restoration and reports the folders kept collapsed', async () => {
    let resolveRestoration: (() => void) | undefined;
    const loadSpecificPaths = vi.fn<
      (
        paths: string[],
        onProgress?: (loaded: number, total: number, currentPath: string) => void
      ) => Promise<void>
    >(
      (_paths) =>
        new Promise<void>((resolve) => {
          resolveRestoration = resolve;
        })
    );
    const rootPaths = Array.from(
      { length: MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS + 25 },
      (_, index) => `/workspace/directory-${index.toString().padStart(4, '0')}`
    );
    const crossRootPath = '/other-workspace/preserved';
    const storeState = createStoreState({
      expandedDirectoryPaths: new Set([...rootPaths, crossRootPath]),
    });
    const store = {
      getState: vi.fn(() => storeState),
    };
    const setExpandedPaths = vi.fn((paths: Set<string>) => {
      storeState.expandedDirectoryPaths = paths;
    });

    const { result } = renderHook(() =>
      useExpandedPathRestoration({
        currentRootFolderId: 'root-a',
        currentRootPath: '/workspace',
        fileTree: [createDirectoryNode(rootPaths[0] ?? '/workspace/directory-0000')],
        isTreeLoading: false,
        loadSpecificPaths,
        restorationKey: 'root-a',
        setExpandedPaths,
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledTimes(1);
    });
    const restoredPaths = loadSpecificPaths.mock.calls[0]?.[0] ?? [];
    expect(restoredPaths).toHaveLength(MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS);
    expect(restoredPaths.every((path) => path.startsWith('/workspace/'))).toBe(true);
    expect(result.current.restorationProgress).toMatchObject({
      loaded: 0,
      omitted: 25,
      total: MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS,
    });
    expect(storeState.expandedDirectoryPaths.has(crossRootPath)).toBe(true);
    expect(storeState.expandedDirectoryPaths.size).toBe(MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS + 1);

    await act(async () => {
      resolveRestoration?.();
    });
  });

  it('deduplicates priority paths before reporting folders kept collapsed', async () => {
    let resolveRestoration: (() => void) | undefined;
    const loadSpecificPaths = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRestoration = resolve;
        })
    );
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          selectedFilePaths: new Set(['root-a|@|/workspace/src/file.ts']),
          selectionModel: {
            explicitPaths: new Set<string>(),
            materializedAt: null,
            materializedPaths: null,
            mode: 'query',
            queryDescriptor: {
              coveredDirectoryPaths: ['/workspace/src'],
              excludedPaths: [],
              excludeFilters: [],
              folderId: 'root-a',
              includedPaths: [],
              includeFilters: [],
              kind: 'recursive-select-all',
              manifestFingerprint: 'query-fingerprint',
              manifestSnapshotId: 'snapshot-1',
              rootPath: '/workspace',
              totalSelectedCount: 1,
              useRegex: false,
            },
          },
        })
      ),
    };

    const { result } = renderHook(() =>
      useExpandedPathRestoration({
        currentRootFolderId: 'root-a',
        currentRootPath: '/workspace',
        fileTree: [createDirectoryNode('/workspace/src')],
        isTreeLoading: false,
        loadSpecificPaths,
        restorationKey: 'root-a',
        setExpandedPaths: vi.fn(),
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(
        ['/workspace', '/workspace/src'],
        expect.any(Function)
      );
      expect(result.current.restorationProgress).toMatchObject({
        loaded: 0,
        omitted: 0,
        total: 2,
      });
    });

    await act(async () => {
      resolveRestoration?.();
    });
  });

  it('loads the bounded plan shallowest-first when a query path is not ancestor-closed', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set(['/workspace/src']),
          selectionModel: {
            explicitPaths: new Set<string>(),
            materializedAt: null,
            materializedPaths: null,
            mode: 'query',
            queryDescriptor: {
              coveredDirectoryPaths: ['/workspace/src/generated'],
              excludedPaths: [],
              excludeFilters: [],
              folderId: 'root-a',
              includedPaths: [],
              includeFilters: [],
              kind: 'recursive-select-all',
              manifestFingerprint: 'query-fingerprint',
              manifestSnapshotId: 'snapshot-1',
              rootPath: '/workspace',
              totalSelectedCount: 1,
              useRegex: false,
            },
          },
        })
      ),
    };

    renderHook(() =>
      useExpandedPathRestoration({
        currentRootFolderId: 'root-a',
        currentRootPath: '/workspace',
        fileTree: [createDirectoryNode('/workspace/src')],
        isTreeLoading: false,
        loadSpecificPaths,
        restorationKey: 'root-a',
        setExpandedPaths: vi.fn(),
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(
        ['/workspace/src', '/workspace/src/generated'],
        expect.any(Function)
      );
    });
  });
});

describe('useExpandSelectedFileParentDirectories', () => {
  it('derives parent directory chains without materializing segment joins per ancestor', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');

    const absoluteAncestors = __getAllAncestorDirectories('/workspace/src/components/Button.tsx');
    const repeatedSeparatorAncestors = __getAllAncestorDirectories('src//components/Button.tsx');
    const windowsAncestors = __getAllAncestorDirectories(
      'C:\\workspace\\src\\components\\Button.tsx'
    );
    const uncAncestors = __getAllAncestorDirectories('\\\\server\\share\\src\\Button.tsx');
    const fileOnlyAncestors = __getAllAncestorDirectories('Button.tsx');
    const rootAncestors = __getAllAncestorDirectories('/');

    expect(joinSpy).not.toHaveBeenCalled();
    joinSpy.mockRestore();

    expect(absoluteAncestors).toEqual([
      '/workspace',
      '/workspace/src',
      '/workspace/src/components',
    ]);
    expect(repeatedSeparatorAncestors).toEqual(['src', 'src/components']);
    expect(windowsAncestors).toEqual([
      'C:',
      'C:\\workspace',
      'C:\\workspace\\src',
      'C:\\workspace\\src\\components',
    ]);
    expect(uncAncestors).toEqual(['\\\\server', '\\\\server\\share', '\\\\server\\share\\src']);
    expect(fileOnlyAncestors).toEqual([]);
    expect(rootAncestors).toEqual([]);
  });

  it('expands parent directories for selected files after restoration settles', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set<string>(),
          selectedFilePaths: new Set(['/workspace|@|src/components/Button.tsx']),
        })
      ),
    };

    const { rerender } = renderHook(
      (props: { selectionVersion: number; isRestorationSettled: boolean }) =>
        useExpandSelectedFileParentDirectories({
          currentRootFolderId: '/workspace',
          isRestorationSettled: props.isRestorationSettled,
          loadSpecificPaths,
          selectionVersion: props.selectionVersion,
          setExpandedPaths,
          store,
        }),
      { initialProps: { isRestorationSettled: false, selectionVersion: 1 } }
    );

    expect(loadSpecificPaths).not.toHaveBeenCalled();

    rerender({ isRestorationSettled: true, selectionVersion: 1 });

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(['src', 'src/components']);
    });

    await waitFor(() => {
      expect(setExpandedPaths).toHaveBeenCalledWith(new Set(['src', 'src/components']));
    });
  });

  it('does not reload parent directories when selection version changes but parents are already expanded', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set(['src', 'src/components']),
          selectedFilePaths: new Set(['/workspace|@|src/components/Button.tsx']),
        })
      ),
    };

    const { rerender } = renderHook(
      (props: { selectionVersion: number }) =>
        useExpandSelectedFileParentDirectories({
          currentRootFolderId: '/workspace',
          isRestorationSettled: true,
          loadSpecificPaths,
          selectionVersion: props.selectionVersion,
          setExpandedPaths,
          store,
        }),
      { initialProps: { selectionVersion: 1 } }
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadSpecificPaths).not.toHaveBeenCalled();

    rerender({ selectionVersion: 2 });

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadSpecificPaths).not.toHaveBeenCalled();
    expect(setExpandedPaths).not.toHaveBeenCalled();
  });

  it('does not expand selected-file parents owned by another root', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          selectedFilePaths: new Set(['/other-root|@|src/components/Button.tsx']),
        })
      ),
    };

    renderHook(() =>
      useExpandSelectedFileParentDirectories({
        currentRootFolderId: '/workspace',
        isRestorationSettled: true,
        loadSpecificPaths,
        selectionVersion: 1,
        setExpandedPaths: vi.fn(),
        store,
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadSpecificPaths).not.toHaveBeenCalled();
  });

  it('expands query-covered directories when the selection version changes', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set<string>(),
          selectionModel: {
            explicitPaths: new Set<string>(),
            materializedAt: null,
            materializedPaths: null,
            mode: 'query',
            queryDescriptor: {
              coveredDirectoryPaths: ['src', 'src/generated'],
              excludedPaths: [],
              excludeFilters: [],
              folderId: '/workspace',
              includedPaths: [],
              includeFilters: [],
              kind: 'recursive-select-all',
              manifestFingerprint: 'query-fingerprint',
              manifestSnapshotId: 'snapshot-1',
              rootPath: null,
              totalSelectedCount: 2,
              useRegex: false,
            },
          },
        })
      ),
    };

    renderHook(() =>
      useExpandSelectedFileParentDirectories({
        currentRootFolderId: '/workspace',
        isRestorationSettled: true,
        loadSpecificPaths,
        selectionVersion: 2,
        setExpandedPaths,
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(['src', 'src/generated']);
    });

    await waitFor(() => {
      expect(setExpandedPaths).toHaveBeenCalledWith(new Set(['src', 'src/generated']));
    });
  });

  it('bounds post-restoration selection expansion without marking omitted parents expanded', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const coveredDirectoryPaths = Array.from(
      { length: MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS + 25 },
      (_, index) => `directory-${index.toString().padStart(4, '0')}`
    );
    const boundedDirectoryPaths = coveredDirectoryPaths.slice(
      0,
      MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS
    );
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set<string>(),
          selectionModel: {
            explicitPaths: new Set<string>(),
            materializedAt: null,
            materializedPaths: null,
            mode: 'query',
            queryDescriptor: {
              coveredDirectoryPaths,
              excludedPaths: [],
              excludeFilters: [],
              folderId: '/workspace',
              includedPaths: [],
              includeFilters: [],
              kind: 'recursive-select-all',
              manifestFingerprint: 'query-fingerprint',
              manifestSnapshotId: 'snapshot-1',
              rootPath: null,
              totalSelectedCount: coveredDirectoryPaths.length,
              useRegex: false,
            },
          },
        })
      ),
    };

    renderHook(() =>
      useExpandSelectedFileParentDirectories({
        currentRootFolderId: '/workspace',
        isRestorationSettled: true,
        loadSpecificPaths,
        selectionVersion: 2,
        setExpandedPaths,
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(boundedDirectoryPaths);
    });

    await waitFor(() => {
      expect(setExpandedPaths).toHaveBeenCalledWith(new Set(boundedDirectoryPaths));
    });
  });

  it('scopes and depth-sorts Windows parents before applying the post-restoration cap', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const outOfRootSelections = Array.from(
      { length: MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS + 25 },
      (_, index) => `/workspace|@|D:\\other\\branch-${index.toString().padStart(4, '0')}\\File.ts`
    );
    const expectedScopedParents = [
      'C:\\repo',
      'C:\\repo\\src',
      'C:\\repo\\zzz',
      'C:\\repo\\aaa\\deep',
      'C:\\repo\\src\\components',
    ];
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set<string>(),
          selectedFilePaths: new Set([
            ...outOfRootSelections,
            '/workspace|@|C:\\repo\\src\\components\\Button.tsx',
          ]),
          selectionModel: {
            explicitPaths: new Set<string>(),
            materializedAt: null,
            materializedPaths: null,
            mode: 'query',
            queryDescriptor: {
              coveredDirectoryPaths: ['C:\\repo\\aaa\\deep', 'C:\\repo\\zzz', 'D:\\outside\\stale'],
              excludedPaths: [],
              excludeFilters: [],
              folderId: '/workspace',
              includedPaths: [],
              includeFilters: [],
              kind: 'recursive-select-all',
              manifestFingerprint: 'query-fingerprint',
              manifestSnapshotId: 'snapshot-1',
              rootPath: null,
              totalSelectedCount: outOfRootSelections.length + 1,
              useRegex: false,
            },
          },
        })
      ),
    };

    renderHook(() =>
      useExpandSelectedFileParentDirectories({
        currentRootFolderId: '/workspace',
        currentRootPath: 'C:\\repo',
        isRestorationSettled: true,
        loadSpecificPaths,
        selectionVersion: 3,
        setExpandedPaths,
        store,
      })
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(expectedScopedParents);
    });

    await waitFor(() => {
      expect(setExpandedPaths).toHaveBeenCalledWith(new Set(expectedScopedParents));
    });
  });

  it('expands selected parents beneath a Windows drive root', async () => {
    const loadSpecificPaths = vi.fn().mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set<string>(),
          selectedFilePaths: new Set([
            '/workspace|@|C:\\repo\\src\\Button.tsx',
            '/workspace|@|D:\\outside\\Ignored.ts',
          ]),
        })
      ),
    };

    renderHook(() =>
      useExpandSelectedFileParentDirectories({
        currentRootFolderId: '/workspace',
        currentRootPath: 'C:\\',
        isRestorationSettled: true,
        loadSpecificPaths,
        selectionVersion: 4,
        setExpandedPaths,
        store,
      })
    );

    const expectedParents = ['C:\\repo', 'C:\\repo\\src'];
    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(expectedParents);
    });
    await waitFor(() => {
      expect(setExpandedPaths).toHaveBeenCalledWith(new Set(expectedParents));
    });
  });

  it('does not apply stale expansion work from an earlier selection version', async () => {
    let resolveFirstLoad: (() => void) | undefined;
    const loadSpecificPaths = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstLoad = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const setExpandedPaths = vi.fn();
    const storeState = createStoreState({
      expandedDirectoryPaths: new Set<string>(),
      selectedFilePaths: new Set(['/workspace|@|src/initial.ts']),
    });
    const store = {
      getState: vi.fn(() => storeState),
    };

    const { rerender } = renderHook(
      (props: { selectionVersion: number }) =>
        useExpandSelectedFileParentDirectories({
          currentRootFolderId: '/workspace',
          isRestorationSettled: true,
          loadSpecificPaths,
          selectionVersion: props.selectionVersion,
          setExpandedPaths,
          store,
        }),
      { initialProps: { selectionVersion: 1 } }
    );

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(['src']);
    });

    storeState.selectedFilePaths = new Set(['/workspace|@|packages/agent/runtime.ts']);
    rerender({ selectionVersion: 2 });

    await waitFor(() => {
      expect(loadSpecificPaths).toHaveBeenCalledWith(['packages', 'packages/agent']);
    });

    await act(async () => {
      resolveFirstLoad?.();
    });

    await waitFor(() => {
      expect(setExpandedPaths).toHaveBeenCalledTimes(1);
      expect(setExpandedPaths).toHaveBeenCalledWith(new Set(['packages', 'packages/agent']));
    });
  });
});
