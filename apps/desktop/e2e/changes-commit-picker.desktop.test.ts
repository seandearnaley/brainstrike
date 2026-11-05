/**
 * The Changes commit picker (ADR-0036), against a real repository: one of a
 * worktree's latest commits opens as its own diff.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { chooseCommit, diffOf, openChanges } from './utils/changes-surface';
import { createTempDirTracker, freshRepo, git } from './utils/git-fixtures';

const tempDirs = createTempDirTracker();

test.afterAll(() => {
  tempDirs.removeAll();
});

test("a worktree's commit opens as its own diff", async ({ window: page }) => {
  test.setTimeout(120_000);
  const repo = freshRepo({ label: 'commits', prefix: 'bs-changes-commits-', tracker: tempDirs });
  writeFileSync(path.join(repo, 'notes.txt'), 'one\n');
  git(repo, ['add', 'notes.txt']);
  git(repo, ['commit', '-m', 'Add notes']);
  writeFileSync(path.join(repo, 'hello.ts'), 'export const value = 2;\n');
  git(repo, ['commit', '-am', 'Bump the value']);

  await openChanges(page, repo, 'changes-commit-picker');
  await chooseCommit(page, 'Add notes');

  const diff = diffOf(page);
  await expect(diff.getByRole('button', { exact: true, name: 'notes.txt' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(diff.getByRole('button', { exact: true, name: 'hello.ts' })).toHaveCount(0);
});
