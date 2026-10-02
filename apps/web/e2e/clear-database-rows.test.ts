import type { Page } from '@playwright/test';
import type { WebE2EFileRowCounts, WebE2EResetRowCounts } from '../src/web-e2e-test-hooks';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible, waitForAppLoad } from './utils/layout-helpers';

const VECTOR_STATUS_UI_STORAGE_KEY = 'vector-status-ui.v1';

async function seedProbeRows(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E test hooks are not installed');
    }
    await hooks.seedResetProbeRows();
  });
}

async function seedFileRowsOnly(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E test hooks are not installed');
    }
    await hooks.seedFileRowsOnly();
  });
}

async function readProbeCounts(page: Page): Promise<WebE2EResetRowCounts> {
  return await page.evaluate(async () => {
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E test hooks are not installed');
    }
    return await hooks.readResetRowCounts();
  });
}

async function readFileRowCounts(page: Page): Promise<WebE2EFileRowCounts> {
  return await page.evaluate(async () => {
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E test hooks are not installed');
    }
    return await hooks.readFileRowCounts();
  });
}

async function linkResetProbeRowsToCollection(page: Page, collectionId: string): Promise<void> {
  await page.evaluate(async (id: string) => {
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E test hooks are not installed');
    }
    await hooks.linkResetProbeRowsToCollection(id);
  }, collectionId);
}

/**
 * Proves the absent-relation branch: calling `readResetRowCounts()` (which
 * selects from `mastra_workflow_snapshot`, unqualified) must throw 42P01
 * before anything seeds or creates the table. A test that skips this check
 * cannot tell an observer which of PR #1978's two code paths it exercised.
 */
