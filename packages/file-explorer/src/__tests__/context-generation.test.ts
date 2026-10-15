import type {
  DirectoryHandle,
  DirectoryReadOptions,
  FileHandle,
  FileSystemAdapter,
  FileSystemChange,
  IFileNode,
} from '@brainstrike/types';
import { extractPathSegments } from '@brainstrike/utils/path-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateReport, generateReportFromAdapter } from '../context-generation.js';

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
      kind: 'directory',
      name: this.rootName,
      path: this.rootName,
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
      depth: 0,
      handle: {
        _internal: entry,
        kind: entry.type,
        name,
        path: fullPath,
        platform: 'web',
      } as unknown as FileSystemFileHandle | FileSystemDirectoryHandle,
      name,
      path: fullPath,
      rootFolderId: this.rootName,
      selectionState: 'unchecked',
      type: entry.type,
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
      'package.json': {
        content: '{"name": "test-package", "version": "1.0.0"}',
        name: 'package.json',
        type: 'file',
      },
      'README.md': {
        content: '# Test Project\n\nThis is a test project.',
        name: 'README.md',
        type: 'file',
      },
      src: {
        children: {
          components: {
            children: {
              'Button.tsx': {
                content: 'export const Button = () => <button>Click me</button>;',
                name: 'Button.tsx',
                type: 'file',
              },
              'Input.tsx': {
                content: 'export const Input = () => <input />;',
                name: 'Input.tsx',
                type: 'file',
              },
            },
            name: 'components',
            type: 'directory',
          },
          'index.ts': {
            content: 'export * from "./components";',
            name: 'index.ts',
            type: 'file',
          },
        },
        name: 'src',
        type: 'directory',
      },
    };
  }
}

