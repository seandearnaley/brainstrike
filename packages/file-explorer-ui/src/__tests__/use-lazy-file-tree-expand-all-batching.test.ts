/**
 * Renderer-fallback expand-all commit batching.
 *
 * When the file-tree worker is unavailable, expand-all loads directories in
 * the renderer via the batched traversal session. Each commitNormalizedTree
 * clones the normalized maps and rematerializes the tree (O(tree)), so
 * committing per directory made expand-all O(tree × directories). These tests
 * pin the batched contract: one display commit per traversal batch, and no
 * per-directory 'loading' display commits while expand-all is running.
 */

import { MockFileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileTree } from '../tree/use-file-tree-context';
import { __resetInFlightRootLoads } from '../tree/use-lazy-file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

// Force the renderer fallback: worker construction fails, so the expand-all
// session drives loadChildren directly.
vi.mock('@brainstrike/file-tree-worker', () => ({
  createFileTreeWorkerPort: vi.fn(() => {
    throw new Error('worker unavailable in test');
  }),
  resolveFileTreeWorkerUrl: vi.fn(() => {
    throw new Error('worker unavailable in test');
  }),
}));

interface MockEntry {
  children?: Record<string, MockEntry>;
  content?: string;
  name: string;
  type: 'file' | 'directory';
}

function createDirEntry(name: string, children: Record<string, MockEntry>): MockEntry {
  return { children, name, type: 'directory' };
}

function createFileEntry(name: string): MockEntry {
  return { content: name, name, type: 'file' };
}

/**
 * 4 top-level dirs × 4 mid dirs × 1 leaf dir = 36 directories, 3 levels deep.
 * The renderer traversal discovers one level per batch, so a batched
 * implementation publishes ~3 display commits while a per-directory one
 * publishes ~72 (loading + loaded per directory).
 */
const TOTAL_DIRECTORY_COUNT = 36;

function createDeepMockFileSystem(): Record<string, MockEntry> {
  const rootEntries: Record<string, MockEntry> = {};
  for (let topIndex = 0; topIndex < 4; topIndex += 1) {
    const midEntries: Record<string, MockEntry> = {};
    for (let midIndex = 0; midIndex < 4; midIndex += 1) {
      midEntries[`sub-${midIndex}`] = createDirEntry(`sub-${midIndex}`, {
        'deep.txt': createFileEntry('deep.txt'),
        leaf: createDirEntry('leaf', { 'leaf.txt': createFileEntry('leaf.txt') }),
      });
    }
    rootEntries[`dir-${topIndex}`] = createDirEntry(`dir-${topIndex}`, midEntries);
  }
  return rootEntries;
}

function findByNamePath(nodes: IFileNode[], names: readonly string[]): IFileNode | undefined {
  let currentNodes = nodes;
  let found: IFileNode | undefined;
  for (const name of names) {
    found = currentNodes.find((node) => node.name === name);
    if (!found) {
      return;
    }
    currentNodes = found.children ?? [];
  }
  return found;
}

