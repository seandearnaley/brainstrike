/**
 * Stage, unstage and revert from the Changes diff (ADR-0036), against a real
 * repository: the host applies each action with git, and the view redraws
 * from git's new state.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { createTempDirTracker, freshRepo, git } from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

const tempDirs = createTempDirTracker();
const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);

test.afterAll(() => {
  tempDirs.removeAll();
});

/** A repo whose `notes.txt` has two unstaged hunks, far enough apart to stay two. */
function repoWithTwoHunks(label: string): string {
  const repo = freshRepo({ label, prefix: 'bs-changes-actions-', tracker: tempDirs });
  writeFileSync(path.join(repo, 'notes.txt'), `${LINES.join('\n')}\n`);
  git(repo, ['add', 'notes.txt']);
  git(repo, ['commit', '-m', 'notes']);
  const edited = LINES.map((line, index) =>
    index === 2 || index === 26 ? `${line} edited` : line
  );
  writeFileSync(path.join(repo, 'notes.txt'), `${edited.join('\n')}\n`);
  return repo;
}

async function openChanges(page: Page, repo: string): Promise<void> {
  await seedRoot(page, repo, { reloadReason: 'changes-git-actions', rootId: randomUUID() });
  await setupAssistantMock(page);
  await ensureAssistantShellVisible(page);
  await page.getByTestId('workspace-add-tab').click({ timeout: 15_000 });
  await page.getByRole('menuitem', { name: /Changes/u }).click({ timeout: 15_000 });
}

async function chooseScope(page: Page, scope: 'staged' | 'unstaged'): Promise<void> {
  const surface = page.getByTestId('changes-surface');
  await surface.getByTestId('changeset-source-picker-trigger').click({ timeout: 30_000 });
  await page.getByTestId('changeset-source-worktree').first().hover({ timeout: 30_000 });
  await page.getByRole('menuitem', { exact: true, name: scope }).click();
}

const diffOf = (page: Page) => page.getByTestId('changes-surface').getByTestId('diff-review');

test('a hunk stages from Unstaged, and its file unstages from Staged', async ({ window: page }) => {
  test.setTimeout(120_000);
  const repo = repoWithTwoHunks('stage');
  await openChanges(page, repo);
  await chooseScope(page, 'unstaged');
  const hunkStage = diffOf(page).getByRole('button', { exact: true, name: 'Stage' });
  await expect(hunkStage).toHaveCount(2, { timeout: 30_000 });

  await hunkStage.first().click();
  await expect.poll(() => git(repo, ['diff', '--cached', '--numstat'])).toBe('1\t1\tnotes.txt\n');
  expect(git(repo, ['diff', '--cached'])).toContain('+line 3 edited');
  expect(git(repo, ['diff'])).toContain('+line 27 edited');
  await expect(hunkStage).toHaveCount(1);

  await chooseScope(page, 'staged');
  await diffOf(page).getByRole('button', { name: 'Unstage notes.txt' }).click({ timeout: 30_000 });
  await expect.poll(() => git(repo, ['diff', '--cached', '--numstat'])).toBe('');
  expect(git(repo, ['diff', '--numstat'])).toBe('2\t2\tnotes.txt\n');
});

test('a hunk reverts at once, a new file reverts after the question, and Stage all stages the rest', async ({
  window: page,
}) => {
  test.setTimeout(120_000);
  const repo = repoWithTwoHunks('revert');
  writeFileSync(path.join(repo, 'draft.txt'), 'a new file\n');
  await openChanges(page, repo);
  await chooseScope(page, 'unstaged');
  const diff = diffOf(page);
  await expect(diff.getByRole('button', { exact: true, name: 'Revert' })).toHaveCount(2, {
    timeout: 30_000,
  });

  await diff.getByRole('button', { exact: true, name: 'Revert' }).first().click();
  await expect
    .poll(() => readFileSync(path.join(repo, 'notes.txt'), 'utf8'))
    .toContain('\nline 3\n');
  expect(readFileSync(path.join(repo, 'notes.txt'), 'utf8')).toContain('line 27 edited');

  await diff.getByRole('button', { name: 'Revert draft.txt' }).click();
  const question = page.getByRole('alertdialog', { name: 'Revert draft.txt?' });
  await question.getByRole('button', { name: 'Revert' }).click();
  await expect.poll(() => existsSync(path.join(repo, 'draft.txt'))).toBe(false);

  await page.getByRole('button', { exact: true, name: 'Stage all' }).click();
  await expect.poll(() => git(repo, ['diff', '--numstat'])).toBe('');
  expect(git(repo, ['diff', '--cached', '--numstat'])).toBe('1\t1\tnotes.txt\n');
});
