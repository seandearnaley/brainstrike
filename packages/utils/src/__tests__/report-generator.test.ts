import type {
  DirectoryHandle,
  DirectoryReadOptions,
  FileHandle,
  FileSystemAdapter,
  FileSystemChange,
  IFileNode,
} from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPathSegments } from '../path-utils.js';
import {
  generateReport,
  generateReportFromAdapter,
  normalizeContextLineRanges,
} from '../report-generator';

interface MockFileEntry {
  children?: Record<string, MockFileEntry>;
  content?: string;
  name: string;
  size?: number;
  type: 'file' | 'directory';
}

class MockFileSystemAdapter implements FileSystemAdapter {
  private readonly rootName = 'mock-root';

  constructor(private readonly mockFileSystem: Record<string, MockFileEntry>) {}

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    return {
      path: this.rootName,
      name: this.rootName,
      kind: 'directory',
      platform: 'web',
    };
  }

  async readDirectory(
    handle: DirectoryHandle,
    _options?: DirectoryReadOptions
  ): Promise<IFileNode[]> {
    const relative =
      handle.path === this.rootName ? '' : handle.path.replace(`${this.rootName}/`, '');
    const level = this.navigate(relative);
    if (!level) {
      return [];
    }

    const entries: IFileNode[] = [];
    for (const [name, entry] of Object.entries(level)) {
      const fullPath = relative ? `${handle.path}/${name}` : `${handle.path}/${name}`;
      entries.push(this.createNode(name, entry, fullPath));
    }
    return entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(_handle: FileHandle): Promise<string> {
    return '';
  }

  async exists(_path: string): Promise<boolean> {
    return false;
  }

  watchDirectory?(
    _handle: DirectoryHandle,
    _callback: (changes: FileSystemChange[]) => void
  ): () => void {
    return () => {};
  }

  restoreLastFolder?(): Promise<DirectoryHandle | null> {
    return Promise.resolve(null);
  }

  private navigate(path: string): Record<string, MockFileEntry> | null {
    if (!path) {
      return this.mockFileSystem;
    }
    const segments = extractPathSegments(path);
    let current = this.mockFileSystem;
    for (const part of segments) {
      const entry = current[part];
      if (entry?.type !== 'directory' || !entry.children) {
        return null;
      }
      current = entry.children;
    }
    return current;
  }

  private createNode(name: string, entry: MockFileEntry, fullPath: string): IFileNode {
    const base: IFileNode = {
      name,
      path: fullPath,
      type: entry.type,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: this.rootName,
      handle: {
        path: fullPath,
        name,
        kind: entry.type,
        platform: 'web',
        _internal: entry,
      } as unknown as FileSystemFileHandle | FileSystemDirectoryHandle,
    };

    if (entry.type === 'file') {
      base.size = entry.size ?? entry.content?.length ?? 0;
      base.lastModified = Date.now();
    } else {
      base.children = [];
    }

    return base;
  }

  static createSimpleFileSystem(): Record<string, MockFileEntry> {
    return {
      src: {
        name: 'src',
        type: 'directory',
        children: {
          'index.ts': {
            name: 'index.ts',
            type: 'file',
            content: 'export * from "./components";',
          },
          components: {
            name: 'components',
            type: 'directory',
            children: {
              'Button.tsx': {
                name: 'Button.tsx',
                type: 'file',
                content: 'export const Button = () => <button>Click me</button>;',
              },
              'Input.tsx': {
                name: 'Input.tsx',
                type: 'file',
                content: 'export const Input = () => <input />;',
              },
            },
          },
        },
      },
      'package.json': {
        name: 'package.json',
        type: 'file',
        content: '{"name": "test-package", "version": "1.0.0"}',
      },
      'README.md': {
        name: 'README.md',
        type: 'file',
        content: '# Test Project\n\nThis is a test project.',
      },
    };
  }
}

