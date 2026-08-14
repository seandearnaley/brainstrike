import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  createBoundedExecFileRunner,
  createIsolatedWorktree,
} from '../agent-routines/shared/isolated-worktree.mjs';

const execFileAsync = promisify(execFile);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

describe('scheduled-maintenance isolated worktree', () => {
  it('rejects a stale frozen base before creating a worktree', async () => {
    const calls = [];
    await assert.rejects(
      createIsolatedWorktree({
        baseSha: SHA_A,
        branchName: 'automation/model-a1b2',
        canonicalPath: '/repo',
        runGit: async (invocation) => {
          calls.push(invocation);
          return { stdout: `${SHA_B}\n` };
        },
      }),
      /stale frozen base/u
    );
    assert.deepEqual(calls, [
      {
        args: ['rev-parse', '--verify', 'origin/main^{commit}'],
        cwd: '/repo',
      },
    ]);
  });

  it('rejects a temp root inside the canonical checkout', async () => {
    await assert.rejects(
      createIsolatedWorktree({
        baseSha: SHA_A,
        branchName: 'automation/model-a1b2',
        canonicalPath: '/repo',
        runGit: async () => ({ stdout: `${SHA_A}\n` }),
        tempRoot: '/repo/.routine-worktrees',
      }),
      /outside the canonical checkout/u
    );
  });

  it('edits only a temporary linked worktree and leaves canonical files unchanged', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'routine-worktree-test-'));
    const canonicalPath = path.join(root, 'canonical');
    await execFileAsync('git', ['init', '--initial-branch=main', canonicalPath]);
    await git(canonicalPath, ['config', 'user.email', 'routine@example.com']);
    await git(canonicalPath, ['config', 'user.name', 'Routine Test']);
    await writeFile(path.join(canonicalPath, 'tracked.txt'), 'canonical\n');
    await git(canonicalPath, ['add', 'tracked.txt']);
    await git(canonicalPath, ['commit', '-m', 'test: seed repository']);
    const { stdout: baseOutput } = await git(canonicalPath, ['rev-parse', 'HEAD']);
    const baseSha = baseOutput.trim();

    const worktree = await createIsolatedWorktree({
      baseRef: 'HEAD',
      baseSha,
      branchName: 'automation/test-fingerprint',
      canonicalPath,
      tempRoot: root,
    });
    try {
      assert.notEqual(worktree.path, canonicalPath);
      assert.equal(worktree.path.startsWith(root), true);
      await writeFile(path.join(worktree.path, 'tracked.txt'), 'isolated edit\n');
      assert.equal(await readFile(path.join(canonicalPath, 'tracked.txt'), 'utf8'), 'canonical\n');
      assert.equal(
        (await git(worktree.path, ['branch', '--show-current'])).stdout.trim(),
        worktree.branch
      );
    } finally {
      await worktree.cleanup();
    }
  });

  it('uses argument arrays and enforces output and timeout bounds', async () => {
    const runner = createBoundedExecFileRunner({ maxBufferBytes: 32, timeoutMs: 50 });
    await assert.rejects(
      runner({
        args: ['-e', "process.stdout.write('x'.repeat(128))"],
        cwd: process.cwd(),
        file: process.execPath,
      }),
      /maxBuffer/u
    );
    await assert.rejects(
      runner({
        args: ['-e', 'setTimeout(() => {}, 1_000)'],
        cwd: process.cwd(),
        file: process.execPath,
      }),
      /timed out/u
    );
  });
});
