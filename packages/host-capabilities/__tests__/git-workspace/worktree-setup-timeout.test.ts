import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { processStartTime } from '@brainstrike/state-store';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { expect, it } from 'vitest';
import { runWorktreeSetup } from '../../src/git-workspace/worktree-setup.ts';

// ADR-0030: a timed-out setup ends its whole tree and settles at the exit, even while a
// program it started still holds the inherited output open.
it('a timed-out setup ends the program it started and settles though that program held its output', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'worktree-setup-timeout-'));
  const pidFile = path.join(directory, 'program.pid');
  let program: number | undefined;
  try {
    const worktree: ManagedWorktreeRow = {
      archivedAt: null,
      archiveSnapshotRef: null,
      baseRef: 'main',
      branch: null,
      createdAt: new Date(0).toISOString(),
      createdBy: 'user',
      id: 'worktree-setup-timeout',
      path: directory,
      repoCommonDir: directory,
      runId: null,
      setupOutput: null,
      setupReason: null,
      setupStatus: 'none',
      threadId: null,
    };
    const launcher = `const { spawn } = require('node:child_process');
const program = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(program.pid));
setInterval(() => {}, 1000);`;
    const outcome = await runWorktreeSetup({
      settings: {
        isDefaultDirectory: true,
        managedDirectory: directory,
        setupCommand: [process.execPath, '-e', launcher],
      },
      sourcePath: directory,
      timeoutMs: 1000,
      worktree,
    });
    program = Number(await readFile(pidFile, 'utf8'));
    expect(outcome).toMatchObject({
      reason: 'Setup command timed out after 1s.',
      status: 'failed',
    });
    await expect.poll(() => processStartTime(program ?? 0)).toBeNull();
  } finally {
    if (program !== undefined && processStartTime(program) !== null) {
      process.kill(program, 'SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  }
});
