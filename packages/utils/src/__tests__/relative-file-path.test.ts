import { describe, expect, it } from 'vitest';
import {
  isAbsoluteFileSystemPath,
  normalizeFilePathForFolder,
  normalizeSelectionPathForFolder,
  validateRelativeFilePath,
} from '../relative-file-path';

describe('validateRelativeFilePath', () => {
  it('accepts safe relative paths', () => {
    expect(validateRelativeFilePath('src/components/button.tsx')).toBe('src/components/button.tsx');
  });

  it('rejects empty paths with the configured label', () => {
    expect(() => validateRelativeFilePath('   ', { label: 'Cache key' })).toThrow(
      'Cache key must not be empty'
    );
  });

  it('rejects null bytes and ASCII control characters', () => {
    expect(() => validateRelativeFilePath('src/\0file.ts')).toThrow(
      'File path must not contain null bytes'
    );
    expect(() => validateRelativeFilePath('src/\u001Ffile.ts')).toThrow(
      'File path must not contain control characters'
    );
    expect(() => validateRelativeFilePath('src/\u007Ffile.ts')).toThrow(
      'File path must not contain control characters'
    );
  });

  it('rejects absolute paths', () => {
    expect(() => validateRelativeFilePath('/absolute/path.ts')).toThrow(
      'File path must be relative'
    );
    expect(() => validateRelativeFilePath('C:\\absolute\\path.ts')).toThrow(
      'File path must be relative'
    );
  });

  it('rejects traversal and empty path segments', () => {
    expect(() => validateRelativeFilePath('src/./file.ts')).toThrow(
      'File path must not contain relative traversal segments'
    );
    expect(() => validateRelativeFilePath('src/../file.ts')).toThrow(
      'File path must not contain relative traversal segments'
    );
    expect(() => validateRelativeFilePath('src//file.ts')).toThrow(
      'File path must not contain empty segments'
    );
  });
});

describe('isAbsoluteFileSystemPath', () => {
  it('detects unix, windows, and UNC absolute paths', () => {
    expect(isAbsoluteFileSystemPath('/absolute/path.ts')).toBe(true);
    expect(isAbsoluteFileSystemPath('C:\\absolute\\path.ts')).toBe(true);
    expect(isAbsoluteFileSystemPath('\\\\server\\share\\path.ts')).toBe(true);
    expect(isAbsoluteFileSystemPath('src/relative/path.ts')).toBe(false);
  });
});

describe('normalizeFilePathForFolder', () => {
  it('keeps relative paths unchanged', () => {
    expect(normalizeFilePathForFolder('src/index.ts', 'project')).toBe('src/index.ts');
  });

  it('converts unix absolute paths using folder id segment', () => {
    const absolutePath = '/Users/me/workspace/project/src/index.ts';
    expect(normalizeFilePathForFolder(absolutePath, 'project')).toBe('src/index.ts');
  });

  it('converts unix absolute paths using the absolute folder id prefix', () => {
    const folderId = '/Users/me/workspace/project';
    const absolutePath = '/Users/me/workspace/project/src/index.ts';
    expect(normalizeFilePathForFolder(absolutePath, folderId)).toBe('src/index.ts');
  });

  it('preserves the absolute path when it points at the folder root exactly', () => {
    const folderId = '/Users/me/workspace/project';
    const absolutePath = '/Users/me/workspace/project';
    expect(normalizeFilePathForFolder(absolutePath, folderId)).toBe(absolutePath);
    expect(() =>
      normalizeSelectionPathForFolder(absolutePath, folderId, { label: 'Token cache file path' })
    ).toThrow('Token cache file path must reference a file within the selected folder');
  });

  it('converts windows absolute paths using folder id segment', () => {
    const absolutePath = 'C:\\Users\\me\\workspace\\Project\\src\\index.ts';
    expect(normalizeFilePathForFolder(absolutePath, 'project')).toBe('src/index.ts');
  });

  it('converts windows absolute paths using the absolute folder id prefix case-insensitively', () => {
    const folderId = 'C:\\Users\\me\\workspace\\project';
    const absolutePath = 'C:\\Users\\me\\workspace\\Project\\src\\index.ts';
    expect(normalizeFilePathForFolder(absolutePath, folderId)).toBe('src/index.ts');
  });

  it('strips leading slash when folder id is not present', () => {
    expect(normalizeFilePathForFolder('/src/index.ts', 'project')).toBe('src/index.ts');
  });

  it('strips UNC server and share prefixes when folder id is not present', () => {
    expect(normalizeFilePathForFolder('//server/share/project/src/index.ts', 'other')).toBe(
      'project/src/index.ts'
    );
    expect(normalizeFilePathForFolder('//server/share', 'other')).toBe('server/share');
  });

  it('strips windows drive prefixes when folder id is not present', () => {
    expect(normalizeFilePathForFolder('C:/repo/src/index.ts', 'project')).toBe('repo/src/index.ts');
  });

  it('handles empty folder id by stripping root prefix only', () => {
    const absolutePath = '/Users/me/workspace/project/src/index.ts';
    expect(normalizeFilePathForFolder(absolutePath, '')).toBe(
      'Users/me/workspace/project/src/index.ts'
    );
  });

  it('preserves traversal segments for downstream validation', () => {
    const normalized = normalizeFilePathForFolder('/Users/me/project/../secret.txt', 'project');
    expect(normalized).toBe('../secret.txt');
    expect(() => validateRelativeFilePath(normalized)).toThrow(
      'File path must not contain relative traversal segments'
    );
  });

  it('uses the deepest matching folder segment when names repeat', () => {
    const duplicatedPath = '/a/project/project/src/file.ts';
    expect(normalizeFilePathForFolder(duplicatedPath, 'project')).toBe('src/file.ts');
  });
});
