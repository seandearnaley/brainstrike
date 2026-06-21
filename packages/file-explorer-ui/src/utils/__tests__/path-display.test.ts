import { describe, expect, it } from 'vitest';
import {
  formatDirPathForDisplay,
  formatFilePathSubtitle,
  formatTrailingPathSegments,
  getDirectoryGroupDisplayName,
  getDirectoryGroupKey,
  getRootFolderDisplayName,
  splitFilePath,
} from '../path-display';

describe('formatTrailingPathSegments', () => {
  it('returns the path unchanged when it has 2 or fewer segments', () => {
    expect(formatTrailingPathSegments('a/b')).toBe('a/b');
    expect(formatTrailingPathSegments('/a/b')).toBe('/a/b');
    expect(formatTrailingPathSegments('only-one')).toBe('only-one');
  });

  it('truncates to the trailing two segments with an ellipsis prefix', () => {
    expect(formatTrailingPathSegments('a/b/c/d')).toBe('.../c/d');
    expect(formatTrailingPathSegments('/Users/me/project/src/file.ts')).toBe('.../src/file.ts');
    expect(formatTrailingPathSegments('/Users/me/project/src/')).toBe('.../project/src/');
  });

  it('handles empty input', () => {
    expect(formatTrailingPathSegments('')).toBe('');
  });
});

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

  it('preserves filesystem-root ids and trims paths relative to "/"', () => {
    const result = formatDirPathForDisplay({
      dirPath: '/usr/local/bin',
      rootFolderId: '/',
    });
    expect(result).toBe('usr/local/bin');
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

describe('formatFilePathSubtitle', () => {
  it('shows the root folder name for desktop root files', () => {
    const result = formatFilePathSubtitle({
      filePath: '/Users/me/BrainStrike/README.md',
      rootFolderId: '/Users/me/BrainStrike',
    });
    expect(result).toBe('BrainStrike');
  });

  it('prefixes nested desktop file paths with the root folder name', () => {
    const result = formatFilePathSubtitle({
      filePath: '/Users/me/BrainStrike/source/index.ts',
      rootFolderId: '/Users/me/BrainStrike',
    });
    expect(result).toBe('BrainStrike/source');
  });

  it('preserves the existing web-style root-prefixed path when already present', () => {
    const result = formatFilePathSubtitle({
      filePath: 'BrainStrike/source/index.ts',
      rootFolderId: 'BrainStrike',
    });
    expect(result).toBe('BrainStrike/source');
  });

  it('preserves nested directories whose name matches the root basename', () => {
    const result = formatFilePathSubtitle({
      filePath: '/Users/me/BrainStrike/BrainStrike/source/index.ts',
      rootFolderId: '/Users/me/BrainStrike',
    });
    expect(result).toBe('BrainStrike/BrainStrike/source');
  });

  it('treats existing relative root prefixes case-insensitively', () => {
    const result = formatFilePathSubtitle({
      filePath: 'project/source/index.ts',
      rootFolderId: 'Project',
    });
    expect(result).toBe('project/source');
  });
});

describe('directory group helpers', () => {
  it('uses a root-prefixed display name for grouped absolute root files', () => {
    const groupKey = getDirectoryGroupKey({
      filePath: '/Users/me/BrainStrike/README.md',
      rootFolderId: '/Users/me/BrainStrike',
    });

    expect(getDirectoryGroupDisplayName({ groupKey })).toBe('BrainStrike');
  });

  it('preserves nested directories whose name matches the root basename', () => {
    const groupKey = getDirectoryGroupKey({
      filePath: '/Users/me/BrainStrike/BrainStrike/source/index.ts',
      rootFolderId: '/Users/me/BrainStrike',
    });

    expect(getDirectoryGroupDisplayName({ groupKey })).toBe('BrainStrike/BrainStrike/source');
  });

  it('treats existing relative root prefixes case-insensitively', () => {
    const groupKey = getDirectoryGroupKey({
      filePath: 'project/source/index.ts',
      rootFolderId: 'Project',
    });

    expect(getDirectoryGroupDisplayName({ groupKey })).toBe('project/source');
  });
});

describe('getRootFolderDisplayName', () => {
  it('preserves the full absolute root identity', () => {
    expect(getRootFolderDisplayName('/Users/me/project')).toBe('/Users/me/project');
  });

  it('preserves the filesystem-root identity', () => {
    expect(getRootFolderDisplayName('/')).toBe('/');
  });

  it('keeps distinct absolute roots distinguishable', () => {
    expect(getRootFolderDisplayName('/work/app')).not.toBe(getRootFolderDisplayName('/tmp/app'));
  });

  it('returns the original value for simple root ids', () => {
    expect(getRootFolderDisplayName('project')).toBe('project');
  });
});
