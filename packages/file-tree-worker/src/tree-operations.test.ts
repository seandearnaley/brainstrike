/**
 * Tree Operations Tests
 *
 * Tests for worker-specific tree operation functions.
 * Generic operations are tested in @brainstrike/utils.
 */

import { describe, expect, it } from 'vitest';
import {
  applyBatchResultsToTree,
  canLoadNode,
  collectDirectoryPaths,
  collectExpandedPaths,
  discoverChildDirectories,
  findNodeByPath,
  getUnloadedDirectories,
  needsLoading,
  setNodeLoadState,
  sortFileNodes,
  updateNodeChildren,
} from './tree-operations';
import type { BatchLoadResult, WorkerFileNode } from './types';

// Test fixtures
function createFileNode(overrides: Partial<WorkerFileNode> = {}): WorkerFileNode {
  return {
    depth: 1,
    name: 'file.txt',
    path: '/root/file.txt',
    rootFolderId: 'root',
    type: 'file',
    ...overrides,
  };
}

function createDirectoryNode(overrides: Partial<WorkerFileNode> = {}): WorkerFileNode {
  return {
    depth: 1,
    loadState: 'unloaded',
    name: 'dir',
    path: '/root/dir',
    rootFolderId: 'root',
    type: 'directory',
    ...overrides,
  };
}

describe('sortFileNodes', () => {
  it('should sort directories before files', () => {
    const nodes = [
      createFileNode({ name: 'a.txt', path: '/root/a.txt' }),
      createDirectoryNode({ name: 'dir', path: '/root/dir' }),
    ];
    const sorted = sortFileNodes(nodes);
    expect(sorted[0]?.type).toBe('directory');
    expect(sorted[1]?.type).toBe('file');
  });

  it('should sort alphabetically within same type', () => {
    const nodes = [
      createDirectoryNode({ name: 'zebra', path: '/root/zebra' }),
      createDirectoryNode({ name: 'alpha', path: '/root/alpha' }),
    ];
    const sorted = sortFileNodes(nodes);
    expect(sorted[0]?.name).toBe('alpha');
    expect(sorted[1]?.name).toBe('zebra');
  });
});

describe('findNodeByPath', () => {
  it('should find root-level node', () => {
    const tree = [createDirectoryNode({ path: '/root/dir' })];
    const found = findNodeByPath(tree, '/root/dir');
    expect(found).not.toBeNull();
    expect(found?.path).toBe('/root/dir');
  });

  it('should find nested node', () => {
    const tree = [
      createDirectoryNode({
        children: [createDirectoryNode({ name: 'child', path: '/root/parent/child' })],
        path: '/root/parent',
      }),
    ];
    const found = findNodeByPath(tree, '/root/parent/child');
    expect(found).not.toBeNull();
    expect(found?.name).toBe('child');
  });

  it('should return null for non-existent path', () => {
    const tree = [createDirectoryNode()];
    const found = findNodeByPath(tree, '/not/found');
    expect(found).toBeNull();
  });
});

describe('needsLoading', () => {
  it('should return true for unloaded directory', () => {
    const node = createDirectoryNode({ loadState: 'unloaded' });
    expect(needsLoading(node)).toBe(true);
  });

  it('should return true for directory without loadState', () => {
    const { loadState: _, ...node } = createDirectoryNode();
    expect(needsLoading(node as WorkerFileNode)).toBe(true);
  });

  it('should return false for loaded directory', () => {
    const node = createDirectoryNode({ loadState: 'loaded' });
    expect(needsLoading(node)).toBe(false);
  });

  it('should return false for loading directory', () => {
    const node = createDirectoryNode({ loadState: 'loading' });
    expect(needsLoading(node)).toBe(false);
  });

  it('should return false for file nodes', () => {
    const node = createFileNode();
    expect(needsLoading(node)).toBe(false);
  });
});

