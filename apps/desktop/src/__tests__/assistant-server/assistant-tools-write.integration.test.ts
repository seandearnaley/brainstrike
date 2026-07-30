import { realpathSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type RuntimeData, resetFileReadState, withFileLock } from '@brainstrike/agent';
import type { ToolInputError } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
  };
});

const {
  getDatabaseMock,
  getAllWindowsMock,
  invalidateManagedCacheMock,
  loggerErrorMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  getAllWindowsMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  invalidateManagedCacheMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
}));

// Keep the real @brainstrike/db exports (EmbeddingSetsRepository, etc.) but stub
// the index-invalidation seam so delete/rename tests assert this tool's honest
// indexInvalidated reporting without emulating the invalidator's internals.
vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...actual,
    invalidateManagedCacheEntriesByIdentity: invalidateManagedCacheMock,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: loggerErrorMock,
      info: vi.fn(),
      warn: loggerWarnMock,
    })),
  };
});

// Split from the 5,101-line assistant-tools.integration.test.ts (BST-976):
// one suite per service seam, sharing the fixture module and repeating the
// vi.mock preamble per file (hoisting is per-importing-module).
describe('assistant-tools write tools', () => {
  async function createWorkspaceFixture(): Promise<string> {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-agent-tools-'));
    await fsPromises.mkdir(path.join(root, 'src', 'components'), { recursive: true });
    await fsPromises.mkdir(path.join(root, 'src', 'lib'), { recursive: true });
    await fsPromises.writeFile(path.join(root, 'README.md'), '# Test Workspace\n', 'utf8');
    await fsPromises.writeFile(
      path.join(root, 'src', 'main.ts'),
      'line 1\nline 2\nline 3\nline 4',
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(root, 'src', 'components', 'button.tsx'),
      'export const Button = () => null;\n',
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(root, 'src', 'lib', 'math.ts'),
      'export const add = () => 1;\n',
      'utf8'
    );
    return root;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('writeWorkspaceFile', () => {
    it('creates a new file (created: true) with the right content and byte count', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
        const tool = tools['brainstrike.writeWorkspaceFile'];

        const result = await tool.execute({
          context: { content: 'export const created = true;\n', path: '/src/new-file.ts' },
        });

        expect(result.path).toBe('/src/new-file.ts');
        expect(result.created).toBe(true);
        expect(result.bytesWritten).toBe(Buffer.byteLength('export const created = true;\n'));
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'src', 'new-file.ts'),
          'utf8'
        );
        expect(onDisk).toBe('export const created = true;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('creates missing parent directories', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        const result = await tool.execute({
          context: { content: 'hello', path: '/deeply/nested/dir/file.txt' },
        });

        expect(result.created).toBe(true);
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'deeply', 'nested', 'dir', 'file.txt'),
          'utf8'
        );
        expect(onDisk).toBe('hello');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('overwrites an existing file (created: false)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        const result = await tool.execute({
          context: { content: '# Overwritten\n', path: '/README.md' },
        });

        expect(result.created).toBe(false);
        const onDisk = await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8');
        expect(onDisk).toBe('# Overwritten\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects a relative "../" escape and writes no file outside the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-out-'));
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        // "../" is clamped at the root by normalizeWorkspacePath, so this normalizes
        // to "/escaped.txt" INSIDE the root — it must NOT land in the sibling dir.
        await tool.execute({ context: { content: 'nope', path: '../escaped.txt' } });

        await expect(
          fsPromises.access(path.join(path.dirname(workspaceRootPath), 'escaped.txt'))
        ).rejects.toThrow();
        await expect(fsPromises.access(path.join(outsideRoot, 'escaped.txt'))).rejects.toThrow();
        // Landed safely inside the root instead.
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'escaped.txt'),
          'utf8'
        );
        expect(onDisk).toBe('nope');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects a write through a symlinked directory that escapes the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-link-'));
      const linkDir = path.join(workspaceRootPath, 'src', 'linked');
      try {
        try {
          await fsPromises.symlink(outsideRoot, linkDir, 'dir');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        await expect(
          tool.execute({ context: { content: 'escape', path: '/src/linked/pwned.txt' } })
        ).rejects.toThrow('is outside the selected workspace root');
        // Nothing was written through the symlink into the outside dir.
        await expect(fsPromises.access(path.join(outsideRoot, 'pwned.txt'))).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects a DANGLING symlink leaf that points outside the root (regression: escaped containment)', async () => {
      // The leaf is an existing symlink whose target does NOT exist. realpath(leaf)
      // throws ENOENT, so the old resolver treated it as not-yet-created and wrote
      // through the real symlink, landing bytes OUTSIDE the root. Must now throw.
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-dl-'));
      const outsideTarget = path.join(outsideRoot, 'pwned.txt'); // never created (dangling)
      const leafLink = path.join(workspaceRootPath, 'src', 'evil.txt');
      try {
        try {
          await fsPromises.symlink(outsideTarget, leafLink, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        await expect(
          tool.execute({ context: { content: 'PWNED', path: '/src/evil.txt' } })
        ).rejects.toThrow('is outside the selected workspace root');
        // The bytes never escaped through the dangling symlink.
        await expect(fsPromises.access(outsideTarget)).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects a LIVE symlink leaf that points outside the root', async () => {
      // The leaf symlink targets an EXISTING file outside the root; writeFile would
      // overwrite it. Must throw and leave the outside file untouched.
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-ll-'));
      const outsideTarget = path.join(outsideRoot, 'pwned.txt');
      const leafLink = path.join(workspaceRootPath, 'src', 'evil.txt');
      await fsPromises.writeFile(outsideTarget, 'original', 'utf8');
      try {
        try {
          await fsPromises.symlink(outsideTarget, leafLink, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        await expect(
          tool.execute({ context: { content: 'PWNED', path: '/src/evil.txt' } })
        ).rejects.toThrow('is outside the selected workspace root');
        // The outside file was NOT overwritten through the symlink.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('original');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects an INTERMEDIATE dangling symlinked directory that escapes the root', async () => {
      // A parent component is a symlink to a non-existent outside dir. A plain
      // mkdir -p would create the target and write through it; must throw instead.
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-wwf-id-'));
      const outsideDir = path.join(outsideRoot, 'subdir'); // never created (dangling)
      const linkDir = path.join(workspaceRootPath, 'src', 'linkdir');
      try {
        try {
          await fsPromises.symlink(outsideDir, linkDir, 'dir');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];

        await expect(
          tool.execute({ context: { content: 'PWNED', path: '/src/linkdir/pwned.txt' } })
        ).rejects.toThrow('outside the selected workspace root');
        // Nothing was created under the dangling intermediate symlink.
        await expect(fsPromises.access(path.join(outsideDir, 'pwned.txt'))).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('rejects content exceeding the write byte cap with a typed error', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];
        // 2 MB + 1 byte exceeds MAX_WRITE_WORKSPACE_FILE_BYTES.
        const oversized = 'a'.repeat(2_000_001);
        await expect(
          tool.execute({ context: { content: oversized, path: '/big.txt' } })
        ).rejects.toThrow(/exceeding the .* byte write limit/i);
        // No partial/empty file was created.
        await expect(fsPromises.access(path.join(workspaceRootPath, 'big.txt'))).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects writing to the workspace root itself', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];
        await expect(tool.execute({ context: { content: 'x', path: '/' } })).rejects.toThrow(
          /workspace root/i
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects overwriting a directory with file content', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.writeWorkspaceFile'
        ];
        await expect(tool.execute({ context: { content: 'x', path: '/src' } })).rejects.toThrow(
          /is a directory/i
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('writes to the folder named by `root` in a multi-root workspace', async () => {
      const rootA = await createWorkspaceFixture();
      const rootB = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({
          workspaceRoots: [
            { displayName: 'ProjectA', path: rootA, rootId: 'id-a' },
            { displayName: 'ProjectB', path: rootB, rootId: 'id-b' },
          ],
        } as unknown as RuntimeData)['brainstrike.writeWorkspaceFile'];

        const result = await tool.execute({
          context: { content: 'into B', path: '/note.txt', root: 'ProjectB' },
        });

        expect(result.rootName).toBe('ProjectB');
        expect(await fsPromises.readFile(path.join(rootB, 'note.txt'), 'utf8')).toBe('into B');
        await expect(fsPromises.access(path.join(rootA, 'note.txt'))).rejects.toThrow();
      } finally {
        await fsPromises.rm(rootA, { force: true, recursive: true });
        await fsPromises.rm(rootB, { force: true, recursive: true });
      }
    });

    it('fails explicitly when no workspace folder is open', async () => {
      const tool = buildDesktopAssistantTools(undefined)['brainstrike.writeWorkspaceFile'];
      await expect(tool.execute({ context: { content: 'x', path: '/x.txt' } })).rejects.toThrow(
        /No folder is open/i
      );
    });
  });

  describe('stringReplaceWorkspaceFile', () => {
    it('surfaces a typed create-file recovery when the target does not exist', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        await expect(
          tool.execute({
            context: {
              newStr: '<main>Created</main>',
              oldStr: '<main>Missing</main>',
              path: '/index.html',
            },
          })
        ).rejects.toMatchObject<ToolInputError>({
          code: 'tool_input_invalid',
          message: expect.stringMatching(/writeWorkspaceFile.*create/i),
        });
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('applies an exact match and leaves the rest of the file intact', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        const result = await tool.execute({
          context: {
            newStr: 'export const add = () => 2;',
            oldStr: 'export const add = () => 1;',
            path: '/src/lib/math.ts',
          },
        });

        expect(result.replaced).toBe(true);
        expect(result.path).toBe('/src/lib/math.ts');
        expect(result.matchType).toBe('exact');
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
          'utf8'
        );
        expect(onDisk).toBe('export const add = () => 2;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('applies a whitespace-normalized match when only indentation differs', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'ws.ts');
      // Tab indentation + extra inner spaces in the file.
      await fsPromises.writeFile(filePath, 'function f() {\n\treturn   1 ;\n}\n', 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        const result = await tool.execute({
          context: {
            newStr: '  return 2;',
            oldStr: 'return 1 ;',
            path: '/src/ws.ts',
          },
        });

        expect(result.matchType).toBe('whitespace-normalized');
        const onDisk = await fsPromises.readFile(filePath, 'utf8');
        expect(onDisk).toContain('return 2;');
        expect(onDisk).not.toContain('return   1');
        expect(onDisk.startsWith('function f() {')).toBe(true);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('applies a close (Levenshtein-fuzzy) multi-line match', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'cfg.ts');
      await fsPromises.writeFile(
        filePath,
        'const config = {\n  enabled: true,\n  retries: 3,\n};\n',
        'utf8'
      );
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        await tool.execute({
          context: {
            newStr: 'const config = {\n  enabled: false,\n  retries: 5,\n};',
            oldStr: 'const config = {\n  enabled: true,\n  retries: 3,\n};',
            path: '/src/cfg.ts',
          },
        });

        const onDisk = await fsPromises.readFile(filePath, 'utf8');
        expect(onDisk).toContain('enabled: false');
        expect(onDisk).toContain('retries: 5');
        expect(onDisk).not.toContain('retries: 3');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('THROWS on an ambiguous single-line oldStr and writes NOTHING', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'dup.ts');
      const original = 'count++;\ndoThing();\ncount++;\ndoOther();\ncount++;\n';
      await fsPromises.writeFile(filePath, original, 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        await expect(
          tool.execute({
            context: { newStr: 'count--;', oldStr: 'count++;', path: '/src/dup.ts' },
          })
        ).rejects.toThrow(/locations|matches|surrounding/i);
        // The file is untouched — no partial / wrong-location edit.
        expect(await fsPromises.readFile(filePath, 'utf8')).toBe(original);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('THROWS on a MULTI-LINE duplicate block and rewrites NOTHING (over-broad-edit fix)', async () => {
      // Regression for the reviewer-found over-broad edit: a multi-line oldStr
      // matching N>1 locations previously rewrote EVERY block (replace-all). It
      // must now be refused, leaving the whole file byte-identical.
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'dupblock.ts');
      const block = 'if (cfg) {\n  enable();\n}';
      const original = `${block}\nmiddle();\n${block}\ntail();\n`;
      await fsPromises.writeFile(filePath, original, 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        await expect(
          tool.execute({
            context: { newStr: 'disable();', oldStr: block, path: '/src/dupblock.ts' },
          })
        ).rejects.toThrow(/2 locations|surrounding/i);
        // BOTH blocks intact — nothing was replace-all'd.
        expect(await fsPromises.readFile(filePath, 'utf8')).toBe(original);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('THROWS when oldStr is not found and writes NOTHING', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      const original = await fsPromises.readFile(filePath, 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        await expect(
          tool.execute({
            context: {
              newStr: 'x',
              oldStr: 'this string is absolutely nowhere in the file content',
              path: '/src/lib/math.ts',
            },
          })
        ).rejects.toThrow(/no sufficiently close match|not\s|Re-read/i);
        expect(await fsPromises.readFile(filePath, 'utf8')).toBe(original);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('serializes two concurrent edits to the SAME file (both apply, no lost update)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      // Two distinct, non-overlapping lines so both edits target different blocks.
      await fsPromises.writeFile(filePath, 'const a = 1;\nconst b = 2;\n', 'utf8');
      try {
        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        // Fire both at once; the per-file lock must serialize their
        // read-modify-write cycles so neither clobbers the other's edit.
        const [r1, r2] = await Promise.all([
          tool.execute({
            context: { newStr: 'const a = 10;', oldStr: 'const a = 1;', path: '/src/lib/math.ts' },
          }),
          tool.execute({
            context: { newStr: 'const b = 20;', oldStr: 'const b = 2;', path: '/src/lib/math.ts' },
          }),
        ]);

        expect(r1.replaced).toBe(true);
        expect(r2.replaced).toBe(true);
        // BOTH edits landed — a lost update would leave one original line.
        const onDisk = await fsPromises.readFile(filePath, 'utf8');
        expect(onDisk).toBe('const a = 10;\nconst b = 20;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('inherits the symlink-leaf write rejection (cannot escape via the write-back)', async () => {
      // Reuse of PR-2.1's symlink-leaf protection through the SHARED safe write:
      // a leaf symlink pointing outside the root must be refused, so the edited
      // bytes never escape. (Proves stringReplace uses the same audited write
      // path — not a weaker copy.)
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-sr-ll-'));
      const outsideTarget = path.join(outsideRoot, 'pwned.txt');
      const leafLink = path.join(workspaceRootPath, 'src', 'evil.ts');
      await fsPromises.writeFile(outsideTarget, 'original\n', 'utf8');
      try {
        try {
          await fsPromises.symlink(outsideTarget, leafLink, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tool = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData)[
          'brainstrike.stringReplaceWorkspaceFile'
        ];

        // The read side resolves the symlink and reads the outside file's content;
        // the write-back must then REFUSE the symlink leaf. Either way no bytes
        // escape through the link.
        await expect(
          tool.execute({
            context: { newStr: 'PWNED', oldStr: 'original', path: '/src/evil.ts' },
          })
        ).rejects.toThrow(/outside the selected workspace root/i);
        // The outside file was NOT modified through the symlink.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('original\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('fails explicitly when no workspace folder is open', async () => {
      const tool = buildDesktopAssistantTools(undefined)['brainstrike.stringReplaceWorkspaceFile'];
      await expect(
        tool.execute({ context: { newStr: 'b', oldStr: 'a', path: '/x.ts' } })
      ).rejects.toThrow(/No folder is open/i);
    });
  });

  describe('read-before-write staleness guard', () => {
    const guardRuntime = (workspaceRootPath: string): RuntimeData =>
      ({
        memory: { resourceId: 'guard-resource', runId: 'guard-run', threadId: 'guard-thread' },
        workspaceRootPath,
      }) as RuntimeData;

    /** Simulate a USER edit outside the assistant tools: new bytes + a forced
     * future mtime so the compare never false-passes on coarse-mtime volumes. */
    async function externallyEdit(absolutePath: string, content: string): Promise<void> {
      await fsPromises.writeFile(absolutePath, content, 'utf8');
      const future = new Date(Date.now() + 5000);
      await fsPromises.utimes(absolutePath, future, future);
    }

    beforeEach(() => {
      resetFileReadState();
    });

    it('write refuses when the file changed on disk after the assistant read it', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/README.md' },
        });

        await externallyEdit(path.join(workspaceRootPath, 'README.md'), '# User edit\n');

        await expect(
          tools['brainstrike.writeWorkspaceFile'].execute({
            context: { content: '# Agent overwrite\n', path: '/README.md' },
          })
        ).rejects.toThrow(/changed on disk since/i);
        // The user's edit survived — nothing was overwritten.
        const onDisk = await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8');
        expect(onDisk).toBe('# User edit\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('a rejected stale continuation does not refresh the write guard', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        const first = await tools['brainstrike.readWorkspaceFile'].execute({
          context: { maxChars: 20, path: '/README.md' },
        });
        expect(first.nextCursor).toEqual(expect.any(String));

        await externallyEdit(path.join(workspaceRootPath, 'README.md'), '# User edit\n');

        await expect(
          tools['brainstrike.readWorkspaceFile'].execute({
            context: {
              cursor: first.nextCursor,
              maxChars: 20,
            },
          })
        ).rejects.toThrow(/continuation handle is stale/i);

        await expect(
          tools['brainstrike.writeWorkspaceFile'].execute({
            context: { content: '# Agent overwrite\n', path: '/README.md' },
          })
        ).rejects.toThrow(/changed on disk since/i);
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8')).toBe(
          '# User edit\n'
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('stringReplace refuses when the file changed on disk after the assistant read it', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/src/lib/math.ts' },
        });

        await externallyEdit(
          path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
          'export const add = () => 2;\n'
        );

        await expect(
          tools['brainstrike.stringReplaceWorkspaceFile'].execute({
            context: {
              newStr: 'export const add = () => 3;',
              oldStr: 'export const add = () => 2;',
              path: '/src/lib/math.ts',
            },
          })
        ).rejects.toThrow(/changed on disk since/i);
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
          'utf8'
        );
        expect(onDisk).toBe('export const add = () => 2;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('write proceeds when unchanged since read, and consecutive writes stay allowed', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/README.md' },
        });

        const first = await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: '# First\n', path: '/README.md' },
        });
        expect(first.created).toBe(false);

        // A successful write refreshes the known state — no self-staleness.
        const second = await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: '# Second\n', path: '/README.md' },
        });
        expect(second.created).toBe(false);
        const onDisk = await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8');
        expect(onDisk).toBe('# Second\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('still allows overwriting a file this scope never observed (compare-only contract)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        const result = await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: '# Never read first\n', path: '/README.md' },
        });
        expect(result.created).toBe(false);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('a successful write establishes known state that a later external edit invalidates', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: 'const value = 1;\n', path: '/src/state.ts' },
        });

        await externallyEdit(path.join(workspaceRootPath, 'src', 'state.ts'), 'const value = 2;\n');

        await expect(
          tools['brainstrike.stringReplaceWorkspaceFile'].execute({
            context: {
              newStr: 'const value = 3;',
              oldStr: 'const value = 2;',
              path: '/src/state.ts',
            },
          })
        ).rejects.toThrow(/changed on disk since/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rename refuses when the source changed on disk after the assistant read it', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/src/lib/math.ts' },
        });

        await externallyEdit(
          path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
          'export const add = () => 99;\n'
        );

        await expect(
          tools['brainstrike.renameWorkspaceFile'].execute({
            context: { fromPath: '/src/lib/math.ts', toPath: '/src/lib/sum.ts' },
          })
        ).rejects.toThrow(/changed on disk since/i);
        // The move did not happen.
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'src', 'lib', 'sum.ts'))
        ).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('serializes the read-and-record under the same per-file lock as writes', async () => {
      // The tracker record must be ordered against same-file writes: an
      // unlocked read could stat OLD mtime, lose the race to a locked write
      // (which records the fresh post-write mtime), then clobber the tracker
      // back to the stale value — making the NEXT legitimate write falsely
      // refuse. Proof: while the file's write lock is held, the read tool must
      // not complete.
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        const canonicalPath = realpathSync(path.join(workspaceRootPath, 'README.md'));

        let releaseLock: () => void = () => {
          throw new Error('release not armed');
        };
        const holdLock = withFileLock(
          canonicalPath,
          () =>
            new Promise<void>((resolve) => {
              releaseLock = resolve;
            })
        );

        let readSettled = false;
        const readPromise = tools['brainstrike.readWorkspaceFile']
          .execute({ context: { path: '/README.md' } })
          .finally(() => {
            readSettled = true;
          });

        // Give the (mis-ordered) read every chance to complete outside the lock.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(readSettled).toBe(false);

        releaseLock();
        await holdLock;
        await readPromise;
        expect(readSettled).toBe(true);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('guards a rename whose SYMLINK source target changed since the read', async () => {
      // Reads record under the realpath'd TARGET; rename mutates the LINK
      // path. The compare must use the matching identity or a read-then-
      // externally-modified symlinked source silently skips the guard.
      const workspaceRootPath = await createWorkspaceFixture();
      const targetPath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      const linkPath = path.join(workspaceRootPath, 'src', 'alias.ts');
      try {
        try {
          await fsPromises.symlink(targetPath, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/src/alias.ts' },
        });

        await externallyEdit(targetPath, 'export const add = () => 42;\n');

        await expect(
          tools['brainstrike.renameWorkspaceFile'].execute({
            context: { fromPath: '/src/alias.ts', toPath: '/src/alias-moved.ts' },
          })
        ).rejects.toThrow(/changed on disk since/i);
        // The link did not move.
        await expect(
          fsPromises.lstat(path.join(workspaceRootPath, 'src', 'alias-moved.ts'))
        ).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('renames a read-but-unchanged symlink source without refusal', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const targetPath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      const linkPath = path.join(workspaceRootPath, 'src', 'alias.ts');
      try {
        try {
          await fsPromises.symlink(targetPath, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }

        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/src/alias.ts' },
        });

        const result = await tools['brainstrike.renameWorkspaceFile'].execute({
          context: { fromPath: '/src/alias.ts', toPath: '/src/alias-moved.ts' },
        });
        expect(result.ok).toBe(true);
        const moved = await fsPromises.lstat(path.join(workspaceRootPath, 'src', 'alias-moved.ts'));
        expect(moved.isSymbolicLink()).toBe(true);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('re-reading the file clears the refusal (documented recovery path)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildDesktopAssistantTools(guardRuntime(workspaceRootPath));
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/README.md' },
        });
        await externallyEdit(path.join(workspaceRootPath, 'README.md'), '# User edit\n');

        await expect(
          tools['brainstrike.writeWorkspaceFile'].execute({
            context: { content: '# Agent v1\n', path: '/README.md' },
          })
        ).rejects.toThrow(/changed on disk since/i);

        // The actionable error tells the model to re-read; doing so recovers.
        await tools['brainstrike.readWorkspaceFile'].execute({
          context: { path: '/README.md' },
        });
        const result = await tools['brainstrike.writeWorkspaceFile'].execute({
          context: { content: '# Agent v2\n', path: '/README.md' },
        });
        expect(result.created).toBe(false);
        const onDisk = await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8');
        expect(onDisk).toBe('# Agent v2\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });
  });
});
