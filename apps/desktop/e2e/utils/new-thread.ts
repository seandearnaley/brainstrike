import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Starts a thread the way a person does: New (or a fresh profile) shows the
 * new-thread screen, and its first send creates the thread. Returns the
 * created thread's tab panel once its tab is the selected one.
 */
export async function startThread(page: Page, prompt: string): Promise<Locator> {
  const welcome = page.getByTestId('new-thread-welcome');
  if (!(await welcome.isVisible())) {
    await page.getByTestId('assistant-new-thread-button').click();
  }
  const input = welcome.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(prompt);
  await welcome.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(welcome).toBeHidden({ timeout: 30_000 });
  const selected = page
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab', { selected: true });
  await expect(selected).toBeVisible({ timeout: 30_000 });
  const panelId = await selected.getAttribute('aria-controls');
  if (!panelId) {
    throw new Error('The started thread tab controls no panel');
  }
  return page.locator(`[id="${panelId}"]`);
}
