import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible, waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

interface CollectionSummaryCounts {
  embeddedChunks: number;
  fileCount: number;
  totalChunks: number;
}

const ROOT_NAME = 'database-import-backfill-root';
const FILE_TREE: FileTree = {
  'alpha.ts': 'export const alpha = "database import backfill";\nexport const beta = "web flow";',
  'notes.ts':
    'export const notes = ["Database Import Flow", "This fixture ensures the browser import flow creates chunks and embeddings."];',
};

function parseCollectionSummaryCounts(summaryText: string): CollectionSummaryCounts {
  const normalized = summaryText.replace(/\s+/g, ' ').trim();
  const match = normalized.match(
    /(\d+)\s+files?.*?(\d+)\s+chunks?.*?(\d+)\s*\/\s*(\d+)\s+embedded/i
  );

  if (!match) {
    throw new Error(`Unable to parse collection summary counts from: ${summaryText}`);
  }

  return {
    fileCount: Number(match[1]),
    totalChunks: Number(match[2]),
    embeddedChunks: Number(match[3]),
  };
}

async function getCollectionSummaryCounts(
  page: Page,
  collectionName: string
): Promise<CollectionSummaryCounts> {
  const option = page.getByRole('option').filter({ hasText: collectionName }).first();
  await expect(option).toBeVisible({ timeout: 15_000 });
  const text = await option.innerText();
  return parseCollectionSummaryCounts(text);
}

async function ensureDatabasePanelVisible(page: Page): Promise<void> {
  await ensureRightPanelVisible(page);
  const databaseTab = page.getByRole('tab', { name: /database/i });
  await expect(databaseTab).toBeVisible({ timeout: 15_000 });
  await databaseTab.click();
  await expect(page.getByRole('tabpanel', { name: /database/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
}

async function createCollection(page: Page, collectionName: string): Promise<void> {
  const databasePanel = page.getByTestId('database-demo-panel');
  await databasePanel.getByRole('button', { name: 'New' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Create Search Collection')).toBeVisible({ timeout: 15_000 });

  const nameInput = dialog.getByLabel('Name *');
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  await nameInput.fill(collectionName);

  const createButton = dialog.getByRole('button', { name: 'Create Collection' });
  await expect(createButton).toBeEnabled({ timeout: 15_000 });
  await createButton.click();

  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole('option').filter({ hasText: collectionName }).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function selectFilesForImport(page: Page): Promise<void> {
  const explorer = new FileExplorerPage(page);
  await explorer.selectRoot();
  await expect(explorer.selectAllButton).toBeEnabled({ timeout: 15_000 });
  await explorer.selectAllButton.click();
  await expect(page.getByText('2/10')).toBeVisible({ timeout: 15_000 });
}

async function waitForCollectionSummary(
  page: Page,
  collectionName: string,
  predicate: (counts: CollectionSummaryCounts) => boolean,
  timeoutMs = 120_000
): Promise<CollectionSummaryCounts> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const counts = await getCollectionSummaryCounts(page, collectionName);
    if (predicate(counts)) {
      return counts;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for collection summary for '${collectionName}'`);
}

test.describe('Database import and backfill (web)', () => {
  test('imports files, chunks them, backfills, and updates collection coverage without reload', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await mockBrowserApis(page, ROOT_NAME, FILE_TREE);
    await page.goto('/');
    await waitForAppLoad(page);

    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);

    const collectionName = `Web Import Backfill ${Date.now()}`;
    await ensureDatabasePanelVisible(page);
    await createCollection(page, collectionName);

    await selectFilesForImport(page);

    await ensureDatabasePanelVisible(page);
    const databasePanel = page.getByTestId('database-demo-panel');
    const importButton = databasePanel.getByRole('button', { name: /^Import \(\d+\)$/ });
    await expect(importButton).toContainText('(2)', { timeout: 15_000 });

    const timeOriginBeforeBackfill = await page.evaluate(() => window.performance.timeOrigin);

    await importButton.click();

    const importedCounts = await waitForCollectionSummary(
      page,
      collectionName,
      (counts) => counts.fileCount === 2 && counts.totalChunks > 0 && counts.embeddedChunks === 0
    );
    expect(importedCounts.fileCount).toBe(2);
    expect(importedCounts.totalChunks).toBeGreaterThan(0);
    expect(importedCounts.embeddedChunks).toBe(0);

    const backfillButton = databasePanel.getByRole('button', {
      name: /^(?:Backfill|Start & Backfill)(?:\s|$)/,
    });
    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await expect(backfillButton).toBeEnabled({ timeout: 15_000 });
    await backfillButton.click();

    const embeddedCounts = await waitForCollectionSummary(
      page,
      collectionName,
      (counts) => counts.totalChunks > 0 && counts.embeddedChunks === counts.totalChunks
    );

    expect(embeddedCounts.fileCount).toBe(2);
    expect(embeddedCounts.totalChunks).toBeGreaterThan(0);
    expect(embeddedCounts.embeddedChunks).toBe(embeddedCounts.totalChunks);
    await expect(backfillButton).toContainText(/Backfill/, { timeout: 15_000 });

    const timeOriginAfterBackfill = await page.evaluate(() => window.performance.timeOrigin);
    expect(timeOriginAfterBackfill).toBe(timeOriginBeforeBackfill);
  });
});
