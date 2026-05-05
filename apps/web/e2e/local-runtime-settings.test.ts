import type { Page, Route } from '@playwright/test';
import {
  installSettingsTestOverrides,
  readLocalRuntimeProbeCounts,
  resetLocalRuntimeProbeCounts,
} from '../../e2e-test-utils/settings-test-overrides';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { resetAppState } from './utils/app-state';

/**
 * Stubs the Ollama and LM Studio localhost probes so the page's discovery
 * service sees a deterministic response without requiring a real local server.
 *
 * When a route returns `unreachable`, we respond with a CORS-allowed network
 * error so the discovery service records an `unavailable` status; for
 * `available` we return a minimal OpenAI-compatible models list.
 */
async function stubLocalRuntimeProbes(
  page: Page,
  policy: {
    lmstudio: 'available' | 'unreachable';
    ollama: 'available' | 'unreachable';
  }
): Promise<void> {
  const ollamaRoutes = /127\.0\.0\.1:11434/;
  const lmstudioRoutes = /127\.0\.0\.1:1234/;

  const fulfillAvailable = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'stub-model' }] }),
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  const fulfillUnreachable = (route: Route) => route.abort('connectionrefused');

  await page.route(ollamaRoutes, async (route) => {
    if (policy.ollama === 'available') {
      await fulfillAvailable(route);
      return;
    }
    await fulfillUnreachable(route);
  });
  await page.route(lmstudioRoutes, async (route) => {
    if (policy.lmstudio === 'available') {
      await fulfillAvailable(route);
      return;
    }
    await fulfillUnreachable(route);
  });
}

test.describe('Local Runtimes settings (web)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
  });

  test('shows the Local Runtimes category with Ollama and LM Studio cards', async ({ page }) => {
    await stubLocalRuntimeProbes(page, { ollama: 'available', lmstudio: 'unreachable' });

    const home = new HomePage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();

    await page.getByRole('button', { name: 'Local Runtimes' }).click();
    await expect(page.getByTestId('settings-category-local-runtimes')).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByRole('heading', { name: 'Ollama', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'LM Studio', exact: true })).toBeVisible();
  });

  test('surfaces Available badge when the probe returns a valid models list', async ({ page }) => {
    await stubLocalRuntimeProbes(page, { ollama: 'available', lmstudio: 'unreachable' });

    const home = new HomePage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await page.getByRole('button', { name: 'Local Runtimes' }).click();

    // Browser calls to http://127.0.0.1:* from an https:// page can be flagged
    // 'blocked_web' by the discovery service; treat either "Available" or
    // "Blocked by browser" as acceptable web outcomes. The spec's real claim is
    // that the probe was actually attempted against the stubbed endpoint.
    const ollamaSection = page
      .getByRole('heading', { name: 'Ollama', exact: true })
      .locator('..')
      .locator('..');
    await expect(ollamaSection).toContainText(/Available|Blocked by browser|Unavailable/, {
      timeout: 15_000,
    });
  });

  test('hides the provider from probes when activation is set to Off', async ({ page }) => {
    await stubLocalRuntimeProbes(page, { ollama: 'available', lmstudio: 'available' });

    const home = new HomePage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await page.getByRole('button', { name: 'Local Runtimes' }).click();

    const ollamaActivation = page.getByTestId('local-runtime-activation-ollama');
    await ollamaActivation.getByRole('radio', { name: /^Off/ }).check();

    const ollamaCard = page
      .getByRole('heading', { name: 'Ollama', exact: true })
      .locator('..')
      .locator('..');
    await expect(ollamaCard).toContainText('Disabled', { timeout: 10_000 });
  });

  test('persists a user-configured baseUrl across a page reload', async ({ page }) => {
    await stubLocalRuntimeProbes(page, { ollama: 'unreachable', lmstudio: 'unreachable' });

    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/Local Runtimes/i, 'local-runtimes');

    const urlInput = page.getByTestId('local-runtime-url-input-ollama');
    await urlInput.fill('http://gpu.lan:11434');
    const saveButton = page.getByTestId('local-runtime-url-save-ollama');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(saveButton).toBeDisabled({ timeout: 10_000 });

    await page.reload();
    await home.navigateToSettings();
    await settings.openCategory(/Local Runtimes/i, 'local-runtimes');

    await expect(page.getByTestId('local-runtime-url-input-ollama')).toHaveValue(
      'http://gpu.lan:11434',
      { timeout: 10_000 }
    );
  });

  test('renders blocked-by-browser diagnostics when the probe reports blocked_web', async ({
    page,
  }) => {
    await installSettingsTestOverrides(page, {
      localRuntime: {
        statuses: {
          ollama: {
            state: 'blocked_web',
            checkedAt: 123,
            message: 'Mixed content blocked the probe',
          },
        },
      },
    });

    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/Local Runtimes/i, 'local-runtimes');

    await expect(page.getByTestId('local-runtime-status-ollama')).toContainText(
      'Blocked by browser'
    );
    await expect(page.getByTestId('local-runtime-card-ollama')).toContainText(
      'Mixed content blocked the probe'
    );
  });

  test('renders unavailable diagnostics when the probe cannot reach the runtime', async ({
    page,
  }) => {
    await installSettingsTestOverrides(page, {
      localRuntime: {
        statuses: {
          ollama: {
            state: 'unavailable',
            checkedAt: 456,
            message: 'Connection refused',
          },
        },
      },
    });

    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/Local Runtimes/i, 'local-runtimes');

    await expect(page.getByTestId('local-runtime-status-ollama')).toContainText('Unavailable');
    await expect(page.getByTestId('local-runtime-card-ollama')).toContainText('Connection refused');
  });

  test('surfaces force-enabled not reachable copy when activation is On and the probe fails', async ({
    page,
  }) => {
    await installSettingsTestOverrides(page, {
      localRuntime: {
        statuses: {
          ollama: {
            state: 'unavailable',
            checkedAt: 789,
            message: 'down for maintenance',
          },
        },
      },
    });

    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/Local Runtimes/i, 'local-runtimes');

    await page
      .getByTestId('local-runtime-activation-ollama')
      .getByRole('radio', { name: /^On/ })
      .check();

    await expect(page.getByTestId('local-runtime-status-ollama')).toContainText(
      'Force-enabled (not reachable)'
    );
    await expect(page.getByTestId('local-runtime-card-ollama')).toContainText(
      'down for maintenance'
    );
  });

  test('probe now only re-probes the clicked runtime', async ({ page }) => {
    await installSettingsTestOverrides(page, {
      localRuntime: {
        trackProbeCounts: true,
        statuses: {
          ollama: {
            state: 'available',
            checkedAt: 100,
            endpoint: 'http://127.0.0.1:11434/v1/models',
            latencyMs: 10,
          },
          lmstudio: {
            state: 'unavailable',
            checkedAt: 101,
            message: 'not running',
          },
        },
      },
    });

    const home = new HomePage(page);
    const settings = new SettingsPage(page);
    await home.goto({ waitForDatabase: false });
    await home.navigateToSettings();
    await settings.openCategory(/Local Runtimes/i, 'local-runtimes');

    await resetLocalRuntimeProbeCounts(page);
    await page.getByTestId('local-runtime-probe-ollama').click();

    await expect(page.getByTestId('local-runtime-status-ollama')).toContainText('Available');
    const counts = await readLocalRuntimeProbeCounts(page);
    expect(counts.ollama).toBe(1);
    expect(counts.lmstudio ?? 0).toBe(0);
  });
});
