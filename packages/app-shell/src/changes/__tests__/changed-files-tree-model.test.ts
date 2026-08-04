/**
 * Unit tests for `buildChangedFilesTree` (BST-1114, W4 Task B).
 *
 * The identity-stability assertions here are the load-bearing ones: TreeTable
 * (`packages/ui/src/tree-table/tree-utils.ts`'s `reuseEqualFlattenedRows`)
 * only bails out a row's re-render when `a.node === b.node`, so this model
 * MUST return `===` node objects for unchanged rows across rebuilds — both
 * when the caller reuses the same `ChangedFileEntry` objects in a fresh
 * array, and when the caller constructs brand-new entry objects that are
 * merely field-equal (the WeakMap fast path in the model does nothing for
 * the latter; the value-equality reuse pass is what covers it).
 */
import type { ChangedFileEntry, GitInventory, WorktreeDescriptor } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { changedFileKey } from '../changes-store';
import {
  buildChangedFilesTree,
  type ChangedFilesTreeNode,
  OUTSIDE_ROOTS_NODE_ID,
} from '../ui/changed-files-tree-model';

function makeEntry(overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return {
    additions: 3,
    deletions: 1,
    path: 'src/a.ts',
    repositoryRoot: '/repo',
    revertible: true,
    rootId: 'root-1',
    status: 'modified',
    worktreePath: '/repo',
    ...overrides,
  };
}

function makeDescriptor(overrides: Partial<WorktreeDescriptor> = {}): WorktreeDescriptor {
  return {
    bare: false,
    branch: 'main',
    containment: ['root-1'],
    current: false,
    detached: false,
    head: 'deadbeef',
    lockedReason: null,
    name: 'primary',
    path: '/repo',
    provenance: 'scanned',
    prunableReason: null,
    trust: 'validated',
    trustReason: null,
    ...overrides,
  };
}

function findNode(nodes: readonly ChangedFilesTreeNode[], id: string): ChangedFilesTreeNode {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(`Expected node ${id} in tree, got: ${nodes.map((n) => n.id).join(', ')}`);
  }
  return node;
}

describe('buildChangedFilesTree identity stability', () => {
  it('returns === node objects for unchanged rows across a fresh-but-equal files array', () => {
    const files = [
      makeEntry({
        path: 'src/one.ts',
        repositoryRoot: '/stable-repo',
        rootId: 'root-stable',
        worktreePath: '/stable-repo',
      }),
      makeEntry({
        path: 'src/two.ts',
        repositoryRoot: '/stable-repo',
        rootId: 'root-stable',
        worktreePath: '/stable-repo',
      }),
    ];

    const first = buildChangedFilesTree(files, null);
    // A fresh ARRAY, same entry object references — the common real-world case.
    const second = buildChangedFilesTree([...files], null);

    expect(second).toHaveLength(first.length);
    for (const node of first) {
      expect(findNode(second, node.id)).toBe(node);
    }
  });

  it('reuses nodes even when the entries themselves are freshly constructed but field-equal', () => {
    const buildFiles = (): ChangedFileEntry[] => [
      makeEntry({
        path: 'src/one.ts',
        repositoryRoot: '/fresh-repo',
        rootId: 'root-fresh',
        worktreePath: '/fresh-repo',
      }),
      makeEntry({
        path: 'src/two.ts',
        repositoryRoot: '/fresh-repo',
        rootId: 'root-fresh',
        worktreePath: '/fresh-repo',
      }),
    ];

    const first = buildChangedFilesTree(buildFiles(), null);
    // Brand-new entry OBJECTS (different references) with equal field values —
    // the WeakMap fast path in the model cannot help here; only the
    // value-equality reuse pass can.
    const second = buildChangedFilesTree(buildFiles(), null);

    expect(second).toHaveLength(first.length);
    for (const node of first) {
      expect(findNode(second, node.id)).toBe(node);
    }
  });

  it('produces a new node for a changed row and reuses === nodes for the rest, including group nodes', () => {
    const fileA = makeEntry({
      path: 'src/changed.ts',
      repositoryRoot: '/repo-2',
      rootId: 'root-2',
      status: 'modified',
      worktreePath: '/repo-2',
    });
    const fileB = makeEntry({
      path: 'src/unchanged.ts',
      repositoryRoot: '/repo-2',
      rootId: 'root-2',
      status: 'added',
      worktreePath: '/repo-2',
    });

    const first = buildChangedFilesTree([fileA, fileB], null);
    const firstRoot = findNode(first, 'root:root-2');
    const firstRepo = findNode(first, 'repo:/repo-2');
    const firstWorktree = findNode(first, 'worktree:/repo-2');
    const firstUnchangedLeaf = findNode(first, changedFileKey(fileB));

    const changedFileA: ChangedFileEntry = { ...fileA, status: 'deleted' };
    const second = buildChangedFilesTree([changedFileA, fileB], null);

    // The changed row gets a fresh node...
    const secondChangedLeaf = findNode(second, changedFileKey(changedFileA));
    expect(secondChangedLeaf).not.toBe(findNode(first, changedFileKey(fileA)));
    expect(secondChangedLeaf.data.kind).toBe('file');
    if (secondChangedLeaf.data.kind === 'file') {
      expect(secondChangedLeaf.data.entry.status).toBe('deleted');
    }

    // ...but every other row, including the ancestor GROUP nodes it shares
    // with the changed file, is reused by reference.
    expect(findNode(second, 'root:root-2')).toBe(firstRoot);
    expect(findNode(second, 'repo:/repo-2')).toBe(firstRepo);
    expect(findNode(second, 'worktree:/repo-2')).toBe(firstWorktree);
    expect(findNode(second, changedFileKey(fileB))).toBe(firstUnchangedLeaf);
  });
});

