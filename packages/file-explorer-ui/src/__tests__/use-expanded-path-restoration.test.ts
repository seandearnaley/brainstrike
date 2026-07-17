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
      ruleSetJson: null,
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
            ruleSetJson: null,
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
            ruleSetJson: null,
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
            ruleSetJson: null,
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
