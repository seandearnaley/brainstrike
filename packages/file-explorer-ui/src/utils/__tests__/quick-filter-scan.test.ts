import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { filterSelectionScanNodesByQuickFilter } from '../quick-filter-tree';

function file(name: string): IFileNode {
  return {
    depth: 1,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name,
    path: `/root/${name}`,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  };
}

function dir(name: string): IFileNode {
  return {
    children: [],
    depth: 1,
    handle: {} as FileSystemDirectoryHandle,
    isVisible: true,
    loadState: 'unloaded',
    name,
    path: `/root/${name}`,
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'directory',
  };
}

describe('filterSelectionScanNodesByQuickFilter', () => {
  const nodes = [file('foo.ts'), file('bar.md'), dir('nested'), dir('foo-dir')];

  it('is a no-op for a blank quick filter', () => {
    expect(filterSelectionScanNodesByQuickFilter(nodes, '   ')).toBe(nodes);
  });

  it('keeps files matching the quick filter and drops non-matching files', () => {
    const result = filterSelectionScanNodesByQuickFilter(nodes, 'foo').map(
      (n: IFileNode) => n.name
    );
    expect(result).toContain('foo.ts');
    expect(result).not.toContain('bar.md');
  });

  it('ALWAYS keeps directories so the scan can traverse into them (matches may be deeper)', () => {
    // 'nested' does not match 'foo' by name, but a matching file could live
    // inside it — the scan must still descend, unlike the display filter which
    // prunes name-mismatched empty dirs.
    const result = filterSelectionScanNodesByQuickFilter(nodes, 'foo').map(
      (n: IFileNode) => n.name
    );
    expect(result).toContain('nested');
    expect(result).toContain('foo-dir');
  });

  it('honors exclusion patterns on files (case-insensitive)', () => {
    const result = filterSelectionScanNodesByQuickFilter(
      [file('Keep.ts'), file('drop.log')],
      '-log'
    ).map((n: IFileNode) => n.name);
    expect(result).toEqual(['Keep.ts']);
  });

  it('DROPS directories whose name matches an exclude term (never traverse them)', () => {
    // Review fix: an exclude term matching a DIRECTORY name (e.g. -node_modules,
    // -dist) must prune it, matching the display filter — else a recursive
    // select would traverse an excluded unloaded dir and select hidden files.
    const tree = [dir('src'), dir('node_modules'), dir('dist'), file('index.ts')];
    const result = filterSelectionScanNodesByQuickFilter(tree, '-node_modules -dist').map(
      (n: IFileNode) => n.name
    );
    expect(result).toEqual(['src', 'index.ts']);
    expect(result).not.toContain('node_modules');
    expect(result).not.toContain('dist');
  });
});
