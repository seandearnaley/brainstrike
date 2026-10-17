import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import type { ToolInputError } from '@brainstrike/assistant-contract';
import {
  EDIT_FAILURE_HINT_MESSAGE,
  resetToolCallLoopGuards,
} from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeLspServers } from '../../assistant-server/lsp-diagnostics';
import { buildHostNativeTools } from './_host-native-tools';
import { requireToolExecute, singleRootRuntime } from './_tool-test-helpers';
import { createWorkspaceFixture } from './_workspace-fixture';

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
  };
});

const { getAllWindowsMock, loggerErrorMock, loggerWarnMock } = vi.hoisted(() => ({
  getAllWindowsMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
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

// Split from assistant-tools.integration.test.ts (BST-976): one suite per
// service seam; the vi.mock preamble is repeated because hoisting is per file.
describe('assistant-tools write tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetToolCallLoopGuards();
  });

  describe('writeWorkspaceFile', () => {
    it('creates a new file (created: true) with the right content and byte count', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        const result = await executeTool({
          content: 'export const created = true;\n',
          path: '/src/new-file.ts',
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
        await disposeLspServers();
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('creates missing parent directories', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        const result = await executeTool({ content: 'hello', path: '/deeply/nested/dir/file.txt' });

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
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        const result = await executeTool({ content: '# Overwritten\n', path: '/README.md' });

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
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        // "../" is clamped at the root by normalizeWorkspacePath, so this normalizes
        // to "/escaped.txt" INSIDE the root — it must NOT land in the sibling dir.
        await executeTool({ content: 'nope', path: '../escaped.txt' });

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

        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        await expect(
          executeTool({ content: 'escape', path: '/src/linked/pwned.txt' })
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

        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        await expect(executeTool({ content: 'PWNED', path: '/src/evil.txt' })).rejects.toThrow(
          'is outside the selected workspace root'
        );
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

        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        await expect(executeTool({ content: 'PWNED', path: '/src/evil.txt' })).rejects.toThrow(
          'is outside the selected workspace root'
        );
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

        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        await expect(
          executeTool({ content: 'PWNED', path: '/src/linkdir/pwned.txt' })
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
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
        // 2 MB + 1 byte exceeds MAX_WRITE_WORKSPACE_FILE_BYTES.
        const oversized = 'a'.repeat(2_000_001);
        await expect(executeTool({ content: oversized, path: '/big.txt' })).rejects.toThrow(
          /exceeding the .* byte write limit/i
        );
        // No partial/empty file was created.
        await expect(fsPromises.access(path.join(workspaceRootPath, 'big.txt'))).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects gutter-prefixed display content and writes nothing', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'guttered.ts');
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');

        await expect(
          executeTool({
            content: '10: import x\n11: const value = x;\n12: export default value;\n',
            path: '/guttered.ts',
          })
        ).rejects.toMatchObject({
          code: 'tool_input_invalid',
          message: expect.stringMatching(/line-number gutters.*N: /i),
        } satisfies Partial<ToolInputError>);
        await expect(fsPromises.access(filePath)).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects writing to the workspace root itself', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
        await expect(executeTool({ content: 'x', path: '/' })).rejects.toThrow(/workspace root/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects overwriting a directory with file content', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
        await expect(executeTool({ content: 'x', path: '/src' })).rejects.toThrow(
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
        const executeTool = requireToolExecute(
          buildHostNativeTools({
            workspaceRoots: [
              { displayName: 'ProjectA', path: rootA, rootId: 'id-a' },
              { displayName: 'ProjectB', path: rootB, rootId: 'id-b' },
            ],
          } as unknown as RuntimeData),
          'brainstrike.writeWorkspaceFile'
        );

        const result = await executeTool({
          content: 'into B',
          path: '/note.txt',
          root: 'ProjectB',
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
      const executeTool = requireToolExecute(
        buildHostNativeTools({ workspaceRoots: [] } as unknown as RuntimeData),
        'brainstrike.writeWorkspaceFile'
      );
      await expect(executeTool({ content: 'x', path: '/x.txt' })).rejects.toThrow(
        /No folder is open/i
      );
    });
  });

  describe('stringReplaceWorkspaceFile', () => {
    it('surfaces a typed create-file recovery when the target does not exist', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

        await expect(
          executeTool({
            newStr: '<main>Created</main>',
            oldStr: '<main>Missing</main>',
            path: '/index.html',
          })
        ).rejects.toMatchObject({
          code: 'tool_input_invalid',
          message: expect.stringMatching(/writeWorkspaceFile.*create/i),
        } satisfies Partial<ToolInputError>);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('applies an exact match and leaves the rest of the file intact', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

        const result = await executeTool({
          newStr: 'export const add = () => 2;',
          oldStr: 'export const add = () => 1;',
          path: '/src/lib/math.ts',
        });

        expect(result.replaced).toBe(true);
        expect(result.path).toBe('/src/lib/math.ts');
        expect(result.matchType).toBe('exact');
        // The written range the context map draws as an edit (BST-2015).
        expect(result.editedLines).toEqual({ endLine: 1, startLine: 1 });
        const onDisk = await fsPromises.readFile(
          path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
          'utf8'
        );
        expect(onDisk).toBe('export const add = () => 2;\n');
      } finally {
        await disposeLspServers();
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('applies a whitespace-normalized match when only indentation differs', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'ws.ts');
      // Tab indentation + extra inner spaces in the file.
      await fsPromises.writeFile(filePath, 'function f() {\n\treturn   1 ;\n}\n', 'utf8');
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

        const result = await executeTool({
          newStr: '  return 2;',
          oldStr: 'return 1 ;',
          path: '/src/ws.ts',
        });

        expect(result.matchType).toBe('whitespace-normalized');
        const onDisk = await fsPromises.readFile(filePath, 'utf8');
        expect(onDisk).toContain('return 2;');
        expect(onDisk).not.toContain('return   1');
        expect(onDisk.startsWith('function f() {')).toBe(true);
      } finally {
        await disposeLspServers();
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
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

        await executeTool({
          newStr: 'const config = {\n  enabled: false,\n  retries: 5,\n};',
          oldStr: 'const config = {\n  enabled: true,\n  retries: 3,\n};',
          path: '/src/cfg.ts',
        });

        const onDisk = await fsPromises.readFile(filePath, 'utf8');
        expect(onDisk).toContain('enabled: false');
        expect(onDisk).toContain('retries: 5');
        expect(onDisk).not.toContain('retries: 3');
      } finally {
        await disposeLspServers();
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('THROWS on an ambiguous single-line oldStr and writes NOTHING', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const filePath = path.join(workspaceRootPath, 'src', 'dup.ts');
      const original = 'count++;\ndoThing();\ncount++;\ndoOther();\ncount++;\n';
      await fsPromises.writeFile(filePath, original, 'utf8');
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

        await expect(
          executeTool({ newStr: 'count--;', oldStr: 'count++;', path: '/src/dup.ts' })
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
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

        await expect(
          executeTool({ newStr: 'disable();', oldStr: block, path: '/src/dupblock.ts' })
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
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

        await expect(
          executeTool({
            newStr: 'x',
            oldStr: 'this string is absolutely nowhere in the file content',
            path: '/src/lib/math.ts',
          })
        ).rejects.toThrow(/no sufficiently close match|not\s|Re-read/i);
        expect(await fsPromises.readFile(filePath, 'utf8')).toBe(original);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects gutter-prefixed newStr without advancing the edit-failure streak', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');
        const path = '/src/lib/math.ts';

        await expect(
          executeTool({
            newStr: '10: import x\n11: const value = x;\n12: export default value;',
            oldStr: 'export const add = () => 1;',
            path,
          })
        ).rejects.toMatchObject({
          code: 'tool_input_invalid',
          message: expect.stringMatching(/line-number gutters.*N: /i),
        } satisfies Partial<ToolInputError>);

        const runRealFailure = async (): Promise<unknown> =>
          executeTool({
            newStr: 'export const add = () => 2;',
            oldStr: 'this string is absolutely nowhere in the file content',
            path,
          }).catch((error: unknown) => error);

        const firstRealFailure = await runRealFailure();
        expect(firstRealFailure).toBeInstanceOf(Error);
        expect((firstRealFailure as Error).message).not.toContain(EDIT_FAILURE_HINT_MESSAGE);

        const secondRealFailure = await runRealFailure();
        expect(secondRealFailure).toBeInstanceOf(Error);
        expect((secondRealFailure as Error).message).not.toContain(EDIT_FAILURE_HINT_MESSAGE);
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
        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

        // Fire both at once; the per-file lock must serialize their
        // read-modify-write cycles so neither clobbers the other's edit.
        const [r1, r2] = await Promise.all([
          executeTool({
            newStr: 'const a = 10;',
            oldStr: 'const a = 1;',
            path: '/src/lib/math.ts',
          }),
          executeTool({
            newStr: 'const b = 20;',
            oldStr: 'const b = 2;',
            path: '/src/lib/math.ts',
          }),
        ]);

        expect(r1.replaced).toBe(true);
        expect(r2.replaced).toBe(true);
        // BOTH edits landed — a lost update would leave one original line.
        const onDisk = await fsPromises.readFile(filePath, 'utf8');
        expect(onDisk).toBe('const a = 10;\nconst b = 20;\n');
      } finally {
        await disposeLspServers();
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

        const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
        const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');

        // The read side resolves the symlink and reads the outside file's content;
        // the write-back must then REFUSE the symlink leaf. Either way no bytes
        // escape through the link.
        await expect(
          executeTool({ newStr: 'PWNED', oldStr: 'original', path: '/src/evil.ts' })
        ).rejects.toThrow(/outside the selected workspace root/i);
        // The outside file was NOT modified through the symlink.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('original\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('fails explicitly when no workspace folder is open', async () => {
      const executeTool = requireToolExecute(
        buildHostNativeTools({ workspaceRoots: [] } as unknown as RuntimeData),
        'brainstrike.stringReplaceWorkspaceFile'
      );
      await expect(executeTool({ newStr: 'b', oldStr: 'a', path: '/x.ts' })).rejects.toThrow(
        /No folder is open/i
      );
    });
  });
});
