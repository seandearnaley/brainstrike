import { expect, type Locator, type Page } from '@playwright/test';
import type { ModelProviderShim } from './model-provider-shim';
import { startThread } from './new-thread';

/** The workspace tab strip, where each browser page is a tab (BST-1271). */
export function workspaceTabs(page: Page): Locator {
  return page.getByRole('tablist', { exact: true, name: 'Workspace tabs' });
}

/** The shown page's address bar; other page tabs stay mounted, hidden. */
export function visibleAddress(page: Page): Locator {
  return page.getByTestId('browser-url-input').filter({ visible: true });
}

/** A `data:` page with a `<title>`, so no network is involved. */
export function titledPage(title: string): string {
  return `data:text/html,${encodeURIComponent(`<title>${title}</title><p>${title}</p>`)}`;
}

/**
 * Start a conversation for browser pages to belong to: a fresh profile opens
 * on the new-thread screen, and the first send creates the conversation. The
 * reply is scripted, and the run has ended on return, so a later script
 * cannot answer it. A provider must be configured first.
 */
export async function startConversation(
  page: Page,
  modelProvider: ModelProviderShim,
  prompt: string
): Promise<void> {
  const reply = `Ready: ${prompt}`;
  modelProvider.setScript(() => ({ finalText: reply }));
  const conversation = await startThread(page, prompt);
  await expect(conversation.getByText(reply, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(conversation.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0, {
    timeout: 30_000,
  });
}

/**
 * Open a browser tab in the shown conversation from the workspace "+" menu,
 * load `url` into it, and wait until its tab, named `title`, is selected.
 * Each browser tab belongs to a conversation, so start one first
 * (`startConversation`).
 */
export async function openBrowserPage(page: Page, url: string, title: string): Promise<Locator> {
  await expect(
    page
      .getByRole('tablist', { exact: true, name: 'Open assistant threads' })
      .getByRole('tab', { selected: true })
  ).toBeVisible();
  await page.getByTestId('workspace-add-tab').click({ timeout: 15_000 });
  await page.getByTestId('workspace-add-tab-new-browser-tab').click();
  const address = visibleAddress(page);
  await expect(address).toHaveValue('about:blank', { timeout: 15_000 });
  await address.fill(url);
  await address.press('Enter');
  const tab = workspaceTabs(page).getByRole('tab', { name: title });
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  return tab;
}
