import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';

import {
  createDirectDirectoryTraversalSession,
  traverseDirectoriesDirect,
} from '../direct-directory-traversal';

function createDirectory(
  path: string,
  loadState: NonNullable<IFileNode['loadState']>,
  children: IFileNode[] = []
): IFileNode {
  return {
    children,
    depth: path.split('/').length - 2,
    handle: {} as FileSystemDirectoryHandle,
    loadState,
    name: path.split('/').pop() || path,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
  };
}

function createFile(path: string): IFileNode {
  return {
    depth: path.split('/').length - 2,
    handle: {} as FileSystemFileHandle,
    loadState: 'loaded',
    name: path.split('/').pop() || path,
    path,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  };
}

function findDirectoryByPath(node: IFileNode, path: string): IFileNode | undefined {
  if (node.path === path) {
    return node;
  }
  for (const child of node.children ?? []) {
    if (child.type !== 'directory') {
      continue;
    }
    const nested = findDirectoryByPath(child, path);
    if (nested) {
      return nested;
    }
  }
  return;
}

describe('traverseDirectoriesDirect', () => {
  it('processes discovered directories across multiple batches', async () => {
    const root = createDirectory('/root', 'loaded', [
      createDirectory('/root/src', 'loaded', [
        createDirectory('/root/src/nested', 'loaded'),
        createFile('/root/src/index.ts'),
      ]),
    ]);

    const session = createDirectDirectoryTraversalSession(['/root/src'], {
      getDirectoryByPath: (path) => findDirectoryByPath(root, path),
      isActive: () => true,
      loadDirectoryPath: async () => undefined,
      maxDirectoriesPerBatch: 1,
    });

    const firstBatch = await session.processNextBatch();
    expect(firstBatch.cancelled).toBe(false);
    expect(firstBatch.complete).toBe(false);
    expect(firstBatch.loaded).toBe(1);
    expect(firstBatch.total).toBe(2);
    expect(firstBatch.newlyDiscoveredPaths).toEqual(['/root/src/nested']);
    expect(firstBatch.visitedPaths).toEqual(['/root/src']);

    const secondBatch = await session.processNextBatch();
    expect(secondBatch.cancelled).toBe(false);
    expect(secondBatch.complete).toBe(true);
    expect(secondBatch.loaded).toBe(2);
    expect(secondBatch.total).toBe(2);
    expect(secondBatch.newlyDiscoveredPaths).toEqual([]);
    expect(secondBatch.visitedPaths).toEqual(['/root/src/nested']);
  });

  it('loads directories concurrently within a batch up to the configured limit', async () => {
    const root = createDirectory('/root', 'loaded', [
      createDirectory('/root/a', 'unloaded'),
      createDirectory('/root/b', 'unloaded'),
    ]);

    let inFlightLoads = 0;
    let maxObservedConcurrency = 0;

    const session = createDirectDirectoryTraversalSession(['/root/a', '/root/b'], {
      getDirectoryByPath: (path) => findDirectoryByPath(root, path),
      isActive: () => true,
      loadDirectoryPath: async (path) => {
        inFlightLoads += 1;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlightLoads);
        await Promise.resolve();
        const target = findDirectoryByPath(root, path);
        if (!target) {
          throw new Error(`missing target: ${path}`);
        }
        target.loadState = 'loaded';
        inFlightLoads -= 1;
      },
      maxConcurrentLoads: 2,
      maxDirectoriesPerBatch: 2,
    });

    const batch = await session.processNextBatch();
    expect(batch.cancelled).toBe(false);
    expect(batch.complete).toBe(true);
    expect(maxObservedConcurrency).toBe(2);
  });

  it('continues processing the remaining directories when one load throws', async () => {
    const root = createDirectory('/root', 'loaded', [
      createDirectory('/root/a', 'unloaded'),
      createDirectory('/root/b', 'unloaded'),
    ]);

    const result = await traverseDirectoriesDirect(['/root/a', '/root/b'], {
      getDirectoryByPath: (path) => findDirectoryByPath(root, path),
      isActive: () => true,
      loadDirectoryPath: async (path) => {
        if (path === '/root/a') {
          throw new Error('permission denied');
        }
        const target = findDirectoryByPath(root, path);
        if (!target) {
          throw new Error(`missing target: ${path}`);
        }
        target.loadState = 'loaded';
      },
    });

    expect(result.cancelled).toBe(false);
    expect(result.failedLoads).toBe(1);
    expect(result.firstError).toEqual(new Error('permission denied'));
    expect(result.loaded).toBe(2);
    expect(result.visitedPaths).toEqual(['/root/a', '/root/b']);
  });

  it('discovers nested directories after direct loads', async () => {
    const root = createDirectory('/root', 'loaded', [createDirectory('/root/src', 'unloaded')]);

    const result = await traverseDirectoriesDirect(['/root/src'], {
      getDirectoryByPath: (path) => findDirectoryByPath(root, path),
      isActive: () => true,
      loadDirectoryPath: async (path) => {
        if (path === '/root/src') {
          const target = findDirectoryByPath(root, path);
          if (!target) {
            throw new Error('missing target');
          }
          target.loadState = 'loaded';
          target.children = [
            createDirectory('/root/src/nested', 'loaded'),
            createFile('/root/src/a.ts'),
          ];
        }
      },
    });

    expect(result.cancelled).toBe(false);
    expect(result.visitedPaths).toEqual(['/root/src', '/root/src/nested']);
    expect(result.discoveredPaths).toEqual(new Set(['/root/src', '/root/src/nested']));
  });

  it('stops and returns cancelled when cancellation happens during an awaited load', async () => {
    const root = createDirectory('/root', 'loaded', [createDirectory('/root/src', 'unloaded')]);
    let active = true;
    let resolveLoad!: () => void;

    const traversalPromise = traverseDirectoriesDirect(['/root/src'], {
      getDirectoryByPath: (path) => findDirectoryByPath(root, path),
      isActive: () => active,
      loadDirectoryPath: () =>
        new Promise<void>((resolve) => {
          resolveLoad = () => {
            const target = findDirectoryByPath(root, '/root/src');
            if (!target) {
              throw new Error('missing target');
            }
            target.loadState = 'loaded';
            target.children = [createDirectory('/root/src/nested', 'loaded')];
            resolve();
          };
        }),
    });

    active = false;
    resolveLoad();

    const result = await traversalPromise;

    expect(result.cancelled).toBe(true);
    expect(result.loaded).toBe(0);
    expect(result.visitedPaths).toEqual(['/root/src']);
  });

  it('treats a directory removed during async load as completed without dereferencing it', async () => {
    const root = createDirectory('/root', 'loaded', [createDirectory('/root/src', 'unloaded')]);

    const result = await traverseDirectoriesDirect(['/root/src'], {
      getDirectoryByPath: (path) => findDirectoryByPath(root, path),
      isActive: () => true,
      loadDirectoryPath: async () => {
        root.children = [];
      },
    });

    expect(result.cancelled).toBe(false);
    expect(result.loaded).toBe(1);
    expect(result.visitedPaths).toEqual(['/root/src']);
  });

  it('does not enumerate stale children when a load resolves into an error state', async () => {
    const staleChild = createDirectory('/root/src/stale', 'loaded');
    const root = createDirectory('/root', 'loaded', [
      createDirectory('/root/src', 'unloaded', [staleChild]),
    ]);

    const result = await traverseDirectoriesDirect(['/root/src'], {
      getDirectoryByPath: (path) => findDirectoryByPath(root, path),
      isActive: () => true,
      loadDirectoryPath: async (path) => {
        if (path !== '/root/src') {
          return;
        }
        const target = findDirectoryByPath(root, path);
        if (!target) {
          throw new Error('missing target');
        }
        target.loadState = 'error';
      },
    });

    expect(result.cancelled).toBe(false);
    expect(result.loaded).toBe(1);
    expect(result.visitedPaths).toEqual(['/root/src']);
    expect(result.discoveredPaths).toEqual(new Set(['/root/src']));
  });

  it('invokes onBatchLoadsSettled after each batch of loads and before discovery reads', async () => {
    const events: string[] = [];
    const nodes = new Map<string, IFileNode>([['/root/a', createDirectory('/root/a', 'unloaded')]]);
    const childrenByPath: Record<string, IFileNode[]> = {
      '/root/a': [createDirectory('/root/a/b', 'unloaded')],
      '/root/a/b': [],
    };

    const session = createDirectDirectoryTraversalSession(['/root/a'], {
      getDirectoryByPath: (path) => {
        events.push(`read:${path}`);
        return nodes.get(path);
      },
      isActive: () => true,
      loadDirectoryPath: async (path) => {
        events.push(`load:${path}`);
        const children = childrenByPath[path] ?? [];
        nodes.set(path, createDirectory(path, 'loaded', children));
        for (const child of children) {
          nodes.set(child.path, child);
        }
      },
      onBatchLoadsSettled: () => {
        events.push('settled');
      },
    });

    const firstBatch = await session.processNextBatch();
    expect(firstBatch.complete).toBe(false);
    const secondBatch = await session.processNextBatch();
    expect(secondBatch.complete).toBe(true);

    // Each batch settles exactly once: after its loads finished, before the
    // discovery reads that enqueue newly revealed child directories.
    expect(events).toEqual([
      'read:/root/a',
      'load:/root/a',
      'settled',
      'read:/root/a',
      'read:/root/a/b',
      'load:/root/a/b',
      'settled',
      'read:/root/a/b',
    ]);
  });

  it('throws when discovered directories exceed the traversal safety limit', async () => {
    const root = createDirectory('/root', 'loaded', [createDirectory('/root/src', 'loaded')]);
    const src = findDirectoryByPath(root, '/root/src');
    if (!src) {
      throw new Error('missing src');
    }
    src.children = [createDirectory('/root/src/nested', 'loaded')];

    await expect(
      traverseDirectoriesDirect(['/root/src'], {
        getDirectoryByPath: (path) => findDirectoryByPath(root, path),
        isActive: () => true,
        loadDirectoryPath: async () => undefined,
        maxDirectories: 1,
      })
    ).rejects.toThrow('Directory traversal limit exceeded (1)');
  });
});
