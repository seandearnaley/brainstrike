/**
 * A nested repository (an agent's worktree inside the workspace, say) is a
 * gitlink to the snapshot. The restore preview lists it only when its commit
 * moved: uncommitted files inside it are not a change any restore acts on,
 * and used to show up as "modified, +0 −0" rows with the same commit on both
 * sides.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSnapshotGitRunner } from '../../src/git-workspace/snapshot-git.ts';
import { createSnapshotService } from '../../src/git-workspace/snapshot-service.ts';

let base: string;
let root: string;
let nested: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
  });
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bs-snapshot-nested-'));
  root = path.join(base, 'root');
  nested = path.join(root, 'worktrees', 'agent');
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'notes.txt'), 'first\n');
  execFileSync('git', ['init', '-q', nested]);
  await writeFile(path.join(nested, 'work.txt'), 'one\n');
  git(nested, 'add', 'work.txt');
  git(nested, 'commit', '-q', '-m', 'one');
});

afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

async function previewPaths(change: () => Promise<void>): Promise<string[]> {
  const service = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir: path.join(base, 'snapshots'),
  });
  const handle = await service.ensureShadowRepo({ path: root, rootId: 'root-1' });
  const before = await service.snapshot(handle, {
    kind: 'turn-start',
    runId: 'run-1',
    threadId: 'thread-1',
  });
  await change();
  const diffs = await service.diffRefs(handle, before.commitOid, { worktree: true });
  return diffs.map((diff) => diff.path).sort();
}

it('leaves out a nested repository whose only change is uncommitted work inside it', async () => {
  const paths = await previewPaths(async () => {
    await writeFile(path.join(root, 'notes.txt'), 'second\n');
    await writeFile(path.join(nested, 'work.txt'), 'two\n');
  });
  expect(paths).toEqual(['notes.txt']);
});

it('lists a nested repository whose commit moved', async () => {
  const paths = await previewPaths(async () => {
    await writeFile(path.join(nested, 'work.txt'), 'two\n');
    git(nested, 'commit', '-q', '-am', 'two');
  });
  expect(paths).toEqual(['worktrees/agent']);
});
