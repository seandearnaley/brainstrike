import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeScopeDiff } from '../src/scope-diff.ts';

const run = promisify(execFile);
let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'spike-diff-'));
  const g = (args: string[]) =>
    run('git', ['-c', 'user.email=s@x', '-c', 'user.name=s', ...args], { cwd: repo });
  await g(['init', '-b', 'main']);
  await writeFile(join(repo, 'kept.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'doomed.txt'), 'bye\n');
  await g(['add', '.']);
  await g(['commit', '-m', 'init']);
  await writeFile(join(repo, 'kept.txt'), 'one\nTWO\nthree\n'); // modified, unstaged
  await rm(join(repo, 'doomed.txt')); // deleted, unstaged
  await writeFile(join(repo, 'fresh.txt'), 'new\n'); // untracked
});

afterAll(async () => {
  await rm(repo, { force: true, recursive: true });
});

describe('computeScopeDiff uncommitted', () => {
  it('reports modified, deleted, and untracked with both-sides content', async () => {
    const diff = await computeScopeDiff(repo, 'uncommitted');
    const byPath = new Map(diff.files.map((f) => [f.path, f]));
    const kept = byPath.get('kept.txt');
    expect(kept?.status).toBe('M');
    expect(kept?.oldContent).toBe('one\ntwo\n');
    expect(kept?.newContent).toBe('one\nTWO\nthree\n');
    expect(kept?.additions).toBe(2);
    expect(kept?.deletions).toBe(1);
    expect(byPath.get('doomed.txt')?.status).toBe('D');
    expect(byPath.get('doomed.txt')?.newContent).toBeNull();
    expect(byPath.get('fresh.txt')?.status).toBe('U');
    expect(byPath.get('fresh.txt')?.oldContent).toBeNull();
    expect(byPath.get('fresh.txt')?.newContent).toBe('new\n');
  });
});
