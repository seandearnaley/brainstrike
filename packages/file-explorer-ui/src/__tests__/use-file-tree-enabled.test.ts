/**
 * BST-1957: an inert tree. `useFileExplorer` must call `useFileTree` for hook
 * order even under a FileTreeProvider, whose shared tree it reads instead.
 * That private tree used to start its own worker and load the root (keyed by
 * path) just to be discarded, once per consumer: the desktop startup-restore
 * E2E counted 3 handle-map builds for one restored root. `enabled: false`
 * keeps it inert.
 */
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { createFileTreeWorkerPort } from '@brainstrike/file-tree-worker';
import type { DirectoryHandle } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
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

const rootHandle = {
  _internal: {},
  kind: 'directory',
  name: 'project',
  path: '/project',
  platform: 'web',
  rootId: 'root-project',
} as unknown as DirectoryHandle;

describe('useFileTree enabled option', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
    vi.clearAllMocks();
    __resetInFlightRootLoads();
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

  it('starts no worker and never loads the root while disabled', async () => {
    const { result } = renderHook(() => useFileTree(rootHandle, { enabled: false }), { wrapper });

    // Let every mount effect run before asserting nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(globalThis.Worker).not.toHaveBeenCalled();
    expect(createFileTreeWorkerPort).not.toHaveBeenCalled();
    expect(mockWorkerPort.init).not.toHaveBeenCalled();
    expect(result.current.fileTree).toEqual([]);
    expect(result.current.workerPortRef.current).toBeNull();
  });

  it('starts its worker by default (positive control)', async () => {
    renderHook(() => useFileTree(null), { wrapper });

    await waitFor(() => expect(createFileTreeWorkerPort).toHaveBeenCalledTimes(1));
    expect(globalThis.Worker).toHaveBeenCalledTimes(1);
  });
});
