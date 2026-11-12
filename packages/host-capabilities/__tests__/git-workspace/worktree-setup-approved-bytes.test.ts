import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorktreeSetup } from '../../src/git-workspace/worktree-setup.ts';

/** The script the person approved: it names the file it ran from. */
const APPROVED = 'echo "$0" > approved.txt\n';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

// ADR-0034: an approved repository script runs for worktrees no person asked
// for, so the bytes that run must be the bytes that were checked. A run that
// can write the source checkout must not swap the script in between.
describe.skipIf(process.platform === 'win32')('the repository setup script that runs', () => {
  let directory: string;
  let source: string;
  let script: string;
  let worktree: ManagedWorktreeRow;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'bst-setup-bytes-'));
    source = path.join(directory, 'source');
    mkdirSync(path.join(source, '.brainstrike'), { recursive: true });
    script = path.join(source, '.brainstrike', 'worktree-setup.sh');
    writeFileSync(script, APPROVED);
    const worktreePath = path.join(directory, 'worktree');
    mkdirSync(worktreePath);
    worktree = {
      archivedAt: null,
      archiveSnapshotRef: null,
      baseRef: 'main',
      branch: null,
      createdAt: new Date(0).toISOString(),
      createdBy: 'agent',
      id: 'worktree-setup-bytes',
      path: worktreePath,
      repoCommonDir: path.join(source, '.git'),
      runId: null,
      setupOutput: null,
      setupReason: null,
      setupStatus: 'none',
      threadId: null,
    };
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  function setup(onScriptChecked?: () => Promise<void>) {
    return runWorktreeSetup({
      ...(onScriptChecked ? { onScriptChecked } : {}),
      repositorySetupDecision: { decision: 'approved', scriptSha256: sha256(APPROVED) },
      settings: { isDefaultDirectory: true, managedDirectory: directory, setupCommand: null },
      sourcePath: source,
      worktree,
    });
  }

  it('runs the approved bytes even when the script is swapped after they were checked', async () => {
    const outcome = await setup(async () => {
      writeFileSync(script, 'echo swapped > swapped.txt\n');
    });

    expect(outcome).toMatchObject({ reason: null, status: 'succeeded' });
    expect(existsSync(path.join(worktree.path, 'swapped.txt'))).toBe(false);
    expect(existsSync(path.join(worktree.path, 'approved.txt'))).toBe(true);
  });

  it('runs a private copy of the approved bytes and removes it afterwards', async () => {
    const outcome = await setup();

    expect(outcome.status).toBe('succeeded');
    const ranFrom = readFileSync(path.join(worktree.path, 'approved.txt'), 'utf8').trim();
    expect(ranFrom).not.toBe(script);
    expect(existsSync(ranFrom)).toBe(false);
  });

  it('removes the private copy when the script fails', async () => {
    const failing = 'echo "$0" > approved.txt\nexit 3\n';
    writeFileSync(script, failing);

    const outcome = await runWorktreeSetup({
      repositorySetupDecision: { decision: 'approved', scriptSha256: sha256(failing) },
      settings: { isDefaultDirectory: true, managedDirectory: directory, setupCommand: null },
      sourcePath: source,
      worktree,
    });

    expect(outcome).toMatchObject({
      reason: 'Setup command exited with code 3.',
      status: 'failed',
    });
    const ranFrom = readFileSync(path.join(worktree.path, 'approved.txt'), 'utf8').trim();
    expect(existsSync(ranFrom)).toBe(false);
  });
});
