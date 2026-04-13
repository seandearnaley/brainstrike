import { describe, expect, it } from 'vitest';
import {
  formatDirPathForDisplay,
  getDirPathForGrouping,
  getRootFolderDisplayName,
  splitFilePath,
} from '../path-display';

describe('splitFilePath', () => {
  it('splits Unix file path correctly', () => {
    const result = splitFilePath('/Users/me/project/src/components/Button.tsx');
    expect(result).toEqual({
      fileName: 'Button.tsx',
      dirPath: '/Users/me/project/src/components',
    });
  });

  it('splits Windows file path correctly', () => {
    const result = splitFilePath('C:\\Users\\me\\project\\src\\Button.tsx');
    expect(result).toEqual({
      fileName: 'Button.tsx',
      dirPath: 'C:/Users/me/project/src',
    });
  });

  it('handles file with no directory', () => {
    const result = splitFilePath('file.txt');
    expect(result).toEqual({
      fileName: 'file.txt',
      dirPath: '',
    });
  });

  it('handles trailing slashes', () => {
    const result = splitFilePath('/path/to/file.txt///');
    expect(result).toEqual({
      fileName: 'file.txt',
      dirPath: '/path/to',
    });
  });

  it('handles root directory files on Unix', () => {
    const result = splitFilePath('/file.txt');
    expect(result).toEqual({
      fileName: 'file.txt',
      dirPath: '',
    });
  });

  it('handles relative paths', () => {
    const result = splitFilePath('src/components/Button.tsx');
    expect(result).toEqual({
      fileName: 'Button.tsx',
      dirPath: 'src/components',
    });
  });

  it('handles deeply nested paths', () => {
    const result = splitFilePath('a/b/c/d/e/f/g/file.txt');
    expect(result).toEqual({
      fileName: 'file.txt',
      dirPath: 'a/b/c/d/e/f/g',
    });
  });
});

describe('formatDirPathForDisplay', () => {
  it('returns empty string for empty dirPath', () => {
    const result = formatDirPathForDisplay({
      dirPath: '',
      rootFolderId: 'project',
    });
    expect(result).toBe('');
  });

  it('returns "." for file at root folder', () => {
    const result = formatDirPathForDisplay({
      dirPath: '/Users/me/project',
      rootFolderId: 'project',
    });
    expect(result).toBe('.');
  });

  it('displays folder-relative path correctly', () => {
    const result = formatDirPathForDisplay({
      dirPath: '/Users/me/project/src/components',
      rootFolderId: 'project',
    });
    expect(result).toBe('src/components');
  });

  it('handles case-insensitive root folder matching', () => {
    const result = formatDirPathForDisplay({
      dirPath: '/Users/me/PROJECT/src/utils',
      rootFolderId: 'project',
    });
    expect(result).toBe('src/utils');
  });

  it('handles Windows drive paths', () => {
    const result = formatDirPathForDisplay({
      dirPath: 'C:/Users/me/project/src',
      rootFolderId: 'project',
    });
    expect(result).toBe('src');
  });

  it('handles UNC paths', () => {
    const result = formatDirPathForDisplay({
      dirPath: '//server/share/project/src/components',
      rootFolderId: 'project',
    });
    expect(result).toBe('src/components');
  });

  it('preserves path when root folder not found', () => {
    const result = formatDirPathForDisplay({
      dirPath: '/some/other/path',
      rootFolderId: 'project',
    });
    expect(result).toBe('some/other/path');
  });

  it('trims using an absolute root folder identity', () => {
    const result = formatDirPathForDisplay({
      dirPath: '/Users/me/project/src/components',
      rootFolderId: '/Users/me/project',
    });
    expect(result).toBe('src/components');
  });

  it('shortens long paths with ellipsis', () => {
    const result = formatDirPathForDisplay({
      dirPath:
        '/Users/me/project/packages/file-explorer-ui/src/components/very/deeply/nested/folder',
      rootFolderId: 'project',
      maxDisplayChars: 40,
    });
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toContain('…');
  });

  it('respects headSegments and tailSegments options', () => {
    const result = formatDirPathForDisplay({
      dirPath: '/Users/me/project/packages/file-explorer-ui/src/components/long-folder-name',
      rootFolderId: 'project',
      maxDisplayChars: 30,
      headSegments: 1,
      tailSegments: 1,
    });
    // Should contain first segment and last segment with ellipsis in between
    expect(result).toContain('packages');
    expect(result).toContain('long-folder-name');
    expect(result).toContain('…');
  });

  it('handles relative paths without root folder trimming', () => {
    const result = formatDirPathForDisplay({
      dirPath: 'src/components',
      rootFolderId: 'project',
    });
    expect(result).toBe('src/components');
  });

  it('does not strip a legitimate top-level folder that matches the root basename', () => {
    const result = formatDirPathForDisplay({
      dirPath: 'project/src/components',
      rootFolderId: '/workspaces/project',
    });
    expect(result).toBe('project/src/components');
  });

  it('handles trailing slashes in dirPath', () => {
    const result = formatDirPathForDisplay({
      dirPath: '/Users/me/project/src//',
      rootFolderId: 'project',
    });
    expect(result).toBe('src');
  });

  it('enforces minimum maxDisplayChars of 15', () => {
    const result = formatDirPathForDisplay({
      dirPath: '/Users/me/project/packages/file-explorer-ui/src/components/very/deeply/nested',
      rootFolderId: 'project',
      maxDisplayChars: 5, // Very small value should be clamped to minimum
    });
    // Result should be at least 15 chars or less if the path itself is shorter
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result).toContain('…');
  });
});

