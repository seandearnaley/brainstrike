import { describe, expect, it } from 'vitest';
import {
  canLoadNode,
  collectDirectoryPaths,
  collectExpandedPaths,
  findNodeByPath,
  getPathDepth,
  isDescendantPath,
  isLoading,
  needsLoading,
  resetDirectoryNode,
  setNodeLoadState,
  sortTreeNodes,
  type TreeNode,
  updateNodeChildren,
} from '../tree-operations';

interface TestTreeNode extends TreeNode {
  children?: TestTreeNode[];
}

function createFileNode(overrides: Partial<TestTreeNode> = {}): TestTreeNode {
  return {
    name: 'file.ts',
    path: '/root/file.ts',
    type: 'file',
    ...overrides,
  };
}

function createDirectoryNode(overrides: Partial<TestTreeNode> = {}): TestTreeNode {
  return {
    name: 'dir',
    path: '/root/dir',
    type: 'directory',
    ...overrides,
  };
}

describe('tree-operations', () => {
  describe('isDescendantPath', () => {
    it('requires an exact path-segment boundary', () => {
      expect(isDescendantPath('/root/com/file.ts', '/root/com')).toBe(true);
      expect(isDescendantPath('/root/components/file.ts', '/root/com')).toBe(false);
      expect(isDescendantPath('/root/com', '/root/com')).toBe(false);
    });
  });

  describe('getPathDepth', () => {
    it('returns zero for empty and separator-only paths', () => {
      expect(getPathDepth('')).toBe(0);
      expect(getPathDepth('/')).toBe(0);
      expect(getPathDepth('///')).toBe(0);
    });

    it('counts only real path segments', () => {
      expect(getPathDepth('file.txt')).toBe(1);
      expect(getPathDepth('/src/components/Button.tsx')).toBe(3);
      expect(getPathDepth('/src//components///Button.tsx/')).toBe(3);
      expect(getPathDepth('src/components/Button.tsx')).toBe(3);
      expect(getPathDepth('/a/b/c/d/e/f/g/h/i/j/k')).toBe(11);
      expect(getPathDepth('src\\components\\Button.tsx')).toBe(1);
    });
  });

  describe('findNodeByPath', () => {
    it('finds descendants without treating shared prefixes as ancestors', () => {
      const tree: TestTreeNode[] = [
        createDirectoryNode({
          children: [createFileNode({ path: '/root/com/legacy.ts' })],
          name: 'com',
          path: '/root/com',
        }),
        createDirectoryNode({
          children: [createFileNode({ path: '/root/components/Button.tsx' })],
          name: 'components',
          path: '/root/components',
        }),
      ];

      const found = findNodeByPath(tree, '/root/components/Button.tsx');

      expect(found?.path).toBe('/root/components/Button.tsx');
    });
  });

  describe('sortTreeNodes', () => {
    it('orders directories before files and uses numeric name sorting within each type', () => {
      const nodes = [
        createFileNode({ name: 'file10.ts', path: '/root/file10.ts' }),
        createDirectoryNode({ name: 'dir2', path: '/root/dir2' }),
        createFileNode({ name: 'file2.ts', path: '/root/file2.ts' }),
        createDirectoryNode({ name: 'dir10', path: '/root/dir10' }),
      ];

      expect(sortTreeNodes(nodes).map((node) => node.name)).toEqual([
        'dir2',
        'dir10',
        'file2.ts',
        'file10.ts',
      ]);
      expect(sortTreeNodes(nodes)).not.toBe(nodes);
    });
  });

  describe('loading predicates', () => {
    it('identifies loadable and loading directory states', () => {
      expect(needsLoading(createDirectoryNode())).toBe(true);
      expect(needsLoading(createDirectoryNode({ loadState: 'unloaded' }))).toBe(true);
      expect(needsLoading(createDirectoryNode({ loadState: 'loaded' }))).toBe(false);
      expect(needsLoading(createFileNode())).toBe(false);

      expect(isLoading(createDirectoryNode({ loadState: 'loading' }))).toBe(true);
      expect(isLoading(createDirectoryNode({ loadState: 'error' }))).toBe(false);

      expect(canLoadNode(null)).toBe(false);
      expect(canLoadNode(undefined)).toBe(false);
      expect(canLoadNode(createFileNode())).toBe(false);
      expect(canLoadNode(createDirectoryNode({ loadState: 'loaded' }))).toBe(false);
      expect(canLoadNode(createDirectoryNode({ loadState: 'loading' }))).toBe(false);
      expect(canLoadNode(createDirectoryNode({ loadState: 'error' }))).toBe(true);
    });
  });

  describe('updateNodeChildren', () => {
    it('does not clone sibling branches that only share a string prefix', () => {
      const untouchedPrefixBranch = createDirectoryNode({
        children: [createFileNode({ path: '/root/com/legacy.ts' })],
        name: 'com',
        path: '/root/com',
      });
      const targetBranch = createDirectoryNode({
        children: [
          createDirectoryNode({
            name: 'nested',
            path: '/root/components/nested',
          }),
        ],
        name: 'components',
        path: '/root/components',
      });
      const tree: TestTreeNode[] = [untouchedPrefixBranch, targetBranch];
      const newChildren = [createFileNode({ path: '/root/components/nested/new.ts' })];

      const updated = updateNodeChildren(tree, '/root/components/nested', newChildren, 'loaded');

      expect(updated[0]).toBe(untouchedPrefixBranch);
      expect(updated[1]).not.toBe(targetBranch);
      expect(updated[1]?.children?.[0]?.children).toEqual(newChildren);
    });
  });

  describe('setNodeLoadState', () => {
    it('updates the target node state immutably and replaces stale errors only when provided', () => {
      const target = createDirectoryNode({
        loadError: 'old error',
        path: '/root/dir/child',
      });
      const parent = createDirectoryNode({
        children: [target],
        path: '/root/dir',
      });
      const sibling = createDirectoryNode({ path: '/root/sibling' });
      const tree = [parent, sibling];

      const loadingTree = setNodeLoadState(tree, '/root/dir/child', 'loading');

      expect(loadingTree[0]).not.toBe(parent);
      expect(loadingTree[1]).toBe(sibling);
      expect(loadingTree[0]?.children?.[0]).toMatchObject({
        loadState: 'loading',
        path: '/root/dir/child',
      });
      expect(loadingTree[0]?.children?.[0]).not.toHaveProperty('loadError');

      const errorTree = setNodeLoadState(tree, '/root/dir/child', 'error', 'permission denied');
      expect(errorTree[0]?.children?.[0]).toMatchObject({
        loadError: 'permission denied',
        loadState: 'error',
      });
    });
  });

  describe('directory path collection', () => {
    it('collects all directory paths and expanded loaded paths recursively', () => {
      const tree: TestTreeNode[] = [
        createDirectoryNode({
          children: [
            createDirectoryNode({
              children: [createFileNode({ path: '/root/src/components/button.tsx' })],
              loadState: 'loaded',
              path: '/root/src/components',
            }),
            createDirectoryNode({
              children: [createFileNode({ path: '/root/src/pending/hidden.ts' })],
              loadState: 'unloaded',
              path: '/root/src/pending',
            }),
          ],
          loadState: 'loaded',
          path: '/root/src',
        }),
        createFileNode({ path: '/root/readme.md' }),
      ];
      const paths = new Set<string>();

      collectDirectoryPaths(tree, paths);

      expect([...paths]).toEqual(['/root/src', '/root/src/components', '/root/src/pending']);
      expect(collectExpandedPaths(tree)).toEqual(['/root/src', '/root/src/components']);
    });
  });

  describe('resetDirectoryNode', () => {
    it('removes loaded children and errors only from directory nodes', () => {
      const directory = createDirectoryNode({
        children: [createFileNode()],
        loadError: 'failed',
        loadState: 'error',
      });
      const file = createFileNode();

      expect(resetDirectoryNode(directory)).toEqual({
        loadState: 'unloaded',
        name: 'dir',
        path: '/root/dir',
        type: 'directory',
      });
      expect(resetDirectoryNode(file)).toBe(file);
    });
  });
});
