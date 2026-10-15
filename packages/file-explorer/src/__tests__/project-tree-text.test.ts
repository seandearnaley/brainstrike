import type { IFileNode } from '@brainstrike/types';
import { calculatePathDepth } from '@brainstrike/utils/path-utils';
import { Minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import {
  compilePatterns,
  generateProjectTreeText,
  traverseFileTree,
} from '../project-tree-text.js';

const createMockFileHandle = (): FileSystemFileHandle => ({
  createWritable: async () => {
    throw new Error('Not implemented in tests');
  },
  getFile: async () => new File([], ''),
  isSameEntry: async () => true,
  kind: 'file',
  name: '',
});

const createMockDirectoryHandle = (name: string): FileSystemDirectoryHandle =>
  ({
    async *entries() {},
    getDirectoryHandle: async () => ({}) as unknown as FileSystemDirectoryHandle,
    getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
    isSameEntry: async () => true,
    kind: 'directory' as const,
    name,
    removeEntry: async () => {},
    resolve: async () => [],
  }) as unknown as FileSystemDirectoryHandle;

const createMockFile = (path: string, name: string): IFileNode => ({
  children: [],
  depth: calculatePathDepth(path),
  handle: createMockFileHandle(),
  name,
  path,
  rootFolderId: 'test-folder',
  selectionState: 'unchecked',
  type: 'file',
});

const createMockDir = (path: string, name: string): IFileNode => ({
  children: [],
  depth: calculatePathDepth(path),
  handle: createMockDirectoryHandle(name),
  name,
  path,
  rootFolderId: 'test-folder',
  selectionState: 'unchecked',
  type: 'directory',
});

describe('generateProjectTreeText', () => {
  it('generates tree text with folder summary threshold', () => {
    const rootDir = createMockDir('root', 'root');
    const srcDir = createMockDir('root/src', 'src');
    const files = Array.from({ length: 10 }, (_, i) =>
      createMockFile(`root/src/file${i}.ts`, `file${i}.ts`)
    );

    srcDir.children = files;
    rootDir.children = [srcDir];

    const result = generateProjectTreeText([rootDir], [], [], false, 3);

    expect(result).toContain('file0.ts');
    expect(result).toContain('file1.ts');
    expect(result).toContain('file2.ts');
    expect(result).toContain('... 7 more items');
  });

  it('generates full tree when threshold is 0', () => {
    const rootDir = createMockDir('root', 'root');
    const srcDir = createMockDir('root/src', 'src');
    const files = Array.from({ length: 10 }, (_, i) =>
      createMockFile(`root/src/file${i}.ts`, `file${i}.ts`)
    );

    srcDir.children = files;
    rootDir.children = [srcDir];

    const result = generateProjectTreeText([rootDir], [], [], false, 0);

    for (let i = 0; i < 10; i++) {
      expect(result).toContain(`file${i}.ts`);
    }
    expect(result).not.toContain('... more items');
  });

  it('applies include filters', () => {
    const rootDir = createMockDir('root', 'root');
    const srcDir = createMockDir('root/src', 'src');
    const files = Array.from({ length: 10 }, (_, i) =>
      createMockFile(`root/src/file${i}.ts`, `file${i}.ts`)
    );

    srcDir.children = files;
    rootDir.children = [srcDir];

    const result = generateProjectTreeText([rootDir], ['**/file[0-4].ts'], [], false, 0);

    expect(result).toContain('file0.ts');
    expect(result).toContain('file4.ts');
    expect(result).not.toContain('file5.ts');
  });

  it('prunes directories that have no matching descendants when include filters are active', () => {
    const rootDir = createMockDir('root', 'root');
    const srcDir = createMockDir('root/src', 'src');
    const docsDir = createMockDir('root/docs', 'docs');
    const appFile = createMockFile('root/src/app.ts', 'app.ts');
    const readmeFile = createMockFile('root/docs/readme.md', 'readme.md');

    srcDir.children = [appFile];
    docsDir.children = [readmeFile];
    rootDir.children = [srcDir, docsDir];

    const result = generateProjectTreeText([rootDir], ['**/*.ts'], [], false, 0);

    expect(result).toContain('src/');
    expect(result).toContain('app.ts');
    expect(result).not.toContain('docs/');
    expect(result).not.toContain('readme.md');
  });

  it('handles paths with leading slashes', () => {
    const rootDir = createMockDir('/root', 'root');
    const testFile = createMockFile('/root/test.ts', 'test.ts');
    rootDir.children = [testFile];

    const result = generateProjectTreeText([rootDir], [], [], false, 0);
    expect(result).toContain('test.ts');
  });

  it('sorts files and directories correctly', () => {
    const rootDir = createMockDir('root', 'root');
    const dirA = createMockDir('root/a', 'a');
    const fileB = createMockFile('root/b.ts', 'b.ts');
    const fileA = createMockFile('root/a.ts', 'a.ts');

    rootDir.children = [fileB, dirA, fileA];

    const result = generateProjectTreeText([rootDir], [], [], false, 0);
    const lines = result.split('\n');

    expect(lines.findIndex((l) => l.includes('a/'))).toBeLessThan(
      lines.findIndex((l) => l.includes('a.ts'))
    );
    expect(lines.findIndex((l) => l.includes('a.ts'))).toBeLessThan(
      lines.findIndex((l) => l.includes('b.ts'))
    );
  });
});

describe('folderTreeGenerator pattern matching', () => {
  it('should handle regex patterns correctly', () => {
    const srcDir = createMockDir('src', 'src');
    const componentsDir = createMockDir('src/components', 'components');
    const utilsDir = createMockDir('src/utils', 'utils');

    const buttonFile = createMockFile('src/components/Button.tsx', 'Button.tsx');
    const inputFile = createMockFile('src/components/Input.tsx', 'Input.tsx');
    const helperFile = createMockFile('src/utils/helper.ts', 'helper.ts');

    componentsDir.children = [buttonFile, inputFile];
    utilsDir.children = [helperFile];
    srcDir.children = [componentsDir, utilsDir];

    const result = generateProjectTreeText([srcDir], ['\\.tsx$'], [], true, 0);

    expect(result).toContain('Button.tsx');
    expect(result).toContain('Input.tsx');
    expect(result).not.toContain('helper.ts');
  });

  it('should handle glob patterns correctly', () => {
    const srcDir = createMockDir('src', 'src');
    const componentsDir = createMockDir('src/components', 'components');
    const utilsDir = createMockDir('src/utils', 'utils');

    const buttonFile = createMockFile('src/components/Button.tsx', 'Button.tsx');
    const inputFile = createMockFile('src/components/Input.tsx', 'Input.tsx');
    const helperFile = createMockFile('src/utils/helper.ts', 'helper.ts');

    componentsDir.children = [buttonFile, inputFile];
    utilsDir.children = [helperFile];
    srcDir.children = [componentsDir, utilsDir];

    const result = generateProjectTreeText([srcDir], ['**/*.tsx'], [], false, 0);

    expect(result).toContain('Button.tsx');
    expect(result).toContain('Input.tsx');
    expect(result).not.toContain('helper.ts');
  });

  it('rejects an invalid regex instead of silently widening the tree', () => {
    const srcDir = createMockDir('src', 'src');
    const componentsDir = createMockDir('src/components', 'components');
    const buttonFile = createMockFile('src/components/Button.tsx', 'Button.tsx');

    componentsDir.children = [buttonFile];
    srcDir.children = [componentsDir];

    expect(() => generateProjectTreeText([srcDir], ['[abc'], [], true, 0)).toThrow(
      'Invalid regular expression pattern: [abc'
    );
  });
});

describe('helper functions', () => {
  it('compilePatterns handles glob and regex', () => {
    const globCompiled = compilePatterns(['**/*.ts'], false);
    expect(globCompiled[0]).toBeInstanceOf(Minimatch);

    const regexCompiled = compilePatterns(['\\.ts$'], true);
    expect(regexCompiled[0]).toBeInstanceOf(RegExp);
  });

  it('traverseFileTree builds lines array', () => {
    const root = createMockDir('root', 'root');
    const file = createMockFile('root/a.ts', 'a.ts');
    root.children = [file];

    const lines: string[] = [];
    traverseFileTree(root, [], [], lines, 5);

    expect(lines).toEqual(['root/', '  a.ts']);
  });
});
