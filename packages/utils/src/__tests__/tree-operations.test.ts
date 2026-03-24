import { describe, expect, it } from 'vitest';
import {
  findNodeByPath,
  getPathDepth,
  isDescendantPath,
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
    });
  });

  describe('findNodeByPath', () => {
    it('finds descendants without treating shared prefixes as ancestors', () => {
      const tree: TestTreeNode[] = [
        createDirectoryNode({
          name: 'com',
          path: '/root/com',
          children: [createFileNode({ path: '/root/com/legacy.ts' })],
        }),
        createDirectoryNode({
          name: 'components',
          path: '/root/components',
          children: [createFileNode({ path: '/root/components/Button.tsx' })],
        }),
      ];

      const found = findNodeByPath(tree, '/root/components/Button.tsx');

      expect(found?.path).toBe('/root/components/Button.tsx');
    });
  });

  describe('updateNodeChildren', () => {
    it('does not clone sibling branches that only share a string prefix', () => {
      const untouchedPrefixBranch = createDirectoryNode({
        name: 'com',
        path: '/root/com',
        children: [createFileNode({ path: '/root/com/legacy.ts' })],
      });
      const targetBranch = createDirectoryNode({
        name: 'components',
        path: '/root/components',
        children: [
          createDirectoryNode({
            name: 'nested',
            path: '/root/components/nested',
          }),
        ],
      });
      const tree: TestTreeNode[] = [untouchedPrefixBranch, targetBranch];
      const newChildren = [createFileNode({ path: '/root/components/nested/new.ts' })];

      const updated = updateNodeChildren(tree, '/root/components/nested', newChildren, 'loaded');

      expect(updated[0]).toBe(untouchedPrefixBranch);
      expect(updated[1]).not.toBe(targetBranch);
      expect(updated[1]?.children?.[0]?.children).toEqual(newChildren);
    });
  });
});
