import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { applyQuickFilterToTree } from '../quick-filter-tree';

function file(name: string, parentPath = '/root'): IFileNode {
  return {
    depth: 1,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name,
    path: `${parentPath}/${name}`,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  };
}

function dir(name: string, children: IFileNode[], parentPath = '/root'): IFileNode {
  return {
    children,
    depth: 1,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState: 'loaded',
    name,
    path: `${parentPath}/${name}`,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
  };
}

describe('applyQuickFilterToTree', () => {
  it('is identity for a blank filter', () => {
    const tree = [dir('src', [file('a.ts', '/root/src')])];
    expect(applyQuickFilterToTree(tree, '  ')).toBe(tree);
  });

  it('filters non-matching files and prunes name-mismatched empty directories', () => {
    const tree = [
      dir('src', [file('a.ts', '/root/src'), file('readme.md', '/root/src')]),
      dir('docs', [file('guide.md', '/root/docs')]),
    ];
    const result = applyQuickFilterToTree(tree, 'ts');
    expect(result.map((node) => node.name)).toEqual(['src']);
    expect(result[0]?.children?.map((node) => node.name)).toEqual(['a.ts']);
  });

  it('drops excluded directories entirely', () => {
    const tree = [
      dir('node_modules', [file('pkg.json', '/root/node_modules')]),
      dir('src', [file('a.ts', '/root/src')]),
    ];
    const result = applyQuickFilterToTree(tree, '-node_modules');
    expect(result.map((node) => node.name)).toEqual(['src']);
  });

  // Structural sharing: the display filter used to CLONE every retained
  // directory on every (deferred) keystroke — for a large workspace that is a
  // full-tree allocation pass per query settle, and fresh node identities
  // defeat the memo'd rows and WeakMap-keyed derivation caches downstream.
  describe('structural sharing', () => {
    it('returns the ORIGINAL node objects for fully retained subtrees', () => {
      const srcChildren = [file('a.ts', '/root/src'), file('b.ts', '/root/src')];
      const src = dir('src', srcChildren);
      const docs = dir('docs', [file('guide.md', '/root/docs')]);
      const tree = [src, docs];

      // Every file under src matches; docs is pruned entirely.
      const result = applyQuickFilterToTree(tree, 'ts');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(src);
      expect(result[0]?.children).toBe(srcChildren);
    });

    it('only reallocates directories whose subtree actually changed', () => {
      const keptSubtree = dir('kept', [file('x.ts', '/root/parent/kept')], '/root/parent');
      const mixedSubtree = dir(
        'mixed',
        [file('y.ts', '/root/parent/mixed'), file('skip.md', '/root/parent/mixed')],
        '/root/parent'
      );
      const parent = dir('parent', [keptSubtree, mixedSubtree]);

      const result = applyQuickFilterToTree([parent], 'ts');
      const filteredParent = result[0];
      expect(filteredParent).not.toBe(parent);
      const filteredKept = filteredParent?.children?.find((node) => node.name === 'kept');
      const filteredMixed = filteredParent?.children?.find((node) => node.name === 'mixed');
      // Untouched subtree keeps identity; changed subtree gets a new object.
      expect(filteredKept).toBe(keptSubtree);
      expect(filteredMixed).not.toBe(mixedSubtree);
      expect(filteredMixed?.children?.map((node) => node.name)).toEqual(['y.ts']);
    });
  });
});
