/**
 * No-root reset idempotence.
 *
 * `resetCommittedRootState` is reached from TWO independent no-root paths:
 * the auto-load effect's `else` branch (no root yet) and `prepareRootLoad`'s
 * missing-handle/adapter early return. Both pass `(null, '', false)`, and both
 * used to post a worker `init([], '')` unconditionally — so every trigger
 * during startup re-initialized an already-empty tree.
 *
 * That churn is invisible to the loadRoot counters: `prepareRootLoad` returns
 * BEFORE `logStartedRootLoad`, so a no-root reset never emits
 * "loadRoot running". The desktop startup-restore regression E2E caught it
 * only through the worker's own "tree initialized" record (4, expected <= 1).
 */
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileTree } from '../tree/use-file-tree-context';
import { __resetInFlightRootLoads } from '../tree/use-lazy-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

const mockWorkerPort = {
  abort: vi.fn(),
  expandAll: vi.fn(),
  init: vi.fn(),
  loadPaths: vi.fn().mockResolvedValue({ expandedPaths: [], loadedCount: 0, patches: [] }),
  onChildrenLoaded: vi.fn(() => () => {}),
  // Typed arity so a test can capture the handler and raise a worker error.
  onError: vi.fn((_handler: (error: Error) => void) => () => {
    // no-op unsubscribe
  }),
  onExpandedPathsDelta: vi.fn(() => () => {}),
  onLog: vi.fn(() => () => {}),
  onNodeLoadStateChanged: vi.fn(() => () => {}),
  onProgress: vi.fn(() => () => {}),
  onRequestLoad: vi.fn(() => () => {}),
  onTreeSnapshot: vi.fn(() => () => {}),
  terminate: vi.fn(),
  updateTree: vi.fn(),
};

vi.mock('@brainstrike/file-tree-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-tree-worker')>();
  return {
    ...actual,
    createFileTreeWorkerPort: vi.fn(() => mockWorkerPort),
    resolveFileTreeWorkerUrl: vi.fn(() => new URL('data:text/javascript,')),
  };
});

vi.stubGlobal(
  'Worker',
  vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(),
    postMessage: vi.fn(),
    removeEventListener: vi.fn(),
    terminate: vi.fn(),
  }))
);

interface RootProps {
  root: Parameters<typeof useFileTree>[0];
}

describe('useLazyFileTree no-root reset', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
    vi.clearAllMocks();
    __resetInFlightRootLoads();
  });

  it('does not re-initialize the worker when the no-root reset repeats', async () => {
    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

    const { result } = renderHook(() => useFileTree(null), { wrapper: TestWrapper });

    // The mount reset is the ONE legitimate init: it establishes the empty tree.
    await waitFor(() => expect(mockWorkerPort.init).toHaveBeenCalledTimes(1));
    expect(mockWorkerPort.init).toHaveBeenLastCalledWith([], '');

    // A second no-root trigger (refreshTree -> loadRoot -> prepareRootLoad's
    // missing-handle return) would land on state that is ALREADY exactly what
    // the reset produces, so it must not reach the worker again.
    await act(async () => {
      await result.current.refreshTree();
    });

    expect(mockWorkerPort.init).toHaveBeenCalledTimes(1);
  });

  it('still clears a worker error raised while no root is loaded', async () => {
    // `handleWorkerError` writes `error` through setState and touches NONE of
    // the refs the worker-init guard consults, so the guard must never be
    // allowed to suppress the state half of the reset — otherwise the error
    // banner outlives every subsequent no-root reset (PR #2370 review).
    let raiseWorkerError: ((error: Error) => void) | undefined;
    mockWorkerPort.onError.mockImplementation((handler: (error: Error) => void) => {
      raiseWorkerError = handler;
      return () => {
        // no-op unsubscribe
      };
    });

    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

    const { result } = renderHook(() => useFileTree(null), { wrapper: TestWrapper });
    await waitFor(() => expect(mockWorkerPort.init).toHaveBeenCalledTimes(1));

    act(() => {
      raiseWorkerError?.(new Error('worker exploded'));
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());

    await act(async () => {
      await result.current.refreshTree();
    });

    // The redundant worker init is still skipped, but the observable state is
    // always re-applied.
    expect(result.current.error).toBeNull();
    expect(mockWorkerPort.init).toHaveBeenCalledTimes(1);
  });

  it('still initializes the worker when a real root arrives after a no-root reset', async () => {
    mockAdapter.setMockFileSystem({
      'a.txt': { content: 'a', name: 'a.txt', type: 'file' },
    });
    const handle = await mockAdapter.requestDirectoryAccess();

    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

    // Annotated so the initial `null` does not narrow the prop type and reject
    // the real handle on rerender.
    const initialProps: RootProps = { root: null };
    const { rerender } = renderHook(({ root }: RootProps) => useFileTree(root), {
      initialProps,
      wrapper: TestWrapper,
    });

    await waitFor(() => expect(mockWorkerPort.init).toHaveBeenCalledTimes(1));

    // The guard must never swallow a reset that genuinely changes identity.
    rerender({ root: handle });

    await waitFor(() => {
      expect(mockWorkerPort.init.mock.calls.length).toBeGreaterThan(1);
    });
  });
});
