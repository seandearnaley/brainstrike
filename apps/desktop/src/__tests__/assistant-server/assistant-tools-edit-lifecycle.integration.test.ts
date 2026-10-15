import { realpathSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHostNativeTools } from './_host-native-tools';
import { requireToolExecute, singleRootRuntime } from './_tool-test-helpers';
import { createWorkspaceFixture } from './_workspace-fixture';

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
  };
});

const { loggerErrorMock, loggerWarnMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
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

// Split from the 5,101-line assistant-tools.integration.test.ts (BST-976):
// one suite per service seam, sharing the fixture module and repeating the
// vi.mock preamble per file (hoisting is per-importing-module).
describe('assistant-tools edit lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('deleteWorkspaceFile', () => {
    it('deletes an existing file and reports indexInvalidated: false when no workspace index', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.deleteWorkspaceFile'
        );

        const result = await executeTool({ context: { path: '/src/lib/math.ts' } });

        expect(result).toMatchObject({
          indexInvalidated: false,
          ok: true,
          path: '/src/lib/math.ts',
        });
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'src', 'lib', 'math.ts'))
        ).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('throws a not-found error for a missing file', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.deleteWorkspaceFile'
        );
        await expect(executeTool({ context: { path: '/src/does-not-exist.ts' } })).rejects.toThrow(
          /does not exist/i
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to delete a directory (suggests executeCommand)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.deleteWorkspaceFile'
        );
        await expect(executeTool({ context: { path: '/src' } })).rejects.toThrow(
          /is a directory.*executeCommand/is
        );
        // The directory is untouched.
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'src'))
        ).resolves.toBeUndefined();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('clamps a "../" escape to inside the root (deletes the in-root file, never the sibling)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-del-esc-'));
      const outsideFile = path.join(path.dirname(workspaceRootPath), 'escaped.txt');
      const siblingFile = path.join(outsideRoot, 'escaped.txt');
      await fsPromises.writeFile(outsideFile, 'do not delete', 'utf8');
      await fsPromises.writeFile(siblingFile, 'do not delete', 'utf8');
      // The clamped path "/escaped.txt" lives INSIDE the root.
      await fsPromises.writeFile(path.join(workspaceRootPath, 'escaped.txt'), 'in root', 'utf8');
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.deleteWorkspaceFile'
        );
        const result = await executeTool({ context: { path: '../escaped.txt' } });
        // Unrooted input keeps the relative convention; ".." is clamped so it
        // resolves to the in-root file, never the sibling dir.
        expect(result.path).toBe('escaped.txt');
        // The in-root file is gone; the two outside files are untouched.
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'escaped.txt'))
        ).rejects.toThrow();
        expect(await fsPromises.readFile(outsideFile, 'utf8')).toBe('do not delete');
        expect(await fsPromises.readFile(siblingFile, 'utf8')).toBe('do not delete');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
        await fsPromises.rm(outsideFile, { force: true });
      }
    });

    it('rejects deleting through a symlinked directory that escapes the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-del-link-'));
      const outsideTarget = path.join(outsideRoot, 'secret.txt');
      await fsPromises.writeFile(outsideTarget, 'secret', 'utf8');
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
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.deleteWorkspaceFile'
        );
        await expect(executeTool({ context: { path: '/src/linked/secret.txt' } })).rejects.toThrow(
          /outside the selected workspace root/i
        );
        // The outside file was NOT deleted through the symlink.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('secret');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('deletes a SYMLINK to an in-root file: the link is removed, the target is untouched', async () => {
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
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.deleteWorkspaceFile'
        );

        const result = await executeTool({ context: { path: '/src/alias.ts' } });

        expect(result).toMatchObject({ ok: true, path: '/src/alias.ts' });
        // The LINK is gone; the target file it pointed at is intact.
        await expect(fsPromises.lstat(linkPath)).rejects.toThrow();
        expect(await fsPromises.readFile(targetPath, 'utf8')).toBe('export const add = () => 1;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('deletes a DANGLING in-root symlink (just a pointer, target does not exist)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const linkPath = path.join(workspaceRootPath, 'src', 'dangling.ts');
      const missingTarget = path.join(workspaceRootPath, 'src', 'ghost.ts');
      try {
        try {
          await fsPromises.symlink(missingTarget, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.deleteWorkspaceFile'
        );

        const result = await executeTool({ context: { path: '/src/dangling.ts' } });

        expect(result.ok).toBe(true);
        await expect(fsPromises.lstat(linkPath)).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to delete a LIVE symlink leaf whose target is OUTSIDE the root (target untouched)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-del-ll-'));
      const outsideTarget = path.join(outsideRoot, 'secret.txt');
      const linkPath = path.join(workspaceRootPath, 'src', 'out-alias.ts');
      await fsPromises.writeFile(outsideTarget, 'secret', 'utf8');
      try {
        try {
          await fsPromises.symlink(outsideTarget, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.deleteWorkspaceFile'
        );
        await expect(executeTool({ context: { path: '/src/out-alias.ts' } })).rejects.toThrow(
          /outside the selected workspace root/i
        );
        // Neither the link nor the outside target was removed.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('secret');
        await expect(fsPromises.lstat(linkPath)).resolves.toBeDefined();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('fails explicitly when no workspace folder is open', async () => {
      const executeTool = requireToolExecute(
        buildHostNativeTools({ workspaceRoots: [] } as unknown as RuntimeData),
        'brainstrike.deleteWorkspaceFile'
      );
      await expect(executeTool({ context: { path: '/x.ts' } })).rejects.toThrow(
        /No folder is open/i
      );
    });
  });

  describe('renameWorkspaceFile', () => {
    it('renames a file within the root and reports both paths', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );

        const result = await executeTool({
          context: { fromPath: '/src/lib/math.ts', toPath: '/src/lib/arithmetic.ts' },
        });

        expect(result).toMatchObject({
          fromPath: '/src/lib/math.ts',
          indexInvalidated: false,
          ok: true,
          toPath: '/src/lib/arithmetic.ts',
        });
        await expect(
          fsPromises.access(path.join(workspaceRootPath, 'src', 'lib', 'math.ts'))
        ).rejects.toThrow();
        expect(
          await fsPromises.readFile(
            path.join(workspaceRootPath, 'src', 'lib', 'arithmetic.ts'),
            'utf8'
          )
        ).toBe('export const add = () => 1;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('creates missing destination parent directories', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );
        await executeTool({
          context: { fromPath: '/README.md', toPath: '/docs/moved/README.md' },
        });
        expect(
          await fsPromises.readFile(
            path.join(workspaceRootPath, 'docs', 'moved', 'README.md'),
            'utf8'
          )
        ).toBe('# Test Workspace\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to overwrite an existing destination (no overwrite in v1)', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );
        await expect(
          executeTool({ context: { fromPath: '/src/lib/math.ts', toPath: '/README.md' } })
        ).rejects.toThrow(/already exists/i);
        // Both files are untouched.
        expect(
          await fsPromises.readFile(path.join(workspaceRootPath, 'src', 'lib', 'math.ts'), 'utf8')
        ).toBe('export const add = () => 1;\n');
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8')).toBe(
          '# Test Workspace\n'
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('throws a not-found error when the source file is missing', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );
        await expect(
          executeTool({ context: { fromPath: '/src/nope.ts', toPath: '/src/yep.ts' } })
        ).rejects.toThrow(/does not exist/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to rename a directory', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );
        await expect(
          executeTool({ context: { fromPath: '/src/lib', toPath: '/src/library' } })
        ).rejects.toThrow(/is a directory/i);
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('clamps a "../" escape in the destination to inside the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );
        const result = await executeTool({
          context: { fromPath: '/README.md', toPath: '../escaped.md' },
        });
        // Unrooted destination keeps the relative convention; ".." is clamped so
        // it resolves INSIDE the root, never the sibling dir.
        expect(result.toPath).toBe('escaped.md');
        await expect(
          fsPromises.access(path.join(path.dirname(workspaceRootPath), 'escaped.md'))
        ).rejects.toThrow();
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'escaped.md'), 'utf8')).toBe(
          '# Test Workspace\n'
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('rejects renaming through a symlinked destination directory that escapes the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-mv-link-'));
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
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );
        await expect(
          executeTool({ context: { fromPath: '/README.md', toPath: '/src/linked/pwned.md' } })
        ).rejects.toThrow(/outside the selected workspace root/i);
        // Nothing landed in the outside dir and the source is intact.
        await expect(fsPromises.access(path.join(outsideRoot, 'pwned.md'))).rejects.toThrow();
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'README.md'), 'utf8')).toBe(
          '# Test Workspace\n'
        );
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('a true swap (a→b concurrent with b→a) contends on the same two lock keys in opposite order and does not deadlock', async () => {
      // This guards withTwoFileLocks' sorted-acquisition invariant specifically.
      // A chain like A→B concurrent with B→C shares only ONE lock key (B), so it
      // can NEVER deadlock under any acquisition order — it doesn't exercise the
      // sort at all. A genuine swap does: both calls lock the SAME two paths
      // {swap-a.ts, swap-b.ts}, but in OPPOSITE from→to order (a→b vs b→a). A
      // naive from-then-to lock order deadlocks here (call1 holds a, waits on b;
      // call2 holds b, waits on a). Sorted acquisition forces both calls to take
      // the two locks in the same physical order, so the pair can only ever run
      // sequentially — never deadlock.
      //
      // Neither rename can legally succeed here (v1 refuses to overwrite an
      // existing destination, and both destinations pre-exist as real swap
      // targets), so the assertion is deliberately "both calls settle without
      // deadlocking", not "both succeed".
      //
      // Path resolution (`resolveWorkspaceWritePath`) normally reaches the lock
      // via `fsPromises.realpath`, a real Node thread-pool op. Empirically (a
      // standalone repro of this exact scenario, thousands of trials), Node
      // drains its microtask queue fully after EVERY thread-pool completion, so
      // one call's ENTIRE lock-registration step always finishes atomically
      // before the other call's continuation can run — through that path, a
      // naive unsorted `withTwoFileLocks` and the sorted one behave IDENTICALLY
      // (never deadlock), because the two calls can never arrive at the lock in
      // the same microtask turn. To actually exercise the interleaved-arrival
      // race the sort defends against, `realpath` is stubbed to resolve via an
      // already-settled promise around a real, synchronous `realpathSync` (same
      // real containment semantics, no thread-pool hop) so both `tool.execute()`
      // calls arrive at the lock in the same microtask burst. Verified locally:
      // with this stub, reverting the sort in `withTwoFileLocks` reproduces the
      // deadlock 20/20 runs; restoring the sort avoids it 20/20 runs.
      const realpathSpy = vi
        .spyOn(fsPromises, 'realpath')
        .mockImplementation((p) => Promise.resolve(realpathSync(p as string)));
      const workspaceRootPath = await createWorkspaceFixture();
      try {
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'swap-a.ts'),
          'content a\n',
          'utf8'
        );
        await fsPromises.writeFile(
          path.join(workspaceRootPath, 'swap-b.ts'),
          'content b\n',
          'utf8'
        );
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );
        // Guard: if this ever hangs (e.g. a regression to naive from-then-to lock
        // ordering), fail with a timeout error instead of an infinite hang.
        const results = await Promise.race([
          Promise.allSettled([
            executeTool({ context: { fromPath: '/swap-a.ts', toPath: '/swap-b.ts' } }),
            executeTool({ context: { fromPath: '/swap-b.ts', toPath: '/swap-a.ts' } }),
          ]),
          new Promise<'deadlock'>((resolve) => setTimeout(() => resolve('deadlock'), 4000)),
        ]);
        expect(results).not.toBe('deadlock');
        expect(Array.isArray(results)).toBe(true);
        const settled = results as PromiseSettledResult<unknown>[];
        expect(settled).toHaveLength(2);
        for (const outcome of settled) {
          expect(outcome.status).toBe('rejected');
        }
        // Both files are untouched — neither rename could legally proceed, since
        // each one's destination was occupied by the other's source the whole time.
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'swap-a.ts'), 'utf8')).toBe(
          'content a\n'
        );
        expect(await fsPromises.readFile(path.join(workspaceRootPath, 'swap-b.ts'), 'utf8')).toBe(
          'content b\n'
        );
      } finally {
        realpathSpy.mockRestore();
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('renames a SYMLINK to an in-root file: the LINK moves (still points at target), target untouched', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const targetPath = path.join(workspaceRootPath, 'src', 'lib', 'math.ts');
      const linkPath = path.join(workspaceRootPath, 'src', 'alias.ts');
      const movedLinkPath = path.join(workspaceRootPath, 'src', 'renamed-alias.ts');
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
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );

        const result = await executeTool({
          context: { fromPath: '/src/alias.ts', toPath: '/src/renamed-alias.ts' },
        });

        expect(result).toMatchObject({
          fromPath: '/src/alias.ts',
          ok: true,
          toPath: '/src/renamed-alias.ts',
        });
        // The old link path is gone; the moved path is STILL a symlink pointing at
        // the original target, and the target file itself was never moved/modified.
        await expect(fsPromises.lstat(linkPath)).rejects.toThrow();
        const movedStats = await fsPromises.lstat(movedLinkPath);
        expect(movedStats.isSymbolicLink()).toBe(true);
        expect(await fsPromises.readlink(movedLinkPath)).toBe(targetPath);
        expect(await fsPromises.readFile(targetPath, 'utf8')).toBe('export const add = () => 1;\n');
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
      }
    });

    it('refuses to rename a LIVE symlink leaf whose target is OUTSIDE the root', async () => {
      const workspaceRootPath = await createWorkspaceFixture();
      const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-mv-ll-'));
      const outsideTarget = path.join(outsideRoot, 'secret.txt');
      const linkPath = path.join(workspaceRootPath, 'src', 'out-alias.ts');
      await fsPromises.writeFile(outsideTarget, 'secret', 'utf8');
      try {
        try {
          await fsPromises.symlink(outsideTarget, linkPath, 'file');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES') {
            return;
          }
          throw error;
        }
        const executeTool = requireToolExecute(
          buildHostNativeTools(singleRootRuntime(workspaceRootPath)),
          'brainstrike.renameWorkspaceFile'
        );
        await expect(
          executeTool({ context: { fromPath: '/src/out-alias.ts', toPath: '/src/moved.ts' } })
        ).rejects.toThrow(/outside the selected workspace root/i);
        // The outside target is intact and nothing was moved into place.
        expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('secret');
        await expect(
          fsPromises.lstat(path.join(workspaceRootPath, 'src', 'moved.ts'))
        ).rejects.toThrow();
      } finally {
        await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
        await fsPromises.rm(outsideRoot, { force: true, recursive: true });
      }
    });

    it('fails explicitly when no workspace folder is open', async () => {
      const executeTool = requireToolExecute(
        buildHostNativeTools({ workspaceRoots: [] } as unknown as RuntimeData),
        'brainstrike.renameWorkspaceFile'
      );
      await expect(
        executeTool({ context: { fromPath: '/a.ts', toPath: '/b.ts' } })
      ).rejects.toThrow(/No folder is open/i);
    });
  });
});