describe('reportGenerator', () => {
  const mockFileContents = {
    'src/lib/utils.ts': 'export const formatDate = (date: Date) => date.toISOString();',
    'src/components/ui/Button.tsx':
      'export const Button = ({ children }) => <button>{children}</button>;',
    'src/components/ui/Input.tsx':
      'export const Input = ({ value, onChange }) => <input value={value} onChange={onChange} />;',
    'src/components/layout/Header.tsx': 'export const Header = () => <header>My App</header>;',
    'src/pages/index.tsx': 'export default function Home() { return <div>Welcome</div>; }',
    'src/styles/globals.css': 'body { margin: 0; padding: 0; }',
    'tests/components/Button.test.tsx':
      'describe("Button", () => { it("renders", () => {/* ... */}); });',
    'README.md': '# My Project\nA Vite application with TypeScript.',
    'package.json': '{ "name": "my-app", "version": "1.0.0" }',
  };

  const createMockDirectoryHandle = (): FileSystemDirectoryHandle => ({
    kind: 'directory',
    name: 'root',
    async *entries() {
      // Root level files
      yield [
        'README.md',
        {
          kind: 'file',
          name: 'README.md',
          getFile: async () => new File([], 'README.md'),
          createWritable: async () => {
            throw new Error('Not implemented');
          },
          isSameEntry: async () => true,
        } as FileSystemFileHandle,
      ];

      yield [
        'package.json',
        {
          kind: 'file',
          name: 'package.json',
          getFile: async () => new File([], 'package.json'),
          createWritable: async () => {
            throw new Error('Not implemented');
          },
          isSameEntry: async () => true,
        } as FileSystemFileHandle,
      ];

      // src directory
      yield [
        'src',
        {
          kind: 'directory',
          name: 'src',
          async *entries() {
            // src/lib
            yield [
              'lib',
              {
                kind: 'directory',
                name: 'lib',
                async *entries() {
                  yield [
                    'utils.ts',
                    {
                      kind: 'file',
                      name: 'utils.ts',
                      getFile: async () => new File([], 'utils.ts'),
                      createWritable: async () => {
                        throw new Error('Not implemented');
                      },
                      isSameEntry: async () => true,
                    } as FileSystemFileHandle,
                  ];
                },
                getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
                getFileHandle: async () => ({}) as FileSystemFileHandle,
                removeEntry: async () => {},
                resolve: async () => [],
                isSameEntry: async () => true,
              } as FileSystemDirectoryHandle,
            ];

            // src/components
            yield [
              'components',
              {
                kind: 'directory',
                name: 'components',
                async *entries() {
                  // src/components/ui
                  yield [
                    'ui',
                    {
                      kind: 'directory',
                      name: 'ui',
                      async *entries() {
                        yield [
                          'Button.tsx',
                          {
                            kind: 'file',
                            name: 'Button.tsx',
                            getFile: async () => new File([], 'Button.tsx'),
                            createWritable: async () => {
                              throw new Error('Not implemented');
                            },
                            isSameEntry: async () => true,
                          } as FileSystemFileHandle,
                        ];
                        yield [
                          'Input.tsx',
                          {
                            kind: 'file',
                            name: 'Input.tsx',
                            getFile: async () => new File([], 'Input.tsx'),
                            createWritable: async () => {
                              throw new Error('Not implemented');
                            },
                            isSameEntry: async () => true,
                          } as FileSystemFileHandle,
                        ];
                      },
                      getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
                      getFileHandle: async () => ({}) as FileSystemFileHandle,
                      removeEntry: async () => {},
                      resolve: async () => [],
                      isSameEntry: async () => true,
                    } as FileSystemDirectoryHandle,
                  ];

                  // src/components/layout
                  yield [
                    'layout',
                    {
                      kind: 'directory',
                      name: 'layout',
                      async *entries() {
                        yield [
                          'Header.tsx',
                          {
                            kind: 'file',
                            name: 'Header.tsx',
                            getFile: async () => new File([], 'Header.tsx'),
                            createWritable: async () => {
                              throw new Error('Not implemented');
                            },
                            isSameEntry: async () => true,
                          } as FileSystemFileHandle,
                        ];
                      },
                      getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
                      getFileHandle: async () => ({}) as FileSystemFileHandle,
                      removeEntry: async () => {},
                      resolve: async () => [],
                      isSameEntry: async () => true,
                    } as FileSystemDirectoryHandle,
                  ];
                },
                getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
                getFileHandle: async () => ({}) as FileSystemFileHandle,
                removeEntry: async () => {},
                resolve: async () => [],
                isSameEntry: async () => true,
              } as FileSystemDirectoryHandle,
            ];

            // src/pages
            yield [
              'pages',
              {
                kind: 'directory',
                name: 'pages',
                async *entries() {
                  yield [
                    'index.tsx',
                    {
                      kind: 'file',
                      name: 'index.tsx',
                      getFile: async () => new File([], 'index.tsx'),
                      createWritable: async () => {
                        throw new Error('Not implemented');
                      },
                      isSameEntry: async () => true,
                    } as FileSystemFileHandle,
                  ];
                },
                getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
                getFileHandle: async () => ({}) as FileSystemFileHandle,
                removeEntry: async () => {},
                resolve: async () => [],
                isSameEntry: async () => true,
              } as FileSystemDirectoryHandle,
            ];

            // src/styles
            yield [
              'styles',
              {
                kind: 'directory',
                name: 'styles',
                async *entries() {
                  yield [
                    'globals.css',
                    {
                      kind: 'file',
                      name: 'globals.css',
                      getFile: async () => new File([], 'globals.css'),
                      createWritable: async () => {
                        throw new Error('Not implemented');
                      },
                      isSameEntry: async () => true,
                    } as FileSystemFileHandle,
                  ];
                },
                getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
                getFileHandle: async () => ({}) as FileSystemFileHandle,
                removeEntry: async () => {},
                resolve: async () => [],
                isSameEntry: async () => true,
              } as FileSystemDirectoryHandle,
            ];
          },
          getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
          getFileHandle: async () => ({}) as FileSystemFileHandle,
          removeEntry: async () => {},
          resolve: async () => [],
          isSameEntry: async () => true,
        } as FileSystemDirectoryHandle,
      ];

      // tests directory
      yield [
        'tests',
        {
          kind: 'directory',
          name: 'tests',
          async *entries() {
            yield [
              'components',
              {
                kind: 'directory',
                name: 'components',
                async *entries() {
                  yield [
                    'Button.test.tsx',
                    {
                      kind: 'file',
                      name: 'Button.test.tsx',
                      getFile: async () => new File([], 'Button.test.tsx'),
                      createWritable: async () => {
                        throw new Error('Not implemented');
                      },
                      isSameEntry: async () => true,
                    } as FileSystemFileHandle,
                  ];
                },
                getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
                getFileHandle: async () => ({}) as FileSystemFileHandle,
                removeEntry: async () => {},
                resolve: async () => [],
                isSameEntry: async () => true,
              } as FileSystemDirectoryHandle,
            ];
          },
          getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
          getFileHandle: async () => ({}) as FileSystemFileHandle,
          removeEntry: async () => {},
          resolve: async () => [],
          isSameEntry: async () => true,
        } as FileSystemDirectoryHandle,
      ];
    },
    getDirectoryHandle: async () => ({}) as FileSystemDirectoryHandle,
    getFileHandle: async () => ({}) as FileSystemFileHandle,
    removeEntry: async () => {},
    resolve: async () => [],
    isSameEntry: async () => true,
  });

  let mockRootDirectoryHandle: FileSystemDirectoryHandle;

  beforeEach(() => {
    mockRootDirectoryHandle = createMockDirectoryHandle();
    vi.clearAllMocks();
  });

  it('normalizes context line ranges by filtering, clamping, sorting, and merging', () => {
    expect(normalizeContextLineRanges(undefined, 10)).toEqual([]);

    expect(
      normalizeContextLineRanges(
        [
          { startLine: 7, endLine: 9 },
          { startLine: 2, endLine: 5.8 },
          { startLine: 1, endLine: 3 },
          { startLine: 0, endLine: 1, isActive: false },
          { startLine: 20, endLine: 30 },
        ],
        10
      )
    ).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 7, endLine: 10 },
    ]);
  });

  it('generates a basic report without project tree', async () => {
    const selectedFiles = new Set(['src/lib/utils.ts', 'src/components/ui/Button.tsx']);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      false
    );

    expect(report).toContain('<relevant_context>');
    expect(report).toContain('src/lib/utils.ts');
    expect(report).toContain('src/components/ui/Button.tsx');
    expect(report).toContain('export const formatDate');
    expect(report).toContain('export const Button');
    expect(report).not.toContain('<project_tree>');
  });

  it('renders human-readable file paths for storage-v5 composite selection keys', async () => {
    // Storage v5: selection keys are `${rootId}|@|${absolutePath}` where
    // rootId is a UUID. The <file path> attribute must render the root's
    // displayName + relative path, never the UUID composite key.
    const ROOT_ID = '11111111-0000-4000-8000-000000000011';
    const compositeKey = `${ROOT_ID}|@|/Users/me/BrainStrike/src/utils.ts`;
    const selectedFiles = new Set([compositeKey]);
    const fileContents = { [compositeKey]: 'export const x = 1;' };

    const report = await generateReport(
      selectedFiles,
      fileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      false,
      5,
      {
        rootDisplayInfoById: {
          [ROOT_ID]: { displayName: 'BrainStrike', path: '/Users/me/BrainStrike' },
        },
      }
    );

    expect(report).toContain('<file path="BrainStrike/src/utils.ts">');
    expect(report).toContain('export const x = 1;');
    expect(report).not.toContain(ROOT_ID);
  });

  it('generates a report with project tree', async () => {
    const selectedFiles = new Set([
      'src/components/ui/Button.tsx',
      'src/components/ui/Input.tsx',
      'src/components/layout/Header.tsx',
    ]);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      true
    );

    expect(report).toContain('<relevant_context>');
    expect(report).toContain('src/components/ui/Button.tsx');
    expect(report).toContain('src/components/ui/Input.tsx');
    expect(report).toContain('src/components/layout/Header.tsx');
    expect(report).toContain('<project_tree>');
    expect(report).toContain('components/');
    expect(report).toContain('ui/');
    expect(report).toContain('layout/');
  });

  it('handles multiple selected files across different directories', async () => {
    const selectedFiles = new Set([
      'README.md',
      'src/pages/index.tsx',
      'src/styles/globals.css',
      'tests/components/Button.test.tsx',
    ]);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      true
    );

    expect(report).toContain('README.md');
    expect(report).toContain('src/pages/index.tsx');
    expect(report).toContain('src/styles/globals.css');
    expect(report).toContain('tests/components/Button.test.tsx');
    expect(report).toContain('# My Project');
    expect(report).toContain('export default function Home');
    expect(report).toContain('body { margin: 0; padding: 0; }');
    expect(report).toContain('describe("Button"');
  });

  it('applies include filters when generating project tree', async () => {
    const selectedFiles = new Set(['src/components/ui/Button.tsx']);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      ['**/components/**/*.tsx'],
      [],
      false,
      true,
      5,
      { projectTreeUsesViewFilters: true }
    );

    expect(report).toContain('<project_tree>');
    expect(report).toContain('Button.tsx');
    expect(report).toContain('Input.tsx');
    expect(report).toContain('Header.tsx');
    expect(report).not.toContain('index.tsx');
    expect(report).not.toContain('globals.css');
  });

  it('applies exclude filters when generating project tree', async () => {
    const selectedFiles = new Set(['src/components/ui/Button.tsx']);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      ['**/*.tsx'],
      ['**/tests/**'],
      false,
      true,
      5,
      { projectTreeUsesViewFilters: true }
    );

    expect(report).toContain('<project_tree>');
    expect(report).toContain('Button.tsx');
    expect(report).toContain('Input.tsx');
    expect(report).toContain('Header.tsx');
    expect(report).not.toContain('Button.test.tsx');
  });

  it('can ignore view filters for full project tree output', async () => {
    const selectedFiles = new Set(['src/components/ui/Button.tsx']);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      ['**/components/**/*.tsx'],
      ['**/tests/**'],
      false,
      true,
      5,
      { projectTreeUsesViewFilters: false }
    );

    expect(report).toContain('<project_tree>');
    expect(report).toContain('index.tsx');
    expect(report).toContain('globals.css');
    expect(report).toContain('Button.test.tsx');
  });

  it('supports tapestry-aware range output for selected files', async () => {
    const selectedFiles = new Set(['src/lib/utils.ts']);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      false,
      5,
      {
        useTapestryRanges: true,
        selectedLineRangesByFile: {
          'src/lib/utils.ts': [{ startLine: 0, endLine: 1, isActive: true }],
        },
      }
    );

    expect(report).toContain('<selection index="1" start_line="0" end_line="1">');
    expect(report).toContain('export const formatDate');
  });

  it('treats files without explicit ranges as fully selected in tapestry mode', async () => {
    const selectedFiles = new Set(['src/lib/utils.ts', 'README.md']);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      false,
      5,
      {
        useTapestryRanges: true,
        selectedLineRangesByFile: {
          'src/lib/utils.ts': [{ startLine: 0, endLine: 1, isActive: true }],
        },
      }
    );

    expect(report).toContain('<selection index="1" start_line="0" end_line="1">');
    expect(report).toContain('export const formatDate');
    expect(report).toContain('<file path="README.md">');
    expect(report).toContain('# My Project');
    expect(report).not.toContain(
      '<selection_summary>No active tapestry ranges selected.</selection_summary>'
    );
  });

  it('emits selection_summary when all tapestry ranges are inactive', async () => {
    const selectedFiles = new Set(['src/lib/utils.ts']);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      false,
      5,
      {
        useTapestryRanges: true,
        selectedLineRangesByFile: {
          'src/lib/utils.ts': [{ startLine: 0, endLine: 1, isActive: false }],
        },
      }
    );

    expect(report).toContain(
      '<selection_summary>No active tapestry ranges selected.</selection_summary>'
    );
    expect(report).not.toContain('export const formatDate');
  });

  it('strips all XML-illegal control characters from file paths', async () => {
    // Test the full range of XML-illegal control characters in file paths:
    // \x00-\x08, \x0B, \x0C, \x0E-\x1F (everything < 0x20 except tab, LF, CR)
    const illegalChars = [
      '\x00',
      '\x01',
      '\x02',
      '\x03',
      '\x04',
      '\x05',
      '\x06',
      '\x07',
      '\x08',
      '\x0B',
      '\x0C',
      '\x0E',
      '\x0F',
      '\x10',
      '\x11',
      '\x12',
      '\x13',
      '\x14',
      '\x15',
      '\x16',
      '\x17',
      '\x18',
      '\x19',
      '\x1A',
      '\x1B',
      '\x1C',
      '\x1D',
      '\x1E',
      '\x1F',
    ];
    const dirtyPath = `src/pre${illegalChars.join('')}fix.ts`;
    const selectedFiles = new Set([dirtyPath]);
    const fileContents = { [dirtyPath]: 'export const ok = true;' };

    const report = await generateReport(
      selectedFiles,
      fileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      false
    );

    // All illegal chars stripped from the path attribute
    expect(report).toContain('<file path="src/prefix.ts">');
    expect(report).toContain('export const ok = true;');
  });

  it('preserves allowed whitespace characters in file paths', async () => {
    // Tab (\x09), LF (\x0A), and CR (\x0D) are legal XML characters and should be preserved
    // (though unusual in paths, the sanitizer should not strip them)
    const pathWithTab = 'src/tab\there.ts';
    const selectedFiles = new Set([pathWithTab]);
    const fileContents = { [pathWithTab]: 'export const tab = true;' };

    const report = await generateReport(
      selectedFiles,
      fileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      false
    );

    expect(report).toContain('tab\there.ts');
    expect(report).toContain('export const tab = true;');
  });

  it('escapes XML-sensitive characters in file path attributes', async () => {
    const selectedFiles = new Set(['src/evil "name"&<tag>.ts']);
    const fileContents = {
      'src/evil "name"&<tag>.ts': 'export const risky = true;',
    };

    const report = await generateReport(
      selectedFiles,
      fileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      false
    );

    expect(report).toContain('<file path="src/evil &quot;name&quot;&amp;&lt;tag&gt;.ts">');
    expect(report).toContain('export const risky = true;');
  });

  it('strips XML-illegal control characters from file path attributes', async () => {
    const selectedFiles = new Set(['src/bad\u0000name\u001F.ts']);
    const fileContents = {
      'src/bad\u0000name\u001F.ts': 'export const risky = true;',
    };

    const report = await generateReport(
      selectedFiles,
      fileContents,
      mockRootDirectoryHandle,
      [],
      [],
      false,
      false
    );

    expect(report).toContain('<file path="src/badname.ts">');
    expect(report).toContain('export const risky = true;');
  });
});

