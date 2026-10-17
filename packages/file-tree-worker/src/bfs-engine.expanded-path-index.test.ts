/**
 * Expanded-path index regression tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerFileNode, WorkerToMainMessage } from './types';

const treeOperationCounters = vi.hoisted(() => ({
  isDescendantPathCalls: 0,
}));

vi.mock('./generic-tree-operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./generic-tree-operations')>();

  return {
    ...actual,
    isDescendantPath(path: string, parentPath: string): boolean {
      treeOperationCounters.isDescendantPathCalls++;
      return actual.isDescendantPath(path, parentPath);
    },
  };
});

const { BFSEngine } = await import('./bfs-engine');

function createDirectoryNode(overrides: Partial<WorkerFileNode> = {}): WorkerFileNode {
  return {
    children: [],
    depth: 1,
    loadState: 'loaded',
    name: 'dir',
    path: '/root/dir',
    rootFolderId: 'root',
    type: 'directory',
    ...overrides,
  };
}

function createDirectoryWithoutChildren(overrides: Partial<WorkerFileNode>): WorkerFileNode {
  const { children: _children, ...node } = createDirectoryNode(overrides);
  return node;
}

describe('BFSEngine expanded-path index', () => {
  let messages: WorkerToMainMessage[];
  let engine: InstanceType<typeof BFSEngine>;

  beforeEach(() => {
    messages = [];
    treeOperationCounters.isDescendantPathCalls = 0;
    engine = new BFSEngine((message) => {
      messages.push(message);
    });
  });

  it('does not scan unrelated expanded siblings for each directory update', () => {
    const siblingDirectories = Array.from({ length: 5000 }, (_, index) =>
      createDirectoryWithoutChildren({
        name: `sibling-${index}`,
        path: `/root/sibling-${index}`,
      })
    );
    const targetChild = createDirectoryNode({
      depth: 2,
      name: 'child',
      path: '/root/target/child',
    });
    engine.setTree(
      [
        createDirectoryNode({
          children: [targetChild],
          name: 'target',
          path: '/root/target',
        }),
        ...siblingDirectories,
      ],
      'root'
    );
    messages = [];

    engine.handleLoadResult('/root/target', [targetChild]);

    expect(treeOperationCounters.isDescendantPathCalls).toBe(0);
    expect(messages.some((message) => message.type === 'expandedPathsDelta')).toBe(false);
  });

  it('observes descendant checks when an indexed nested node is updated', () => {
    const target = createDirectoryWithoutChildren({
      depth: 2,
      name: 'target',
      path: '/root/parent/target',
    });
    engine.setTree(
      [
        createDirectoryNode({
          children: [target],
          depth: 0,
          name: 'root',
          path: '/root',
        }),
      ],
      'root'
    );

    engine.handleLoadResult('/root/parent/target', []);

    expect(treeOperationCounters.isDescendantPathCalls).toBeGreaterThan(0);
  });
});
