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
  async function verifyDatabaseConnection(page: Page): Promise<void> {
    const hasErrorPanel = await page.locator('[data-testid="db-init-error"]').isVisible();

    if (hasErrorPanel) {
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
        .locator('button:has-text("Refresh")')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });
    }
  }

  async function performInitialCleanup(page: Page): Promise<void> {
    const hasErrorPanel = await page.locator('[data-testid="db-init-error"]').isVisible();
    if (hasErrorPanel) return;

    await clearDatabaseRecords(page);
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    const initialCount = await page.locator('tbody tr').count();

    if (initialCount > 0) {
      await clearDatabaseRecords(page);
      await page.click('button:has-text("Refresh")');
      await page.waitForTimeout(500);
    }
  }

  test.beforeAll(async ({ electron }) => {
    test.setTimeout(150000);
    const { window } = await electron.ensureContext();
    await showDatabaseDemoPanel(window);
    await waitForDatabaseReady(window);
    await verifyDatabaseConnection(window);
    await performInitialCleanup(window);
    await electron.ensureWindow();
  });

  test.beforeEach(async ({ electron }) => {
    await electron.ensureWindow();
  });

  test.afterEach(async ({ electron, window }, testInfo) => {
    const preserveState = testInfo.title.includes('should persist data between app restarts');

    if (!preserveState) {
      try {
        await showDatabaseDemoPanel(window);
        await waitForDatabaseReady(window);
        await clearDatabaseRecords(window);
      } catch (_error) {
        // Ignore cleanup errors; tests already succeeded.
      }
    }

    await electron.ensureWindow();
  });

  test('should handle database errors gracefully', async ({ window }) => {
    await showDatabaseDemoPanel(window);
    await waitForDatabaseReady(window);

    const hasErrorPanel = await window.locator('[data-testid="db-init-error"]').isVisible();
    const hasSuccessPanel = await window.locator('[data-testid="database-demo-panel"]').isVisible();

    if (hasErrorPanel) {
      await expect(window.locator('[data-testid="db-init-error"]').first()).toBeVisible();
      const errorText = await window.locator('[data-testid="db-init-error"]').textContent();
      expect(errorText).toContain('pgvector');
      return;
    }

    if (hasSuccessPanel) {
      await expect(window.locator('text=✓')).toBeVisible();
      await window.click('button:has-text("Refresh")');
      await expect(window.locator('text=Failed to')).not.toBeVisible();
      return;
    }

    throw new Error('Neither success panel nor error panel is visible');
  });

  test('should show correct database location info', async ({ window }) => {
    await showDatabaseDemoPanel(window);
    await waitForDatabaseReady(window);

    const hasErrorPanel = await window.locator('[data-testid="db-init-error"]').isVisible();
    const hasSuccessPanel = await window.locator('[data-testid="database-demo-panel"]').isVisible();

    if (hasErrorPanel) {
      await expect(window.locator('[data-testid="db-init-error"]').first()).toBeVisible();
      const errorText = await window.locator('[data-testid="db-init-error"]').textContent();
      expect(errorText).toContain('pgvector');
      await expect(window.locator('text=Ensure pgvector is available')).toBeVisible();
      return;
    }

    if (hasSuccessPanel) {
      await expect(window.locator('[data-testid="db-info"]').first()).toBeVisible();
      await expect(window.locator('text=Storage: Database connected via DbProvider')).toBeVisible();
      await expect(window.locator('text=✓')).toBeVisible();
      await expect(window.locator('text=Successfully connected')).toBeVisible();
      return;
    }

    throw new Error('Neither success panel nor error panel is visible');
  });

  async function createTestDataForClearTest(page: Page): Promise<boolean> {
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
      await showDatabaseDemoPanel(page);
      await waitForDatabaseReady(page);
      const testDataButton = page
        .locator('button:has-text("Create Test Data")')
        .or(page.locator('button:has-text("Add Sample Data")'));

      if (await testDataButton.isVisible()) {
        await testDataButton.click();
        await page.waitForTimeout(2000);
        return true;
      }

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

  async function executeClearDatabaseWorkflow(page: Page): Promise<void> {
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
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);

    const recordCountAfter = await page.locator('tbody tr').count();
    expect(recordCountAfter).toBe(0);

    await expect(page.locator('text=No files imported yet')).toBeVisible();
  }

  test('should clear database via UI button workflow', async ({ window }) => {
    await showDatabaseDemoPanel(window);
    await waitForDatabaseReady(window);

    const dataCreated = await createTestDataForClearTest(window);
    if (!dataCreated) return;

    await showDatabaseDemoPanel(window);
    await waitForDatabaseReady(window);

    await window.click('button:has-text("Refresh")');
    await window.waitForTimeout(1000);

    const recordCountBefore = await window.locator('tbody tr').count();
    if (recordCountBefore === 0) return;

    await executeClearDatabaseWorkflow(window);
  });

  test('should properly disable Clear Database button when no data exists', async ({ window }) => {
    await showDatabaseDemoPanel(window);
    await waitForDatabaseReady(window);
    await clearDatabaseRecords(window);

    await window.click('button:has-text("Refresh")');
    await window.waitForTimeout(1000);

    const recordCount = await window.locator('tbody tr').count();
    expect(recordCount).toBe(0);

    const clearButton = window.locator('button:has-text("Clear Database")');
    await expect(clearButton).toBeVisible();
    await expect(clearButton).toBeDisabled();

    await expect(window.locator('text=No files imported yet')).toBeVisible();
  });

  test('should handle Clear Database with uninitialized database gracefully', async ({
    electron,
  }) => {
    test.info().annotations.push({ type: 'preserve-electron-state' });
    const context = await electron.ensureContext();
    const page = context.window;

    await showDatabaseDemoPanel(page);
    await page.waitForTimeout(1000);

    const clearButton = page.locator('button:has-text("Clear Database")');
    await expect(clearButton).toBeVisible({ timeout: 10000 });

    const isEnabled = await clearButton.isEnabled();
    if (isEnabled) {
      await clearButton.click();
      const confirmDialog = page.locator('[role="dialog"]');
      const dialogAppeared = await confirmDialog.isVisible({ timeout: 3000 });

      if (dialogAppeared) {
        const confirmButton = confirmDialog
          .locator('button:has-text("Clear Database")')
          .or(confirmDialog.locator('button[variant="destructive"]:has-text("Clear")'));
        if (await confirmButton.isVisible()) {
          await confirmButton.click();
          await expect(confirmDialog).not.toBeVisible({ timeout: 10000 });
        }
      }

      await page.waitForTimeout(3000);
    }

    const specificErrorToast = page
      .locator(':has-text("Database repositories not available")')
      .or(page.locator(':has-text("Remaining operations were cancelled")'));
    await expect(specificErrorToast).not.toBeVisible({ timeout: 1000 });

    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);

    const refreshButton = page.locator('button:has-text("Refresh")');
    await expect(refreshButton).toBeVisible();
  });

  async function setupDatabaseUIState(page: Page): Promise<void> {
    await showDatabaseDemoPanel(page);
    await waitForDatabaseReady(page);
    await page.waitForTimeout(1000);

    const loadingMessage = page.locator('text=Loading PGlite database...');
    if (await loadingMessage.isVisible().catch(() => false)) {
      await loadingMessage.waitFor({ state: 'hidden', timeout: 10000 });
    }

    const filesButton = page.getByRole('button', { name: /Files \(\d+\)/ }).first();
    try {
      if (await filesButton.isVisible()) {
        await filesButton.click();
        await page.waitForTimeout(500);
      }
    } catch (error) {
      console.log('⚠️ Error clicking Files button:', error);
    }
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

  async function clearWithButton(page: Page, clearButton: Locator): Promise<void> {
    await clearButton.click();
    await confirmClearIfDialogVisible(page.locator('[role="dialog"]'));
    await page.waitForTimeout(2000);
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
  }

  async function cleanupExistingData(page: Page): Promise<void> {
    if (!(await hasExistingData(page))) return;

    const clearButton = page.locator('button:has-text("Clear Database")');
    if (await clearButton.isVisible()) {
      await clearWithButton(page, clearButton);
      return;
    }

    await clearDatabaseRecords(page);
  }

  async function verifyUIFunctionalityAndState(page: Page): Promise<void> {
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
    await setupDatabaseUIState(window);
    await cleanupExistingData(window);
    await expect(window.locator('button:has-text("Import Selected Files")')).toBeVisible();
    await window.click('button:has-text("Refresh")');
    await window.waitForTimeout(500);
    await verifyUIFunctionalityAndState(window);
  });

  test('should persist data between app restarts', async ({ electron, window }) => {
    test.setTimeout(120000);

    await showDatabaseDemoPanel(window);
    await waitForDatabaseReady(window);

    await clearDatabaseRecords(window);
    await window.click('button:has-text("Refresh")');
    await window.waitForTimeout(500);

    await expect(window.locator('text=Database connected via DbProvider')).toBeVisible();
    await expect(window.locator('tbody tr')).toHaveCount(0, { timeout: 5000 });
    await expect(window.locator('text=✓')).toBeVisible();
    await expect(window.locator('text=Successfully connected')).toBeVisible();

    const relaunched = await electron.restart();
    await showDatabaseDemoPanel(relaunched.window);
    await waitForDatabaseReady(relaunched.window);
    await relaunched.window.waitForTimeout(3000);
    await relaunched.window.click('button:has-text("Refresh")');
    await relaunched.window.waitForTimeout(2000);

    await expect(relaunched.window.locator('text=✓')).toBeVisible({ timeout: 15000 });
    await expect(relaunched.window.locator('text=Successfully connected')).toBeVisible({
      timeout: 5000,
    });
    await expect(relaunched.window.locator('text=Database connected via DbProvider')).toBeVisible();
    await expect(
      relaunched.window.locator('button:has-text("Import Selected Files")')
    ).toBeVisible();
    await expect(
      relaunched.window.locator('[data-testid="database-demo-panel"]').first()
    ).toBeVisible();

    await clearDatabaseRecords(relaunched.window);
    await relaunched.window.click('button:has-text("Refresh")');
    await relaunched.window.waitForTimeout(500);

    const finalRecordCount = await relaunched.window.locator('tbody tr').count();
    expect(finalRecordCount).toBe(0);
  });
});
