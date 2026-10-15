// @vitest-environment node
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  buildFileNodeCache,
  type FileNodeCache,
  getFileNodeFromCache,
  refreshFileNodeCacheEntry,
} from '../file-node-cache';

const createFileNode = (
  overrides: Partial<IFileNode> & { name: string; path: string; rootFolderId: string }
): IFileNode => ({
  depth: 0,
  handle: {} as FileSystemFileHandle,
  selectionState: 'unchecked',
  type: 'file',
  ...overrides,
});

const createDirNode = (
  overrides: Partial<IFileNode> & {
    name: string;
    path: string;
    rootFolderId: string;
    children?: IFileNode[];
  }
): IFileNode => ({
  depth: 0,
  handle: {} as FileSystemDirectoryHandle,
  selectionState: 'unchecked',
  type: 'directory',
  ...overrides,
});

describe('buildFileNodeCache', () => {
  it('builds cache from flat file tree', () => {
    const tree: IFileNode[] = [
      createFileNode({ name: 'file1.ts', path: 'file1.ts', rootFolderId: 'project' }),
      createFileNode({ name: 'file2.ts', path: 'file2.ts', rootFolderId: 'project' }),
    ];

    const cache = buildFileNodeCache(tree);

    expect(cache.size).toBe(1);
    expect(cache.get('project')?.size).toBe(2);
    expect(cache.get('project')?.get('file1.ts')?.name).toBe('file1.ts');
    expect(cache.get('project')?.get('file2.ts')?.name).toBe('file2.ts');
  });

  it('builds cache from nested file tree', () => {
    const tree: IFileNode[] = [
      createDirNode({
        children: [
          createFileNode({ name: 'index.ts', path: 'src/index.ts', rootFolderId: 'project' }),
          createDirNode({
            children: [
              createFileNode({
                name: 'Button.tsx',
                path: 'src/components/Button.tsx',
                rootFolderId: 'project',
              }),
            ],
            name: 'components',
            path: 'src/components',
            rootFolderId: 'project',
          }),
        ],
        name: 'src',
        path: 'src',
        rootFolderId: 'project',
      }),
    ];

    const cache = buildFileNodeCache(tree);

    expect(cache.get('project')?.size).toBe(4); // src, src/index.ts, src/components, src/components/Button.tsx
    expect(cache.get('project')?.get('src/components/Button.tsx')?.name).toBe('Button.tsx');
  });

  it('handles multiple root folders', () => {
    const tree: IFileNode[] = [
      createFileNode({ name: 'file1.ts', path: 'file1.ts', rootFolderId: 'project-a' }),
      createFileNode({ name: 'file2.ts', path: 'file2.ts', rootFolderId: 'project-b' }),
      createFileNode({ name: 'file3.ts', path: 'file3.ts', rootFolderId: 'project-a' }),
    ];

    const cache = buildFileNodeCache(tree);

    expect(cache.size).toBe(2);
    expect(cache.get('project-a')?.size).toBe(2);
    expect(cache.get('project-b')?.size).toBe(1);
  });

  it('handles empty tree', () => {
    const cache = buildFileNodeCache([]);

    expect(cache.size).toBe(0);
  });

  it('recursively processes deeply nested trees', () => {
    const tree: IFileNode[] = [
      createDirNode({
        children: [
          createDirNode({
            children: [
              createDirNode({
                children: [
                  createFileNode({
                    name: 'deep.ts',
                    path: 'a/b/c/deep.ts',
                    rootFolderId: 'root',
                  }),
                ],
                name: 'c',
                path: 'a/b/c',
                rootFolderId: 'root',
              }),
            ],
            name: 'b',
            path: 'a/b',
            rootFolderId: 'root',
          }),
        ],
        name: 'a',
        path: 'a',
        rootFolderId: 'root',
      }),
    ];

    const cache = buildFileNodeCache(tree);

    expect(cache.get('root')?.get('a/b/c/deep.ts')?.name).toBe('deep.ts');
  });
});

