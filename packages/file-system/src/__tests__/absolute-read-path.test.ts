import { describe, expect, it } from 'vitest';
import { isDurableRootId, isFullyQualifiedFileSystemPath } from '../absolute-read-path.js';

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

describe('isDurableRootId', () => {
  it('accepts non-empty durable identities without imposing a UUID migration', () => {
    expect(isDurableRootId('root-a')).toBe(true);
    expect(isDurableRootId('11111111-0000-4000-8000-000000000011')).toBe(true);
  });

  it.each(['', '   ', 'root\nsecret', null, undefined])(
    'rejects malformed durable root identity %s',
    (value) => {
      expect(isDurableRootId(value)).toBe(false);
    }
  );
});