describe('getDirPathForGrouping', () => {
  it('returns folder-relative path for grouped display', () => {
    const result = getDirPathForGrouping({
      filePath: '/Users/me/project/src/components/Button.tsx',
      rootFolderId: 'project',
    });
    expect(result).toBe('src/components');
  });

  it('returns "." for file at project root', () => {
    const result = getDirPathForGrouping({
      filePath: '/Users/me/project/index.ts',
      rootFolderId: 'project',
    });
    expect(result).toBe('.');
  });

  it('returns "." for file with no directory', () => {
    const result = getDirPathForGrouping({
      filePath: 'file.txt',
      rootFolderId: 'project',
    });
    expect(result).toBe('.');
  });

  it('handles Windows paths', () => {
    const result = getDirPathForGrouping({
      filePath: 'C:\\Users\\me\\project\\src\\utils\\helpers.ts',
      rootFolderId: 'project',
    });
    expect(result).toBe('src/utils');
  });

  it('handles deeply nested paths', () => {
    const result = getDirPathForGrouping({
      filePath: '/Users/me/project/a/b/c/d/e/file.ts',
      rootFolderId: 'project',
    });
    expect(result).toBe('a/b/c/d/e');
  });

  it('handles case-insensitive root folder matching', () => {
    const result = getDirPathForGrouping({
      filePath: '/home/user/MyProject/src/index.ts',
      rootFolderId: 'myproject',
    });
    expect(result).toBe('src');
  });

  it('preserves path when root folder not in path', () => {
    const result = getDirPathForGrouping({
      filePath: '/some/random/path/file.ts',
      rootFolderId: 'project',
    });
    expect(result).toBe('/some/random/path');
  });

  it('uses an absolute root folder identity when grouping absolute file paths', () => {
    const result = getDirPathForGrouping({
      filePath: '/Users/me/project/src/components/Button.tsx',
      rootFolderId: '/Users/me/project',
    });
    expect(result).toBe('src/components');
  });

  it('handles relative paths', () => {
    const result = getDirPathForGrouping({
      filePath: 'src/components/Button.tsx',
      rootFolderId: 'project',
    });
    expect(result).toBe('src/components');
  });

  it('keeps a legitimate relative top-level folder when it matches the root basename', () => {
    const result = getDirPathForGrouping({
      filePath: 'project/biome.json',
      rootFolderId: '/workspaces/project',
    });
    expect(result).toBe('project');
  });
});

describe('getRootFolderDisplayName', () => {
  it('preserves the full absolute root identity', () => {
    expect(getRootFolderDisplayName('/Users/me/project')).toBe('/Users/me/project');
  });

  it('keeps distinct absolute roots distinguishable', () => {
    expect(getRootFolderDisplayName('/work/app')).not.toBe(getRootFolderDisplayName('/tmp/app'));
  });

  it('returns the original value for simple root ids', () => {
    expect(getRootFolderDisplayName('project')).toBe('project');
  });
});
