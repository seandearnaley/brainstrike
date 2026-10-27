import { expect, type Locator, type Page } from '@playwright/test';

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
 * Open a browser tab in the shown conversation from the workspace "+" menu,
 * load `url` into it, and wait until its tab, named `title`, is selected.
 * Each browser tab belongs to a conversation, so one must be open first: a
 * fresh profile opens its first conversation shortly after the shell shows.
 */
export async function openBrowserPage(page: Page, url: string, title: string): Promise<Locator> {
  await expect(
    page
      .getByRole('tablist', { exact: true, name: 'Open assistant threads' })
      .getByRole('tab', { selected: true })
  ).toBeVisible({ timeout: 30_000 });
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
