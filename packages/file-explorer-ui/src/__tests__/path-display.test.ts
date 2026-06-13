import { describe, expect, it } from 'vitest';
import {
  formatDirPathForDisplay,
  formatFilePathSubtitle,
  formatTrailingPathSegments,
  getDirectoryGroupDisplayName,
  getDirectoryGroupKey,
  getRootFolderDisplayName,
  splitFilePath,
} from '../utils/path-display';

describe('path-display utilities', () => {
  describe('formatTrailingPathSegments', () => {
    it('keeps short paths and abbreviates longer paths to the final two segments', () => {
      expect(formatTrailingPathSegments('src/app.ts')).toBe('src/app.ts');
      expect(formatTrailingPathSegments('packages/ui/src/button.tsx')).toBe('.../src/button.tsx');
    });
  });

  describe('splitFilePath', () => {
    it('normalizes separators and separates the final file name', () => {
      expect(splitFilePath('C:\\Users\\Sean\\project\\file.ts')).toEqual({
        dirPath: 'C:/Users/Sean/project',
        fileName: 'file.ts',
      });
      expect(splitFilePath('README.md')).toEqual({ dirPath: '', fileName: 'README.md' });
      expect(splitFilePath('/workspace/src/')).toEqual({
        dirPath: '/workspace',
        fileName: 'src',
      });
    });
  });

  describe('formatDirPathForDisplay', () => {
    it('returns the folder root marker when an absolute directory equals the root', () => {
      expect(
        formatDirPathForDisplay({
          dirPath: '/Users/sean/project',
          rootFolderId: '/Users/sean/project',
        })
      ).toBe('.');
    });

    it('trims absolute root prefixes and Windows drive paths case-insensitively', () => {
      expect(
        formatDirPathForDisplay({
          dirPath: '/Users/sean/project/src/components',
          rootFolderId: '/Users/sean/project',
        })
      ).toBe('src/components');
      expect(
        formatDirPathForDisplay({
          dirPath: 'C:\\Users\\Sean\\Project\\src',
          rootFolderId: 'c:/users/sean/project',
        })
      ).toBe('src');
    });

    it('keeps unmatched absolute paths and trims by relative root basename when possible', () => {
      expect(
        formatDirPathForDisplay({
          dirPath: '/external/root/src',
          rootFolderId: '/workspace/project',
        })
      ).toBe('external/root/src');
      expect(
        formatDirPathForDisplay({
          dirPath: '/Users/sean/Brainstrike/packages/ui',
          rootFolderId: 'brainstrike',
        })
      ).toBe('packages/ui');
    });

    it('shortens long paths by segments before falling back to character truncation', () => {
      expect(
        formatDirPathForDisplay({
          dirPath: '/workspace/project/packages/very-long-component-name/src/deeply/nested',
          rootFolderId: '/workspace/project',
          maxDisplayChars: 24,
          maxSegmentChars: 8,
        })
      ).toBe('packages/…/deeply/nested');

      expect(
        formatDirPathForDisplay({
          dirPath: 'extremely-long-segment-name-without-useful-breaks',
          rootFolderId: '',
          maxDisplayChars: 15,
          headSegments: 0,
          tailSegments: 0,
        })
      ).toBe('extrem…l-breaks');
    });
  });

  describe('file subtitles and directory groups', () => {
    it('joins root labels without duplicating existing relative prefixes', () => {
      expect(
        formatFilePathSubtitle({
          filePath: 'project/src/app.ts',
          rootFolderId: 'project',
        })
      ).toBe('project/src');

      expect(
        formatFilePathSubtitle({
          filePath: '/Users/sean/project/src/app.ts',
          rootFolderId: '/Users/sean/project',
        })
      ).toBe('project/src');
    });

    it('handles filesystem root labels and empty roots', () => {
      expect(
        formatFilePathSubtitle({
          filePath: '/src/app.ts',
          rootFolderId: '/',
        })
      ).toBe('/src');
      expect(formatFilePathSubtitle({ filePath: 'app.ts', rootFolderId: '' })).toBe('');
    });

    it('round-trips encoded directory group identities with canonical root labels', () => {
      const groupKey = getDirectoryGroupKey({
        filePath: '/Users/sean/project/src/app.ts',
        rootFolderId: '/Users/sean/project',
      });

      expect(getDirectoryGroupDisplayName({ groupKey })).toBe('project/src');
      expect(getDirectoryGroupDisplayName({ groupKey, useCanonicalRootLabel: true })).toBe(
        '/Users/sean/project/src'
      );
    });

    it('supports legacy JSON and malformed directory group keys', () => {
      expect(
        getDirectoryGroupDisplayName({
          groupKey: JSON.stringify({
            rootFolderId: 'project',
            relativeDirPath: 'src',
            allowExistingRootPrefix: false,
          }),
        })
      ).toBe('project/src');
      expect(getDirectoryGroupDisplayName({ groupKey: 'not%encoded|json' })).toBe(
        'not%encoded|json'
      );
    });
  });

  describe('getRootFolderDisplayName', () => {
    it('returns canonical absolute roots and basenames for relative roots', () => {
      expect(getRootFolderDisplayName('/Users/sean/project/')).toBe('/Users/sean/project');
      expect(getRootFolderDisplayName('workspace/project')).toBe('project');
      expect(getRootFolderDisplayName('')).toBe('');
    });
  });

  // Storage v5: rootFolderId is a RootId UUID, never a path. Display helpers
  // must accept the descriptor's displayName/path so the UUID never renders.
  describe('multi-root UUID identities (storage v5)', () => {
    const ROOT_ID = '11111111-0000-4000-8000-000000000011';

    it('formatFilePathSubtitle uses descriptor displayName/path instead of the UUID', () => {
      expect(
        formatFilePathSubtitle({
          filePath: '/Users/sean/project/src/app.ts',
          rootFolderId: ROOT_ID,
          rootPath: '/Users/sean/project',
          rootDisplayName: 'project',
        })
      ).toBe('project/src');
    });

    it('directory group keys carry the displayName and relativize by the root path', () => {
      const groupKey = getDirectoryGroupKey({
        filePath: '/Users/sean/project/src/app.ts',
        rootFolderId: ROOT_ID,
        rootPath: '/Users/sean/project',
        rootDisplayName: 'project',
      });

      expect(getDirectoryGroupDisplayName({ groupKey })).toBe('project/src');
      // Same relative dir in two roots groups separately (identity = rootId).
      const otherGroupKey = getDirectoryGroupKey({
        filePath: '/Users/sean/other/src/app.ts',
        rootFolderId: '22222222-0000-4000-8000-000000000022',
        rootPath: '/Users/sean/other',
        rootDisplayName: 'project',
      });
      expect(otherGroupKey).not.toBe(groupKey);
      // Canonical (disambiguated) label stays readable — displayName plus a
      // short root id suffix, never the raw UUID alone.
      const canonical = getDirectoryGroupDisplayName({ groupKey, useCanonicalRootLabel: true });
      expect(canonical).toContain('project');
      expect(canonical).not.toContain(ROOT_ID);
    });

    it('web-style root-name-prefixed paths relativize against the descriptor path', () => {
      expect(
        formatFilePathSubtitle({
          filePath: '/project-b/src/app.ts',
          rootFolderId: ROOT_ID,
          rootPath: '/project-b',
          rootDisplayName: 'project-b',
        })
      ).toBe('project-b/src');
    });
  });
});