describe('generateReportFromAdapter', () => {
  let adapter: MockFileSystemAdapter;
  let rootHandle: DirectoryHandle;

  const fileContents = {
    'src/index.ts': 'export * from "./components";',
    'src/components/Button.tsx': 'export const Button = () => <button>Click me</button>;',
    'src/components/Input.tsx': 'export const Input = () => <input />;',
  };

  beforeEach(async () => {
    const fs = MockFileSystemAdapter.createSimpleFileSystem();
    fs['node_modules'] = {
      name: 'node_modules',
      type: 'directory',
      children: {
        pkg: {
          name: 'pkg',
          type: 'directory',
          children: { 'index.js': { name: 'index.js', type: 'file', content: '//lib' } },
        },
      },
    };
    fs['dist'] = {
      name: 'dist',
      type: 'directory',
      children: { 'bundle.js': { name: 'bundle.js', type: 'file', content: 'bundle' } },
    };

    // build deep nested structure to trigger depth limiting
    fs['deep'] = { name: 'deep', type: 'directory', children: {} };
    let current: Record<string, MockFileEntry> = fs['deep'].children as Record<
      string,
      MockFileEntry
    >;
    for (let i = 0; i < 31; i++) {
      current[`dir${i}`] = { name: `dir${i}`, type: 'directory', children: {} };
      current = current[`dir${i}`]!.children as Record<string, MockFileEntry>;
    }
    current['tooDeep.txt'] = { name: 'tooDeep.txt', type: 'file', content: 'deep' };

    adapter = new MockFileSystemAdapter(fs);
    rootHandle = await adapter.requestDirectoryAccess();
  });

  it('generates report and project tree from adapter', async () => {
    const selected = new Set(['src/index.ts', 'src/components/Button.tsx']);

    const report = await generateReportFromAdapter(
      selected,
      fileContents,
      adapter,
      rootHandle,
      [],
      [],
      false,
      true
    );

    expect(report.startsWith('<context>')).toBe(true);
    expect(report.trim().endsWith('</context>')).toBe(true);
    expect(report).toContain('<project_tree>');
    expect(report).toContain('src/');
    expect(report).toContain('components/');
    expect(report).toContain('Button.tsx');
    expect(report).toContain('Input.tsx');
    expect(report).not.toContain('node_modules');
    expect(report).not.toContain('dist/');
    // deepest file should be truncated by depth limit
    expect(report).not.toContain('tooDeep.txt');
  });

  it('handles adapter errors gracefully', async () => {
    const spy = vi.spyOn(adapter, 'readDirectory');
    spy.mockImplementationOnce(() => Promise.reject(new Error('fail')));

    const selected = new Set(['src/index.ts']);
    const report = await generateReportFromAdapter(
      selected,
      fileContents,
      adapter,
      rootHandle,
      [],
      [],
      false,
      true
    );

    expect(report).toContain('<context>');
    expect(report).toContain('src/index.ts');

    spy.mockRestore();
  });

  it('skips ignored adapter paths without traversing ignored directories', async () => {
    const readDirectoryCalls: string[] = [];

    class IgnorePathAdapter implements FileSystemAdapter {
      async requestDirectoryAccess(): Promise<DirectoryHandle> {
        return { path: 'root', name: 'root', kind: 'directory', platform: 'web' };
      }

      async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
        readDirectoryCalls.push(handle.path);

        if (handle.path === 'root/node_modules') {
          throw new Error('Ignored directory should not be traversed');
        }

        if (handle.path !== 'root') {
          return [];
        }

        return [
          {
            name: 'src',
            path: 'root/src',
            type: 'directory',
            handle: {
              path: 'root/src',
              name: 'src',
              kind: 'directory',
              platform: 'web',
            } as unknown as FileSystemDirectoryHandle,
            depth: 0,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
          {
            name: 'node_modules',
            path: 'root/node_modules',
            type: 'directory',
            handle: {
              path: 'root/node_modules',
              name: 'node_modules',
              kind: 'directory',
              platform: 'web',
            } as unknown as FileSystemDirectoryHandle,
            depth: 0,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
        ];
      }

      async readFile(): Promise<string> {
        return '';
      }

      async exists(): Promise<boolean> {
        return false;
      }
    }

    const treeModule = await import('../tree-generator');
    let capturedTree: IFileNode[] = [];
    const treeSpy = vi.spyOn(treeModule, 'generateProjectTreeText').mockImplementation((nodes) => {
      capturedTree = nodes;
      return 'project tree';
    });

    try {
      const ignoreAdapter = new IgnorePathAdapter();
      const ignoreRoot = await ignoreAdapter.requestDirectoryAccess();

      await generateReportFromAdapter(
        new Set(),
        {},
        ignoreAdapter,
        ignoreRoot,
        [],
        [],
        false,
        true
      );

      expect(readDirectoryCalls).toEqual(['root', 'root/src']);
      expect(capturedTree.map((node) => node.name)).toEqual(['src']);
    } finally {
      treeSpy.mockRestore();
    }
  });

  it('flags symlinks, depth truncation, and ignores standard paths', async () => {
    // Minimal helper functions to create file and directory nodes (unused but kept for future use)
    // const dirNode = (path: string, name?: string): MockFileEntry => ({
    //   name: name ?? (path.split('/').pop() || ''),
    //   type: 'directory',
    //   children: {},
    // });

    // const fileNode = (path: string): MockFileEntry => ({
    //   name: path.split('/').pop() || '',
    //   type: 'file',
    //   content: '',
    // });

    // Build custom structure with a symlink-like entry and deep nesting
    const makeDirHandle = (path: string): DirectoryHandle => ({
      path,
      name: path.split('/').pop() || path,
      kind: 'directory',
      platform: 'web',
    });
    const makeFileHandle = (path: string): FileHandle => ({
      path,
      name: path.split('/').pop() || path,
      kind: 'file',
      platform: 'web',
    });

    const dirNodeFull = (path: string, name?: string): IFileNode => ({
      name: name ?? (path.split('/').pop() || ''),
      path,
      type: 'directory',
      handle: makeDirHandle(path) as unknown as FileSystemDirectoryHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'root',
    });
    const fileNodeFull = (path: string): IFileNode => ({
      name: path.split('/').pop() || '',
      path,
      type: 'file',
      handle: makeFileHandle(path) as unknown as FileSystemFileHandle,
      depth: 0,
      selectionState: 'unchecked',
      rootFolderId: 'root',
    });

    const structure: Record<string, IFileNode[]> = {};
    structure['root'] = [
      dirNodeFull('root/dir'),
      dirNodeFull('root/deep'),
      dirNodeFull('root', 'root-link'),
      dirNodeFull('root/node_modules'),
      dirNodeFull('root/.git'),
    ];
    structure['root/dir'] = [fileNodeFull('root/dir/file.txt')];

    // deep directory chain
    let prevPath = 'root/deep';
    for (let i = 0; i < 31; i++) {
      const currentPath = `${prevPath}/dir${i}`;
      structure[prevPath] = [dirNodeFull(currentPath)];
      prevPath = currentPath;
    }
    structure[prevPath] = [fileNodeFull(`${prevPath}/end.txt`)];

    structure['root/node_modules'] = [fileNodeFull('root/node_modules/ignored.js')];
    structure['root/.git'] = [fileNodeFull('root/.git/HEAD')];

    class SimpleAdapter implements FileSystemAdapter {
      constructor(private readonly map: Record<string, IFileNode[]>) {}
      async requestDirectoryAccess(): Promise<DirectoryHandle> {
        return { path: 'root', name: 'root', kind: 'directory', platform: 'web' };
      }
      async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
        return this.map[handle.path] || [];
      }
      async readFile(): Promise<string> {
        return '';
      }
      async exists(): Promise<boolean> {
        return false;
      }
    }

    const customAdapter = new SimpleAdapter(structure);
    const customRoot = await customAdapter.requestDirectoryAccess();

    // Capture the file tree passed to generateProjectTreeText
    const treeModule = await import('../tree-generator');
    let captured: import('@brainstrike/types').IFileNode[] = [];
    const treeSpy = vi.spyOn(treeModule, 'generateProjectTreeText').mockImplementation((nodes) => {
      captured = nodes;
      return '';
    });

    await generateReportFromAdapter(new Set(), {}, customAdapter, customRoot, [], [], false, true);

    treeSpy.mockRestore();

    // Ensure ignored directories were skipped
    expect(captured.some((n) => n.name === 'node_modules')).toBe(false);
    expect(captured.some((n) => n.name === '.git')).toBe(false);

    // Check symbolic link flag
    const linkNode = captured.find((n) => n.name === 'root-link');
    expect(linkNode?.isSymbolicLink).toBe(true);

    // Traverse deep chain to verify depth truncation flag
    function findNode(nodes: IFileNode[] | undefined, target: string): IFileNode | undefined {
      if (!nodes) {
        return;
      }
      for (const node of nodes) {
        if (node.name === target) {
          return node;
        }
        const found = findNode(node.children, target);
        if (found) {
          return found;
        }
      }
      return;
    }
    const truncated = findNode(captured, 'dir28');
    expect(truncated?.isDepthTruncated).toBe(true);
  });
});
