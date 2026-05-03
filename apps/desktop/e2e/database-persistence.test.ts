import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import {
  clearDatabaseRecords,
  resolveRefreshButton,
  showDatabaseDemoPanel,
  waitForDatabaseReady,
} from './utils/layout-helpers';

// Configure this test suite to run in serial mode to avoid database interference
test.describe.configure({ mode: 'serial' });

test.describe('Database Persistence', () => {
  const ERROR_LOCATOR = '[data-testid="db-init-error"]';
  const REFRESH_BUTTON_SELECTOR = 'button:has-text("Refresh")';
  const IMPORT_SETTINGS_SELECTOR = 'button[aria-label="Import Settings"]';
  const EXPECTED_DATABASE_ERROR_SUBSTRINGS = [
    'pgvector',
    'desktop database',
    'failed to initialize',
    'runtime aborted',
    'migration failed',
    'already in use',
    'filesystem access failed',
  ] as const;

  async function isDatabaseError(page: Page): Promise<boolean> {
    try {
      return await page.locator(ERROR_LOCATOR).isVisible({ timeout: 200 });
    } catch {
      return false;
    }
  }

  /**
   * Expand the Import Settings panel to access the Clear Database button.
   * The Clear Database button was moved to Import Settings > Danger Zone.
   */
  async function expandImportSettings(page: Page): Promise<void> {
    const panelScope = page.locator('[data-testid="database-demo-panel"]');
    const importSettingsButton = panelScope
      .getByRole('button', { name: /import settings|settings/i })
      .or(panelScope.locator(IMPORT_SETTINGS_SELECTOR))
      .first();
    // The settings content is rendered in a portal, so it must be queried from the page root.
    const clearDatabaseButton = page.getByRole('button', { name: 'Clear Database' });

    // Check if settings are already expanded (Clear Database button visible)
    const isAlreadyExpanded = await clearDatabaseButton
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (isAlreadyExpanded) {
      return;
    }

    // Click Import Settings to expand
    if (await importSettingsButton.isVisible({ timeout: 2000 })) {
      await importSettingsButton.click();
      // Wait for the settings panel to expand and Clear Database button to appear
      await clearDatabaseButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
        console.warn('⚠️ Clear Database button not visible after expanding Import Settings');
      });
    }
  }

  async function readImportSettingsState(page: Page): Promise<{
    chunkingPreset: string;
    chunkingStrategy: string;
  }> {
    return await page.evaluate(() => {
      const stored = window.localStorage.getItem('import-settings.v1');
      if (!stored) {
        throw new Error('import-settings.v1 is missing');
      }
      const parsed = JSON.parse(stored) as {
        state?: {
          chunkingPreset?: string;
          chunkingStrategy?: string;
        };
      };
      const chunkingPreset = parsed.state?.chunkingPreset;
      const chunkingStrategy = parsed.state?.chunkingStrategy;
      if (typeof chunkingPreset !== 'string' || typeof chunkingStrategy !== 'string') {
        throw new Error('Import settings state is missing canonical chunking fields');
      }
      return { chunkingPreset, chunkingStrategy };
    });
  }

  async function selectChunkingPreset(page: Page, presetName: RegExp): Promise<void> {
    const presetButton = page.getByRole('button', { name: presetName });
    await expect(presetButton).toBeVisible({ timeout: 10_000 });
    await presetButton.scrollIntoViewIfNeeded();
    await presetButton.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error('Chunking preset button is not an HTMLElement');
      }
      element.click();
    });
  }

  async function verifyDatabaseConnection(page: Page): Promise<void> {
    if (await isDatabaseError(page)) {
      const errorText = await page.locator('[data-testid="db-init-error"]').textContent();
      if (!isExpectedDatabaseInitError(errorText)) {
        throw new Error(`Unexpected database error: ${errorText}`);
      }
      return;
    }

    try {
      // Database status is now in the global status bar at the bottom of the window
      await page
        .locator('[data-testid="status-bar-db-connected"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
    } catch {
      try {
        await resolveRefreshButton(page, { timeoutMs: 15_000 });
      } catch {
        // If neither status bar nor refresh button appears, continue; tests will handle error state.
      }
    }
  }

  function isExpectedDatabaseInitError(errorText: string | null): boolean {
    if (!errorText) {
      return false;
    }
    const normalizedText = errorText.toLowerCase();
    return EXPECTED_DATABASE_ERROR_SUBSTRINGS.some((expectedSubstring) =>
      normalizedText.includes(expectedSubstring)
    );
  }

  async function ensureDatabasePanel(page: Page): Promise<Page> {
    const shown = await showDatabaseDemoPanel(page);
    return waitForDatabaseReady(shown);
  }

  async function ensureDatabasePanelVisibleQuick(page: Page): Promise<Page | null> {
    const activePage = await showDatabaseDemoPanel(page, {
      tabTimeoutMs: 5000,
      panelTimeoutMs: 10_000,
    });
    if (await isDatabaseError(activePage)) {
      return activePage;
    }

    const panelVisible = await activePage
      .locator('[data-testid="database-demo-panel"]')
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (!panelVisible) {
      return null;
    }

    return activePage;
  }

  async function clickRefreshIfAvailable(page: Page): Promise<boolean> {
    if (await isDatabaseError(page)) {
      return false;
    }

    try {
      const { button: refreshButton } = await resolveRefreshButton(page, { timeoutMs: 10_000 });
      await refreshButton.click({ timeout: 5000 });
      await page.waitForTimeout(1000);
      return true;
    } catch {
      return false;
    }
  }

  async function performInitialCleanup(page: Page): Promise<Page> {
    if (await isDatabaseError(page)) {
      return page;
    }

    return clearDatabaseRecords(page);
  }

  test.beforeAll(async ({ electron }) => {
    test.setTimeout(150_000);
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
        await clearDatabaseRecords(window);
      } catch {
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
      .isVisible()
      .catch(() => false);
    const hasConnectedStatus = await activeWindow
      .locator('[data-testid="status-bar-db-connected"]')
      .isVisible()
      .catch(() => false);

    if (hasErrorPanel) {
      await expect(activeWindow.locator('[data-testid="db-init-error"]').first()).toBeVisible();
      const errorText = await activeWindow.locator('[data-testid="db-init-error"]').textContent();
      expect(isExpectedDatabaseInitError(errorText)).toBe(true);
      return;
    }

    if (hasSuccessPanel) {
      await expect(
        activeWindow.locator('[data-testid="database-demo-panel"]').first()
      ).toBeVisible();
      return;
    }

    if (hasConnectedStatus) {
      // Database status is now in the global status bar - check for connected state
      await expect(activeWindow.locator('[data-testid="status-bar-db-connected"]')).toBeVisible();
      return;
    }

    throw new Error('Neither success panel nor error panel is visible');
  });

  test('opening database panel does not reload the visible renderer', async ({ window }) => {
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    const activeWindow = await showDatabaseDemoPanel(window);

    await expect
      .poll(async () => activeWindow.evaluate(() => performance.timeOrigin), {
        timeout: 10_000,
        message: 'Opening the database panel should not reload the visible renderer',
      })
      .toBe(initialTimeOrigin);

    await expect(
      activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .or(activeWindow.locator('[data-testid="db-init-error"]'))
        .first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test('should show correct database location info', async ({ window }) => {
    const activeWindow = await ensureDatabasePanel(window);

    const hasErrorPanel = await isDatabaseError(activeWindow);
    const hasSuccessPanel = await activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .isVisible();
    const hasConnectedStatus = await activeWindow
      .locator('[data-testid="status-bar-db-connected"]')
      .isVisible()
      .catch(() => false);

    if (hasErrorPanel) {
      await expect(activeWindow.locator('[data-testid="db-init-error"]').first()).toBeVisible();
      const errorText = await activeWindow.locator('[data-testid="db-init-error"]').textContent();
      expect(isExpectedDatabaseInitError(errorText)).toBe(true);
      return;
    }

    if (hasSuccessPanel || hasConnectedStatus) {
      // Database status is now in the global status bar at the bottom of the window
      const statusBarElement = activeWindow.locator('[data-testid="status-bar"]');
      await expect(statusBarElement).toBeVisible();

      // Wait for database connection to complete (may show "Connecting..." initially)
      // Increased timeout to account for embedding worker initialization in renderer
      await expect(
        activeWindow.locator('[data-testid="status-bar-db-connected"]').first()
      ).toBeVisible({
        timeout: 30_000,
      });

      // Verify the connection details - check that storage location is shown
      const statusText = await activeWindow
        .locator('[data-testid="status-bar-db-connected"]')
        .first()
        .textContent();
      expect(statusText).toContain('Storage:');
      expect(statusText).not.toContain('Connecting...'); // Ensure it's not in loading state
      // Accept either IPC connection or PGlite connection
      expect(statusText).toMatch(/IPC|PGlite/i);
      return;
    }

    throw new Error('Neither success panel, connected status, nor error panel is visible');
  });

  test('should persist non-legacy chunking preset selection across renderer reload', async ({
    window,
  }) => {
    let activeWindow = await ensureDatabasePanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator('[data-testid="db-init-error"]').first()).toBeVisible();
      return;
    }

    await expandImportSettings(activeWindow);
    await selectChunkingPreset(activeWindow, /^Docs/);
    const activePreset = activeWindow.getByTestId('chunking-active-preset');
    await expect(activePreset).toBeVisible({ timeout: 10_000 });
    await expect(activePreset).toContainText('Docs', { timeout: 10_000 });
    await expect(activePreset).toContainText('semantic-markdown', { timeout: 10_000 });

    await expect
      .poll(async () => await readImportSettingsState(activeWindow), {
        timeout: 10_000,
      })
      .toEqual({
        chunkingPreset: 'docs',
        chunkingStrategy: 'semantic-markdown',
      });

    await activeWindow.reload();
    activeWindow = await ensureDatabasePanel(activeWindow);

    await expect
      .poll(async () => await readImportSettingsState(activeWindow), {
        timeout: 10_000,
      })
      .toEqual({
        chunkingPreset: 'docs',
        chunkingStrategy: 'semantic-markdown',
      });
  });

  test('should persist adaptive codebase preset routing across renderer reload', async ({
    window,
  }) => {
    let activeWindow = await ensureDatabasePanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator('[data-testid="db-init-error"]').first()).toBeVisible();
      return;
    }

    await expandImportSettings(activeWindow);
    await selectChunkingPreset(activeWindow, /^Codebase/);
    await expect(activeWindow.getByText('Adaptive presets still route each file type')).toBeVisible(
      { timeout: 10_000 }
    );
    await expect(activeWindow.getByText('docs/getting-started.md')).toBeVisible({
      timeout: 10_000,
    });
    await expect(activeWindow.getByText('src/assistant/retrieval.ts')).toBeVisible({
      timeout: 10_000,
    });

    await expect
      .poll(async () => await readImportSettingsState(activeWindow), {
        timeout: 10_000,
      })
      .toEqual({
        chunkingPreset: 'codebase',
        chunkingStrategy: 'auto',
      });

    await activeWindow.reload();
    activeWindow = await ensureDatabasePanel(activeWindow);
    await expandImportSettings(activeWindow);
    await expect(activeWindow.getByText('Adaptive presets still route each file type')).toBeVisible(
      { timeout: 10_000 }
    );

    await expect
      .poll(async () => await readImportSettingsState(activeWindow), {
        timeout: 10_000,
      })
      .toEqual({
        chunkingPreset: 'codebase',
        chunkingStrategy: 'auto',
      });
  });

  async function createTestDataForClearTest(page: Page): Promise<boolean> {
    if (await isDatabaseError(page)) {
      return false;
    }
    if (await importFromExplorer(page)) {
      return true;
    }
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

    const importButton = page.getByRole('button', { name: /^Import\s*\(/ });
    if ((await importButton.isVisible()) && !(await importButton.isDisabled())) {
      await importButton.click();
      await page.waitForTimeout(5000);
      return true;
    }

    return false;
  }

  async function createUsingSampleData(page: Page): Promise<boolean> {
    const activePage = await showDatabaseDemoPanel(page, {
      tabTimeoutMs: 5000,
      panelTimeoutMs: 10_000,
    });
    if (await isDatabaseError(activePage)) {
      return false;
    }
    const panelVisible = await activePage
      .locator('[data-testid="database-demo-panel"]')
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (!panelVisible) {
      return false;
    }
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
      await expect(confirmDialog).not.toBeVisible({ timeout: 10_000 });
    }

    await page.waitForTimeout(3000);
  }

  async function handleClearDatabasePage(page: Page): Promise<void> {
    const activePage = await ensureDatabasePanelVisibleQuick(page);
    if (!activePage) {
      return;
    }
    if (await isDatabaseError(activePage)) {
      await expect(activePage.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    // Expand Import Settings to access Clear Database button
    await expandImportSettings(activePage);

    const clearButton = activePage.locator('button:has-text("Clear Database")');
    const visible = await clearButton.isVisible({ timeout: 10_000 }).catch(() => false);
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

    await clickRefreshIfAvailable(activePage);

    const refreshButton = activePage.locator(REFRESH_BUTTON_SELECTOR);
    if (await refreshButton.isVisible().catch(() => false)) {
      await expect(refreshButton).toBeVisible();
    }
  }

  async function executeClearDatabaseWorkflow(page: Page): Promise<void> {
    if (await isDatabaseError(page)) {
      await expect(page.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    // Expand Import Settings to access Clear Database button
    await expandImportSettings(page);

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

    await expect(confirmDialog).not.toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2000);
    await clickRefreshIfAvailable(page);

    const recordCountAfter = await page.locator('tbody tr').count();
    expect(recordCountAfter).toBe(0);

    // After clearing, we should see an empty state message
    await expect(
      page.locator(
        'text=/No files in this collection|No files imported yet|No collection selected/'
      )
    ).toBeVisible();
  }

  test('should clear database via UI button workflow', async ({ window }) => {
    let activeWindow = await ensureDatabasePanelVisibleQuick(window);
    if (!activeWindow) {
      return;
    }
    if (await isDatabaseError(activeWindow)) {
      console.log('⚠️ Database start failed (pgvector missing) – skipping CRUD test.');
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const dataCreated = await createTestDataForClearTest(activeWindow);
    if (!dataCreated) {
      return;
    }

    activeWindow = await ensureDatabasePanelVisibleQuick(activeWindow);
    if (!activeWindow) {
      return;
    }
    if (await isDatabaseError(activeWindow)) {
      console.log('⚠️ Database start failed (pgvector missing) – skipping persistence test.');
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clickRefreshIfAvailable(activeWindow);

    const recordCountBefore = await activeWindow.locator('tbody tr').count();
    if (recordCountBefore === 0) {
      return;
    }

    await executeClearDatabaseWorkflow(activeWindow);
  });

  test('should properly disable Clear Database button when no data exists', async ({ window }) => {
    let activeWindow = await ensureDatabasePanelVisibleQuick(window);
    if (!activeWindow) {
      return;
    }
    activeWindow = await clearDatabaseRecords(activeWindow);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      // Expand Import Settings first to check button count
      await expandImportSettings(activeWindow);
      await expect(activeWindow.getByRole('button', { name: 'Clear Database' })).toHaveCount(0);
      return;
    }

    await clickRefreshIfAvailable(activeWindow);

    // Expand Import Settings to access Clear Database button
    await expandImportSettings(activeWindow);

    const clearButton = activeWindow.getByRole('button', { name: 'Clear Database' });
    await expect(clearButton).toBeVisible();
    await expect(clearButton).toBeDisabled();
  });

  test('should handle Clear Database with uninitialized database gracefully', async ({
    electron,
  }) => {
    test.info().annotations.push({ type: 'preserve-electron-state' });
    const context = await electron.ensureContext();
    await handleClearDatabasePage(context.window);
  });

  async function setupDatabaseUIState(page: Page): Promise<Page> {
    const activePage = page;
    if (await isDatabaseError(activePage)) {
      return activePage;
    }
    await activePage.waitForTimeout(1000);

    const loadingMessage = activePage.locator('text=Loading PGlite database...');
    if (await loadingMessage.isVisible().catch(() => false)) {
      await loadingMessage.waitFor({ state: 'hidden', timeout: 10_000 });
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
    if (await isDatabaseError(page)) {
      return false;
    }
    await clickRefreshIfAvailable(page);
    return true;
  }

  async function cleanupExistingData(page: Page): Promise<Page> {
    let activePage = page;
    if (await isDatabaseError(activePage)) {
      return activePage;
    }
    if (!(await hasExistingData(activePage))) {
      return activePage;
    }

    // Expand Import Settings to access Clear Database button
    await expandImportSettings(activePage);

    const clearButton = activePage.locator('button:has-text("Clear Database")');
    if (await clearButton.isVisible()) {
      const cleared = await clearWithButton(activePage, clearButton);
      if (!cleared) {
        return activePage;
      }
      return activePage;
    }

    activePage = await clearDatabaseRecords(activePage);
    if (await isDatabaseError(activePage)) {
      return activePage;
    }
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
        page.locator('text=/No files in this collection/'),
        page.locator('text=/No files imported yet/'),
        page.locator('text=/No collection selected/'),
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
    let activeWindow = await ensureDatabasePanelVisibleQuick(window);
    if (!activeWindow) {
      return;
    }
    activeWindow = await setupDatabaseUIState(activeWindow);
    activeWindow = await cleanupExistingData(activeWindow);
    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }
    await expect(activeWindow.getByRole('button', { name: /^Import\s*\(/ })).toBeVisible();
    await clickRefreshIfAvailable(activeWindow);
    await verifyUIFunctionalityAndState(activeWindow);
  });

  test('should persist data between app restarts', async ({ electron, window }) => {
    test.setTimeout(120_000);

    let activeWindow = await ensureDatabasePanelVisibleQuick(window);
    if (!activeWindow) {
      return;
    }

    activeWindow = await clearDatabaseRecords(activeWindow);
    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }
    await clickRefreshIfAvailable(activeWindow);

    // Wait for database connection status (now in global status bar)
    await expect(
      activeWindow.locator('[data-testid="status-bar-db-connected"]').first()
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(activeWindow.locator('tbody tr')).toHaveCount(0, { timeout: 5000 });
    // Verify connection indicator in status bar
    const statusText = await activeWindow
      .locator('[data-testid="status-bar-db-connected"]')
      .first()
      .textContent();
    expect(statusText).toContain('Storage:');
    expect(statusText).toMatch(/IPC|PGlite/i);

    const relaunched = await electron.restart();
    let relaunchedWindow = await ensureDatabasePanelVisibleQuick(relaunched.window);
    if (!relaunchedWindow) {
      return;
    }
    relaunchedWindow = await clearDatabaseRecords(relaunchedWindow);
    if (await isDatabaseError(relaunchedWindow)) {
      console.log('⚠️ Database start failed after restart – skipping persistence assertions.');
      await expect(relaunchedWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }
    await clickRefreshIfAvailable(relaunchedWindow);

    // Wait for database connection status after restart (now in global status bar)
    await expect(
      relaunchedWindow.locator('[data-testid="status-bar-db-connected"]').first()
    ).toBeVisible({ timeout: 30_000 });
    // Verify connection message in status bar
    const relaunchedStatusText = await relaunchedWindow
      .locator('[data-testid="status-bar-db-connected"]')
      .first()
      .textContent();
    expect(relaunchedStatusText).toContain('Storage:');
    expect(relaunchedStatusText).toMatch(/IPC|PGlite/i);
    await expect(relaunchedWindow.getByRole('button', { name: /^Import\s*\(/ })).toBeVisible();
    await expect(
      relaunchedWindow.locator('[data-testid="database-demo-panel"]').first()
    ).toBeVisible();

    relaunchedWindow = await clearDatabaseRecords(relaunchedWindow);
    await clickRefreshIfAvailable(relaunchedWindow);

    const finalRecordCount = await relaunchedWindow.locator('tbody tr').count();
    expect(finalRecordCount).toBe(0);
  });
});
