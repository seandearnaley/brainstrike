import { describe, expect, it } from 'vitest';
import { isFullyQualifiedFileSystemPath } from '../absolute-read-path.js';

describe('isFullyQualifiedFileSystemPath', () => {
  it.each([
    '/',
    '/workspace/file.txt',
    'C:/',
    'C:\\Workspace\\file.txt',
    '//server/share/file.txt',
    '\\\\server\\share\\file.txt',
  ])('accepts fully qualified POSIX, drive, and UNC path %s', (value) => {
    expect(isFullyQualifiedFileSystemPath(value)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'workspace/file.txt',
    'C:relative.txt',
    '\\drive-relative.txt',
    '//server',
    '\\\\server',
    '/workspace/line\nbreak.txt',
  ])('rejects incomplete or nonabsolute path %s', (value) => {
    expect(isFullyQualifiedFileSystemPath(value)).toBe(false);
  });
});
