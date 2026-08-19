import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRestorationLock,
  useExpandedPathRestoration,
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

describe('useExpandedPathRestoration lifecycle', () => {
  beforeEach(() => {
    __resetRestorationLock();
  });

  it('retries an aborted automatic restoration without latching or warning as failure', async () => {
    let rejectFirstAttempt: ((reason?: unknown) => void) | undefined;
    const loadSpecificPaths = vi.fn((_paths: string[]): Promise<void> => {
      if (loadSpecificPaths.mock.calls.length > 1) {
        return Promise.resolve();
      }
      return new Promise<void>((_resolve, reject) => {
        rejectFirstAttempt = reject;
      });
    });
    const warningRecords: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'ExpandedPathRestoration' && record.level === LogLevel.WARN) {
        warningRecords.push(record);
      }
    });
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set(['/workspace/src']),
        })
      ),
    };

    try {
      const { result, unmount } = renderHook(() =>
        useExpandedPathRestoration({
          currentRootFolderId: 'root-a',
          currentRootPath: '/workspace',
          fileTree: [createDirectoryNode('/workspace/src')],
          isTreeLoading: false,
          loadSpecificPaths,
          restorationKey: 'root-a:key-a',
          setExpandedPaths: vi.fn(),
          store,
        })
      );
      await waitFor(() => expect(loadSpecificPaths).toHaveBeenCalledTimes(1));

      await act(async () => {
        rejectFirstAttempt?.(new DOMException('Restoration cancelled', 'AbortError'));
        await Promise.resolve();
      });

      await waitFor(() => expect(loadSpecificPaths).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.isRestorationSettled).toBe(true));
      expect(loadSpecificPaths.mock.calls.map(([paths]) => paths)).toEqual([
        ['/workspace/src'],
        ['/workspace/src'],
      ]);
      expect(warningRecords).toHaveLength(0);
      unmount();
    } finally {
      removeListener();
    }
  });

  it.each([
    {
      expectedSecondPaths: ['/workspace-a/src'],
      name: 'restoration key',
      nextProps: {
        currentRootFolderId: 'root-a',
        currentRootPath: '/workspace-a',
        restorationKey: 'root-a:key-b',
      },
    },
    {
      expectedSecondPaths: ['/workspace-b/src'],
      name: 'root',
      nextProps: {
        currentRootFolderId: 'root-b',
        currentRootPath: '/workspace-b',
        restorationKey: 'root-b:key-a',
      },
    },
  ])(
    'starts the new $name restoration after an older physical failure settles',
    async ({ expectedSecondPaths, nextProps }) => {
      let rejectFirstAttempt: ((reason?: unknown) => void) | undefined;
      const loadSpecificPaths = vi.fn((_paths: string[]): Promise<void> => {
        if (loadSpecificPaths.mock.calls.length > 1) {
          return Promise.resolve();
        }
        return new Promise<void>((_resolve, reject) => {
          rejectFirstAttempt = reject;
        });
      });
      const store = {
        getState: vi.fn(() =>
          createStoreState({
            expandedDirectoryPaths: new Set(['/workspace-a/src', '/workspace-b/src']),
          })
        ),
      };
      const initialProps = {
        currentRootFolderId: 'root-a',
        currentRootPath: '/workspace-a',
        restorationKey: 'root-a:key-a',
      };
      const { rerender, result, unmount } = renderHook(
        (props: typeof initialProps) =>
          useExpandedPathRestoration({
            ...props,
            fileTree: [createDirectoryNode(`${props.currentRootPath}/src`)],
            isTreeLoading: false,
            loadSpecificPaths,
            setExpandedPaths: vi.fn(),
            store,
          }),
        { initialProps }
      );
      await waitFor(() => expect(loadSpecificPaths).toHaveBeenCalledTimes(1));

      rerender(nextProps);
      expect(loadSpecificPaths).toHaveBeenCalledTimes(1);

      await act(async () => {
        rejectFirstAttempt?.(new Error('old restoration failed'));
        await Promise.resolve();
      });

      await waitFor(() => expect(loadSpecificPaths).toHaveBeenCalledTimes(2));
      expect(loadSpecificPaths.mock.calls[1]?.[0]).toEqual(expectedSecondPaths);
      await waitFor(() => expect(result.current.isRestorationSettled).toBe(true));
      unmount();
    }
  );

  it('starts a changed root only after the older physical success settles', async () => {
    let resolveFirstAttempt: (() => void) | undefined;
    const loadSpecificPaths = vi.fn((_paths: string[]): Promise<void> => {
      if (loadSpecificPaths.mock.calls.length > 1) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        resolveFirstAttempt = resolve;
      });
    });
    const store = {
      getState: vi.fn(() =>
        createStoreState({
          expandedDirectoryPaths: new Set(['/workspace-a/src', '/workspace-b/src']),
        })
      ),
    };
    const initialProps = {
      currentRootFolderId: 'root-a',
      currentRootPath: '/workspace-a',
      restorationKey: 'root-a:key-a',
    };
    const { rerender, result, unmount } = renderHook(
      (props: typeof initialProps) =>
        useExpandedPathRestoration({
          ...props,
          fileTree: [createDirectoryNode(`${props.currentRootPath}/src`)],
          isTreeLoading: false,
          loadSpecificPaths,
          setExpandedPaths: vi.fn(),
          store,
        }),
      { initialProps }
    );
    await waitFor(() => expect(loadSpecificPaths).toHaveBeenCalledTimes(1));

    rerender({
      currentRootFolderId: 'root-b',
      currentRootPath: '/workspace-b',
      restorationKey: 'root-b:key-a',
    });
    expect(loadSpecificPaths).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstAttempt?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(loadSpecificPaths).toHaveBeenCalledTimes(2));
    expect(loadSpecificPaths.mock.calls[1]?.[0]).toEqual(['/workspace-b/src']);
    await waitFor(() => expect(result.current.isRestorationSettled).toBe(true));
    unmount();
  });
});
