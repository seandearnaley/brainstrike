import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible, waitForAppLoad } from './utils/layout-helpers';

async function ensureDatabasePanelVisible(page: Page): Promise<void> {
  await ensureRightPanelVisible(page);
  const databaseTab = page.getByRole('tab', { name: /collections/i });
  await expect(databaseTab).toBeVisible({ timeout: 15_000 });
  await databaseTab.click();
  await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
}

/**
 * Browser coverage for the collection debug drawer (BST-1214).
 *
 * The unit suite owns the drawer's behavior; what only a real browser can
 * prove is that the lazily-imported content chunk actually resolves inside the
 * built app and mounts against the app's real action registry. A drawer that
 * silently failed to code-split — or that threw for a missing
 * ActionRegistryProvider — would still pass every jsdom test.
 *
 * `@stateful`, NOT `@web-smoke`: the drawer is rendered past the
 * `if (!repository)` early return in `database-demo-panel.tsx`, so its toggle
 * does not exist until the PGlite provider has produced a repository. That is a
 * hard database dependency — dropping the readiness wait would not make this
 * test fast, it would just move the same wait into a `toBeVisible` timeout and
 * put a DB-dependent spec in the lane that exists to stay quick. It therefore
 * runs serially in its own `test:e2e:lane:collection-drawer`, which
 * full-regression invokes.
 */
test.describe('Collection debug drawer @stateful @web-collection-drawer', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test('is collapsed by default and discloses its content on demand', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await waitForAppLoad(page);
    await ensureDatabasePanelVisible(page);

    const toggle = page.getByTestId('collection-debug-drawer-toggle');
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('collection-debug-drawer-content')).toHaveCount(0);

    await toggle.click();

    // The lazy chunk has to load before this resolves.
    await expect(page.getByTestId('collection-debug-drawer-content')).toBeVisible({
      timeout: 15_000,
    });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // All three affordances mount.
    await expect(page.getByTestId('collection-debug-inspector')).toBeVisible();
    await expect(page.getByTestId('collection-debug-retrieval')).toBeVisible();
    await expect(page.getByTestId('collection-debug-failed')).toBeVisible();

    await toggle.click();
    await expect(page.getByTestId('collection-debug-drawer-content')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
