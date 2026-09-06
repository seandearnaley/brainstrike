/**
 * Real-git lane for adoption + checkout status. Uses the same temp-repo
 * fixtures the worktree-archive integration lane uses; nothing is mocked
 * below the `GitCommandRunner`.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { GitCommandRun, GitCommandRunner } from '../../assistant-server/git-service';
import { adoptWorktree, readCheckoutStatus } from '../../assistant-server/worktree-adopt';

const exec = promisify(execFile);
const created: string[] = [];

async function git(cwd: string, ...args: readonly string[]): Promise<void> {
  await exec('git', [...args], { cwd });
}

async function freshRepo(): Promise<string> {
  const dir = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bst-w5-'))
  );
  created.push(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  await fsPromises.writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
}

afterAll(async () => {
  await Promise.all(created.map((dir) => fsPromises.rm(dir, { force: true, recursive: true })));
});

describe('worktree adoption over real git', () => {
  it('adopts an externally created worktree and then reports its status', async () => {
    const repo = await freshRepo();
    const worktreePath = path.join(repo, 'external-wt');
    await git(repo, 'worktree', 'add', '-b', 'external', worktreePath);
    const commonDir = await fsPromises.realpath(path.join(repo, '.git'));

    const rows: unknown[] = [];
    const run: GitCommandRunner = ({ args, cwd }) =>
      new Promise<GitCommandRun>((resolve) => {
        execFile('git', [...args], { cwd }, (error, stdout, stderr) => {
          resolve({
            exitCode: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
            stderr,
            stdout,
            timedOut: false,
          });
        });
      });
    const deps = {
      ledger: {
        getByPath: () => Promise.resolve(null),
        insert: (row: unknown) => {
          rows.push(row);
          return Promise.resolve(row);
        },
        listActive: () => Promise.resolve([]),
      } as never,
      readSettings: () =>
        Promise.resolve({
          isDefaultDirectory: true,
          managedDirectory: path.join(repo, 'managed'),
          setupCommand: null,
        }),
      resolveInventory: () =>
        Promise.resolve({
          errors: [],
          repositories: [
            {
              identity: { gitCommonDir: commonDir, repositoryRoot: repo },
              worktrees: [
                {
                  bare: false,
                  branch: 'external',
                  containment: ['root-1'] as readonly string[],
                  current: false,
                  detached: false,
                  head: 'HEAD',
                  lockedReason: null,
                  name: 'external-wt',
                  path: worktreePath,
                  provenance: 'scanned' as const,
                  prunableReason: null,
                  trust: 'validated' as const,
                  trustReason: null,
                },
              ],
            },
          ],
        }),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: repo }]),
      run,
    };

    const adopted = await adoptWorktree(deps, { createdBy: 'user', path: worktreePath });
    expect(adopted.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(adopted.ok && adopted.value.baseRef).toMatch(/^[0-9a-f]{40}$/u);
    expect(adopted.ok && adopted.value.repoCommonDir).toBe(commonDir);

    await fsPromises.writeFile(path.join(worktreePath, 'dirty.txt'), 'x');
    const status = await readCheckoutStatus(deps, { path: worktreePath });
    expect(status.ok).toBe(true);
    expect(status.ok && status.value.clean).toBe(false);
    expect(status.ok && status.value.upstream).toBeNull();
  });
});
