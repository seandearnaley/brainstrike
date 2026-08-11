/**
 * Fake-fs + spy-runner UNIT coverage for `git-inventory-service.ts`'s
 * `buildInventorySnapshot` — specifically the hook-free spawn discipline at
 * its ONE git-spawning call site (`buildRepository`'s `invoke(['worktree',
 * 'list', ...])`) and the "one spawn per unique common dir" dedup contract
 * (`groupByCommonDir`). Real end-to-end behavior against real repos lives in
 * `git-inventory.integration.test.ts`; this file never spawns a real `git`
 * process — every invocation goes through the injected spy `run`.
 *
 * Two real fs touches remain un-fakeable by design (`resolveRoots` and the
 * main-worktree `repositoryRoot` resolution both call `node:fs/promises`'s
 * `realpath` directly, not through the injected `InventoryFs`) — this file
 * uses real, empty temp directories for those paths so they resolve, while
 * everything the WALK and commondir-resolution chain sees comes from the
 * fake `InventoryFs` below.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  InventoryDirent,
  InventoryFs,
  InventoryStat,
} from '../../assistant-server/git-inventory-discovery';
import { buildInventorySnapshot } from '../../assistant-server/git-inventory-service';
import type { GitCommandRun, GitCommandRunner } from '../../assistant-server/git-service';

const createdRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

type FakeNode =
  | { readonly children: readonly string[]; readonly type: 'dir' }
  | { readonly content: string; readonly type: 'file' };

/** Minimal in-memory `InventoryFs` — a narrower copy of the fake in
 * `git-inventory-discovery.test.ts`, scoped to what this file's scenarios need. */
class FakeFs implements InventoryFs {
  private readonly nodes = new Map<string, FakeNode>();
  private readonly realpaths = new Map<string, string>();

  addDir(dirPath: string, children: readonly string[]): void {
    this.nodes.set(dirPath, { children, type: 'dir' });
  }

  addFile(filePath: string, content: string): void {
    this.nodes.set(filePath, { content, type: 'file' });
  }

  setRealpath(fromPath: string, toPath: string): void {
    this.realpaths.set(fromPath, toPath);
  }

  lstat(targetPath: string): Promise<InventoryStat> {
    const node = this.nodes.get(targetPath);
    if (!node) {
      return Promise.reject(enoent(targetPath));
    }
    return Promise.resolve({
      isDirectory: () => node.type === 'dir',
      isFile: () => node.type === 'file',
    });
  }

  readdir(dirPath: string): Promise<readonly InventoryDirent[]> {
    const node = this.nodes.get(dirPath);
    if (node?.type !== 'dir') {
      return Promise.reject(enoent(dirPath));
    }
    return Promise.resolve(
      node.children.map((name) => {
        const childPath = `${dirPath}/${name}`;
        const childNode = this.nodes.get(childPath);
        return {
          isDirectory: () => childNode?.type === 'dir',
          isFile: () => childNode?.type === 'file',
          name,
        };
      })
    );
  }

  readFile(filePath: string): Promise<string> {
    const node = this.nodes.get(filePath);
    if (node?.type !== 'file') {
      return Promise.reject(enoent(filePath));
    }
    return Promise.resolve(node.content);
  }

  realpath(targetPath: string): Promise<string> {
    const resolved = this.realpaths.get(targetPath) ?? targetPath;
    if (!(this.nodes.has(resolved) || this.realpaths.has(targetPath))) {
      return Promise.reject(enoent(targetPath));
    }
    return Promise.resolve(resolved);
  }
}

