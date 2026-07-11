import { expect, type Locator, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { ensureRightPanelVisible } from './utils/layout-helpers';

async function requireBoundingBox(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Expected a visible indexing surface with measurable geometry.');
  }
  return box;
}

test.describe('Embedding Worker Telemetry @stateful @web-db-startup', () => {
  /**
   * Indexing activity is now exposed through the app-shell status bar instead
   * of a Database-tab footer. This keeps queue/status visibility stable while
   * users navigate between collections and panels.
   */
  test('surfaces indexing activity in the app status bar', async ({ page }) => {
    const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
    const panelTimeout = isCI ? 20_000 : 8000;
    const home = new HomePage(page);

    await home.goto();
    await ensureRightPanelVisible(page);

    // Navigate to Database tab (BST-311: Vectors tab merged into Database)
    const databaseTab = page.getByRole('tab', { name: /database/i });
    await expect(databaseTab).toBeVisible({ timeout: panelTimeout });
    await databaseTab.click();

    const databasePanel = page.getByRole('tabpanel', { name: /database/i });
    await expect(databasePanel).toBeVisible({ timeout: panelTimeout });

    const indexingStatusItem = page.getByTestId('indexing-status-item');
    const indexingTrigger = page.getByTestId('indexing-status-trigger');
    const statusBarRight = page.getByTestId('status-bar-right');
    await expect(indexingStatusItem).toBeVisible({ timeout: panelTimeout });
    await expect(indexingStatusItem).toContainText('Workspace Index');
    await expect(statusBarRight).toContainText('Workspace Index');

    const triggerBox = await requireBoundingBox(indexingTrigger);
    const rightSlotBox = await requireBoundingBox(statusBarRight);
    expect(Math.abs(triggerBox.width - 192)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(triggerBox.x + triggerBox.width - (rightSlotBox.x + rightSlotBox.width))
    ).toBeLessThanOrEqual(1);

    await indexingTrigger.click();

    const indexingPopover = page.getByTestId('indexing-status-popover');
    await expect(indexingPopover).toBeVisible({ timeout: panelTimeout });
    await expect(indexingPopover.getByText('Files', { exact: true })).toBeVisible();
    await expect(indexingPopover.getByText('Chunks', { exact: true })).toBeVisible();
    await expect(indexingPopover.getByText('Embedded', { exact: true })).toBeVisible();
    await expect(indexingPopover.getByText('Pending', { exact: true })).toBeVisible();
    await expect(indexingPopover.getByText('Embedding queue', { exact: true })).toBeVisible();

    const popoverBox = await requireBoundingBox(indexingPopover);
    expect(Math.abs(popoverBox.width - 512)).toBeLessThanOrEqual(1);
    expect(Math.abs(popoverBox.height - 512)).toBeLessThanOrEqual(1);

    await indexingPopover.getByRole('button', { name: 'Worker and database diagnostics' }).click();
    await expect(indexingPopover.getByText('Worker state', { exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
    await page.setViewportSize({ height: 720, width: 320 });

    const compactLeftSlotBox = await requireBoundingBox(page.getByTestId('status-bar-left'));
    const compactRightSlotBox = await requireBoundingBox(page.getByTestId('status-bar-right'));
    const compactTriggerBox = await requireBoundingBox(indexingTrigger);
    expect(compactLeftSlotBox.x + compactLeftSlotBox.width).toBeLessThanOrEqual(
      compactRightSlotBox.x + 1
    );
    expect(compactTriggerBox.width).toBeLessThanOrEqual(41);
  });
});
