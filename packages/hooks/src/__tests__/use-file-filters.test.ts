import { act, renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useFileFilters } from '../use-file-filters';
import type { IFileNode } from '@brainstrike/types';

// Helper to create file nodes
const fileNode = (name: string, path: string): IFileNode => ({
  type: 'file',
  name,
  path,
  handle: {} as any,
  selectionState: 'unchecked',
  rootFolderId: 'root',
});

// Helper to create directory nodes
const dirNode = (name: string, path: string, children: IFileNode[]): IFileNode => ({
  type: 'directory',
  name,
  path,
  handle: {} as any,
  selectionState: 'unchecked',
  rootFolderId: 'root',
  children,
});

describe('useFileFilters', () => {
  const mockTree: IFileNode[] = [
    dirNode('root', 'root', [
      fileNode('foo.txt', 'root/foo.txt'),
      fileNode('bar.md', 'root/bar.md'),
      dirNode('sub', 'root/sub', [fileNode('baz.js', 'root/sub/baz.js')]),
    ]),
  ];

  it('returns original tree when no filters', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters, filterError } = result.current;
    const filtered = applyFileFilters(mockTree, [], []);
    expect(filtered).toEqual(mockTree);
    expect(filterError).toBeNull();
  });

  it('filters by include glob patterns', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters } = result.current;
    const filtered = applyFileFilters(mockTree, ['*.txt'], []);
    // Expect only foo.txt under root, bar.md filtered out, sub directory present but children empty
    expect(filtered).toHaveLength(1);
    const rootDir = filtered[0];
    const children = rootDir.children ?? [];
    expect(children).toHaveLength(1);
    expect(children[0].name).toBe('foo.txt');
  });

  it('filters by exclude glob patterns', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters } = result.current;
    const filtered = applyFileFilters(mockTree, [], ['*.md']);
    // Expect foo.txt and baz.js, bar.md excluded
    const rootDir = filtered[0];
    // Children: foo.txt, sub directory (children baz.js)
    const children = rootDir.children ?? [];
    expect(children).toHaveLength(2);
    const names = children.map((n) => n.name);
    expect(names).toContain('foo.txt');
    const sub = children.find((n) => n.name === 'sub');
    expect(sub).toBeDefined();
    const subChildren = sub?.children ?? [];
    expect(subChildren).toHaveLength(1);
    expect(subChildren[0].name).toBe('baz.js');
  });

  it('applies both include and exclude patterns', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters } = result.current;
    // Include all .js files but exclude sub directory
    const filtered = applyFileFilters(mockTree, ['*.js'], ['sub']);
    // root directory children: only sub? But exclude 'sub' directory itself, so no children
    expect(filtered).toHaveLength(1);
    const rootDir = filtered[0];
    expect(rootDir.children ?? []).toHaveLength(0);
  });

  it('handles valid regex filters', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters, filterError } = result.current;
    const filtered = applyFileFilters(mockTree, ['^.*\\.js$'], [], true);
    expect(filtered).toHaveLength(1);
    const rootDir = filtered[0];
    // Children: sub directory with baz.js
    const children = rootDir.children ?? [];
    const sub = children.find((n) => n.name === 'sub');
    expect(sub).toBeDefined();
    const subChildren = sub?.children ?? [];
    expect(subChildren[0].name).toBe('baz.js');
    expect(filterError).toBeNull();
  });

  it('returns empty on invalid regex and sets filterError', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters } = result.current;
    let filtered: IFileNode[] = [];
    act(() => {
      filtered = result.current.applyFileFilters(mockTree, ['['], [], true);
    });
    expect(filtered).toEqual([]);
    expect(result.current.filterError).toContain('Invalid regex pattern');
  });
});
