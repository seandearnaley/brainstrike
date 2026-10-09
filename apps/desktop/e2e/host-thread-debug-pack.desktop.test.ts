import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-debug-pack';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
const REPLY = 'A reply the debug pack exports.';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL_ID}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    const db = window.electronAPI?.db;
    if (!db) {
      throw new Error('The app database query path is unavailable');
    }
    await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
      model,
      'openrouter',
    ]);
  }, MODEL_ID);
}

// The download itself writes to the OS Downloads folder, which an E2E run
// must not touch; the pack's content is proven in host-thread-debug.test.ts.
test('a host thread offers its debug pack', async ({ modelProvider, window: page }) => {
  test.setTimeout(300_000);
  await enableModel(page);
  modelProvider.setScript({ finalText: REPLY });
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Debug me.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });

  await region.getByText('Debug pack', { exact: true }).click();
  await expect(region.getByRole('button', { name: 'Download debug pack' })).toBeEnabled();
  expect(modelProvider.refusals()).toEqual([]);
});
