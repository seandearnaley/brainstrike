import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { readIndexConfig } from './utils/index-config';

async function openSearchIndexingSettings(page: Page) {
  await new HomePage(page).openSettings();
  await page.getByRole('button', { name: 'Search & Indexing' }).click();
  const section = page.getByTestId('settings-category-search-indexing');
  await expect(section).toBeVisible({ timeout: 15_000 });
  return section;
}

async function readNativeStatus(
  page: Page
): Promise<Awaited<ReturnType<IndexSearchCapability['status']>>> {
  return await page.evaluate(async () => {
    const capability = (
      window as Window & {
        readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
      }
    ).__brainstrikeTestHooks__?.indexSearch;
    if (!capability) {
      throw new Error('Native indexing capability is unavailable.');
    }
    return await capability.status();
  });
}

async function readyStoreId(page: Page): Promise<string> {
  const status = await readNativeStatus(page);
  if (status.kind !== 'ready') {
    throw new Error(`Native indexing is not ready: ${status.reason}`);
  }
  return status.storeId;
}

test.describe('Search & Indexing settings (desktop)', () => {
  test('keeps the chosen file policy and Text search across a restart', async ({
    electron,
  }, testInfo) => {
    const { window } = await electron.ensureContext();
    const section = await openSearchIndexingSettings(window);
    const text = section.getByRole('group', { name: 'Search mode' }).getByRole('button', {
      name: /^Text/u,
    });
    await expect(text).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    // The file policy applies at once, apart from the choices Apply re-indexes with.
    await section.getByRole('combobox', { exact: true, name: 'Files' }).click();
    await window.getByRole('option', { exact: true, name: 'Full root' }).click();
    await expect(section.getByRole('combobox', { exact: true, name: 'Files' })).toContainText(
      'Full root'
    );
    await expect
      .poll(() => readIndexConfig(window), { timeout: 15_000 })
      .toMatchObject({ mode: 'text', policy: 'full-root' });
    await expect
      .poll(() => readNativeStatus(window), { timeout: 15_000 })
      .toMatchObject({ embedding: { indexMode: 'text-only' }, kind: 'ready' });
    const storeId = await readyStoreId(window);
    await testInfo.attach('chosen-before-restart', {
      body: JSON.stringify(
        { config: await readIndexConfig(window), status: await readNativeStatus(window) },
        null,
        2
      ),
      contentType: 'application/json',
    });

    const restarted = await electron.restart();
    const reopened = await openSearchIndexingSettings(restarted.window);
    await expect(reopened.getByRole('combobox', { exact: true, name: 'Files' })).toContainText(
      'Full root',
      { timeout: 15_000 }
    );
    await expect(
      reopened.getByRole('group', { name: 'Search mode' }).getByRole('button', { name: /^Text/u })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(await readIndexConfig(restarted.window)).toMatchObject({
      mode: 'text',
      policy: 'full-root',
    });
    await expect
      .poll(() => readNativeStatus(restarted.window), { timeout: 15_000 })
      .toMatchObject({ embedding: { indexMode: 'text-only' }, kind: 'ready' });
    expect(await readyStoreId(restarted.window)).toBe(storeId);
    await testInfo.attach('chosen-after-restart', {
      body: JSON.stringify(
        {
          config: await readIndexConfig(restarted.window),
          status: await readNativeStatus(restarted.window),
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
  });
});
