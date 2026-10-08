/**
 * Desktop E2E: deleting a committed agent-host thread from the Threads panel.
 *
 * Host thread deletion erases the thread from the host's state log and its
 * derived state index; the row must disappear without an error and stay gone
 * after a reload re-reads the host's thread list.
 */
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

test('deletes a committed host thread from the Threads panel and it stays deleted after reload', async ({
  window: page,
}) => {
  test.setTimeout(120_000);
  await setupAssistantMock(page, { variant: 'simple' });
  await ensureAssistantShellVisible(page);
  const strip = page.getByRole('tablist', { name: 'Open assistant threads' });
  await expect(strip).toBeVisible({ timeout: 30_000 });
  const newThread = page.getByTestId('assistant-new-thread-button');
  for (let count = await strip.getByRole('tab').count(); count < 2; count += 1) {
    await expect(newThread).toBeEnabled({ timeout: 15_000 });
    await newThread.click();
    await expect(strip.getByRole('tab')).toHaveCount(count + 1, { timeout: 15_000 });
  }

  const rows = page.getByTestId('thread-row');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  const target = rows.nth(1);
  await target.getByRole('button', { name: /^Thread actions / }).click();
  await page.getByRole('button', { exact: true, name: 'Delete…' }).click();
  await page.getByRole('button', { name: /^Confirm delete thread / }).click();

  await expect(rows).toHaveCount(1, { timeout: 30_000 });

  await page.reload();
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
});