describe('reportGenerator', () => {
  const mockFileContents = {
    'package.json': '{ "name": "my-app", "version": "1.0.0" }',
    'README.md': '# My Project\nA Vite application with TypeScript.',
    'src/components/layout/Header.tsx': 'export const Header = () => <header>My App</header>;',
    'src/components/ui/Button.tsx':
      'export const Button = ({ children }) => <button>{children}</button>;',
    'src/components/ui/Input.tsx':
      'export const Input = ({ value, onChange }) => <input value={value} onChange={onChange} />;',
    'src/lib/utils.ts': 'export const formatDate = (date: Date) => date.toISOString();',
    'src/pages/index.tsx': 'export default function Home() { return <div>Welcome</div>; }',
    'src/styles/globals.css': 'body { margin: 0; padding: 0; }',
    'tests/components/Button.test.tsx':
      'describe("Button", () => { it("renders", () => {/* ... */}); });',
  };

  // Partial mock: only implements the subset of FileSystemDirectoryHandle that
  // report-generator.ts actually reads (kind/name/entries()). TypeScript 6's DOM
  // lib always includes the async-iterable members (keys/values/
  // [Symbol.asyncIterator]) on FileSystemDirectoryHandle, which this test double
  // intentionally omits, so the shape is asserted through `unknown` at the
  // boundary rather than matched structurally against the full DOM type.
  const createMockDirectoryHandle = () =>
    ({
      async *entries() {
        // Root level files
        yield [
          'README.md',
          {
            createWritable: async () => {
              throw new Error('Not implemented');
            },
            getFile: async () => new File([], 'README.md'),
            isSameEntry: async () => true,
            kind: 'file',
            name: 'README.md',
          } as unknown as FileSystemFileHandle,
        ];

        yield [
          'package.json',
          {
            createWritable: async () => {
              throw new Error('Not implemented');
            },
            getFile: async () => new File([], 'package.json'),
            isSameEntry: async () => true,
            kind: 'file',
            name: 'package.json',
          } as unknown as FileSystemFileHandle,
        ];

        // src directory
        yield [
          'src',
          {
            async *entries() {
              // src/lib
              yield [
                'lib',
                {
                  async *entries() {
                    yield [
                      'utils.ts',
                      {
                        createWritable: async () => {
                          throw new Error('Not implemented');
                        },
                        getFile: async () => new File([], 'utils.ts'),
                        isSameEntry: async () => true,
                        kind: 'file',
                        name: 'utils.ts',
                      } as unknown as FileSystemFileHandle,
                    ];
                  },
                  getDirectoryHandle: async () => ({}) as unknown as FileSystemDirectoryHandle,
                  getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
                  isSameEntry: async () => true,
                  kind: 'directory',
                  name: 'lib',
                  removeEntry: async () => {},
                  resolve: async () => [],
                } as unknown as FileSystemDirectoryHandle,
              ];

              // src/components
              yield [
                'components',
                {
                  async *entries() {
                    // src/components/ui
                    yield [
                      'ui',
                      {
                        async *entries() {
                          yield [
                            'Button.tsx',
                            {
                              createWritable: async () => {
                                throw new Error('Not implemented');
                              },
                              getFile: async () => new File([], 'Button.tsx'),
                              isSameEntry: async () => true,
                              kind: 'file',
                              name: 'Button.tsx',
                            } as unknown as FileSystemFileHandle,
                          ];
                          yield [
                            'Input.tsx',
                            {
                              createWritable: async () => {
                                throw new Error('Not implemented');
                              },
                              getFile: async () => new File([], 'Input.tsx'),
                              isSameEntry: async () => true,
                              kind: 'file',
                              name: 'Input.tsx',
                            } as unknown as FileSystemFileHandle,
                          ];
                        },
                        getDirectoryHandle: async () =>
                          ({}) as unknown as FileSystemDirectoryHandle,
                        getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
                        isSameEntry: async () => true,
                        kind: 'directory',
                        name: 'ui',
                        removeEntry: async () => {},
                        resolve: async () => [],
                      } as unknown as FileSystemDirectoryHandle,
                    ];

                    // src/components/layout
                    yield [
                      'layout',
                      {
                        async *entries() {
                          yield [
                            'Header.tsx',
                            {
                              createWritable: async () => {
                                throw new Error('Not implemented');
                              },
                              getFile: async () => new File([], 'Header.tsx'),
                              isSameEntry: async () => true,
                              kind: 'file',
                              name: 'Header.tsx',
                            } as unknown as FileSystemFileHandle,
                          ];
                        },
                        getDirectoryHandle: async () =>
                          ({}) as unknown as FileSystemDirectoryHandle,
                        getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
                        isSameEntry: async () => true,
                        kind: 'directory',
                        name: 'layout',
                        removeEntry: async () => {},
                        resolve: async () => [],
                      } as unknown as FileSystemDirectoryHandle,
                    ];
                  },
                  getDirectoryHandle: async () => ({}) as unknown as FileSystemDirectoryHandle,
                  getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
                  isSameEntry: async () => true,
                  kind: 'directory',
                  name: 'components',
                  removeEntry: async () => {},
                  resolve: async () => [],
                } as unknown as FileSystemDirectoryHandle,
              ];

              // src/pages
              yield [
                'pages',
                {
                  async *entries() {
                    yield [
                      'index.tsx',
                      {
                        createWritable: async () => {
                          throw new Error('Not implemented');
                        },
                        getFile: async () => new File([], 'index.tsx'),
                        isSameEntry: async () => true,
                        kind: 'file',
                        name: 'index.tsx',
                      } as unknown as FileSystemFileHandle,
                    ];
                  },
                  getDirectoryHandle: async () => ({}) as unknown as FileSystemDirectoryHandle,
                  getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
                  isSameEntry: async () => true,
                  kind: 'directory',
                  name: 'pages',
                  removeEntry: async () => {},
                  resolve: async () => [],
                } as unknown as FileSystemDirectoryHandle,
              ];

              // src/styles
              yield [
                'styles',
                {
                  async *entries() {
                    yield [
                      'globals.css',
                      {
                        createWritable: async () => {
                          throw new Error('Not implemented');
                        },
                        getFile: async () => new File([], 'globals.css'),
                        isSameEntry: async () => true,
                        kind: 'file',
                        name: 'globals.css',
                      } as unknown as FileSystemFileHandle,
                    ];
                  },
                  getDirectoryHandle: async () => ({}) as unknown as FileSystemDirectoryHandle,
                  getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
                  isSameEntry: async () => true,
                  kind: 'directory',
                  name: 'styles',
                  removeEntry: async () => {},
                  resolve: async () => [],
                } as unknown as FileSystemDirectoryHandle,
              ];
            },
            getDirectoryHandle: async () => ({}) as unknown as FileSystemDirectoryHandle,
            getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
            isSameEntry: async () => true,
            kind: 'directory',
            name: 'src',
            removeEntry: async () => {},
            resolve: async () => [],
          } as unknown as FileSystemDirectoryHandle,
        ];

        // tests directory
        yield [
          'tests',
          {
            async *entries() {
              yield [
                'components',
                {
                  async *entries() {
                    yield [
                      'Button.test.tsx',
                      {
                        createWritable: async () => {
                          throw new Error('Not implemented');
                        },
                        getFile: async () => new File([], 'Button.test.tsx'),
                        isSameEntry: async () => true,
                        kind: 'file',
                        name: 'Button.test.tsx',
                      } as unknown as FileSystemFileHandle,
                    ];
                  },
                  getDirectoryHandle: async () => ({}) as unknown as FileSystemDirectoryHandle,
                  getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
                  isSameEntry: async () => true,
                  kind: 'directory',
                  name: 'components',
                  removeEntry: async () => {},
                  resolve: async () => [],
                } as unknown as FileSystemDirectoryHandle,
              ];
            },
            getDirectoryHandle: async () => ({}) as unknown as FileSystemDirectoryHandle,
            getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
            isSameEntry: async () => true,
            kind: 'directory',
            name: 'tests',
            removeEntry: async () => {},
            resolve: async () => [],
          } as unknown as FileSystemDirectoryHandle,
        ];
      },
      getDirectoryHandle: async () => ({}) as unknown as FileSystemDirectoryHandle,
      getFileHandle: async () => ({}) as unknown as FileSystemFileHandle,
      isSameEntry: async () => true,
      kind: 'directory',
      name: 'root',
      removeEntry: async () => {},
      resolve: async () => [],
    }) as unknown as FileSystemDirectoryHandle;

  class BrowserHandleTestAdapter implements FileSystemAdapter {
    constructor(private readonly root: FileSystemDirectoryHandle) {}

    async requestDirectoryAccess(): Promise<DirectoryHandle> {
      return {
        _internal: this.root,
        kind: 'directory',
        name: this.root.name,
        path: '',
        platform: 'web',
      };
    }

    async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
      const browserHandle = handle._internal;
      if (!(browserHandle && typeof browserHandle === 'object' && 'entries' in browserHandle)) {
        throw new Error(`Missing browser directory handle for ${handle.path}`);
      }

      const nodes: IFileNode[] = [];
      for await (const [name, childHandle] of (
        browserHandle as FileSystemDirectoryHandle
      ).entries()) {
        nodes.push({
          depth: 0,
          handle: childHandle as FileSystemDirectoryHandle | FileSystemFileHandle,
          name,
          path: `${handle.path}/${name}`,
          rootFolderId: this.root.name,
          selectionState: 'unchecked',
          type: childHandle.kind,
          ...(childHandle.kind === 'directory' ? { children: [] } : {}),
        });
      }
      return nodes;
    }

    async readFile(): Promise<string> {
      return '';
    }

    async exists(): Promise<boolean> {
      return false;
    }
  }

  let mockFileSystemAdapter: FileSystemAdapter;
  let mockRootDirectoryHandle: DirectoryHandle;

  beforeEach(async () => {
    mockFileSystemAdapter = new BrowserHandleTestAdapter(createMockDirectoryHandle());
    mockRootDirectoryHandle = await mockFileSystemAdapter.requestDirectoryAccess();
    vi.clearAllMocks();
  });

  it('generates a basic report without project tree', async () => {
    const selectedFiles = new Set(['src/lib/utils.ts', 'src/components/ui/Button.tsx']);
    const report = await generateReport(
      selectedFiles,
      mockFileContents,
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
      mockFileSystemAdapter,
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
    'src/components/Button.tsx': 'export const Button = () => <button>Click me</button>;',
    'src/components/Input.tsx': 'export const Input = () => <input />;',
    'src/index.ts': 'export * from "./components";',
  };

  beforeEach(async () => {
    const fs = MockFileSystemAdapter.createSimpleFileSystem();
    fs['node_modules'] = {
      children: {
        pkg: {
          children: { 'index.js': { content: '//lib', name: 'index.js', type: 'file' } },
          name: 'pkg',
          type: 'directory',
        },
      },
      name: 'node_modules',
      type: 'directory',
    };
    fs['dist'] = {
      children: { 'bundle.js': { content: 'bundle', name: 'bundle.js', type: 'file' } },
      name: 'dist',
      type: 'directory',
    };

    // build deep nested structure to trigger depth limiting
    fs['deep'] = { children: {}, name: 'deep', type: 'directory' };
    let current: Record<string, MockFileEntry> = fs['deep'].children as Record<
      string,
      MockFileEntry
    >;
    for (let i = 0; i < 31; i++) {
      current[`dir${i}`] = { children: {}, name: `dir${i}`, type: 'directory' };
      current = current[`dir${i}`]!.children as Record<string, MockFileEntry>;
    }
    current['tooDeep.txt'] = { content: 'deep', name: 'tooDeep.txt', type: 'file' };

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

  it('surfaces adapter errors instead of returning partial context', async () => {
    const spy = vi.spyOn(adapter, 'readDirectory');
    spy.mockImplementationOnce(() => Promise.reject(new Error('fail')));

    const selected = new Set(['src/index.ts']);
    await expect(
      generateReportFromAdapter(selected, fileContents, adapter, rootHandle, [], [], false, true)
    ).rejects.toThrow('Failed to read directory contents while generating context: mock-root');

    spy.mockRestore();
  });

  it('reports the exact nested directory whose adapter read failed', async () => {
    const spy = vi.spyOn(adapter, 'readDirectory');
    spy.mockImplementation(async (handle) => {
      if (handle.path === 'mock-root/src/components') {
        throw new Error('nested failure');
      }
      return MockFileSystemAdapter.prototype.readDirectory.call(adapter, handle);
    });

    await expect(
      generateReportFromAdapter(new Set(), {}, adapter, rootHandle, [], [], false, true)
    ).rejects.toThrow(
      'Failed to read directory contents while generating context: mock-root/src/components'
    );

    spy.mockRestore();
  });

  it('skips ignored adapter paths without traversing ignored directories', async () => {
    const readDirectoryCalls: string[] = [];

    class IgnorePathAdapter implements FileSystemAdapter {
      async requestDirectoryAccess(): Promise<DirectoryHandle> {
        return { kind: 'directory', name: 'root', path: 'root', platform: 'web' };
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
            depth: 0,
            handle: {
              kind: 'directory',
              name: 'src',
              path: 'root/src',
              platform: 'web',
            } as unknown as FileSystemDirectoryHandle,
            name: 'src',
            path: 'root/src',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
          },
          {
            depth: 0,
            handle: {
              kind: 'directory',
              name: 'node_modules',
              path: 'root/node_modules',
              platform: 'web',
            } as unknown as FileSystemDirectoryHandle,
            name: 'node_modules',
            path: 'root/node_modules',
            rootFolderId: 'root',
            selectionState: 'unchecked',
            type: 'directory',
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

    const treeModule = await import('../project-tree-text.js');
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
      kind: 'directory',
      name: path.split('/').pop() || path,
      path,
      platform: 'web',
    });
    const makeFileHandle = (path: string): FileHandle => ({
      kind: 'file',
      name: path.split('/').pop() || path,
      path,
      platform: 'web',
    });

    const dirNodeFull = (path: string, name?: string): IFileNode => ({
      depth: 0,
      handle: makeDirHandle(path) as unknown as FileSystemDirectoryHandle,
      name: name ?? (path.split('/').pop() || ''),
      path,
      rootFolderId: 'root',
      selectionState: 'unchecked',
      type: 'directory',
    });
    const fileNodeFull = (path: string): IFileNode => ({
      depth: 0,
      handle: makeFileHandle(path) as unknown as FileSystemFileHandle,
      name: path.split('/').pop() || '',
      path,
      rootFolderId: 'root',
      selectionState: 'unchecked',
      type: 'file',
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
        return { kind: 'directory', name: 'root', path: 'root', platform: 'web' };
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
    const treeModule = await import('../project-tree-text.js');
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