describe('canLoadNode', () => {
  it('should return true for unloaded directory', () => {
    const node = createDirectoryNode({ loadState: 'unloaded' });
    expect(canLoadNode(node)).toBe(true);
  });

  it('should return false for null', () => {
    expect(canLoadNode(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(canLoadNode(undefined)).toBe(false);
  });

  it('should return false for file node', () => {
    const node = createFileNode();
    expect(canLoadNode(node)).toBe(false);
  });

  it('should return false for loaded directory', () => {
    const node = createDirectoryNode({ loadState: 'loaded' });
    expect(canLoadNode(node)).toBe(false);
  });
});

describe('updateNodeChildren', () => {
  it('should update children of target node', () => {
    const tree = [createDirectoryNode({ path: '/root/dir' })];
    const children = [createFileNode({ path: '/root/dir/file.txt' })];

    const updated = updateNodeChildren(tree, '/root/dir', children);

    expect(updated[0]?.children).toHaveLength(1);
    expect(updated[0]?.loadState).toBe('loaded');
  });

  it('should maintain immutability', () => {
    const original = [createDirectoryNode({ path: '/root/dir' })];
    const children = [createFileNode({ path: '/root/dir/file.txt' })];

    const updated = updateNodeChildren(original, '/root/dir', children);

    expect(updated).not.toBe(original);
    expect(original[0]?.children).toBeUndefined();
  });
});

describe('setNodeLoadState', () => {
  it('should set loading state', () => {
    const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir' })];

    const updated = setNodeLoadState(tree, '/root/dir', 'loading');

    expect(updated[0]?.loadState).toBe('loading');
  });

  it('should set error state with message', () => {
    const tree = [createDirectoryNode({ path: '/root/dir' })];

    const updated = setNodeLoadState(tree, '/root/dir', 'error', 'Permission denied');

    expect(updated[0]?.loadState).toBe('error');
    expect(updated[0]?.loadError).toBe('Permission denied');
  });
});

describe('collectDirectoryPaths', () => {
  it('should collect all directory paths', () => {
    const tree = [
      createDirectoryNode({ path: '/root/dir1' }),
      createDirectoryNode({
        children: [createDirectoryNode({ path: '/root/dir2/nested' })],
        path: '/root/dir2',
      }),
      createFileNode({ path: '/root/file.txt' }),
    ];
    const paths = new Set<string>();

    collectDirectoryPaths(tree, paths);

    expect(paths.size).toBe(3);
    expect(paths.has('/root/dir1')).toBe(true);
    expect(paths.has('/root/dir2')).toBe(true);
    expect(paths.has('/root/dir2/nested')).toBe(true);
    expect(paths.has('/root/file.txt')).toBe(false);
  });
});

describe('collectExpandedPaths', () => {
  it('should collect paths of loaded directories with children', () => {
    const tree = [
      // Loaded with children - should be included
      createDirectoryNode({ children: [], loadState: 'loaded', path: '/root/loaded' }),
      // Unloaded - should not be included
      createDirectoryNode({ loadState: 'unloaded', path: '/root/unloaded' }),
      // Loaded without children - should not be included (loadState only)
      createDirectoryNode({ loadState: 'loaded', path: '/root/loaded-no-children' }),
      createDirectoryNode({
        children: [
          // Nested loaded with children
          createDirectoryNode({ children: [], loadState: 'loaded', path: '/root/parent/nested' }),
        ],
        loadState: 'loaded',
        path: '/root/parent',
      }),
    ];

    const paths = collectExpandedPaths(tree);

    expect(paths).toContain('/root/loaded');
    expect(paths).toContain('/root/parent');
    expect(paths).toContain('/root/parent/nested');
    expect(paths).not.toContain('/root/unloaded');
    expect(paths).not.toContain('/root/loaded-no-children');
  });
});

describe('getUnloadedDirectories', () => {
  it('should return unloaded directories from current wave', () => {
    const tree = [
      createDirectoryNode({ loadState: 'unloaded', path: '/root/dir1' }),
      createDirectoryNode({ loadState: 'loaded', path: '/root/dir2' }),
      createDirectoryNode({ loadState: 'unloaded', path: '/root/dir3' }),
    ];
    const currentWave = new Set(['/root/dir1', '/root/dir2', '/root/dir3']);
    const processed = new Set<string>();

    const toLoad = getUnloadedDirectories(currentWave, processed, tree);

    expect(toLoad).toHaveLength(2);
    expect(toLoad).toContain('/root/dir1');
    expect(toLoad).toContain('/root/dir3');
    expect(toLoad).not.toContain('/root/dir2');
  });

  it('should retry errored directories from current wave', () => {
    const tree = [
      createDirectoryNode({
        loadError: 'Permission denied',
        loadState: 'error',
        path: '/root/dir1',
      }),
      createDirectoryNode({ loadState: 'loaded', path: '/root/dir2' }),
    ];
    const currentWave = new Set(['/root/dir1', '/root/dir2']);
    const processed = new Set<string>();

    const toLoad = getUnloadedDirectories(currentWave, processed, tree);

    expect(toLoad).toEqual(['/root/dir1']);
  });

  it('should skip already processed paths', () => {
    const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir1' })];
    const currentWave = new Set(['/root/dir1']);
    const processed = new Set(['/root/dir1']);

    const toLoad = getUnloadedDirectories(currentWave, processed, tree);

    expect(toLoad).toHaveLength(0);
  });

  it('should add paths to processed set', () => {
    const tree = [createDirectoryNode({ loadState: 'unloaded', path: '/root/dir1' })];
    const currentWave = new Set(['/root/dir1']);
    const processed = new Set<string>();

    getUnloadedDirectories(currentWave, processed, tree);

    expect(processed.has('/root/dir1')).toBe(true);
  });
});

describe('discoverChildDirectories', () => {
  it('should discover child directories from loaded nodes', () => {
    const tree = [
      createDirectoryNode({
        children: [
          createDirectoryNode({ loadState: 'unloaded', path: '/root/parent/child1' }),
          createDirectoryNode({ loadState: 'unloaded', path: '/root/parent/child2' }),
          createFileNode({ path: '/root/parent/file.txt' }),
        ],
        loadState: 'loaded',
        path: '/root/parent',
      }),
    ];
    const currentWave = new Set(['/root/parent']);
    const processed = new Set(['/root/parent']);

    const { nextWave, newCount } = discoverChildDirectories(currentWave, processed, tree);

    expect(nextWave.size).toBe(2);
    expect(nextWave.has('/root/parent/child1')).toBe(true);
    expect(nextWave.has('/root/parent/child2')).toBe(true);
    expect(newCount).toBe(2);
  });

  it('should skip already processed child directories', () => {
    const tree = [
      createDirectoryNode({
        children: [createDirectoryNode({ loadState: 'unloaded', path: '/root/parent/child' })],
        loadState: 'loaded',
        path: '/root/parent',
      }),
    ];
    const currentWave = new Set(['/root/parent']);
    const processed = new Set(['/root/parent', '/root/parent/child']);

    const { nextWave, newCount } = discoverChildDirectories(currentWave, processed, tree);

    expect(nextWave.size).toBe(0);
    expect(newCount).toBe(0);
  });
});

describe('applyBatchResultsToTree', () => {
  it('should apply successful load results', () => {
    const tree = [createDirectoryNode({ loadState: 'loading', path: '/root/dir' })];
    const children = [createFileNode({ path: '/root/dir/file.txt' })];
    const results: BatchLoadResult[] = [{ children, path: '/root/dir' }];

    const updated = applyBatchResultsToTree(tree, results);

    expect(updated[0]?.children).toHaveLength(1);
    expect(updated[0]?.loadState).toBe('loaded');
  });

  it('should apply error results', () => {
    const tree = [createDirectoryNode({ loadState: 'loading', path: '/root/dir' })];
    const results: BatchLoadResult[] = [{ error: 'Access denied', path: '/root/dir' }];

    const updated = applyBatchResultsToTree(tree, results);

    expect(updated[0]?.loadState).toBe('error');
    expect(updated[0]?.loadError).toBe('Access denied');
  });

  it('should apply multiple results', () => {
    const tree = [
      createDirectoryNode({ loadState: 'loading', path: '/root/dir1' }),
      createDirectoryNode({ loadState: 'loading', path: '/root/dir2' }),
    ];
    const results: BatchLoadResult[] = [
      { children: [], path: '/root/dir1' },
      { error: 'Error', path: '/root/dir2' },
    ];

    const updated = applyBatchResultsToTree(tree, results);

    expect(updated[0]?.loadState).toBe('loaded');
    expect(updated[1]?.loadState).toBe('error');
  });
});
