import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE, discoverRepos } from '../src/discover-repos.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'spike-discover-'));
  await mkdir(join(root, 'repo-a', '.git'), { recursive: true });
  await mkdir(join(root, 'repo-a', '.git', 'modules', 'sub', '.git'), { recursive: true });
  await mkdir(join(root, 'nested', 'repo-b', '.git'), { recursive: true });
  await mkdir(join(root, 'linked-wt'), { recursive: true });
  await writeFile(join(root, 'linked-wt', '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  await mkdir(join(root, 'node_modules', 'trap', '.git'), { recursive: true });
  await mkdir(join(root, 'a/b/c/d/e/f/too-deep', '.git'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

describe('discoverRepos', () => {
  it('finds .git directories and .git files, classifies kind', async () => {
    const found = await discoverRepos([root], { ignore: DEFAULT_IGNORE, maxDepth: 4 });
    const byPath = new Map(found.map((f) => [f.gitPath, f]));
    expect(byPath.get(join(root, 'repo-a', '.git'))?.kind).toBe('repo');
    expect(byPath.get(join(root, 'nested', 'repo-b', '.git'))?.kind).toBe('repo');
    expect(byPath.get(join(root, 'linked-wt', '.git'))?.kind).toBe('gitfile');
  });

  it('skips ignored directories and respects maxDepth', async () => {
    const found = await discoverRepos([root], { ignore: DEFAULT_IGNORE, maxDepth: 4 });
    const paths = found.map((f) => f.gitPath);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('too-deep'))).toBe(false);
  });

  it('does not descend INTO a found repo (no nested scan inside .git)', async () => {
    const found = await discoverRepos([root], { ignore: DEFAULT_IGNORE, maxDepth: 4 });
    expect(
      found.filter((f) => f.gitPath.startsWith(join(root, 'repo-a', '.git') + sep))
    ).toHaveLength(0);
  });
});
