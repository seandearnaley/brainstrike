import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __getAllAncestorDirectories,
  __resetRestorationLock,
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
