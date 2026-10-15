import { expect, type Page, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import {
  CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR,
  CONTEXT_EXPLORER_PANEL_SELECTOR,
  contextExplorerActiveNavLocator,
  ensureRightPanelVisible,
  getPanelElements,
  leaveSettingsPage,
  openSettingsPage,
  waitForAppLoad,
  waitForContextExplorerPage,
  waitForSettingsPage,
} from './utils/layout-helpers';

const PANEL_LAYOUT_STORE_KEY = 'panel-layout-store.v1' as const;
const CONTEXT_EXPLORER_LAYOUT_STORE_KEY = 'context-explorer-layout-store.v1' as const;

async function reloadAndWait(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppLoad(page, { waitForDatabase: false });
}

interface PersistedPanelLayout {
  state?: {
    sizes?: number[];
    showLeftPanel?: boolean;
    showRightPanel?: boolean;
    showConsole?: boolean;
  };
}

async function getPersistedLayout(
  page: Page,
  storageKey:
    | typeof PANEL_LAYOUT_STORE_KEY
    | typeof CONTEXT_EXPLORER_LAYOUT_STORE_KEY = PANEL_LAYOUT_STORE_KEY
) {
  return page.evaluate((key: string) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as PersistedPanelLayout;
    } catch {
      return null;
    }
  }, storageKey);
}

async function expectLayoutState(
  page: Page,
  predicate: (state: PersistedPanelLayout | null) => boolean,
  options?: {
    readonly storageKey?: typeof PANEL_LAYOUT_STORE_KEY | typeof CONTEXT_EXPLORER_LAYOUT_STORE_KEY;
    readonly timeout?: number;
  }
) {
  const storageKey = options?.storageKey ?? PANEL_LAYOUT_STORE_KEY;
  const timeout = options?.timeout ?? 8000;
  await expect
    .poll(async () => predicate(await getPersistedLayout(page, storageKey)), { timeout })
    .toBe(true);
}

test.describe('IDE Layout Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Clear any existing layout state to start fresh
    await resetAppState(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test.describe('Panel Visibility Persistence', () => {
    test('should keep the removed console file-editor controls absent across reloads', async ({
      page,
    }) => {
      await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);
      await expect(page.locator('button[aria-label="Show File Editor"]')).toHaveCount(0);
      await expect(page.locator('button[aria-label="Close File Editor"]')).toHaveCount(0);

      await reloadAndWait(page);

      await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);
      await expect(page.locator(CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR)).toHaveCount(0);
    });

    test('should persist right panel toggle state across page reloads', async ({ page }) => {
      const elements = getPanelElements(page);

      const hideButtonVisible = await elements.hideRightPanelButton.isVisible().catch(() => false);
      const showShimVisible = await elements.showRightPanelShim.isVisible().catch(() => false);
      if (!(hideButtonVisible || showShimVisible)) {
        test.skip(true, 'Tools panel controls not available in this environment');
      }

      await ensureRightPanelVisible(page);
      await expect(elements.hideRightPanelButton).toBeVisible();
      await elements.hideRightPanelButton.click();
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === false);

      await reloadAndWait(page);
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === false);
      await expect(elements.showRightPanelShim).toBeVisible();

      await elements.showRightPanelShim.click();
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === true);

      await reloadAndWait(page);
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === true);
      await expect(elements.hideRightPanelButton).toBeVisible();
    });
  });

  test.describe('Complex Layout State Persistence', () => {
    // NOTE (honest scope): this test and its sibling below no longer exercise
    // cross-page persistence. Settings became a dialog rendered OVER the
    // explorer (PR #1626), so the Context Explorer subtree never unmounts and
    // the panel-visibility assertions hold regardless of what the persistence
    // layer does. Routing through a different sidebar destination (Notes) would
    // NOT restore the old coverage either: `RootLayoutContent` keeps every
    // route mounted and only toggles `hidden`/`aria-hidden` on it (see
    // packages/app-shell/src/root-layout-content.tsx — `mountedTabs` plus the
    // `explorer-route`/`notes-route` wrappers), so no route switch remounts the
    // explorer. What these two tests actually assert today is that opening and
    // leaving the Settings route leaves the explorer panel state untouched.
    // Real reload-based persistence coverage lives in the describe blocks above.
    test('should handle navigation between pages while preserving layout', async ({ page }) => {
      // The explorer is the whole Files page (BST-2018): it has no hide control.
      const rightPanel = page.locator(CONTEXT_EXPLORER_PANEL_SELECTOR);
      await expect(rightPanel).toBeVisible();

      // Open Settings (a keep-mounted route beside the explorer, BST-1668)
      await openSettingsPage(page);
      await waitForSettingsPage(page);

      // Navigate back to Context Explorer
      await leaveSettingsPage(page);
      await waitForContextExplorerPage(page);

      // Verify panel is still visible (state persisted)
      await expect(rightPanel).toBeVisible();
    });
  });

  test.describe('Layout State Recovery', () => {
    test('should handle corrupted localStorage gracefully', async ({ page }) => {
      // Corrupt the layout storage
      await page.evaluate(
        (keys: readonly string[]) => {
          for (const key of keys) {
            localStorage.setItem(key, 'invalid-json');
          }
        },
        [PANEL_LAYOUT_STORE_KEY, CONTEXT_EXPLORER_LAYOUT_STORE_KEY]
      );

      // Reload page
      await page.reload();
      await expect(contextExplorerActiveNavLocator(page)).toBeVisible();

      // Verify app loads with default layout and without the removed console file-editor panel.
      const rightPanel = page.locator(CONTEXT_EXPLORER_PANEL_SELECTOR);
      await expect(rightPanel).toBeVisible();

      await expect(page.locator(CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR)).toHaveCount(0);
      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);
    });

    test('should handle missing localStorage gracefully', async ({ page }) => {
      // Clear all localStorage
      await page.evaluate(() => {
        localStorage.clear();
      });

      // Reload page
      await page.reload();
      await expect(contextExplorerActiveNavLocator(page)).toBeVisible();

      // Verify app loads with default layout
      const rightPanel = page.locator(CONTEXT_EXPLORER_PANEL_SELECTOR);
      await expect(rightPanel).toBeVisible();

      await expect(page.locator(CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR)).toHaveCount(0);
      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);
    });
  });
});
