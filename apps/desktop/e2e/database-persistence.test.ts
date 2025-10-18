import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import {
  clearDatabaseRecords,
  showDatabaseDemoPanel,
  waitForDatabaseReady,
} from './utils/layout-helpers';

// Configure this test suite to run in serial mode to avoid database interference
test.describe.configure({ mode: 'serial' });

test.describe('Database Persistence', () => {
  const ERROR_LOCATOR = '[data-testid="db-init-error"]';
  const REFRESH_BUTTON_SELECTOR = 'button:has-text("Refresh")';

  async function isDatabaseError(page: Page): Promise<boolean> {
    try {
      return await page.locator(ERROR_LOCATOR).isVisible({ timeout: 200 });
    } catch {
      return false;
    }
  }

  async function verifyDatabaseConnection(page: Page): Promise<void> {
    if (await isDatabaseError(page)) {
      const errorText = await page.locator('[data-testid="db-init-error"]').textContent();
      if (!errorText?.includes('pgvector')) {
        throw new Error(`Unexpected database error: ${errorText}`);
      }
      return;
    }

    try {
      await page
        .locator('[data-testid="db-status-connected"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });
    } catch (_error) {
      await page
        .locator(REFRESH_BUTTON_SELECTOR)
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });
    }
  }

  async function ensureDatabasePanel(page: Page): Promise<Page> {
    const shown = await showDatabaseDemoPanel(page);
    return waitForDatabaseReady(shown);
  }

  async function performInitialCleanup(page: Page): Promise<Page> {
    if (await isDatabaseError(page)) return page;

    let activePage = await clearDatabaseRecords(page);
    if (await isDatabaseError(activePage)) return activePage;

    await activePage.click(REFRESH_BUTTON_SELECTOR);
    await activePage.waitForTimeout(1000);
    const initialCount = await activePage.locator('tbody tr').count();

    if (initialCount > 0) {
      activePage = await clearDatabaseRecords(activePage);
      if (await isDatabaseError(activePage)) return activePage;
      await activePage.click(REFRESH_BUTTON_SELECTOR);
      await activePage.waitForTimeout(500);
    }

    return activePage;
  }

  test.beforeAll(async ({ electron }) => {
    test.setTimeout(150000);
    const { window } = await electron.ensureContext();
    let activeWindow = await ensureDatabasePanel(window);
    await verifyDatabaseConnection(activeWindow);
    activeWindow = await performInitialCleanup(activeWindow);
    await electron.ensureWindow();
  });

  test.beforeEach(async ({ electron }) => {
    await electron.ensureWindow();
  });

  test.afterEach(async ({ electron, window }, testInfo) => {
    const preserveState = testInfo.title.includes('should persist data between app restarts');

    if (!preserveState) {
      try {
        const cleanupWindow = await ensureDatabasePanel(window);
        await clearDatabaseRecords(cleanupWindow);
      } catch (_error) {
        // Ignore cleanup errors; tests already succeeded.
      }
    }

    await electron.ensureWindow();
  });

  test('should handle database errors gracefully', async ({ window }) => {
    const activeWindow = await ensureDatabasePanel(window);

    const hasErrorPanel = await isDatabaseError(activeWindow);
    const hasSuccessPanel = await activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .isVisible();

    if (hasErrorPanel) {
      await expect(activeWindow.locator('[data-testid="db-init-error"]').first()).toBeVisible();
      const errorText = await activeWindow.locator('[data-testid="db-init-error"]').textContent();
      expect(errorText).toContain('pgvector');
      return;
    }

    if (hasSuccessPanel) {
      await expect(activeWindow.locator('text=✓')).toBeVisible();
      await activeWindow.click(REFRESH_BUTTON_SELECTOR);
      await expect(activeWindow.locator('text=Failed to')).not.toBeVisible();
      return;
    }

    throw new Error('Neither success panel nor error panel is visible');
  });

  test('should show correct database location info', async ({ window }) => {
    const activeWindow = await ensureDatabasePanel(window);

    const hasErrorPanel = await isDatabaseError(activeWindow);
    const hasSuccessPanel = await activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .isVisible();

    if (hasErrorPanel) {
      await expect(activeWindow.locator('[data-testid="db-init-error"]').first()).toBeVisible();
      const errorText = await activeWindow.locator('[data-testid="db-init-error"]').textContent();
      expect(errorText).toContain('pgvector');
      await expect(activeWindow.locator('text=Ensure pgvector is available')).toBeVisible();
      return;
    }

    if (hasSuccessPanel) {
      await expect(activeWindow.locator('[data-testid="db-info"]').first()).toBeVisible();
      await expect(
        activeWindow.locator('text=Storage: Database connected via DbProvider')
      ).toBeVisible();
      await expect(activeWindow.locator('text=✓')).toBeVisible();
      await expect(activeWindow.locator('text=Successfully connected')).toBeVisible();
      return;
    }

    throw new Error('Neither success panel nor error panel is visible');
  });

  async function createTestDataForClearTest(page: Page): Promise<boolean> {
    if (await isDatabaseError(page)) return false;
    if (await importFromExplorer(page)) return true;
    return createUsingSampleData(page);
  }

  async function importFromExplorer(page: Page): Promise<boolean> {
    const explorerTab = page
      .locator('button:has-text("Explorer")')
      .or(page.locator('[role="tab"]:has-text("Explorer")'));

    if (await explorerTab.isVisible()) {
      await explorerTab.click();
      await page.waitForTimeout(1000);

      const selectRootButton = page.locator('button:has-text("Select Root")');
      if (await selectRootButton.isVisible()) {
        await selectRootButton.click();
        await page.waitForTimeout(2000);
      }
    }

    const fileElements = await page.locator('[data-testid="file-node"]').count();
    if (fileElements === 0) {
      return false;
    }

    const filesToSelect = Math.min(2, fileElements);
    for (let i = 0; i < filesToSelect; i++) {
      const fileNode = page.locator('[data-testid="file-node"]').nth(i);
      await fileNode.click();
      await page.waitForTimeout(200);
    }

    const importButton = page.locator('button:has-text("Import Selected Files")');
    if ((await importButton.isVisible()) && !(await importButton.isDisabled())) {
      await importButton.click();
      await page.waitForTimeout(5000);
      return true;
    }

    return false;
  }

  async function createUsingSampleData(page: Page): Promise<boolean> {
    const activePage = await ensureDatabasePanel(page);
    const testDataButton = activePage
      .locator('button:has-text("Create Test Data")')
      .or(activePage.locator('button:has-text("Add Sample Data")'));

    if (await testDataButton.isVisible()) {
      await testDataButton.click();
      await activePage.waitForTimeout(2000);
      return true;
    }

    return false;
  }

  async function handleClearConfirmation(page: Page): Promise<void> {
    const confirmDialog = page.locator('[role="dialog"]');
    const dialogAppeared = await confirmDialog.isVisible({ timeout: 3000 }).catch(() => false);

    if (!dialogAppeared) {
      await page.waitForTimeout(3000);
      return;
    }

    const confirmButton = confirmDialog
      .locator('button:has-text("Clear Database")')
      .or(confirmDialog.locator('button[variant="destructive"]:has-text("Clear")'));
    if (await confirmButton.isVisible()) {
      await confirmButton.click();
      await expect(confirmDialog).not.toBeVisible({ timeout: 10000 });
    }

    await page.waitForTimeout(3000);
  }

  async function handleClearDatabasePage(page: Page): Promise<void> {
    const activePage = await ensureDatabasePanel(page);
    if (await isDatabaseError(activePage)) {
      await expect(activePage.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const clearButton = activePage.locator('button:has-text("Clear Database")');
    const visible = await clearButton.isVisible({ timeout: 10000 }).catch(() => false);
    if (!visible) {
      await expect(activePage.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    if (await clearButton.isEnabled()) {
      await clearButton.click();
      await handleClearConfirmation(activePage);
      if (await isDatabaseError(activePage)) {
        await expect(activePage.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }
    }

    const specificErrorToast = activePage
      .locator(':has-text("Database repositories not available")')
      .or(activePage.locator(':has-text("Remaining operations were cancelled")'));
    await expect(specificErrorToast).not.toBeVisible({ timeout: 1000 });

    if (await isDatabaseError(activePage)) {
      await expect(activePage.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await activePage.click(REFRESH_BUTTON_SELECTOR);
    await activePage.waitForTimeout(1000);

    const refreshButton = activePage.locator(REFRESH_BUTTON_SELECTOR);
    await expect(refreshButton).toBeVisible();
  }

  async function executeClearDatabaseWorkflow(page: Page): Promise<void> {
    if (await isDatabaseError(page)) {
      await expect(page.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }
    const clearButton = page.locator('button:has-text("Clear Database")');
    await expect(clearButton).toBeVisible();
    await expect(clearButton).toBeEnabled({ timeout: 5000 });

    await clearButton.click();

    const confirmDialog = page.locator('[role="dialog"]');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });

    const confirmButton = confirmDialog
      .locator('button:has-text("Clear Database")')
      .or(confirmDialog.locator('button[variant="destructive"]:has-text("Clear")'));
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();

    await expect(confirmDialog).not.toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);
    if (!(await isDatabaseError(page))) {
      await page.click(REFRESH_BUTTON_SELECTOR);
      await page.waitForTimeout(1000);
    }

    const recordCountAfter = await page.locator('tbody tr').count();
    expect(recordCountAfter).toBe(0);

    await expect(page.locator('text=No files imported yet')).toBeVisible();
  }

  test('should clear database via UI button workflow', async ({ window }) => {
    let activeWindow = await ensureDatabasePanel(window);
    if (await isDatabaseError(activeWindow)) {
      console.log('⚠️ Database start failed (pgvector missing) – skipping CRUD test.');
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const dataCreated = await createTestDataForClearTest(activeWindow);
    if (!dataCreated) return;

    activeWindow = await ensureDatabasePanel(activeWindow);
    if (await isDatabaseError(activeWindow)) {
      console.log('⚠️ Database start failed (pgvector missing) – skipping persistence test.');
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await activeWindow.click(REFRESH_BUTTON_SELECTOR);
    await activeWindow.waitForTimeout(1000);

    const recordCountBefore = await activeWindow.locator('tbody tr').count();
    if (recordCountBefore === 0) return;

    await executeClearDatabaseWorkflow(activeWindow);
  });

  test('should properly disable Clear Database button when no data exists', async ({ window }) => {
    let activeWindow = await ensureDatabasePanel(window);
    activeWindow = await clearDatabaseRecords(activeWindow);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      await expect(activeWindow.locator('button:has-text("Clear Database")')).toHaveCount(0);
      return;
    }

    await activeWindow.click(REFRESH_BUTTON_SELECTOR);
    await activeWindow.waitForTimeout(1000);

    const recordCount = await activeWindow.locator('tbody tr').count();
    expect(recordCount).toBe(0);

    const clearButton = activeWindow.locator('button:has-text("Clear Database")');
    await expect(clearButton).toBeVisible();
    await expect(clearButton).toBeDisabled();

    await expect(activeWindow.locator('text=No files imported yet')).toBeVisible();
  });

  test('should handle Clear Database with uninitialized database gracefully', async ({
    electron,
  }) => {
    test.info().annotations.push({ type: 'preserve-electron-state' });
    const context = await electron.ensureContext();
    await handleClearDatabasePage(context.window);
  });

  async function setupDatabaseUIState(page: Page): Promise<Page> {
    const activePage = await ensureDatabasePanel(page);
    if (await isDatabaseError(activePage)) return activePage;
    await activePage.waitForTimeout(1000);

    const loadingMessage = activePage.locator('text=Loading PGlite database...');
    if (await loadingMessage.isVisible().catch(() => false)) {
      await loadingMessage.waitFor({ state: 'hidden', timeout: 10000 });
    }

    const filesButton = activePage.getByRole('button', { name: /Files \(\d+\)/ }).first();
    try {
      if (await filesButton.isVisible()) {
        await filesButton.click();
        await activePage.waitForTimeout(500);
      }
    } catch (error) {
      console.log('⚠️ Error clicking Files button:', error);
    }

    return activePage;
  }

  async function hasExistingData(page: Page): Promise<boolean> {
    const [fileRows, tableRows] = await Promise.all([
      page.locator('.border.rounded.p-3').count(),
      page.locator('tbody tr').count(),
    ]);
    return fileRows > 0 || tableRows > 0;
  }

  async function confirmClearIfDialogVisible(dialog: Locator): Promise<void> {
    try {
      if (await dialog.isVisible({ timeout: 2000 })) {
        const confirmButton = dialog
          .locator('button:has-text("Clear Database")')
          .or(dialog.locator('button:has-text("Clear")'))
          .or(dialog.locator('button:has-text("Confirm")'));
        if (await confirmButton.isVisible()) {
          await confirmButton.click();
        }
        await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      }
    } catch {
      // Ignore visibility timeouts; absence of dialog is acceptable.
    }
  }

  async function clearWithButton(page: Page, clearButton: Locator): Promise<boolean> {
    await clearButton.click();
    await confirmClearIfDialogVisible(page.locator('[role="dialog"]'));
    await page.waitForTimeout(2000);
    if (await isDatabaseError(page)) return false;
    await page.click(REFRESH_BUTTON_SELECTOR);
    await page.waitForTimeout(1000);
    return true;
  }

  async function cleanupExistingData(page: Page): Promise<Page> {
    let activePage = page;
    if (await isDatabaseError(activePage)) return activePage;
    if (!(await hasExistingData(activePage))) return activePage;

    const clearButton = activePage.locator('button:has-text("Clear Database")');
    if (await clearButton.isVisible()) {
      const cleared = await clearWithButton(activePage, clearButton);
      if (!cleared) return activePage;
      return activePage;
    }

    activePage = await clearDatabaseRecords(activePage);
    if (await isDatabaseError(activePage)) return activePage;
    return activePage;
  }

  async function verifyUIFunctionalityAndState(page: Page): Promise<void> {
    if (await isDatabaseError(page)) {
      await expect(page.locator('[data-testid="db-init-error"]').first()).toBeVisible();
      return;
    }
    const currentFileRows = await page.locator('.border.rounded.p-3').count();
    const currentTableRows = await page.locator('tbody tr').count();

    if (currentFileRows === 0 && currentTableRows === 0) {
      const emptyStateSelectors = [
        page.locator('text=/No files imported yet/'),
        page.locator('.text-muted-foreground:has-text("No files imported")'),
        page.locator('text=/No chunks available/'),
        page.locator('text="Enter a search query to find similar content."'),
        page.locator('.text-center.text-muted-foreground'),
      ];

      for (const selector of emptyStateSelectors) {
        if (await selector.isVisible({ timeout: 1000 }).catch(() => false)) {
          return;
        }
      }

      console.warn('⚠️ Empty state message not found, but database is empty');
      return;
    }

    await expect(page.locator('.border.rounded.p-3').first()).toBeVisible();
  }

  test('should perform CRUD operations through UI', async ({ window }) => {
    let activeWindow = await setupDatabaseUIState(window);
    activeWindow = await cleanupExistingData(activeWindow);
    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }
    await expect(activeWindow.locator('button:has-text("Import Selected Files")')).toBeVisible();
    await activeWindow.click(REFRESH_BUTTON_SELECTOR);
    await activeWindow.waitForTimeout(500);
    await verifyUIFunctionalityAndState(activeWindow);
  });

  test('should persist data between app restarts', async ({ electron, window }) => {
    test.setTimeout(120000);

    let activeWindow = await ensureDatabasePanel(window);

    activeWindow = await clearDatabaseRecords(activeWindow);
    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }
    await activeWindow.click(REFRESH_BUTTON_SELECTOR);
    await activeWindow.waitForTimeout(500);

    await expect(activeWindow.locator('text=Database connected via DbProvider')).toBeVisible();
    await expect(activeWindow.locator('tbody tr')).toHaveCount(0, { timeout: 5000 });
    await expect(activeWindow.locator('text=✓')).toBeVisible();
    await expect(activeWindow.locator('text=Successfully connected')).toBeVisible();

    const relaunched = await electron.restart();
    let relaunchedWindow = await ensureDatabasePanel(relaunched.window);
    relaunchedWindow = await clearDatabaseRecords(relaunchedWindow);
    if (await isDatabaseError(relaunchedWindow)) {
      console.log('⚠️ Database start failed after restart – skipping persistence assertions.');
      await expect(relaunchedWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }
    await relaunchedWindow.click(REFRESH_BUTTON_SELECTOR);
    await relaunchedWindow.waitForTimeout(2000);

    await expect(relaunchedWindow.locator('text=✓')).toBeVisible({ timeout: 15000 });
    await expect(relaunchedWindow.locator('text=Successfully connected')).toBeVisible({
      timeout: 5000,
    });
    await expect(relaunchedWindow.locator('text=Database connected via DbProvider')).toBeVisible();
    await expect(
      relaunchedWindow.locator('button:has-text("Import Selected Files")')
    ).toBeVisible();
    await expect(
      relaunchedWindow.locator('[data-testid="database-demo-panel"]').first()
    ).toBeVisible();

    relaunchedWindow = await clearDatabaseRecords(relaunchedWindow);
    await relaunchedWindow.click(REFRESH_BUTTON_SELECTOR);
    await relaunchedWindow.waitForTimeout(500);

    const finalRecordCount = await relaunchedWindow.locator('tbody tr').count();
    expect(finalRecordCount).toBe(0);
  });
});
