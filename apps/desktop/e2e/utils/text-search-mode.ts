import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { expect, type Page } from '@playwright/test';
import { HomePage } from '../page-objects/home-page';
import { SettingsPage } from '../page-objects/settings-page';

/** Text search through the visible Search & Indexing control, choosing no embedding model. */
export async function chooseTextSearch(page: Page): Promise<void> {
  const home = new HomePage(page);
  await home.openSettings();
  const section = await new SettingsPage(page).openCategory(
    /Search & Indexing/i,
    'search-indexing'
  );
  await section.getByRole('combobox', { name: 'Search mode' }).click();
  await page.getByRole('option', { exact: true, name: 'Text search' }).click();
  await home.leaveSettings();
}

/** The renderer's native index status, as the Search panel and status bar read it. */
export async function nativeStatus(
  page: Page
): Promise<Awaited<ReturnType<IndexSearchCapability['status']>>> {
  return await page.evaluate(async () => {
    const capability = (window as Window & { readonly indexSearch?: IndexSearchCapability })
      .indexSearch;
    if (!capability) {
      throw new Error('The native index capability is unavailable');
    }
    return await capability.status();
  });
}

/**
 * The status bar reads Ready, and still does after the provider's next progress
 * reads (it polls every 2 s); a refused read would flip it to Blocked.
 */
export async function expectStatusBarReady(page: Page): Promise<void> {
  const status = page.getByTestId('indexing-status-value');
  await expect(status).toHaveText('Ready', { timeout: 30_000 });
  await page.waitForTimeout(5000);
  await expect(status).toHaveText('Ready');
}

/** A compact readiness summary: Text-ready with this many fully scanned folders, or the raw status. */
export async function textReadiness(page: Page): Promise<unknown> {
  const status = await nativeStatus(page);
  return status.kind === 'ready' && status.rootReadiness.every((root) => root.scanComplete)
    ? {
        folders: status.rootReadiness.length,
        indexMode: status.embedding.indexMode,
        kind: status.kind,
      }
    : status;
}