describe('getFileNodeFromCache', () => {
  it('returns cached node when available', () => {
    const tree: IFileNode[] = [
      createFileNode({
        name: 'cached.ts',
        path: 'cached.ts',
        rootFolderId: 'project',
        size: 1234,
      }),
    ];
    const cache = buildFileNodeCache(tree);

    const result = getFileNodeFromCache(cache, tree, 'project', 'cached.ts');

    expect(result?.name).toBe('cached.ts');
    expect(result?.size).toBe(1234);
  });

  it('populates cache when node not cached', () => {
    const tree: IFileNode[] = [
      createFileNode({ name: 'uncached.ts', path: 'uncached.ts', rootFolderId: 'project' }),
    ];
    const cache: FileNodeCache = new Map();

    const result = getFileNodeFromCache(cache, tree, 'project', 'uncached.ts');

    expect(result?.name).toBe('uncached.ts');
    expect(cache.get('project')?.get('uncached.ts')).toBeDefined();
  });

  it('returns null for non-existent path', () => {
    const tree: IFileNode[] = [
      createFileNode({ name: 'exists.ts', path: 'exists.ts', rootFolderId: 'project' }),
    ];
    const cache = buildFileNodeCache(tree);

    const result = getFileNodeFromCache(cache, tree, 'project', 'does-not-exist.ts');

    expect(result).toBeNull();
  });

  it('allows callers to demote expected cache misses to debug', () => {
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'FileNodeCache') {
        captured.push(record);
      }
    });
    const tree: IFileNode[] = [
      createFileNode({ name: 'exists.ts', path: 'exists.ts', rootFolderId: 'project' }),
    ];
    const cache = buildFileNodeCache(tree);

    try {
      const result = getFileNodeFromCache(cache, tree, 'project', 'direct-only.ts', {
        warnOnMiss: false,
      });

      expect(result).toBeNull();
      expect(captured).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: LogLevel.WARN,
            message: 'Node not found in cache or tree',
          }),
        ])
      );
    } finally {
      removeListener();
    }
  });

  it('returns null for non-existent folder', () => {
    const tree: IFileNode[] = [
      createFileNode({ name: 'file.ts', path: 'file.ts', rootFolderId: 'project' }),
    ];
    const cache = buildFileNodeCache(tree);

    const result = getFileNodeFromCache(cache, tree, 'wrong-folder', 'file.ts');

    expect(result).toBeNull();
  });

  it('creates new folder map when needed', () => {
    const tree: IFileNode[] = [
      createFileNode({ name: 'file.ts', path: 'file.ts', rootFolderId: 'new-folder' }),
    ];
    const cache: FileNodeCache = new Map();

    getFileNodeFromCache(cache, tree, 'new-folder', 'file.ts');

    expect(cache.has('new-folder')).toBe(true);
  });
});

describe('refreshFileNodeCacheEntry', () => {
  it('updates cache with fresh node data', () => {
    const initialTree: IFileNode[] = [
      createFileNode({ name: 'file.ts', path: 'file.ts', rootFolderId: 'project', size: 100 }),
    ];
    const cache = buildFileNodeCache(initialTree);

    // Simulate updated tree with new size
    const updatedTree: IFileNode[] = [
      createFileNode({ name: 'file.ts', path: 'file.ts', rootFolderId: 'project', size: 200 }),
    ];

    const result = refreshFileNodeCacheEntry(cache, updatedTree, 'project', 'file.ts');

    expect(result?.size).toBe(200);
    expect(cache.get('project')?.get('file.ts')?.size).toBe(200);
  });

  it('returns null and does not update cache for non-existent node', () => {
    const tree: IFileNode[] = [];
    const cache: FileNodeCache = new Map();

    const result = refreshFileNodeCacheEntry(cache, tree, 'project', 'non-existent.ts');

    expect(result).toBeNull();
  });

  it('creates folder map if it does not exist', () => {
    const tree: IFileNode[] = [
      createFileNode({ name: 'new.ts', path: 'new.ts', rootFolderId: 'new-project' }),
    ];
    const cache: FileNodeCache = new Map();

    refreshFileNodeCacheEntry(cache, tree, 'new-project', 'new.ts');

    expect(cache.has('new-project')).toBe(true);
    expect(cache.get('new-project')?.has('new.ts')).toBe(true);
  });
});
