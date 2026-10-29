import {
  NATIVE_TOOL_DEFAULTS,
  TOOL_CATEGORIES,
  TOOL_LOADING_TIERS,
} from '@brainstrike/assistant-contract/tool-metadata';
import { expect, test } from './fixtures/electron-fixture';
import { SettingsPage } from './page-objects/settings-page';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const NATIVE_TOOL_ID = 'brainstrike.readWorkspaceContext';
// A tool in a *different* loading tier, used to prove the tier filter actually
// filters instead of being a no-op.
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

async function openToolsSettings(
  homePage: import('./page-objects/home-page').HomePage,
  settingsPage: SettingsPage
): Promise<void> {
  await homePage.openSettings();
  await settingsPage.openCategory(/AI Tools/i, 'ai-tools');
}

test.describe('AI Tools settings (desktop)', { tag: '@smoke' }, () => {
  test('Controls retires on Escape, reopens, and navigates to AI Tools settings', async ({
    window,
  }) => {
    const assistant = await ensureAssistantShellVisible(window);
    const trigger = assistant.getByRole('button', { name: 'Open assistant controls' });
    const controls = window.getByRole('dialog', { name: 'Assistant controls' });

    await trigger.click();
    await expect(controls).toBeVisible();
    await controls.press('Escape');
    await expect(controls).toHaveCount(0);
    await trigger.click();
    await expect(controls).toBeVisible();
    await controls.getByRole('button', { name: 'Manage tools…' }).click();
    await expect(window.getByTestId('unified-tools-settings')).toBeVisible();
    await expect(controls).toHaveCount(0);
    await window.getByTestId('search-input').fill('readWorkspaceContext');
    await expect(window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
  });

  test('supports search, category/tier filters, and native bulk toggles', async ({
    window,
    homePage,
  }) => {
    const settingsPage = new SettingsPage(window);
    expect(NATIVE_TOOL_DEFAULTS[NATIVE_TOOL_ID].category).not.toBe(
      NATIVE_TOOL_DEFAULTS[NON_RETRIEVAL_TOOL_ID].category
    );
    await openToolsSettings(homePage, settingsPage);

    await expect(window.getByTestId('unified-tools-settings')).toBeVisible();
    await window.getByTestId('search-input').fill('readWorkspaceContext');
    await expect(window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
    await expect(window.getByTestId('tool-row-brainstrike.readWorkspaceFile')).toHaveCount(0);
    await expect(
      window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`).getByTestId('requires-approval-icon')
    ).toHaveCount(0);

    await window.getByTestId('reset-filters').click();
    await expect(window.getByTestId(`tool-row-${NON_RETRIEVAL_TOOL_ID}`)).toBeVisible();
    await window.getByTestId('category-filter').click();
    await window.getByRole('option', { exact: true, name: TOOL_CATEGORY_LABEL }).click();
    await expect(window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();
    await expect(window.getByTestId(`tool-row-${NON_RETRIEVAL_TOOL_ID}`)).toHaveCount(0);
  });

  test('supports native bulk toggles after tier filtering', async ({ window, homePage }) => {
    const settingsPage = new SettingsPage(window);
    await openToolsSettings(homePage, settingsPage);

    // Guard the premise: the two tiers below must differ for this to discriminate.
    expect(TOOL_TIER_LABEL).not.toBe(PEER_TIER_LABEL);

    await window.getByTestId('search-input').fill('readWorkspaceContext');

    // The search leaves exactly one row, so prove the tier filter actually
    // filters: the row must vanish under the peer's tier and come back under
    // its own. Asserting only the second half would pass on a no-op filter.
    await window.getByTestId('tier-filter').click();
    await window.getByRole('option', { exact: true, name: PEER_TIER_LABEL }).click();
    await expect(window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toHaveCount(0);

    await window.getByTestId('tier-filter').click();
    await window.getByRole('option', { exact: true, name: TOOL_TIER_LABEL }).click();
    await expect(window.getByTestId(`tool-row-${NATIVE_TOOL_ID}`)).toBeVisible();

    await window.getByTestId('tool-group-menu-native').click();
    await window.getByTestId('disable-all-action').click();
    await expect(window.getByTestId(`tool-toggle-${NATIVE_TOOL_ID}`)).toHaveAttribute(
      'aria-checked',
      'false'
    );

    await window.getByTestId('tool-group-menu-native').click();
    await window.getByTestId('enable-all-action').click();
    await expect(window.getByTestId(`tool-toggle-${NATIVE_TOOL_ID}`)).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('the page scroll reaches the last tool and the window never scrolls', async ({
    window,
    homePage,
  }) => {
    const settingsPage = new SettingsPage(window);
    await openToolsSettings(homePage, settingsPage);
    const rows = window.locator('[data-testid^="tool-row-"]');
    await expect(rows.first()).toBeVisible();

    // Scroll the settings page itself to its end, as a wheel would. The tool
    // list must flow with the page: a nested capped scroller would leave the
    // last tools (and any MCP server's group below them) out of reach.
    await window.getByTestId('settings-category-ai-tools').evaluate((category) => {
      const page = category.parentElement;
      if (page) {
        page.scrollTop = page.scrollHeight;
      }
    });
    await expect(rows.last()).toBeInViewport();

    // Nothing inside the shell may stretch the document past the window, or
    // the whole app scrolls up over blank space below the status bar.
    const documentOverflow = await window.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight
    );
    expect(documentOverflow).toBe(0);
  });
});
