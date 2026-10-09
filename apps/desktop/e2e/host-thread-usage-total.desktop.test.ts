import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-usage-total';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
const REPLY = 'A reply the meter totals.';

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

test("a host thread's meter leads with its committed total and cost, across a reload", async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await enableModel(page);
  modelProvider.setScript({ finalText: REPLY });
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Count my tokens.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });

  // The shim reports 4 input and 3 output tokens for the one provider call,
  // priced at the catalog's $3 / $15 per million tokens.
  const trigger = region.getByTestId('context-usage-trigger');
  await expect(trigger).toHaveAttribute('aria-label', /^Thread usage: 7 tokens; context /u, {
    timeout: 30_000,
  });
  await expect(region.getByTestId('context-usage-trigger-cost')).toHaveText('· $0.000057');

  // The total is read from the committed log, so a reload shows it again.
  await page.reload();
  const reloaded = page.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(reloaded.getByText(REPLY)).toBeVisible({ timeout: 60_000 });
  await expect(reloaded.getByTestId('context-usage-trigger')).toHaveAttribute(
    'aria-label',
    /^Thread usage: 7 tokens; context /u,
    { timeout: 30_000 }
  );
  await expect(reloaded.getByTestId('context-usage-trigger-cost')).toHaveText('· $0.000057');
  expect(modelProvider.refusals()).toEqual([]);
});