async function assertWorkflowSnapshotRelationAbsent(page: Page): Promise<void> {
  const failureMessage = await page.evaluate(async () => {
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E test hooks are not installed');
    }
    try {
      await hooks.readResetRowCounts();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  expect(failureMessage).not.toBeNull();
  // Must be a genuine missing-relation error, not merely any error that
  // happens to mention the table name — `readFileRowCounts`'s own
  // "was not numeric" error would also match a substring check, silently
  // passing this assertion for the wrong reason.
  expect(failureMessage).toMatch(/relation .*mastra_workflow_snapshot.* does not exist/);
}

async function ensureDatabasePanelVisible(page: Page): Promise<void> {
  await ensureRightPanelVisible(page);
  const databaseTab = page.getByRole('tab', { name: /collections/i });
  await expect(databaseTab).toBeVisible({ timeout: 15_000 });
  await databaseTab.click();
  await expect(page.getByRole('tabpanel', { name: /collections/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
}

async function readActiveCollectionId(page: Page): Promise<string | null> {
  return await page.evaluate((storageKey: string) => {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { state?: { activeEmbeddingSetId?: unknown } };
    const id = parsed.state?.activeEmbeddingSetId;
    return typeof id === 'string' ? id : null;
  }, VECTOR_STATUS_UI_STORAGE_KEY);
}

async function waitForActiveCollectionId(page: Page, timeoutMs = 15_000): Promise<string> {
  const startedAt = Date.now();
  let lastId: string | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastId = await readActiveCollectionId(page);
    if (lastId) {
      return lastId;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(
    `Timed out waiting for an active embedding set id. Last value: ${String(lastId)}`
  );
}

/**
 * The Settings-panel "Clear All Collections" button is gated on the ACTIVE
 * collection's live counts (`ACTIVE_COLLECTION_LIVE_COUNTS_QUERY` in
 * `packages/db-explorer/src/use-database-demo-data.ts`), not on global table
 * counts — with zero collections, `activeCollectionCounts` is always
 * `{records: 0, chunks: 0}` and the button stays disabled forever.
 *
 * This drives the REAL "New Collection" dialog (same production code path as
 * `apps/web/e2e/database-import-backfill.test.ts`), which both creates a real
 * `embedding_sets` row and marks it active
 * (`CreateCollectionDialog.onCreated` -> `handleCollectionChange`). The
 * created collection's id is read back from the `vector-status-ui.v1`
 * persisted store (the same store the app itself reads from) rather than
 * clicking through the picker, since a directly-inserted row (desktop's
 * approach) has no equivalent on web without a raw SQL bridge.
 */
async function createActiveCollection(page: Page, collectionName: string): Promise<string> {
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

  return await waitForActiveCollectionId(page);
}

async function clickClearAllCollections(page: Page): Promise<void> {
  // "Clear All Collections" renders inside `SettingsPanel`, which only mounts
  // once the "Import Settings" popover trigger (an exact accessible name, see
  // `database-demo-panel.tsx`) is opened — `ensureDatabasePanelVisible` only
  // gets as far as the Collections tabpanel, not into this popover. An exact
  // match, unconditional click replaces the previous loose
  // `/import settings|settings/i` regex behind a swallowed `.catch(() =>
  // false)`, which risked matching the wrong "settings" control.
  await page.getByRole('button', { name: 'Import Settings' }).click();

  const clearButton = page.getByRole('button', { name: 'Clear All Collections' });
  await expect(clearButton).toBeVisible({ timeout: 10_000 });
  await expect(clearButton).toBeEnabled({ timeout: 10_000 });
  await clearButton.click();

  const confirmDialog = page.getByRole('dialog');
  await expect(confirmDialog).toBeVisible({ timeout: 5000 });
  await confirmDialog.getByRole('button', { name: /clear/i }).first().click();
  await expect(confirmDialog).not.toBeVisible({ timeout: 15_000 });
}

/**
 * Asserts ROW COUNTS, never the success toast: the defect class PR #1978 fixed
 * is a FALSE SUCCESS, so a toast assertion would reproduce the blind spot.
 *
 * `mastra_workflow_snapshot` is created lazily by
 * `PgliteWorkflowsStore.initialize()` and by NO migration (unlike desktop,
 * where the assistant server creates it at boot before any test can run — see
 * `apps/desktop/e2e/clear-database-rows.desktop.test.ts`). A `to_regclass`
 * probe against a fresh web profile (via `readResetRowCounts()` throwing
 * before any seed) confirmed the relation is ABSENT on web, so BOTH of
 * PR #1978's code paths are covered here:
 *   - the main test seeds the table itself (`seedResetProbeRows`, Task 3),
 *     exercising the PRESENT branch of `clearRelationIfPresent` (called with
 *     `MASTRA_WORKFLOW_TABLE`; formerly `clearWorkflowSnapshotsIfPresent`,
 *     renamed and consolidated by PR #1986).
 *   - the second test seeds only `file_records`/`file_chunks` and proves the
 *     table is genuinely absent first, exercising the branch PR #1978 broke:
 *     a swallowed 42P01 aborting the transaction so every later statement
 *     fails 25P02 and the whole clear silently rolls back.
 */
test.describe('Clear Database clears rows (web) @destructive @web-clear-database', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test.fixme('clears file records, chunks, and workflow snapshots', {
    annotation: { description: 'BST-1962', type: 'quarantine' },
  }, async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await waitForAppLoad(page);

    await seedProbeRows(page);

    const before = await readProbeCounts(page);
    expect(before.fileRecords).toBeGreaterThan(0);
    expect(before.fileChunks).toBeGreaterThan(0);
    expect(before.workflowSnapshots).toBeGreaterThan(0);

    await ensureDatabasePanelVisible(page);
    const collectionId = await createActiveCollection(page, `Clear DB Probe ${Date.now()}`);
    await linkResetProbeRowsToCollection(page, collectionId);

    await clickClearAllCollections(page);

    await expect
      .poll(() => readProbeCounts(page), {
        message: 'expected Clear Database to empty every probed relation',
        timeout: 20_000,
      })
      .toEqual({ fileChunks: 0, fileRecords: 0, workflowSnapshots: 0 });
  });

  test.fixme('clears file records and chunks when mastra_workflow_snapshot is absent', {
    annotation: { description: 'BST-1962', type: 'quarantine' },
  }, async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await waitForAppLoad(page);

    await assertWorkflowSnapshotRelationAbsent(page);

    await seedFileRowsOnly(page);

    const before = await readFileRowCounts(page);
    expect(before.fileRecords).toBeGreaterThan(0);
    expect(before.fileChunks).toBeGreaterThan(0);

    await ensureDatabasePanelVisible(page);
    const collectionId = await createActiveCollection(page, `Clear DB Absent Probe ${Date.now()}`);
    await linkResetProbeRowsToCollection(page, collectionId);

    // Re-assert absence immediately before the action: the absence of
    // mastra_workflow_snapshot is the premise of this test, and it must hold
    // at the moment Clear Database is invoked, not merely at setup. If a
    // future change made collection creation boot Mastra memory, only this
    // second check would catch the test silently degrading into a duplicate
    // of the present-relation test above.
    await assertWorkflowSnapshotRelationAbsent(page);

    await clickClearAllCollections(page);

    await expect
      .poll(() => readFileRowCounts(page), {
        message:
          'expected Clear Database to empty file_records and file_chunks even when mastra_workflow_snapshot is absent',
        timeout: 20_000,
      })
      .toEqual({ fileChunks: 0, fileRecords: 0 });
  });
});
