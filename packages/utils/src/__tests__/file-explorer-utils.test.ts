import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import { describe, expect, it } from 'vitest';
import { fileExplorer, memoizedFileExplorer } from '../file-explorer-utils';

const buildSampleTree = () => {
  const fileA = createFileNode({ name: 'a.ts', path: '/root/a.ts' });
  const fileB = createFileNode({ name: 'b.ts', path: '/root/sub/b.ts' });
  const subDir = createDirectoryNode({ children: [fileB], name: 'sub', path: '/root/sub' });
  const root = createDirectoryNode({ children: [fileA, subDir], name: 'root', path: '/root' });
  return root;
};

describe('file-explorer-utils', () => {
  it('getAllFilePathsInDirectory collects files recursively', () => {
    const tree = buildSampleTree();
    const result = fileExplorer.getAllFilePathsInDirectory(tree);
    expect(result.sort()).toEqual(['/root/a.ts', '/root/sub/b.ts']);
  });

  it('getAllFilePathsInDirectory returns file nodes directly and empty directories as empty', () => {
    const file = createFileNode({ name: 'a.ts', path: '/root/a.ts' });
    const emptyDirectory = createDirectoryNode({ name: 'empty', path: '/root/empty' });

    expect(fileExplorer.getAllFilePathsInDirectory(file)).toEqual(['/root/a.ts']);
    expect(fileExplorer.getAllFilePathsInDirectory(emptyDirectory)).toEqual([]);
  });

  it('findNodeByPath locates nodes with optional rootFolderId', () => {
    const tree = buildSampleTree();
    const result = fileExplorer.findNodeByPath([tree], '/root/sub/b.ts');
    expect(result?.path).toBe('/root/sub/b.ts');
    const miss = fileExplorer.findNodeByPath([tree], '/root/sub/b.ts', 'other-root');
    expect(miss).toBeNull();
  });

  it('findNodeByPath returns null for empty or missing trees', () => {
    expect(fileExplorer.findNodeByPath([], '/root/sub/b.ts')).toBeNull();
    expect(fileExplorer.findNodeByPath([buildSampleTree()], '/root/missing.ts')).toBeNull();
  });

  it('getFileExtension returns normalized extension without dot or empty string', () => {
    expect(fileExplorer.getFileExtension('test/file.tsx')).toBe('tsx');
    expect(fileExplorer.getFileExtension('test/file.TSX')).toBe('tsx');
    expect(fileExplorer.getFileExtension('testfile')).toBe('');
    expect(fileExplorer.getFileExtension('/home/user/.gitignore')).toBe('');
    expect(fileExplorer.getFileExtension('/home/user/.env.local')).toBe('local');
  });

  it('getFolderFileCount counts nested files', () => {
    const tree = buildSampleTree();
    const result = fileExplorer.getFolderFileCount(tree);
    expect(result).toEqual({ count: 2, isComplete: true });
  });

  it('getFolderFileCount counts file nodes and empty directories', () => {
    const file = createFileNode({ name: 'a.ts', path: '/root/a.ts' });
    const emptyDirectory = createDirectoryNode({ name: 'empty', path: '/root/empty' });

    expect(fileExplorer.getFolderFileCount(file)).toEqual({ count: 1, isComplete: true });
    expect(fileExplorer.getFolderFileCount(emptyDirectory)).toEqual({
      count: 0,
      isComplete: true,
    });
  });

  it('memoizes file explorer results by node identity', () => {
    const tree = buildSampleTree();

    expect(memoizedFileExplorer.getAllFilePathsInDirectory(tree)).toBe(
      memoizedFileExplorer.getAllFilePathsInDirectory(tree)
    );
    expect(memoizedFileExplorer.getFolderFileCount(tree)).toBe(
      memoizedFileExplorer.getFolderFileCount(tree)
    );
  });

  it('generateFullFolderTreeText prints tree respecting filters', () => {
    const tree = buildSampleTree();
    const text = fileExplorer.generateFullFolderTreeText([tree], ['**/*.ts'], [], false);
    const lines = text.split('\n');
    expect(text).toContain('📁 root');
    expect(text).toContain('📄 a.ts');
    expect(text).toContain('📄 b.ts');
    expect(lines.indexOf('  📁 sub')).toBeLessThan(lines.indexOf('  📄 a.ts'));
  });

  it('generateFullFolderTreeText keeps root files while filtering directory children', () => {
    const readme = createFileNode({ name: 'README.md', path: '/README.md' });
    const root = createDirectoryNode({
      children: [
        createFileNode({ name: 'keep.ts', path: '/root/keep.ts' }),
        createFileNode({ name: 'skip.md', path: '/root/skip.md' }),
      ],
      name: 'root',
      path: '/root',
    });

    const text = fileExplorer.generateFullFolderTreeText([root, readme], ['**/*.ts'], [], false);
    expect(text).toContain('📁 root');
    expect(text).toContain('  📄 keep.ts');
    expect(text).not.toContain('skip.md');
    expect(text).toContain('📄 README.md');
  });
});
