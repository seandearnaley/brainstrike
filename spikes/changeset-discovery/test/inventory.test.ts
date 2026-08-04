import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInventory } from '../src/inventory.ts';

const run = promisify(execFile);
let base: string;
let scanRoot: string;

beforeAll(async () => {
  // realpath: on macOS, os.tmpdir() is under /var, a symlink to /private/var.
  // git canonicalizes cwd internally (getcwd() after chdir resolves symlinks),
  // so its reported absolute paths are under /private/var. Without this
  // resolution, string comparisons against git's own output never match.
  base = await realpath(await mkdtemp(join(tmpdir(), 'spike-inv-')));
  scanRoot = join(base, 'workspace');
  const repo = join(scanRoot, 'myrepo');
  await mkdir(repo, { recursive: true });
  await run('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'f.txt'), 'hello\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['-c', 'user.email=s@x', '-c', 'user.name=s', 'commit', '-m', 'init'], {
    cwd: repo,
  });
  // one worktree inside the scanned root, one outside it
  await run('git', ['worktree', 'add', join(scanRoot, 'wt-inside'), '-b', 'inside'], { cwd: repo });
  await run('git', ['worktree', 'add', join(base, 'wt-outside'), '-b', 'outside'], { cwd: repo });
});

afterAll(async () => {
  await rm(base, { force: true, recursive: true });
});

describe('buildInventory', () => {
  it('dedupes worktrees of one repo to a single RepoEntry keyed by main worktree', async () => {
    const inv = await buildInventory([scanRoot]);
    expect(inv.repos).toHaveLength(1);
    expect(inv.repos[0]?.repositoryRoot).toBe(join(scanRoot, 'myrepo'));
    expect(inv.repos[0]?.worktrees).toHaveLength(3); // main + inside + outside
  });

  it('classifies containment, including outside-roots', async () => {
    const inv = await buildInventory([scanRoot]);
    const byPath = new Map(inv.repos[0]?.worktrees.map((w) => [w.path, w]));
    expect(byPath.get(join(scanRoot, 'wt-inside'))?.containment).toEqual([scanRoot]);
    expect(byPath.get(join(base, 'wt-outside'))?.containment).toBe('outside-roots');
  });

  it('reports branch names and detachment honestly', async () => {
    const inv = await buildInventory([scanRoot]);
    const branches = inv.repos[0]?.worktrees.map((w) => w.branch).sort();
    expect(branches).toEqual(['inside', 'main', 'outside']);
  });
});
