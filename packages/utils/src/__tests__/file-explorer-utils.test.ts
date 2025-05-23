import { describe, expect, it } from 'vitest';
import { fileExplorer } from '../file-explorer-utils';
import { createDirectoryNode, createFileNode } from '../test/factories/file-node';

const buildSampleTree = () => {
  const fileA = createFileNode({ name: 'a.ts', path: '/root/a.ts' });
  const fileB = createFileNode({ name: 'b.ts', path: '/root/sub/b.ts' });
  const subDir = createDirectoryNode({ name: 'sub', path: '/root/sub', children: [fileB] });
  const root = createDirectoryNode({ name: 'root', path: '/root', children: [fileA, subDir] });
  return root;
};

describe('file-explorer-utils', () => {
  it('getAllFilePathsInDirectory collects files recursively', () => {
    const tree = buildSampleTree();
    const result = fileExplorer.getAllFilePathsInDirectory(tree);
    expect(result.sort()).toEqual(['/root/a.ts', '/root/sub/b.ts']);
  });

  it('findNodeByPath locates nodes with optional rootFolderId', () => {
    const tree = buildSampleTree();
    const result = fileExplorer.findNodeByPath([tree], '/root/sub/b.ts');
    expect(result?.path).toBe('/root/sub/b.ts');
    const miss = fileExplorer.findNodeByPath([tree], '/root/sub/b.ts', 'other-root');
    expect(miss).toBeNull();
  });

  it('getFileExtension returns extension with dot or empty string', () => {
    expect(fileExplorer.getFileExtension('test/file.tsx')).toBe('.tsx');
    expect(fileExplorer.getFileExtension('testfile')).toBe('');
  });

  it('getFolderFileCount counts nested files', () => {
    const tree = buildSampleTree();
    const result = fileExplorer.getFolderFileCount(tree);
    expect(result).toEqual({ count: 2, isComplete: true });
  });

  it('generateFullFolderTreeText prints tree respecting filters', () => {
    const tree = buildSampleTree();
    const text = fileExplorer.generateFullFolderTreeText([tree], ['**/*.ts'], [], false);
    expect(text).toContain('📁 root');
    expect(text).toContain('📄 a.ts');
    expect(text).toContain('📄 b.ts');
  });
});
