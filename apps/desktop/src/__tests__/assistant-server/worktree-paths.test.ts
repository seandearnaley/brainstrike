import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertWorktreeTargetOutsideRoots,
  externalToolForPath,
  generateWorktreeName,
  repositorySlug,
  resolveWorktreeTargetPath,
} from '../../assistant-server/worktree-paths';

describe('repositorySlug', () => {
  it('combines the repository basename with a short hash of the common dir', () => {
    const slug = repositorySlug(
      '/Users/me/GitHub/brainstrike',
      '/Users/me/GitHub/brainstrike/.git'
    );
    expect(slug).toMatch(/^brainstrike-[0-9a-f]{8}$/u);
  });

  it('separates two same-named repositories', () => {
    const a = repositorySlug('/a/app', '/a/app/.git');
    const b = repositorySlug('/b/app', '/b/app/.git');
    expect(a).not.toBe(b);
    expect(a.startsWith('app-')).toBe(true);
  });

  it('sanitizes a basename that is not filesystem-safe', () => {
    expect(repositorySlug('/x/My Repo!', '/x/My Repo!/.git')).toMatch(/^my-repo-[0-9a-f]{8}$/u);
  });
});

describe('generateWorktreeName', () => {
  it('produces an adjective-noun name', () => {
    expect(generateWorktreeName(new Set())).toMatch(/^[a-z]+-[a-z]+$/u);
  });

  it('never returns a taken name', () => {
    const taken = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const name = generateWorktreeName(taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });

  it('THROWS rather than inventing a colliding name when the space is exhausted', () => {
    // A silent numeric suffix would be a fallback; the caller must see this.
    const alwaysTaken = { has: () => true, size: 100_000 } as unknown as ReadonlySet<string>;
    expect(() => generateWorktreeName(alwaysTaken)).toThrow(
      'Could not generate an unused worktree name after 64 attempts.'
    );
  });
});

describe('resolveWorktreeTargetPath', () => {
  it('joins managedDirectory/slug/name', () => {
    expect(
      resolveWorktreeTargetPath('/home/me/.brainstrike/worktrees', 'app-abcd1234', 'bright-fox')
    ).toBe(path.join('/home/me/.brainstrike/worktrees', 'app-abcd1234', 'bright-fox'));
  });

  it('rejects a name that would escape the managed directory', () => {
    expect(() => resolveWorktreeTargetPath('/m', 'app-1', '../escape')).toThrow(
      'Worktree name must be a single path segment.'
    );
    expect(() => resolveWorktreeTargetPath('/m', 'app-1', 'a/b')).toThrow(
      'Worktree name must be a single path segment.'
    );
  });
});

describe('assertWorktreeTargetOutsideRoots', () => {
  it('accepts the excluded BrainStrike worktree tree and rejects adjacent scratch space', () => {
    expect(() =>
      assertWorktreeTargetOutsideRoots('/work/app/.brainstrike/worktrees/a/b', ['/work/app'])
    ).not.toThrow();
    expect(() =>
      assertWorktreeTargetOutsideRoots('/work/app/.brainstrike/scratch/a/b', ['/work/app'])
    ).toThrow(
      'Managed worktrees must not live inside the granted folder "/work/app" — change the location in Settings → Workspace.'
    );
  });

  it('accepts a target outside every granted root', () => {
    expect(() =>
      assertWorktreeTargetOutsideRoots('/home/me/.brainstrike/worktrees/a/b', ['/work/app'])
    ).not.toThrow();
  });

  it('REFUSES a target inside a granted root, naming the root (BST-1342)', () => {
    expect(() => assertWorktreeTargetOutsideRoots('/work/app/wt/alpha', ['/work/app'])).toThrow(
      'Managed worktrees must not live inside the granted folder "/work/app" — change the location in Settings → Workspace.'
    );
  });
});

describe('externalToolForPath', () => {
  it.each([
    ['/repo/.claude/worktrees/foo', 'claude-code'],
    ['/Users/me/.codex/worktrees/bar', 'codex'],
    ['/Users/me/.cursor/worktrees/baz', 'cursor'],
    ['/Users/me/.brainstrike/worktrees/app/qux', null],
    ['/work/app/wt/alpha', null],
  ])('labels %s as %s', (candidate, expected) => {
    expect(externalToolForPath(candidate)).toBe(expected);
  });
});
