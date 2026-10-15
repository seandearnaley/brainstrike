// @vitest-environment node
/**
 * Pure helpers behind the breadcrumb popover mini-tree (BST-1319): which
 * directory a clicked segment lists (its PARENT — the segment's siblings),
 * the ancestor chain to materialize lazily, and flattening loaded nodes into
 * visible rows. Both '/' and Windows '\\' separator forms are exercised —
 * segment paths are sliced from the original tab path, so the helpers must
 * never normalize.
 */

import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  collectMiniTreeLoadChain,
  flattenMiniTreeEntries,
  resolveMiniTreeParentPath,
} from '../breadcrumb-mini-tree-entries';

function node(
  path: string,
  type: 'file' | 'directory' | 'loadMore',
  children?: IFileNode[]
): IFileNode {
  return {
    depth: 0,
    handle: {} as unknown as IFileNode['handle'],
    name: path.split(/[/\\]/).pop() ?? path,
    path,
    type,
    ...(children ? { children } : {}),
  } as IFileNode;
}

describe('resolveMiniTreeParentPath', () => {
  it('maps a first-level segment to the workspace root level (null)', () => {
    expect(resolveMiniTreeParentPath('/root/src', '/root')).toBeNull();
  });

  it('maps deeper segments to their parent directory', () => {
    expect(resolveMiniTreeParentPath('/root/src/app.ts', '/root')).toBe('/root/src');
    expect(resolveMiniTreeParentPath('/root/src/ui/button.ts', '/root')).toBe('/root/src/ui');
  });

  it('handles relative (web) tab paths', () => {
    expect(resolveMiniTreeParentPath('src', null)).toBeNull();
    expect(resolveMiniTreeParentPath('src/app.ts', null)).toBe('src');
  });

  it('handles Windows separators without normalizing', () => {
    expect(resolveMiniTreeParentPath('C:\\root\\src', 'C:\\root')).toBeNull();
    expect(resolveMiniTreeParentPath('C:\\root\\src\\app.ts', 'C:\\root')).toBe('C:\\root\\src');
  });
});

describe('collectMiniTreeLoadChain', () => {
  it('is empty at the root level (the provider loads the root itself)', () => {
    expect(collectMiniTreeLoadChain(null, '/root')).toEqual([]);
  });

  it('lists every cumulative ancestor directory down to the parent', () => {
    expect(collectMiniTreeLoadChain('/root/src/ui', '/root')).toEqual([
      '/root/src',
      '/root/src/ui',
    ]);
  });

  it('preserves Windows separator form', () => {
    expect(collectMiniTreeLoadChain('C:\\root\\src\\ui', 'C:\\root')).toEqual([
      'C:\\root\\src',
      'C:\\root\\src\\ui',
    ]);
  });
});

describe('flattenMiniTreeEntries', () => {
  const tree: IFileNode[] = [
    node('/root/readme.md', 'file'),
    node('/root/src', 'directory', [
      node('/root/src/app.ts', 'file'),
      node('/root/src/ui', 'directory', [node('/root/src/ui/button.ts', 'file')]),
      node('/root/src/…more', 'loadMore'),
    ]),
  ];

  const paths = (entries: ReturnType<typeof flattenMiniTreeEntries>) =>
    entries.map((entry) => [entry.kind === 'node' ? entry.node.path : entry.path, entry.depth]);

  it('lists the workspace root level when parentPath is null', () => {
    expect(paths(flattenMiniTreeEntries(tree, null, new Set()))).toEqual([
      ['/root/readme.md', 0],
      ['/root/src', 0],
    ]);
  });

  it('lists a parent directory contents, recursing ONLY into expanded dirs', () => {
    expect(paths(flattenMiniTreeEntries(tree, '/root/src', new Set()))).toEqual([
      ['/root/src/app.ts', 0],
      ['/root/src/ui', 0],
      ['/root/src/…more#partial', 0],
    ]);

    expect(paths(flattenMiniTreeEntries(tree, '/root/src', new Set(['/root/src/ui'])))).toEqual([
      ['/root/src/app.ts', 0],
      ['/root/src/ui', 0],
      ['/root/src/ui/button.ts', 1],
      ['/root/src/…more#partial', 0],
    ]);
  });

  it('pseudo node types (loadMore/truncated) become NOTICE rows — a partial listing must not pass as complete', () => {
    const entries = flattenMiniTreeEntries(tree, '/root/src', new Set());
    const notice = entries.at(-1);
    expect(notice).toEqual({
      depth: 0,
      kind: 'notice',
      message: 'Partial listing — browse the rest in the explorer pane.',
      path: '/root/src/…more#partial',
    });
    expect(entries.some((entry) => entry.kind === 'node' && entry.node.type === 'loadMore')).toBe(
      false
    );
  });

  it('an expanded dir whose load ERRORED yields a synthetic error row, never a silent empty branch', () => {
    const broken = node('/root/src/ui', 'directory');
    (broken as { loadError?: string; loadState?: string }).loadState = 'error';
    (broken as { loadError?: string }).loadError = 'Permission denied';
    const errorTree: IFileNode[] = [node('/root/src', 'directory', [broken])];

    const entries = flattenMiniTreeEntries(errorTree, '/root/src', new Set(['/root/src/ui']));
    expect(entries).toEqual([
      { depth: 0, kind: 'node', node: broken },
      {
        depth: 1,
        kind: 'error',
        message: 'Permission denied',
        path: '/root/src/ui#load-error',
      },
    ]);
  });

  it('returns [] when the parent node is not present (caller shows an explicit state)', () => {
    expect(flattenMiniTreeEntries(tree, '/root/missing', new Set())).toEqual([]);
  });
});