function enoent(targetPath: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory '${targetPath}'`
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

interface RecordedRun {
  readonly args: readonly string[];
  readonly cwd: string;
}

const FAKE_HEAD = 'a'.repeat(40);

describe('buildInventorySnapshot — hook-free spawn discipline + dedup (unit, fake fs + spy runner)', () => {
  it('spawns "git worktree list" with fsmonitor/hooksPath disabled and configured-hook overrides, exactly ONCE for one unique common dir', async () => {
    const rootDir = await makeTempDir('brainstrike-git-inventory-unit-root-');
    // Real (empty) directory so the linked group's `repositoryRoot`
    // resolution (real `fs.realpath`, un-fakeable) would ALSO succeed if the
    // dedup were broken — otherwise a broken-dedup run would fail for an
    // unrelated reason (ENOENT) instead of demonstrating the extra spawn.
    const linkedDir = path.join(rootDir, 'linked');
    await fsPromises.mkdir(linkedDir);

    const fs = new FakeFs();
    fs.addDir(rootDir, ['.git', 'linked']);
    fs.addDir(`${rootDir}/.git`, []);
    fs.setRealpath(`${rootDir}/.git`, `${rootDir}/.git`);
    fs.addDir(linkedDir, ['.git']);
    fs.addFile(`${linkedDir}/.git`, `gitdir: ${rootDir}/.git/worktrees/linked\n`);
    fs.addDir(`${rootDir}/.git/worktrees/linked`, ['commondir']);
    fs.addFile(`${rootDir}/.git/worktrees/linked/commondir`, '../..\n');
    fs.setRealpath(`${rootDir}/.git/worktrees/linked`, `${rootDir}/.git/worktrees/linked`);

    const runCalls: RecordedRun[] = [];
    const run: GitCommandRunner = ({ args, cwd }): Promise<GitCommandRun> => {
      runCalls.push({ args, cwd });
      if (args[0] === 'config') {
        // A nonsense hook name (not a real git hook like `pre-commit`) so the
        // assertion below can only pass if the disabled-hooks list is DERIVED
        // from this probe's output — hardcoding `hook.pre-commit.enabled=false`
        // and ignoring the probe entirely would still look plausible with a
        // real hook name, but cannot produce `hook.sentinel-xyz.enabled=false`.
        return Promise.resolve({
          exitCode: 0,
          stderr: '',
          stdout: 'hook.sentinel-xyz.command\0',
          timedOut: false,
        });
      }
      return Promise.resolve({
        exitCode: 0,
        stderr: '',
        stdout: `worktree ${cwd}\0HEAD ${FAKE_HEAD}\0branch refs/heads/main\0\0`,
        timedOut: false,
      });
    };

    const snapshot = await buildInventorySnapshot({
      fs,
      loadRoots: () => Promise.resolve([{ id: 'root-1', path: rootDir }]),
      run,
    });

    expect(snapshot.errors).toEqual([]);
    // The `.git` DIRECTORY (main worktree) and the linked worktree's `.git`
    // FILE both resolve to the SAME common dir — `groupByCommonDir` must
    // dedupe them into ONE group before any spawn. A dedup keyed by
    // `${commonDir}::${entry.path}` instead of `commonDir` alone would form
    // TWO groups here and double every assertion below.
    expect(snapshot.repositories).toHaveLength(1);
    expect(runCalls).toHaveLength(2);

    const worktreeListCall = runCalls.find((call) => call.args.includes('worktree'));
    expect(worktreeListCall).toBeDefined();
    expect(worktreeListCall?.args).toEqual(
      expect.arrayContaining([
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'hook.sentinel-xyz.enabled=false',
        'worktree',
        'list',
        '--porcelain',
        '-z',
      ])
    );

    const probeCall = runCalls.find((call) => call.args[0] === 'config');
    expect(probeCall).toBeDefined();
    expect(probeCall?.args).toEqual([
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^hook\\..*\\.command$',
    ]);
  });

  it('reports a visible `errors` entry for a realpath failure on a NON-prunable worktree — git did not already explain this one', async () => {
    // `canonicalPath = await fsRealpath(summary.path)` in `buildRepository`
    // calls `node:fs/promises`'s `realpath` directly, not the injected fake
    // `InventoryFs` (same un-fakeable-by-design seam as `resolveRoots` and
    // the main-worktree resolution, documented in the file header) — so this
    // path must be REAL and REALLY absent for the realpath call to reject.
    //
    // Never created on disk: this simulates the narrow, genuinely reachable
    // race between "git worktree list" reporting a worktree (without a
    // `prunable` field — git's own snapshot still considered it valid) and
    // our own resolution moments later finding it already gone.
    const rootDir = await makeTempDir('brainstrike-git-inventory-unit-nonprunable-root-');
    const vanishedWorktreePath = path.join(rootDir, 'vanished-worktree');

    const fs = new FakeFs();
    fs.addDir(rootDir, ['.git']);
    fs.addDir(`${rootDir}/.git`, []);
    fs.setRealpath(`${rootDir}/.git`, `${rootDir}/.git`);

    const run: GitCommandRunner = ({ args, cwd }): Promise<GitCommandRun> => {
      if (args[0] === 'config') {
        return Promise.resolve({ exitCode: 1, stderr: '', stdout: '', timedOut: false });
      }
      // Two worktrees: the real, resolvable main worktree, and a second
      // entry with NO `prunable ...` field — git is not explaining this one
      // away as routine housekeeping the way it does a deleted worktree it
      // already detected.
      return Promise.resolve({
        exitCode: 0,
        stderr: '',
        stdout: `worktree ${cwd}\0HEAD ${FAKE_HEAD}\0branch refs/heads/main\0\0worktree ${vanishedWorktreePath}\0HEAD ${FAKE_HEAD}\0branch refs/heads/feat\0\0`,
        timedOut: false,
      });
    };

    const snapshot = await buildInventorySnapshot({
      fs,
      loadRoots: () => Promise.resolve([{ id: 'root-1', path: rootDir }]),
      run,
    });

    expect(snapshot.repositories).toHaveLength(1);
    const worktrees = snapshot.repositories[0]?.worktrees ?? [];
    const vanishedDescriptor = worktrees.find((wt) => wt.path === vanishedWorktreePath);
    expect(vanishedDescriptor).toBeDefined();
    expect(vanishedDescriptor?.prunableReason).toBeNull();
    expect(vanishedDescriptor?.trust).toBe('unvalidated');

    // Unlike the prunable case, THIS realpath failure must surface — the
    // error names WHICH worktree failed and WHY, never a bare "failed".
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toContain(vanishedWorktreePath);
    expect(snapshot.errors[0]).toContain('ENOENT');
  });
});
