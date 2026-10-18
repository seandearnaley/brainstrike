// @vitest-environment node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared';

/**
 * A nested Git repository inside a managed worktree is not in the archive
 * snapshot: `git add -A` records at most a gitlink, and the nested repository's
 * commits and untracked files live only in its own `.git`. Archive refuses
 * rather than deleting them with the worktree, and `force` does not override
 * it (BST-1625).
 */
describe('WorktreeService archive with nested repositories (real git + real SQLite)', () => {
  let db: StateStore;
  let managedDirectory: string;
  let repo: string;
  const workspace = createTestWorkspace();

  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-worktree-state-'));
    repo = workspace.freshRepo('nested-archive-repo');
    managedDirectory = workspace.freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  async function createWorktree(name: string) {
    const service = buildTestService({ db, managedDirectory, repo });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: `bs/${name}` },
      createdBy: 'user',
      name,
      rootId: 'r-1',
    });
    if (!created.ok) {
      throw new Error(created.error);
    }
    return { service, worktree: created.value.worktree };
  }

  function initNestedRepository(directory: string, commit: boolean): void {
    mkdirSync(directory, { recursive: true });
    git(directory, ['init', '--quiet', '-b', 'main']);
    git(directory, ['config', 'user.email', 'test@brainstrike.invalid']);
    git(directory, ['config', 'user.name', 'BrainStrike Test']);
    if (commit) {
      writeFileSync(path.join(directory, 'committed.ts'), 'export const nested = true;\n');
      git(directory, ['add', 'committed.ts']);
      git(directory, ['commit', '--quiet', '-m', 'nested work']);
    }
    writeFileSync(path.join(directory, 'scratch.md'), 'untracked nested notes\n');
  }

  const refusal = (paths: string) =>
    `This worktree contains nested Git repositories that the archive snapshot cannot restore: ${paths}. Their commits and files would be deleted with the worktree. Move them out of the worktree before archiving.`;

  it('refuses even with force, and leaves the nested commits and untracked files intact', async () => {
    const { service, worktree } = await createWorktree('nested-committed');
    const nested = path.join(worktree.path, 'tools', 'vendored');
    initNestedRepository(nested, true);

    await expect(service.archive({ force: true, worktreeId: worktree.id })).resolves.toEqual({
      error: refusal('tools/vendored'),
      ok: false,
    });

    expect(existsSync(worktree.path)).toBe(true);
    expect(git(nested, ['log', '--format=%s']).trim()).toBe('nested work');
    expect(readFileSync(path.join(nested, 'scratch.md'), 'utf8')).toBe('untracked nested notes\n');
  });

  it('refuses a nested repository with no commits with the same refusal, not a git add failure', async () => {
    const { service, worktree } = await createWorktree('nested-empty');
    const nested = path.join(worktree.path, 'sandbox');
    initNestedRepository(nested, false);

    await expect(service.archive({ force: true, worktreeId: worktree.id })).resolves.toEqual({
      error: refusal('sandbox'),
      ok: false,
    });
    expect(readFileSync(path.join(nested, 'scratch.md'), 'utf8')).toBe('untracked nested notes\n');
  });

  it('refuses an embedded repository already committed as a gitlink', async () => {
    const { service, worktree } = await createWorktree('nested-gitlink');
    const nested = path.join(worktree.path, 'embedded');
    initNestedRepository(nested, true);
    git(worktree.path, ['add', 'embedded']);
    git(worktree.path, [
      '-c',
      'user.email=test@brainstrike.invalid',
      '-c',
      'user.name=BrainStrike Test',
      'commit',
      '--quiet',
      '-m',
      'embed a repository',
    ]);

    await expect(service.archive({ force: true, worktreeId: worktree.id })).resolves.toEqual({
      error: refusal('embedded'),
      ok: false,
    });
    expect(git(nested, ['log', '--format=%s']).trim()).toBe('nested work');
  });

  it('archives once the nested repository is moved out', async () => {
    const { service, worktree } = await createWorktree('nested-moved');
    const nested = path.join(worktree.path, 'sandbox');
    initNestedRepository(nested, true);
    await expect(service.archive({ force: true, worktreeId: worktree.id })).resolves.toMatchObject({
      ok: false,
    });

    const outside = path.join(workspace.freshTempDir('bst-nested-moved-'), 'sandbox');
    renameSync(nested, outside);

    const archived = await service.archive({ force: true, worktreeId: worktree.id });
    expect(archived.ok).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(outside, ['log', '--format=%s']).trim()).toBe('nested work');
  });
});
