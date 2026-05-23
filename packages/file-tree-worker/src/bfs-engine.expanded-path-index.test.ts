/**
 * Expanded-path index regression tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerFileNode, WorkerToMainMessage } from './types';

const treeOperationCounters = vi.hoisted(() => ({
  isDescendantPathCalls: 0,
}));

vi.mock('@brainstrike/utils/tree-operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/tree-operations')>();

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
    name: 'dir',
    path: '/root/dir',
    type: 'directory',
    depth: 1,
    rootFolderId: 'root',
    loadState: 'loaded',
    children: [],
    ...overrides,
  };
}

describe('BFSEngine expanded-path index', () => {
  let messages: WorkerToMainMessage[];
  let engine: BFSEngine;

  beforeEach(() => {
    messages = [];
    treeOperationCounters.isDescendantPathCalls = 0;
    engine = new BFSEngine((message) => {
      messages.push(message);
    });
  });

  it('does not scan unrelated expanded siblings for each directory update', () => {
    const siblingDirectories = Array.from({ length: 5000 }, (_, index) =>
      createDirectoryNode({
        name: `sibling-${index}`,
        path: `/root/sibling-${index}`,
        children: undefined,
      })
    );
    const targetChild = createDirectoryNode({
      name: 'child',
      path: '/root/target/child',
      depth: 2,
    });
    engine.setTree(
      [
        createDirectoryNode({
          name: 'target',
          path: '/root/target',
          children: [targetChild],
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
});
