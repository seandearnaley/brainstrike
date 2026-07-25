import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { showDatabaseDemoPanel, waitForDatabaseReady } from './utils/layout-helpers';
import { readResetProbeCounts, seedResetProbeRows } from './utils/reset-seed-helpers';

/**
 * Guards PR #1978: a swallowed 42P01 inside `db.transaction(...)` left the
 * transaction aborted, the next statement raised 25P02, and the whole clear
 * rolled back behind a misleading message — while the unit tests stayed green
 * because they mock `tx.query` with `vi.fn()`.
 *
 * Asserts ROW COUNTS, never the success toast: the defect class is a FALSE
 * SUCCESS, so asserting the toast would reproduce the original blind spot.
 */

/**
 * The Settings-panel "Clear All Collections" button is gated on the ACTIVE
 * collection's row counts (`ACTIVE_COLLECTION_LIVE_COUNTS_QUERY` in
 * packages/db/src/services/collection-indexing-stats.ts), not on global table
 * counts. `seedResetProbeRows` deliberately seeds bare probe rows with a NULL
 * `embedding_set_id` (see Task 1), and a fresh profile has zero collections,
 * so without this the button stays disabled in its "Counts pending" state
 * forever and the real UI path can never be exercised.
 *
 * This creates a real `embedding_sets` row and links the seeded probe rows to
 * it purely to satisfy that UI enablement gate. The wipe itself still goes
 * through the unmodified production `db:clearAll` handler once the button is
 * clicked, and that handler clears every relation regardless of collection
 * scoping — so this setup step does not weaken what the test proves.
 */
async function linkProbeRowsToNewCollection(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const api = (window as Window & { electronAPI?: unknown }).electronAPI;
    const query = (
      api as { db?: { query?: (sql: string, params?: readonly unknown[]) => Promise<unknown> } }
    )?.db?.query;
    if (typeof query !== 'function') {
      throw new Error('Electron db.query bridge is not available');
    }

    const collectionId = crypto.randomUUID();
    await query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        collectionId,
        'reset-probe-model',
        'reset-probe-model',
        8,
        'cosine',
        'Reset Probe Collection',
      ]
    );
    await query("UPDATE file_records SET embedding_set_id = $1 WHERE path LIKE 'reset-probe://%'", [
      collectionId,
    ]);
    await query(
      "UPDATE file_chunks SET embedding_set_id = $1 WHERE content = 'reset probe chunk'",
      [collectionId]
    );

    return collectionId;
  });
}

test.describe('Clear Database clears rows (desktop) @destructive @desktop-db-storage', () => {
  test.describe.configure({ mode: 'serial' });

  test('clears file records, chunks, and workflow snapshots', async ({ window }) => {
    const readyPage = await waitForDatabaseReady(window);
    const panelPage = await showDatabaseDemoPanel(readyPage);

    await seedResetProbeRows(panelPage);

    const before = await readResetProbeCounts(panelPage);
    expect(before.fileRecords).toBeGreaterThan(0);
    expect(before.fileChunks).toBeGreaterThan(0);
    expect(before.workflowSnapshots).toBeGreaterThan(0);

    const panelScope = panelPage.locator('[data-testid="database-demo-panel"]');

    // Link the seeded probe rows to a real collection and select it — see
    // linkProbeRowsToNewCollection for why this step is required.
    await linkProbeRowsToNewCollection(panelPage);
    const collectionOption = panelScope.getByRole('option', { name: /Reset Probe Collection/ });
    await expect(collectionOption).toBeVisible({ timeout: 10_000 });
    await collectionOption.click();

    // Expand Import Settings > Danger Zone, where Clear All Collections lives.
    // The settings content renders in a portal, so the button is queried from
    // the page root rather than from the panel scope.
    const clearButton = panelPage.getByRole('button', { name: 'Clear All Collections' });
    if (!(await clearButton.isVisible({ timeout: 500 }).catch(() => false))) {
      await panelScope
        .getByRole('button', { name: /import settings|settings/i })
        .first()
        .click();
    }
    await expect(clearButton).toBeVisible({ timeout: 10_000 });
    await expect(clearButton).toBeEnabled({ timeout: 15_000 });
    await clearButton.click();

    const confirmDialog = panelPage.getByRole('dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    await confirmDialog.getByRole('button', { name: /clear/i }).first().click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 15_000 });

    await expect
      .poll(() => readResetProbeCounts(panelPage), {
        message: 'expected Clear Database to empty every probed relation',
        timeout: 20_000,
      })
      .toEqual({ fileChunks: 0, fileRecords: 0, workflowSnapshots: 0 });
  });
});
