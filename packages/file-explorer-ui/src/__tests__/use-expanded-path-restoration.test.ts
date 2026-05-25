import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRestorationLock,
  useExpandedPathRestoration,
  useExpandSelectedFileParentDirectories,
} from '../use-expanded-path-restoration';

function createDirectoryNode(path: string): IFileNode {
  return {
    path,
    name: path.split('/').pop() ?? path,
    type: 'directory',
    children: [],
    depth: path.split('/').filter(Boolean).length,
    handle: {} as IFileNode['handle'],
    rootFolderId: '/workspace',
    selectionState: 'unchecked',
  } satisfies IFileNode;
}

function createStoreState(overrides: Partial<FileExplorerState> = {}): FileExplorerState {
  return {
    expandedDirectoryPaths: new Set<string>(),
    selectedFilePaths: new Set<string>(),
    selectionModel: { mode: 'explicit' },
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
      { initialProps: { selectionVersion: 1, isRestorationSettled: false } }
    );

    expect(loadSpecificPaths).not.toHaveBeenCalled();

    rerender({ selectionVersion: 1, isRestorationSettled: true });

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
});
