import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { type RuntimeData, resetFileReadState, withFileLock } from '@brainstrike/agent';
import { resetToolCallLoopGuards } from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeLspServers } from '../../assistant-server/lsp-diagnostics';
import { buildHostNativeTools } from './_host-native-tools';
import { requireToolExecute, singleRootRuntime } from './_tool-test-helpers';
import { createWorkspaceFixture } from './_workspace-fixture';

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    withFileLock: vi.fn(actual.withFileLock),
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

// Split from assistant-tools-write.integration.test.ts (BST-1202): the
// read-before-write staleness guard suite moved to its own file to stay
// under the noExcessiveLinesPerFile cap; the vi.mock preamble is repeated
// because hoisting is per file.
describe('read-before-write staleness guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetToolCallLoopGuards();
  });

  const guardRuntime = (workspaceRootPath: string): RuntimeData =>
    ({
      ...singleRootRuntime(workspaceRootPath),
      memory: { resourceId: 'guard-resource', runId: 'guard-run', threadId: 'guard-thread' },
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

  it('keeps sibling native execution read observations separate in one shared tool registry', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    const file = path.join(workspaceRootPath, 'README.md');
    try {
      await promisify(execFile)('git', ['init', '--quiet', workspaceRootPath]);
      await fsPromises.utimes(file, new Date(1000), new Date(1000));
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const read = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const write = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      const cedar = { threadId: 'child-cedar', toolCallId: 'cedar-edit' };
      const flint = { threadId: 'child-flint', toolCallId: 'flint-edit' };
      await read({ path: '/README.md' }, cedar);
      await read({ path: '/README.md' }, flint);
      await write({ content: '# Cedar\n', path: '/README.md' }, cedar);
      await expect(write({ content: '# Flint\n', path: '/README.md' }, flint)).rejects.toThrow(
        /changed on disk since/i
      );
      expect(await fsPromises.readFile(file, 'utf8')).toBe('# Cedar\n');
      await read({ path: '/README.md' }, flint);
      await write({ content: '# Flint after reread\n', path: '/README.md' }, flint);
      expect(await fsPromises.readFile(file, 'utf8')).toBe('# Flint after reread\n');
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('preserves dirty user files and disjoint child edits in a real shared repository', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    try {
      const git = (args: string[]) =>
        promisify(execFile)('git', ['-C', workspaceRootPath, ...args]);
      await git(['init', '--quiet']);
      await git(['add', '.']);
      await git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'baseline',
      ]);
      await fsPromises.writeFile(path.join(workspaceRootPath, 'README.md'), '# User draft\n');
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const read = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const write = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      const cedar = { threadId: 'child-cedar', toolCallId: 'cedar-edit' };
      const flint = { threadId: 'child-flint', toolCallId: 'flint-edit' };
      await read({ path: '/src/main.ts' }, cedar);
      await read({ path: '/src/lib/math.ts' }, flint);
      await Promise.all([
        write({ content: '// Cedar\n', path: '/src/main.ts' }, cedar),
        write({ content: '// Flint\n', path: '/src/lib/math.ts' }, flint),
      ]);
      expect(await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8')).toBe(
        '# User draft\n'
      );
      expect(await fsPromises.readFile(path.join(workspaceRootPath, 'src/main.ts'), 'utf8')).toBe(
        '// Cedar\n'
      );
      expect(
        await fsPromises.readFile(path.join(workspaceRootPath, 'src/lib/math.ts'), 'utf8')
      ).toBe('// Flint\n');
      expect((await git(['status', '--porcelain'])).stdout.trim().split('\n')).toHaveLength(3);
      expect((await git(['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('1');
    } finally {
      await disposeLspServers();
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it.each([
    ['writeWorkspaceFile', { content: 'Late effect', path: '/README.md' }],
    [
      'stringReplaceWorkspaceFile',
      { newStr: 'Late effect', oldStr: 'Completed child effect', path: '/README.md' },
    ],
    ['deleteWorkspaceFile', { path: '/README.md' }],
    ['renameWorkspaceFile', { fromPath: '/README.md', toPath: '/new-parent/moved.md' }],
  ] as const)(
    'stopping a child prevents a queued %s while preserving completed work',
    async (name, input) => {
      const workspaceRootPath = await createWorkspaceFixture();
      const release = Promise.withResolvers<void>();
      let holding: Promise<void> | undefined;
      let mutation: Promise<unknown> | undefined;
      try {
        const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
        const write = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
        await write(
          { content: 'Completed child effect', path: '/README.md' },
          { threadId: 'child-stopped', toolCallId: 'completed-write' }
        );
        const canonicalPath = realpathSync(path.join(workspaceRootPath, 'README.md'));
        vi.mocked(withFileLock).mockClear();
        holding = withFileLock(canonicalPath, () => release.promise);
        const controller = new AbortController();
        mutation = Promise.resolve(
          requireToolExecute(tools, `brainstrike.${name}`)(input, {
            abortSignal: controller.signal,
            threadId: 'child-stopped',
            toolCallId: 'queued-mutation',
          })
        );
        // Observe admission to the real path lock before stopping the child.
        await vi.waitFor(() =>
          expect(
            vi.mocked(withFileLock).mock.calls.filter(([key]) => key === canonicalPath)
          ).toHaveLength(2)
        );
        controller.abort(new Error('Selected child stopped'));
        const rejected = expect(mutation).rejects.toThrow('Selected child stopped');
        release.resolve();
        await rejected;
        expect(await fsPromises.readFile(canonicalPath, 'utf8')).toBe('Completed child effect');
        await expect(
          fsPromises.stat(path.join(workspaceRootPath, 'new-parent'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await write(
          { content: 'Sibling still active', path: '/sibling.txt' },
          { threadId: 'child-sibling', toolCallId: 'sibling-write' }
        );
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'sibling.txt'), 'utf8')).toBe(
          'Sibling still active'
        );
      } finally {
        release.resolve();
        await Promise.allSettled([holding, mutation]);
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    }
  );

  it('keeps the child on its bound non-Git root and refuses a disconnected root instead of switching folders', async () => {
    const firstRoot = await createWorkspaceFixture();
    const focusedRoot = await createWorkspaceFixture();
    try {
      const roots = [
        { displayName: 'Bound', path: firstRoot, rootId: 'bound-root' },
        { displayName: 'Focused', path: focusedRoot, rootId: 'focused-root' },
      ];
      const runtime = {
        ...guardRuntime(firstRoot),
        boundWorkspaceRootId: 'bound-root',
        workspaceRootPath: focusedRoot,
        workspaceRoots: roots,
      };
      const tools = buildHostNativeTools(runtime);
      const execution = { threadId: 'child-bound', toolCallId: 'bound-write' };
      const command = { command: process.platform === 'win32' ? 'cd' : 'pwd' };
      const shell = await requireToolExecute<{ cwd: string; rootId: string; exitCode: number }>(
        tools,
        'brainstrike.executeCommand'
      )(command, execution);
      expect(shell).toMatchObject({
        cwd: await fsPromises.realpath(firstRoot),
        exitCode: 0,
        rootId: 'bound-root',
      });

      await requireToolExecute(tools, 'brainstrike.writeWorkspaceFile')(
        { content: 'Bound child effect', path: '/child.txt' },
        execution
      );
      expect(await fsPromises.readFile(path.join(firstRoot, 'child.txt'), 'utf8')).toBe(
        'Bound child effect'
      );
      await expect(
        fsPromises.readFile(path.join(focusedRoot, 'child.txt'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const disconnected = buildHostNativeTools({
        ...runtime,
        workspaceRoots: roots.filter((root) => root.rootId !== 'bound-root'),
      });
      await expect(
        requireToolExecute(disconnected, 'brainstrike.executeCommand')(command, execution)
      ).rejects.toThrow(/bound workspace root.*no longer open/i);
      await expect(
        requireToolExecute(disconnected, 'brainstrike.writeWorkspaceFile')(
          { content: 'Must not switch roots', path: '/other.txt' },
          execution
        )
      ).rejects.toThrow(/bound workspace root.*no longer open/i);
      await expect(
        fsPromises.readFile(path.join(focusedRoot, 'other.txt'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fsPromises.readFile(path.join(firstRoot, 'child.txt'), 'utf8')).toBe(
        'Bound child effect'
      );
    } finally {
      await fsPromises.rm(firstRoot, { force: true, recursive: true });
      await fsPromises.rm(focusedRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ['brainstrike.writeWorkspaceFile', { content: 'stopped', path: '/README.md' }],
    [
      'brainstrike.stringReplaceWorkspaceFile',
      { newStr: 'stopped', oldStr: 'before', path: '/README.md' },
    ],
    ['brainstrike.deleteWorkspaceFile', { path: '/README.md' }],
    ['brainstrike.renameWorkspaceFile', { fromPath: '/README.md', toPath: '/renamed.md' }],
  ])('refuses an already stopped %s before acquiring a path lock', async (toolId, input) => {
    const workspaceRootPath = await createWorkspaceFixture();
    const controller = new AbortController();
    const reason = new Error('Selected child already stopped');
    controller.abort(reason);
    const lock = vi.mocked(withFileLock);
    lock.mockClear();
    try {
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      await expect(
        requireToolExecute(tools, toolId)(input, {
          abortSignal: controller.signal,
          threadId: 'child-cedar',
          toolCallId: 'stopped-write',
        })
      ).rejects.toBe(reason);
      expect(lock).not.toHaveBeenCalled();
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('rejects forged thread-ownership keys on a delegated native write and writes nothing', async () => {
    // The live half of the legacy attribution case below: the shared input
    // schema refuses ownership smuggled through tool input. Attribution itself
    // is Core's (each dispatched call carries its own edit tracker).
    const workspaceRootPath = await createWorkspaceFixture();
    try {
      const execute = requireToolExecute(
        buildHostNativeTools(guardRuntime(workspaceRootPath)),
        'brainstrike.writeWorkspaceFile'
      );
      await expect(
        execute(
          {
            agent: { threadId: 'forged-child' },
            content: 'Forged ownership',
            path: '/cedar.txt',
            threadId: 'forged-child',
          },
          { threadId: 'child-cedar', toolCallId: 'cedar-write' }
        )
      ).rejects.toThrow(
        /agent: Expected no excess property; threadId: Expected no excess property/
      );
      await expect(
        fsPromises.stat(path.join(workspaceRootPath, 'cedar.txt'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('write refuses when the file changed on disk after the assistant read it', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    try {
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const executeWriteTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      await executeReadTool({ path: '/README.md' });

      await externallyEdit(path.join(workspaceRootPath, 'README.md'), '# User edit\n');

      await expect(
        executeWriteTool({ content: '# Agent overwrite\n', path: '/README.md' })
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
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const executeWriteTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      const first = await executeReadTool({ maxChars: 20, path: '/README.md' });
      expect(first.nextCursor).toEqual(expect.any(String));

      await externallyEdit(path.join(workspaceRootPath, 'README.md'), '# User edit\n');

      await expect(
        executeReadTool({
          cursor: first.nextCursor,
          maxChars: 20,
        })
      ).rejects.toThrow(/continuation handle is stale/i);

      await expect(
        executeWriteTool({ content: '# Agent overwrite\n', path: '/README.md' })
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
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const executeReplaceTool = requireToolExecute(
        tools,
        'brainstrike.stringReplaceWorkspaceFile'
      );
      await executeReadTool({ path: '/src/lib/math.ts' });

      await externallyEdit(
        path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
        'export const add = () => 2;\n'
      );

      await expect(
        executeReplaceTool({
          newStr: 'export const add = () => 3;',
          oldStr: 'export const add = () => 2;',
          path: '/src/lib/math.ts',
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
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const executeWriteTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      await executeReadTool({ path: '/README.md' });

      const first = await executeWriteTool({ content: '# First\n', path: '/README.md' });
      expect(first.created).toBe(false);

      // A successful write refreshes the known state — no self-staleness.
      const second = await executeWriteTool({ content: '# Second\n', path: '/README.md' });
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
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeWriteTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      const result = await executeWriteTool({
        content: '# Never read first\n',
        path: '/README.md',
      });
      expect(result.created).toBe(false);
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('a successful write establishes known state that a later external edit invalidates', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    try {
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeWriteTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      const executeReplaceTool = requireToolExecute(
        tools,
        'brainstrike.stringReplaceWorkspaceFile'
      );
      await executeWriteTool({ content: 'const value = 1;\n', path: '/src/state.ts' });

      await externallyEdit(path.join(workspaceRootPath, 'src', 'state.ts'), 'const value = 2;\n');

      await expect(
        executeReplaceTool({
          newStr: 'const value = 3;',
          oldStr: 'const value = 2;',
          path: '/src/state.ts',
        })
      ).rejects.toThrow(/changed on disk since/i);
    } finally {
      await disposeLspServers();
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('rename refuses when the source changed on disk after the assistant read it', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    try {
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const executeRenameTool = requireToolExecute(tools, 'brainstrike.renameWorkspaceFile');
      await executeReadTool({ path: '/src/lib/math.ts' });

      await externallyEdit(
        path.join(workspaceRootPath, 'src', 'lib', 'math.ts'),
        'export const add = () => 99;\n'
      );

      await expect(
        executeRenameTool({ fromPath: '/src/lib/math.ts', toPath: '/src/lib/sum.ts' })
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
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
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
      const readPromise = executeReadTool({ path: '/README.md' }).finally(() => {
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

      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const executeRenameTool = requireToolExecute(tools, 'brainstrike.renameWorkspaceFile');
      await executeReadTool({ path: '/src/alias.ts' });

      await externallyEdit(targetPath, 'export const add = () => 42;\n');

      await expect(
        executeRenameTool({ fromPath: '/src/alias.ts', toPath: '/src/alias-moved.ts' })
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

      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const executeRenameTool = requireToolExecute(tools, 'brainstrike.renameWorkspaceFile');
      await executeReadTool({ path: '/src/alias.ts' });

      const result = await executeRenameTool({
        fromPath: '/src/alias.ts',
        toPath: '/src/alias-moved.ts',
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
      const tools = buildHostNativeTools(guardRuntime(workspaceRootPath));
      const executeReadTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
      const executeWriteTool = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      await executeReadTool({ path: '/README.md' });
      await externallyEdit(path.join(workspaceRootPath, 'README.md'), '# User edit\n');

      await expect(
        executeWriteTool({ content: '# Agent v1\n', path: '/README.md' })
      ).rejects.toThrow(/changed on disk since/i);

      // The actionable error tells the model to re-read; doing so recovers.
      await executeReadTool({ path: '/README.md' });
      const result = await executeWriteTool({ content: '# Agent v2\n', path: '/README.md' });
      expect(result.created).toBe(false);
      const onDisk = await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8');
      expect(onDisk).toBe('# Agent v2\n');
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });
});
