import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInventory } from '../src/inventory.ts';

const run = promisify(execFile);
// `base`/`scanRoot` are deliberately left as the RAW mkdtemp() result (not
// realpath'd) — on macOS this is a /var path symlinked to /private/var.
// We pass this symlinked path straight into buildInventory([scanRoot]) to
// prove it canonicalizes internally: git's own porcelain output is always
// canonical, so if buildInventory didn't realpath its roots, containment
// classification would silently misclassify every worktree under a
// symlinked scan root as outside-roots.
let base: string;
let scanRoot: string;
// Canonical forms, computed once, used only to express expected values —
// this is what buildInventory's internal canonicalization should produce.
let canonicalBase: string;
let canonicalScanRoot: string;
let brokenWorkdir: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'spike-inv-'));
  canonicalBase = await realpath(base);
  scanRoot = join(base, 'workspace');
  canonicalScanRoot = join(canonicalBase, 'workspace');
  const repo = join(scanRoot, 'myrepo');
  await mkdir(repo, { recursive: true });
  await run('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'f.txt'), 'hello\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['-c', 'user.email=s@x', '-c', 'user.name=s', 'commit', '-m', 'init'], {
    cwd: repo,
  });
  // one worktree inside the scanned root, one outside it, one detached
  await run('git', ['worktree', 'add', join(scanRoot, 'wt-inside'), '-b', 'inside'], { cwd: repo });
  await run('git', ['worktree', 'add', join(base, 'wt-outside'), '-b', 'outside'], { cwd: repo });
  await run('git', ['worktree', 'add', '--detach', join(scanRoot, 'wt-detached')], { cwd: repo });

  // A corrupt repo: a `.git` FILE pointing at a nonexistent gitdir. Discovered
  // as a gitfile entry, but any `git` invocation inside it fails — this must
  // surface as a visible Inventory.errors entry, never a silently dropped repo.
  brokenWorkdir = join(scanRoot, 'broken-repo');
  await mkdir(brokenWorkdir, { recursive: true });
  await writeFile(join(brokenWorkdir, '.git'), 'gitdir: /nonexistent/path/.git\n');
});

afterAll(async () => {
  await rm(base, { force: true, recursive: true });
});

describe('buildInventory', () => {
  it('dedupes worktrees of one repo to a single RepoEntry keyed by main worktree', async () => {
    const inv = await buildInventory([scanRoot]);
    expect(inv.repos).toHaveLength(1);
    const repo = inv.repos.find((r) => r.repositoryRoot === join(canonicalScanRoot, 'myrepo'));
    expect(repo).toBeDefined();
    expect(repo?.worktrees).toHaveLength(4); // main + inside + outside + detached
  });

  it('classifies containment, including outside-roots', async () => {
    const inv = await buildInventory([scanRoot]);
    const repo = inv.repos.find((r) => r.repositoryRoot === join(canonicalScanRoot, 'myrepo'));
    const byPath = new Map(repo?.worktrees.map((w) => [w.path, w]));
    expect(byPath.get(join(canonicalScanRoot, 'wt-inside'))?.containment).toEqual([
      canonicalScanRoot,
    ]);
    expect(byPath.get(join(canonicalBase, 'wt-outside'))?.containment).toBe('outside-roots');
  });

  it('reports branch names and detachment honestly', async () => {
    const inv = await buildInventory([scanRoot]);
    const repo = inv.repos.find((r) => r.repositoryRoot === join(canonicalScanRoot, 'myrepo'));
    const branches = repo?.worktrees.map((w) => w.branch).sort();
    expect(branches).toEqual(['inside', 'main', null, 'outside']);
    const byPath = new Map(repo?.worktrees.map((w) => [w.path, w]));
    expect(byPath.get(join(canonicalScanRoot, 'wt-detached'))?.branch).toBeNull();
  });

  it('records a visible error for a corrupt repo without dropping the healthy one', async () => {
    const inv = await buildInventory([scanRoot]);
    const repo = inv.repos.find((r) => r.repositoryRoot === join(canonicalScanRoot, 'myrepo'));
    expect(repo).toBeDefined();
    expect(inv.errors).toHaveLength(1);
    expect(inv.errors[0]).toContain(brokenWorkdir);
  });
});
