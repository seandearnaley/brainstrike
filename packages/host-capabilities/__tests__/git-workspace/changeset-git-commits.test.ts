/**
 * The Changes commit picker's list (ADR-0036): a worktree's latest commits,
 * each of which opens as its own diff. Real repositories and real git.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChangesetDiffService } from '../../src/git-workspace/changeset-diff-service.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';

let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-commits-')));
  root = path.join(base, 'root');
  await mkdir(root);
  git('init', '--quiet', '--initial-branch=main');
});

afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

function git(...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd: root, encoding: 'utf8' }
  );
}

async function commit(file: string, text: string, message: string): Promise<string> {
  await writeFile(path.join(root, file), text);
  git('add', file);
  git('commit', '--quiet', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}

const service = () =>
  createChangesetDiffService({
    resolveRootCwd: async (): Promise<BoundaryResult<string>> => ({ ok: true, value: root }),
    run: execFileGitRunner,
  });

describe('a worktree’s commits', () => {
  it('lists its latest commits newest first, and each opens as its own diff', async () => {
    const first = await commit('a.txt', 'one\n', 'Add a');
    const second = await commit('b.txt', 'two\n', 'Add b\n\nWith a body that is not listed.');
    const changes = service();

    expect(await changes.commits('root-a', root)).toEqual({
      ok: true,
      value: [
        { commitId: second, subject: 'Add b' },
        { commitId: first, subject: 'Add a' },
      ],
    });

    const view = await changes.resolveView('root-a', {
      kind: 'git-scope',
      repositoryRoot: root,
      scope: { commitId: second, kind: 'commit' },
      worktreePath: root,
    });
    expect(view.ok && view.value.files.map((file) => [file.path, file.status])).toEqual([
      ['b.txt', 'added'],
    ]);
  });

  it('lists none before the first commit', async () => {
    expect(await service().commits('root-a', root)).toEqual({ ok: true, value: [] });
  });

  it('refuses a worktree outside the folder', async () => {
    const elsewhere = path.join(base, 'elsewhere');
    await mkdir(elsewhere);
    expect(await service().commits('root-a', elsewhere)).toMatchObject({
      error: { code: 'changeset.outside-roots' },
      ok: false,
    });
  });
});
