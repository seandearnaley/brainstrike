import {
  NATIVE_TOOL_DEFAULTS,
  TOOL_CATEGORIES,
  TOOL_LOADING_TIERS,
} from '@brainstrike/assistant-contract/tool-metadata';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';

const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
// A retrieval peer that sits in a *different* loading tier, so filtering by one
// tier must hide the other. Used as the negative half of the tier assertion.
const PEER_TOOL_ID = 'brainstrike.readWorkspaceFile';
const NON_RETRIEVAL_TOOL_ID = 'brainstrike.askUser';

// Derive the filter labels from the canonical contract rather than hardcoding
// them: the tier partition is owned by tool-discovery-contract.test.ts, and a
// re-tiering there (as in BST-612/BST-757) previously left this spec stale.
const tierLabelFor = (toolId: typeof NATIVE_TOOL_ID | typeof PEER_TOOL_ID): string =>
  TOOL_LOADING_TIERS[NATIVE_TOOL_DEFAULTS[toolId].loadingTier].label;

const TOOL_TIER_LABEL = tierLabelFor(NATIVE_TOOL_ID);
const PEER_TIER_LABEL = tierLabelFor(PEER_TOOL_ID);
const TOOL_CATEGORY_LABEL = TOOL_CATEGORIES[NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category].label;

async function openToolsSettings(page: import('@playwright/test').Page): Promise<SettingsPage> {
  const home = new HomePage(page);
  const settings = new SettingsPage(page);
  await home.goto({ waitForDatabase: false });
  await home.navigateToSettings();
  await settings.openCategory(/AI Tools/i, 'ai-tools');
  return settings;
}

test.describe('AI Tools and System Diagnostics settings (web)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
  });

  test('supports search, category/tier filters, and native bulk toggles', async ({ page }) => {
    // Guard the premise of the tier assertions below: if both tools ever land in
    // the same tier the negative assertion would silently stop discriminating.
    expect(TOOL_TIER_LABEL).not.toBe(PEER_TIER_LABEL);
    expect(NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category).not.toBe(
      NATIVE_TOOL_DEFAULTS[NON_RETRIEVAL_TOOL_ID].category
    );

    await openToolsSettings(page);

    await expect(page.getByTestId('unified-tools-settings')).toBeVisible();

    await page.getByTestId('search-input').fill('readWorkspaceContext');
    await expect(page.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
    await expect(page.getByTestId(`tool-row-${PEER_TOOL_ID}`)).toHaveCount(0);
    await expect(
      page.getByTestId(`tool-row-${NATIVE_TOOL_ID}`).getByTestId('requires-approval-icon')
    ).toHaveCount(0);

    await page.getByTestId('reset-filters').click();
    await page.getByTestId('category-filter').click();
    await page.getByRole('option', { exact: true, name: TOOL_CATEGORY_LABEL }).click();
    await expect(page.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
    await expect(page.getByTestId(`tool-row-${PEER_TOOL_ID}`)).toBeVisible();
    await expect(page.getByTestId(`tool-row-${NON_RETRIEVAL_TOOL_ID}`)).toHaveCount(0);

    // Both rows survive the category filter, so narrowing to one tier must keep
    // this tool and drop its differently-tiered peer.
    await page.getByTestId('tier-filter').click();
    await page.getByRole('option', { exact: true, name: TOOL_TIER_LABEL }).click();
    await expect(page.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
    await expect(page.getByTestId(`tool-row-${PEER_TOOL_ID}`)).toHaveCount(0);

    await page.getByTestId('tool-group-menu-native').click();
    await page.getByTestId('disable-all-action').click();
    await expect(page.getByTestId(`tool-toggle-${NATIVE_TOOL_ID}`)).toHaveAttribute(
      'aria-checked',
      'false'
    );

    await page.getByTestId('tool-group-menu-native').click();
    await page.getByTestId('enable-all-action').click();
    await expect(page.getByTestId(`tool-toggle-${NATIVE_TOOL_ID}`)).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('renders system diagnostics and refreshes without leaving the category', async ({
    page,
  }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/System Diagnostics/i, 'system-diagnostics');

    await expect(page.getByTestId('system-diagnostics-panel')).toBeVisible();
    const refreshButton = page.getByTestId('system-diagnostics-refresh');
    await refreshButton.click();
    await expect(refreshButton).toBeDisabled();
    await expect(refreshButton).toBeEnabled({ timeout: 2000 });
    await expect(page.getByTestId('settings-category-system-diagnostics')).toBeVisible();
  });
});
