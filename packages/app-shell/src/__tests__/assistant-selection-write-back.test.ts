import { describe, expect, it } from 'vitest';
import {
  normalizeRootPathForLookup,
  resolveWriteBackFolderId,
} from '../assistant-ui-panel-wrapper';

const PATH_TO_CLIENT_ROOT_ID = new Map<string, string>([
  ['/work/ProjectA', 'client-a'],
  ['/work/ProjectB', 'client-b'],
]);

describe('resolveWriteBackFolderId (multi-root write-back routing)', () => {
  it('routes a payload rootPath to the matching client RootId', () => {
    expect(
      resolveWriteBackFolderId(
        { folderId: 'client-a', rootId: 'db-b', rootPath: '/work/ProjectB' },
        PATH_TO_CLIENT_ROOT_ID
      )
    ).toBe('client-b');
  });

  it('matches despite a trailing separator on the rootPath', () => {
    expect(resolveWriteBackFolderId({ rootPath: '/work/ProjectB/' }, PATH_TO_CLIENT_ROOT_ID)).toBe(
      'client-b'
    );
  });

  it('returns null when the rootPath matches no open client root (caller must skip)', () => {
    expect(
      resolveWriteBackFolderId(
        { folderId: 'client-a', rootId: 'db-x', rootPath: '/work/NotOpen' },
        PATH_TO_CLIENT_ROOT_ID
      )
    ).toBeNull();
  });

  it('falls back to the legacy folderId when no rootPath is present (single/focused root)', () => {
    expect(resolveWriteBackFolderId({ folderId: 'client-a' }, PATH_TO_CLIENT_ROOT_ID)).toBe(
      'client-a'
    );
  });

  it('returns null when neither rootPath nor folderId is present', () => {
    expect(resolveWriteBackFolderId({}, PATH_TO_CLIENT_ROOT_ID)).toBeNull();
  });
});

describe('normalizeRootPathForLookup', () => {
  it('strips trailing separators and surrounding whitespace', () => {
    expect(normalizeRootPathForLookup('/work/ProjectA/')).toBe('/work/ProjectA');
    expect(normalizeRootPathForLookup('  /work/ProjectA  ')).toBe('/work/ProjectA');
    expect(normalizeRootPathForLookup('C:\\work\\ProjectA\\')).toBe('C:\\work\\ProjectA');
  });
});
