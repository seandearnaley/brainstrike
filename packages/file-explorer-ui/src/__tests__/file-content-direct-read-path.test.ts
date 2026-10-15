// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveDirectReadPath, supportsDirectPathRead } from '../file-content-direct-read-path';

describe('supportsDirectPathRead', () => {
  it('requires the explicit absolute-path capability', () => {
    expect(
      supportsDirectPathRead({
        readFileByPath: async () => 'web-relative-content',
      })
    ).toBe(false);
    expect(
      supportsDirectPathRead({
        readFileByAbsolutePath: async () => 'native-content',
        readFileByPath: async () => 'legacy-content',
      })
    ).toBe(true);
  });
});

describe('resolveDirectReadPath', () => {
  it.each([
    {
      expected: '/workspace/src/index.ts',
      rootPath: '/workspace',
      selectionPath: 'src/index.ts',
    },
    {
      expected: '/workspace/src/index.ts',
      rootPath: '/workspace/',
      selectionPath: '/workspace/src/index.ts',
    },
    {
      expected: '/index.ts',
      rootPath: '/',
      selectionPath: 'index.ts',
    },
    {
      expected: 'C:/index.ts',
      rootPath: 'C:/',
      selectionPath: 'index.ts',
    },
    {
      expected: 'c:/workspace/src/index.ts',
      rootPath: 'C:\\Workspace',
      selectionPath: 'c:/workspace/src/index.ts',
    },
    {
      expected: '//server/share/src/index.ts',
      rootPath: '\\\\Server\\Share\\',
      selectionPath: '//server/share/src/index.ts',
    },
  ])(
    'resolves $selectionPath within $rootPath without erasing the absolute root',
    ({ expected, rootPath, selectionPath }) => {
      expect(resolveDirectReadPath(rootPath, selectionPath)).toBe(expected);
    }
  );

  it.each([
    {
      rootPath: '/workspace',
      selectionPath: '/other/outside.ts',
    },
    {
      rootPath: '/Workspace',
      selectionPath: '/workspace/case-mismatch.ts',
    },
    {
      rootPath: 'C:/workspace',
      selectionPath: 'D:/outside.ts',
    },
    {
      rootPath: '\\\\server\\share',
      selectionPath: '\\\\server\\other\\outside.ts',
    },
    {
      rootPath: '/workspace',
      selectionPath: '../outside.ts',
    },
    {
      rootPath: '/workspace',
      selectionPath: 'src/../../outside.ts',
    },
    {
      rootPath: '/workspace',
      selectionPath: './src/index.ts',
    },
    {
      rootPath: '/workspace',
      selectionPath: 'src//index.ts',
    },
    {
      rootPath: '/workspace',
      selectionPath: 'src/',
    },
    {
      rootPath: '/workspace',
      selectionPath: '',
    },
    {
      rootPath: '/workspace',
      selectionPath: 'src/line\nbreak.ts',
    },
    {
      rootPath: 'C:/workspace',
      selectionPath: 'C:relative.ts',
    },
  ])('rejects unsafe or out-of-root path $selectionPath', ({ rootPath, selectionPath }) => {
    expect(resolveDirectReadPath(rootPath, selectionPath)).toBeNull();
  });
});
