import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFileFilters } from '../use-file-filters';

// Helper to create file nodes
const dummyHandle = {} as FileSystemFileHandle;
const fileNode = (name: string, path: string): IFileNode => ({
  depth: 0,
  handle: dummyHandle,
  name,
  path,
  rootFolderId: 'root',
  selectionState: 'unchecked',
  type: 'file',
});

// Helper to create directory nodes
const dummyDirHandle = {} as FileSystemDirectoryHandle;
const dirNode = (
  name: string,
  path: string,
  children: IFileNode[],
  overrides: Partial<IFileNode> = {}
): IFileNode => ({
  children,
  depth: 0,
  handle: dummyDirHandle,
  name,
  path,
  rootFolderId: 'root',
  selectionState: 'unchecked',
  type: 'directory',
  ...overrides,
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
    expect(filtered).toBe(mockTree);
    expect(filterError).toBeNull();
  });

  it('filters by include glob patterns', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters } = result.current;
    const filtered = applyFileFilters(mockTree, ['*.txt'], []);

    expect(filtered).toHaveLength(1); // root directory
    const rootDir = filtered[0]!;
    expect(rootDir.name).toBe('root');
    const rootChildren = rootDir.children ?? [];
    expect(rootChildren).toHaveLength(2); // foo.txt AND the sub directory

    const fooTxtNode = rootChildren.find((node) => node.name === 'foo.txt');
    expect(fooTxtNode).toBeDefined();
    expect(fooTxtNode?.type).toBe('file');

    const subDirNode = rootChildren.find((node) => node.name === 'sub');
    expect(subDirNode).toBeDefined();
    expect(subDirNode?.type).toBe('directory');
    expect(subDirNode?.children ?? []).toHaveLength(0); // sub directory should be empty
  });

  it('filters by exclude glob patterns', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters } = result.current;
    const filtered = applyFileFilters(mockTree, [], ['*.md']);
    // Expect foo.txt and baz.js, bar.md excluded
    const rootDir = filtered[0]!;
    // Children: foo.txt, sub directory (children baz.js)
    const children = rootDir.children ?? [];
    expect(children).toHaveLength(2);
    const names = children.map((n) => n.name);
    expect(names).toContain('foo.txt');
    const sub = children.find((n) => n.name === 'sub');
    expect(sub).toBeDefined();
    const subChildren = sub?.children ?? [];
    expect(subChildren).toHaveLength(1);
    expect(subChildren[0]!.name).toBe('baz.js');
  });

  it('applies both include and exclude patterns', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters } = result.current;
    // Include all .js files but exclude sub directory
    const filtered = applyFileFilters(mockTree, ['*.js'], ['sub']);
    // root directory children: only sub? But exclude 'sub' directory itself, so no children
    expect(filtered).toHaveLength(1);
    const rootDir = filtered[0]!;
    expect(rootDir.children ?? []).toHaveLength(0);
  });

  it('handles valid regex filters', () => {
    const { result } = renderHook(() => useFileFilters());
    const { applyFileFilters, filterError } = result.current;
    const filtered = applyFileFilters(mockTree, ['^.*\\.js$'], [], true);
    expect(filtered).toHaveLength(1);
    const rootDir = filtered[0]!;
    // Children: sub directory with baz.js
    const children = rootDir.children ?? [];
    const sub = children.find((n) => n.name === 'sub');
    expect(sub).toBeDefined();
    const subChildren = sub?.children ?? [];
    expect(subChildren[0]!.name).toBe('baz.js');
    expect(filterError).toBeNull();
  });

  it('returns empty on invalid regex and sets filterError', () => {
    const { result } = renderHook(() => useFileFilters());
    let filtered: IFileNode[] = [];
    act(() => {
      filtered = result.current.applyFileFilters(mockTree, ['['], [], true);
    });
    expect(filtered).toEqual([]);
    expect(result.current.filterError).toContain('Invalid regex pattern');
  });

  it('returns empty on invalid regex in exclude and sets filterError', () => {
    const { result } = renderHook(() => useFileFilters());
    let filtered: IFileNode[] = [];
    act(() => {
      filtered = result.current.applyFileFilters(mockTree, [], ['['], true);
    });
    expect(filtered).toEqual([]);
    expect(result.current.filterError).toContain('Invalid regex pattern');
  });

  it('clears filterError on subsequent valid calls', () => {
    const { result } = renderHook(() => useFileFilters());
    act(() => {
      result.current.applyFileFilters(mockTree, ['['], [], true);
    });
    expect(result.current.filterError).toContain('Invalid regex pattern');

    let filtered: IFileNode[] = [];
    act(() => {
      filtered = result.current.applyFileFilters(mockTree, [], []);
    });
    expect(result.current.filterError).toBeNull();
    expect(filtered).toMatchObject(mockTree);
  });

  it('compiles regex once for large trees', () => {
    const { result } = renderHook(() => useFileFilters());

    const largeChildren = Array.from({ length: 1000 }, (_, i) =>
      fileNode(`file${i}.txt`, `root/file${i}.txt`)
    );
    const largeTree: IFileNode[] = [dirNode('root', 'root', largeChildren)];

    const OriginalRegExp = RegExp;
    const spy = vi.fn((pattern: string, flags?: string) => new OriginalRegExp(pattern, flags));
    globalThis.RegExp = spy as unknown as RegExpConstructor;

    result.current.applyFileFilters(largeTree, ['^file\\d+\\.txt$'], [], true);

    expect(spy).toHaveBeenCalledTimes(1);

    globalThis.RegExp = OriginalRegExp;
  });

  it('should handle paths with and without leading slash', () => {
    const tree: IFileNode[] = [
      dirNode('root', '/root', [
        fileNode('file1.ts', 'file1.ts'),
        fileNode('file2.ts', '/file2.ts'),
      ]),
    ];

    const { result } = renderHook(() => useFileFilters());
    const filtered = result.current.applyFileFilters(tree, ['*.ts'], []);

    expect(filtered).toHaveLength(1);
    const rootDir = filtered[0]!;
    const children = rootDir.children ?? [];
    expect(children).toHaveLength(2);
  });

  it('should preserve directory structure when children match', () => {
    const tree: IFileNode[] = [
      dirNode('root', '/root', [dirNode('src', '/src', [fileNode('app.ts', '/src/app.ts')])]),
    ];

    const { result } = renderHook(() => useFileFilters());
    const filtered = result.current.applyFileFilters(tree, ['*.ts'], []);

    const srcDir = filtered[0]!.children?.[0];
    expect(srcDir?.children).toHaveLength(1);
  });

  it('should handle empty children array', () => {
    const tree: IFileNode[] = [dirNode('root', '/root', [dirNode('empty', '/empty', [])])];

    const { result } = renderHook(() => useFileFilters());
    const filtered = result.current.applyFileFilters(tree, ['*.ts'], []);

    expect(filtered).toHaveLength(1);
    const rootDir = filtered[0]!;
    const children = rootDir.children ?? [];
    expect(children).toHaveLength(1); // empty directory should be preserved
  });

  it('should correctly filter files vs directories', () => {
    const tree: IFileNode[] = [
      dirNode('root', '/root', [
        fileNode('file.ts', '/file.ts'),
        dirNode('dir', '/dir', [fileNode('nested.ts', '/dir/nested.ts')]),
      ]),
    ];

    const { result } = renderHook(() => useFileFilters());
    const filtered = result.current.applyFileFilters(tree, ['*.ts'], []);

    const rootDir = filtered[0]!;
    const children = rootDir.children ?? [];
    expect(children).toHaveLength(2);

    const fileChild = children.find((n) => n.type === 'file');
    const dirChild = children.find((n) => n.type === 'directory');

    expect(fileChild).toBeDefined();
    expect(dirChild).toBeDefined();
    expect(dirChild?.children).toHaveLength(1);
  });

  it('preserves loaded directories that have no matching descendants under include filters', () => {
    const tree: IFileNode[] = [
      dirNode(
        'root',
        '/root',
        [
          dirNode('src', '/root/src', [fileNode('app.ts', '/root/src/app.ts')], {
            loadState: 'loaded',
          }),
          dirNode('docs', '/root/docs', [fileNode('readme.md', '/root/docs/readme.md')], {
            loadState: 'loaded',
          }),
        ],
        { loadState: 'loaded' }
      ),
    ];

    const { result } = renderHook(() => useFileFilters());
    const filtered = result.current.applyFileFilters(tree, ['*.ts'], []);

    const rootDir = filtered[0]!;
    const children = rootDir.children ?? [];
    expect(children.map((child) => child.name)).toEqual(['src', 'docs']);
    expect(children.find((child) => child.name === 'docs')?.children ?? []).toHaveLength(0);
  });

  it('preserves unloaded directories until their descendants are known', () => {
    const tree: IFileNode[] = [
      dirNode('root', '/root', [dirNode('docs', '/root/docs', [], { loadState: 'unloaded' })], {
        loadState: 'loaded',
      }),
    ];

    const { result } = renderHook(() => useFileFilters());
    const filtered = result.current.applyFileFilters(tree, ['*.ts'], []);

    const rootDir = filtered[0]!;
    expect(rootDir.children?.map((child) => child.name)).toEqual(['docs']);
  });
});