describe('useLazyFileTree renderer-fallback expand-all batching', () => {
  let mockAdapter: MockFileSystemAdapter;

  beforeEach(() => {
    mockAdapter = new MockFileSystemAdapter();
    __resetInFlightRootLoads();
  });

  it('publishes once per traversal batch instead of per directory, without loading-state churn', async () => {
    mockAdapter.setMockFileSystem(createDeepMockFileSystem());
    const handle = await mockAdapter.requestDirectoryAccess();

    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

    const renderSnapshots: { isExpandingAll: boolean; loadingPathCount: number }[] = [];
    const { result } = renderHook(
      () => {
        const hook = useFileTree(handle);
        renderSnapshots.push({
          isExpandingAll: hook.isExpandingAll,
          loadingPathCount: hook.loadingPaths.size,
        });
        return hook;
      },
      { wrapper: TestWrapper }
    );

    await waitFor(() => expect(result.current.fileTree.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const versionBefore = result.current.__internalNormalizedTreeVersion;
    expect(versionBefore).toBeDefined();

    let expandedPaths = new Set<string>();
    const setExpandedPaths = (updater: (prev: Set<string>) => Set<string>): void => {
      expandedPaths = updater(expandedPaths);
    };

    await act(async () => {
      await result.current.expandAllProgressively(setExpandedPaths, expandedPaths);
    });

    // Every directory (all 3 levels) was discovered and expanded.
    expect(expandedPaths.size).toBe(TOTAL_DIRECTORY_COUNT);

    // The fully loaded tree is visible, down to the deepest file.
    const leafFile = findByNamePath(result.current.fileTree, [
      'dir-0',
      'sub-0',
      'leaf',
      'leaf.txt',
    ]);
    expect(leafFile?.type).toBe('file');
    const midDirectory = findByNamePath(result.current.fileTree, ['dir-3', 'sub-3']);
    expect(midDirectory?.loadState).toBe('loaded');

    // Display commits are batched: one publish per traversal batch (~tree
    // depth), not O(directories). A per-directory implementation performs
    // ~2 commits per directory (loading + loaded) = ~72 here.
    const versionAfter = result.current.__internalNormalizedTreeVersion;
    expect(versionAfter).toBeDefined();
    const commitCount = (versionAfter ?? 0) - (versionBefore ?? 0);
    expect(commitCount).toBeGreaterThan(0);
    expect(commitCount).toBeLessThanOrEqual(8);

    // Intermediate per-directory 'loading' display state is suppressed while
    // expand-all runs — no render observed loadingPaths churn.
    const loadingDuringExpandAll = renderSnapshots.filter(
      (snapshot) => snapshot.isExpandingAll && snapshot.loadingPathCount > 0
    );
    expect(loadingDuringExpandAll).toEqual([]);
  });

  it('batches failed directory loads into the per-batch flush instead of committing per error', async () => {
    mockAdapter.setMockFileSystem(createDeepMockFileSystem());
    const handle = await mockAdapter.requestDirectoryAccess();

    // Fail every sub-1/sub-2 directory read (8 of the 16 mid-level dirs).
    const originalStreaming = mockAdapter.readDirectoryStreaming.bind(mockAdapter);
    mockAdapter.readDirectoryStreaming = async (dirHandle, onBatch, options) => {
      if (/\/(sub-1|sub-2)$/.test(dirHandle.path)) {
        throw new Error(`permission denied: ${dirHandle.path}`);
      }
      return originalStreaming(dirHandle, onBatch, options);
    };

    const TestWrapper = ({ children }: { children: ReactNode }) =>
      FileExplorerTestWrapper({ children, mockFileSystemAdapter: mockAdapter });

    const { result } = renderHook(() => useFileTree(handle), { wrapper: TestWrapper });

    await waitFor(() => expect(result.current.fileTree.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const versionBefore = result.current.__internalNormalizedTreeVersion ?? 0;

    let expandedPaths = new Set<string>();
    const setExpandedPaths = (updater: (prev: Set<string>) => Set<string>): void => {
      expandedPaths = updater(expandedPaths);
    };

    await act(async () => {
      await result.current.expandAllProgressively(setExpandedPaths, expandedPaths);
    });

    // 4 top + 16 mid + 8 leaf (only under the 8 non-failing mids) = 28 dirs.
    expect(expandedPaths.size).toBe(28);

    // Failed directories surface their error state...
    const failedDirectory = findByNamePath(result.current.fileTree, ['dir-0', 'sub-1']);
    expect(failedDirectory?.loadState).toBe('error');
    // ...and healthy siblings still loaded fully.
    const leafFile = findByNamePath(result.current.fileTree, [
      'dir-0',
      'sub-0',
      'leaf',
      'leaf.txt',
    ]);
    expect(leafFile?.type).toBe('file');

    // Error commits ride the same per-batch flush — commit count stays at
    // ~batch count, not batches + one O(tree) commit per failed directory.
    const commitCount = (result.current.__internalNormalizedTreeVersion ?? 0) - versionBefore;
    expect(commitCount).toBeGreaterThan(0);
    expect(commitCount).toBeLessThanOrEqual(8);
  });
});
