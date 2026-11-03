/**
 * Desktop E2E: a file tab whose folder was closed says so, in the same words in its body and its
 * side pane, with no spinner, and Reopen brings the file back. Opening another folder replaces
 * the first, so the first one's open file is the closed-folder case; after a restart the tab has
 * no text cached, so its body shows the state too.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { ensureMockWorkspaceOpen } from './utils/layout-helpers';

test('a file whose folder closed names the folder and reopens it', async ({
  electron,
  electronApp,
  window: page,
}) => {
  test.setTimeout(180_000);
  const alphaRoot = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(alphaRoot).not.toBe('');
  const alphaName = path.basename(alphaRoot);
  writeFileSync(path.join(alphaRoot, 'alpha-file.txt'), 'ALPHA CONTENT\n');
  const bravoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-closed-folder-')));
  writeFileSync(path.join(bravoRoot, 'bravo-file.txt'), 'BRAVO CONTENT\n');
  try {
    await ensureMockWorkspaceOpen(page);
    await page.getByText('alpha-file.txt', { exact: true }).first().dblclick();
    await expect(page.getByText('ALPHA CONTENT').first()).toBeVisible({ timeout: 30_000 });

    // Opening folder B closes A.
    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, bravoRoot);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Open folder');
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: /Files/u }).first().click();
    await expect(page.getByText('bravo-file.txt').first()).toBeVisible({ timeout: 30_000 });

    // The open tab keeps the text it read; its side pane says A is closed.
    await page
      .getByRole('tab', { name: /alpha-file/u })
      .first()
      .click();
    await expect(page.getByTestId('file-tab-pane-unavailable')).toContainText(
      `${alphaName} is closed`
    );

    // After a restart the tab has no text yet: its body says the same, and nothing spins.
    const restarted = (await electron.restart()).window;
    await restarted
      .getByRole('tab', { name: /alpha-file/u })
      .first()
      .click();
    const body = restarted.getByTestId('file-folder-closed');
    await expect(body).toContainText(`${alphaName} is closed`, { timeout: 30_000 });
    await expect(restarted.getByTestId('file-tab-pane-unavailable')).toContainText(
      `${alphaName} is closed`
    );
    await expect(restarted.getByText(/Opening .*…|Connecting folder/u)).toHaveCount(0);

    await body.getByRole('button', { exact: true, name: 'Reopen folder' }).click();
    await expect(restarted.getByText('ALPHA CONTENT').first()).toBeVisible({ timeout: 30_000 });
    await expect(restarted.getByTestId('file-folder-closed')).toHaveCount(0);
  } finally {
    await electron.dispose();
    rmSync(bravoRoot, { force: true, recursive: true });
  }
});
