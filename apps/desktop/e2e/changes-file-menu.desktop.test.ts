/**
 * A changed file from the Changes diff (ADR-0036), against a real repository:
 * a line number of the new version opens the file at that line, and a file
 * header's right-click copies the file's patch.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { workspaceTabs } from './utils/browser-page-helpers';
import { chooseScope, diffOf, openChanges } from './utils/changes-surface';
import { createTempDirTracker, freshRepo, git } from './utils/git-fixtures';

const tempDirs = createTempDirTracker();

test.afterAll(() => {
  tempDirs.removeAll();
});

test("a line number opens its file, and a file's menu copies its patch", async ({
  electronApp,
  window: page,
}) => {
  test.setTimeout(120_000);
  const { app } = electronApp;
  const repo = freshRepo({ label: 'file-menu', prefix: 'bs-changes-menu-', tracker: tempDirs });
  writeFileSync(path.join(repo, 'notes.txt'), 'one\ntwo\nthree\n');
  git(repo, ['add', 'notes.txt']);
  git(repo, ['commit', '-m', 'notes']);
  writeFileSync(path.join(repo, 'notes.txt'), 'one\nTWO\nthree\n');
  await openChanges(page, repo, 'changes-file-menu');
  await chooseScope(page, 'unstaged');
  const diff = diffOf(page);
  const header = diff.getByRole('button', { exact: true, name: 'notes.txt' });
  await expect(header).toBeVisible({ timeout: 30_000 });

  await header.click({ button: 'right' });
  await page.getByRole('menuitem', { exact: true, name: 'Copy Patch' }).click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('diff --git a/notes.txt b/notes.txt');
  const patch = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(patch).toContain('-two\n+TWO\n');

  await diff.locator('[data-additions] [data-column-number="2"]').click();
  await expect(workspaceTabs(page).getByRole('tab', { name: /notes\.txt/u })).toBeVisible({
    timeout: 15_000,
  });
});