describe('buildChangedFilesTree grouping and honesty', () => {
  it('places a file with a null worktreePath in the explicit outside-roots group instead of dropping it', () => {
    const outside = makeEntry({
      path: 'loose.ts',
      repositoryRoot: null,
      rootId: null,
      worktreePath: null,
    });
    const located = makeEntry({
      path: 'src/in.ts',
      repositoryRoot: '/repo-3',
      rootId: 'root-3',
      worktreePath: '/repo-3',
    });

    const nodes = buildChangedFilesTree([outside, located], null);

    const outsideGroup = findNode(nodes, OUTSIDE_ROOTS_NODE_ID);
    expect(outsideGroup.data.kind).toBe('outside-roots');
    expect(outsideGroup.parentId).toBeNull();

    const outsideLeaf = findNode(nodes, changedFileKey(outside));
    expect(outsideLeaf.parentId).toBe(OUTSIDE_ROOTS_NODE_ID);
    expect(outsideLeaf.data.kind).toBe('file');

    // The located file is NOT swept into the outside group.
    const locatedLeaf = findNode(nodes, changedFileKey(located));
    expect(locatedLeaf.parentId).toBe('worktree:/repo-3');
  });

  it('keeps null additions/deletions as null on the node data, never coerced to 0', () => {
    const binary = makeEntry({
      additions: null,
      deletions: null,
      path: 'image.png',
      repositoryRoot: '/repo-4',
      rootId: 'root-4',
      worktreePath: '/repo-4',
    });

    const nodes = buildChangedFilesTree([binary], null);
    const leaf = findNode(nodes, changedFileKey(binary));

    expect(leaf.data.kind).toBe('file');
    if (leaf.data.kind === 'file') {
      expect(leaf.data.entry.additions).toBeNull();
      expect(leaf.data.entry.deletions).toBeNull();
    }
  });

  it('resolves the worktree group data from the inventory descriptor name, not a path basename', () => {
    const descriptor = makeDescriptor({
      branch: 'feature/nested',
      name: 'Friendly Worktree Name',
      path: '/deeply/nested/worktree-path',
      trust: 'validated',
    });
    const inventory: GitInventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: '/deeply/nested/.git', repositoryRoot: '/deeply/nested' },
          worktrees: [descriptor],
        },
      ],
    };
    const entry = makeEntry({
      path: 'src/x.ts',
      repositoryRoot: '/deeply/nested',
      rootId: 'root-5',
      worktreePath: '/deeply/nested/worktree-path',
    });

    const nodes = buildChangedFilesTree([entry], inventory);
    const worktreeNode = findNode(nodes, 'worktree:/deeply/nested/worktree-path');

    expect(worktreeNode.data.kind).toBe('worktree');
    if (worktreeNode.data.kind === 'worktree') {
      // The model carries the resolved descriptor through untouched — it never
      // derives its own basename-based label, which would have produced
      // "worktree-path" here instead of the descriptor's real name.
      expect(worktreeNode.data.descriptor?.name).toBe('Friendly Worktree Name');
      expect(worktreeNode.data.descriptor?.name).not.toBe('worktree-path');
    }
  });

  it('builds a tree from files alone when inventory is null, without blocking or fabricating names', () => {
    const entry = makeEntry({
      path: 'src/x.ts',
      repositoryRoot: '/repo-6',
      rootId: 'root-6',
      worktreePath: '/repo-6',
    });

    const nodes = buildChangedFilesTree([entry], null);
    const worktreeNode = findNode(nodes, 'worktree:/repo-6');

    expect(worktreeNode.data.kind).toBe('worktree');
    if (worktreeNode.data.kind === 'worktree') {
      expect(worktreeNode.data.descriptor).toBeNull();
    }
  });
});
