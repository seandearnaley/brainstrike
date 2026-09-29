import {
  installSettingsTestOverrides,
  updateSettingsTestOverrides,
} from '@brainstrike/e2e-test-utils/settings-test-overrides';
import type { Page } from '@playwright/test';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

async function readE2eDbPath(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
      .__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E database hooks are not installed');
    }
    return hooks.dbPath;
  });
}

async function waitForPersistedModelState(
  page: Page,
  modelId: string,
  expectedState: boolean
): Promise<void> {
  await page.waitForFunction(
    async ({ expected, id }) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        return false;
      }
      const currentState = await hooks.readModelEnabled(id);
      if (currentState !== expected) {
        return false;
      }
      await hooks.syncDatabase();
      return true;
    },
    { expected: expectedState, id: modelId },
    { timeout: 15_000 }
  );
}

test.describe('Model Catalog settings (web) @web-settings-state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('shows a registry load error and recovers on retry @stateful', async ({ page }) => {
    await installSettingsTestOverrides(page, {
      modelRegistry: { fetchErrorMessage: 'Model registry unavailable for test' },
    });

    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    const modelsContent = await settings.openCategory(/Model Catalog/i, 'models');

    const registryError = modelsContent.getByTestId('model-registry-error');
    await expect(registryError).toBeVisible({ timeout: 15_000 });
    await expect(registryError.getByText('Error loading models', { exact: true })).toBeVisible();
    await expect(registryError.getByText('Model registry unavailable for test')).toBeVisible({
      timeout: 15_000,
    });

    await updateSettingsTestOverrides(page, {
      modelRegistry: { fetchErrorMessage: null },
    });
    await page.getByTestId('model-registry-retry').click();

    // The cache directory lives in a header popover since BST-1805.
    await expect(page.getByTestId('model-cache-dir-trigger')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="model-row-"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('shows the web-only cache directory unavailable path', async ({ page }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/Model Catalog/i, 'models');

    await page.getByTestId('model-cache-dir-trigger').click();
    await page.getByTestId('model-cache-dir-select').click();

    await expect(page.getByText('Directory selection unavailable', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText('Choose a cache directory from the desktop app.', { exact: true })
    ).toBeVisible();
  });

  test('persists a model toggle across reload @stateful', async ({ page }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto();
    await home.navigateToSettings();
    await settings.openCategory(/Model Catalog/i, 'models');

    // Rows are windowed inside provider sections (BST-1805): only rendered rows
    // exist in the DOM. Expand every section, then take the first rendered
    // disabled toggle. Expand all only covers sections that exist when clicked,
    // so wait for the registry to render them first.
    await expect(page.getByTestId(/^model-catalog-section-header-/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId('model-catalog-expand-all').click();
    const firstDisabledToggle = page
      .locator('[data-testid^="model-toggle-"][aria-checked="false"]')
      .first();
    await expect(firstDisabledToggle).toBeVisible({ timeout: 30_000 });
    const toggleTestId = await firstDisabledToggle.getAttribute('data-testid');
    if (!toggleTestId?.startsWith('model-toggle-')) {
      throw new Error(`Unexpected model toggle test id: ${String(toggleTestId)}`);
    }
    const modelId = toggleTestId.slice('model-toggle-'.length);

    const toggle = page.getByTestId(`model-toggle-${modelId}`);
    const expectedAttributeState = 'true';
    const expectedPersistedState = true;

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', expectedAttributeState);
    await waitForPersistedModelState(page, modelId, expectedPersistedState);
    await page.getByRole('button', { name: 'Refresh model registry' }).click();
    await expect(page.getByTestId(`model-toggle-${modelId}`)).toHaveAttribute(
      'aria-checked',
      expectedAttributeState,
      { timeout: 15_000 }
    );
    await waitForPersistedModelState(page, modelId, expectedPersistedState);

    const dbPathBeforeReload = await readE2eDbPath(page);
    await page.reload();
    await waitForAppLoad(page);
    await expect
      .poll(async () => await readE2eDbPath(page), {
        message: 'Expected the Playwright E2E DB path to stay stable across reload',
        timeout: 15_000,
      })
      .toBe(dbPathBeforeReload);
    await home.navigateToSettings();
    await settings.openCategory(/Model Catalog/i, 'models');
    // Searching the id expands its section and brings the row into the window.
    await page.getByRole('searchbox', { name: 'Search models' }).fill(modelId);

    await expect(page.getByTestId(`model-toggle-${modelId}`)).toHaveAttribute(
      'aria-checked',
      expectedAttributeState,
      { timeout: 15_000 }
    );
  });

  test('paints one-line rows at a 36px pitch, windows them, and pins provider headers', async ({
    page,
  }) => {
    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    // Read-only: no DB-readiness wait outside @stateful (readiness contract);
    // the row-visibility wait below gates on the registry instead.
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/Model Catalog/i, 'models');
    // Expand all only covers sections that exist when clicked.
    await expect(page.getByTestId(/^model-catalog-section-header-/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId('model-catalog-expand-all').click();

    const firstGridRows = page.getByRole('treegrid').first().locator('tr[data-node-type="model"]');
    await expect(firstGridRows.nth(3)).toBeVisible({ timeout: 30_000 });

    // Pitch is the delta between consecutive row tops; one row's own height
    // under-reports by half the collapsed border (ui-conventions.md). The first
    // row has no collapsed border above it (measured: 35.5px box, then 36px
    // steps), so sample from the second row onward.
    const tops = await firstGridRows.evaluateAll((rows) =>
      rows.slice(1, 4).map((row) => row.getBoundingClientRect().top)
    );
    const [first, second, third] = tops;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Expected three rendered model rows');
    }
    expect(second - first).toBeCloseTo(36, 0);
    expect(third - second).toBeCloseTo(36, 0);

    // Shared-scroller windowing: with EVERY section expanded, the DOM holds
    // far fewer rows than the catalog.
    const summary = (await page.getByTestId('model-catalog-summary').textContent()) ?? '';
    const totalModels = Number.parseInt(summary, 10);
    expect(totalModels).toBeGreaterThan(50);
    expect(await page.locator('tr[data-node-type="model"]').count()).toBeLessThan(totalModels);

    // Sticky headers: after scrolling, the section under the scroller's top
    // edge has its header pinned there AND painting above the rows.
    const scroller = page.getByTestId('model-catalog-scroll');
    await scroller.evaluate((element) => {
      element.scrollTop = 600;
    });
    await expect
      .poll(
        async () =>
          await scroller.evaluate((element) => {
            const top = element.getBoundingClientRect().top;
            const headers = Array.from(
              element.querySelectorAll<HTMLElement>(
                '[data-testid^="model-catalog-section-header-"]'
              )
            );
            const pinned = headers.find(
              (header) => Math.abs(header.getBoundingClientRect().top - top) < 1
            );
            if (!pinned) {
              return 'no header pinned';
            }
            // Probe a grid over the whole header box: without the sticky layer
            // class, rows scrolled underneath paint over its lower band only
            // (measured), which a single top-edge probe would miss.
            const rect = pinned.getBoundingClientRect();
            for (const x of [rect.left + 8, rect.left + rect.width / 2, rect.right - 8]) {
              for (let y = rect.top + 2; y < rect.bottom - 1; y += 4) {
                const probe = document.elementFromPoint(x, y);
                if (probe === null || !pinned.contains(probe)) {
                  return `occluded at (${Math.round(x - rect.left)}, ${Math.round(y - rect.top)})`;
                }
              }
            }
            return 'pinned';
          }),
        { timeout: 10_000 }
      )
      .toBe('pinned');
  });
});
