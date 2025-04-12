import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateReport } from '../report-generator';

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
    entries: async function* () {
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
          entries: async function* () {
            // src/lib
            yield [
              'lib',
              {
                kind: 'directory',
                name: 'lib',
                entries: async function* () {
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
                entries: async function* () {
                  // src/components/ui
                  yield [
                    'ui',
                    {
                      kind: 'directory',
                      name: 'ui',
                      entries: async function* () {
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
                      entries: async function* () {
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
                entries: async function* () {
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
                entries: async function* () {
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
          entries: async function* () {
            yield [
              'components',
              {
                kind: 'directory',
                name: 'components',
                entries: async function* () {
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

    expect(report).toContain('<relevant_files>');
    expect(report).toContain('src/lib/utils.ts');
    expect(report).toContain('src/components/ui/Button.tsx');
    expect(report).toContain('export const formatDate');
    expect(report).toContain('export const Button');
    expect(report).not.toContain('<project_tree>');
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

    expect(report).toContain('<relevant_files>');
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
      true
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
      true
    );

    expect(report).toContain('<project_tree>');
    expect(report).toContain('Button.tsx');
    expect(report).toContain('Input.tsx');
    expect(report).toContain('Header.tsx');
    expect(report).not.toContain('Button.test.tsx');
  });
});
