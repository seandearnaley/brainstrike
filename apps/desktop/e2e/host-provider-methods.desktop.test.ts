import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writePrivateCredentialFile } from '@brainstrike/agent-host/file-credentials';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const STORED_KEY = 'profile-store-openrouter-key';
// The shim's one recorded OpenRouter metadata fixture.
const MODEL = 'anthropic/claude-sonnet-4.6';
const MAIN_PROVIDER_ROUTES = /\/assistant\/(status|verify-provider|openrouter-model)$/;

async function openProvidersCategory(window: Page): Promise<void> {
  const categories = window.getByRole('navigation', { name: 'Settings categories' });
  await expect(categories).toBeVisible();
  await categories.getByRole('button', { name: /^Providers$/i }).click();
  await expect(window.getByTestId('settings-category-providers')).toBeVisible();
}

/**
 * Provider status, credential verification and OpenRouter model metadata come
 * from the agent host over the window's desktop-ui port. The key lives only in
 * the profile's credential store (no provider env key: the launch fixture
 * scrubs them), so every answer below proves the host read its own store.
 */
test('the panel, Settings and the composer read provider facts from the host', async ({
  electron,
  homePage,
  modelProvider,
}) => {
  test.setTimeout(180_000);
  const userData = electron.getUserDataDir();
  await mkdir(userData, { recursive: true });
  await writePrivateCredentialFile(
    path.join(userData, 'brainstrike-credentials.json'),
    JSON.stringify({
      records: {},
      secrets: { openrouter: JSON.stringify({ key: STORED_KEY, type: 'api_key' }) },
      version: 1,
    })
  );
  const page = await electron.ensureWindow();
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(new URL(request.url()).pathname);
  });

  // Select the OpenRouter model without the availability override, so the
  // panel gates on the host's real status answer.
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
  await page.evaluate((model) => {
    const globals = window as unknown as {
      __brainstrikeTestHooks__?: { setAssistantModel: (compositeKey: string) => void };
    };
    const hooks = globals.__brainstrikeTestHooks__;
    if (!hooks) {
      throw new Error('Brainstrike desktop test hooks are unavailable.');
    }
    hooks.setAssistantModel(`openrouter::${model}`);
  }, MODEL);

  // Panel gate: the composer renders only for an enabled availability answer.
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(region.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 60_000,
  });
  // Effort metadata: the composer's reasoning control needs the model's metadata.
  await expect(region.getByTestId('composer-effort-trigger')).toBeVisible({ timeout: 60_000 });
  expect(modelProvider.servedMetadata()).toContain(MODEL);

  // Settings gate: the card names the host-read key source, and the probe runs
  // in the host against the provider boundary, which refuses the fixture key.
  await homePage.openSettings();
  await openProvidersCategory(page);
  await expect(page.getByTestId('provider-connection-openrouter')).toHaveAttribute(
    'data-connection',
    'connected'
  );
  await page.getByTestId('provider-card-toggle-openrouter').click();
  await expect(page.getByTestId('provider-card-body-openrouter')).toBeVisible();
  await page.getByTestId('provider-test-connection-openrouter').click();
  await expect(page.getByTestId('provider-verification-openrouter')).toContainText('Invalid key');
  await expect(page.getByTestId('provider-verification-detail-openrouter')).toContainText(
    'HTTP 401'
  );
  // BST-1981: the card face no longer pairs "Connected" with the rejection.
  await expect(page.getByTestId('provider-connection-openrouter')).toHaveText('Key rejected');
  expect(modelProvider.refusals()).toContainEqual(
    expect.objectContaining({ knob: 'OPENROUTER_BASE_URL', method: 'GET', route: '/key' })
  );

  // Exercise the request observer through an intercepted loopback request.
  // The retired Main assistant HTTP server and URL bridge must stay absent.
  const canaryUrl = `${modelProvider.baseUrl}/request-listener-canary`;
  await page.route(canaryUrl, (route) =>
    route.fulfill({ headers: { 'access-control-allow-origin': '*' }, status: 204 })
  );
  await page.evaluate(async (url) => {
    const bridge = (window as unknown as { assistant?: { getUrl?: unknown } }).assistant;
    if (bridge?.getUrl !== undefined) {
      throw new Error('The retired Main assistant URL bridge is still exposed.');
    }
    await fetch(url);
  }, canaryUrl);
  await expect.poll(() => requests).toContain('/request-listener-canary');
  expect(requests.filter((pathname) => MAIN_PROVIDER_ROUTES.test(pathname))).toEqual([]);
});
