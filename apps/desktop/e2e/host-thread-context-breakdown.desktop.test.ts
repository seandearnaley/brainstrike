import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-breakdown';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
const REPLY = 'A reply whose prompt the popover breaks down.';

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

test('a host run shows its prompt breakdown in the context popover, from its committed log', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await enableModel(page);
  modelProvider.setScript({ finalText: REPLY });
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Break my prompt down.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });

  // The meter's popover opens on hover and focus.
  await region.getByTestId('context-usage-trigger').hover();
  const breakdown = page.getByTestId('context-usage-breakdown');
  await expect(breakdown.getByTestId('context-usage-breakdown-system')).toContainText(
    /System instructions.*~\d/u,
    { timeout: 30_000 }
  );
  await expect(breakdown.getByTestId('context-usage-breakdown-tool-definitions')).toContainText(
    /Tool definitions.*~\d/u
  );
  await expect(page.getByTestId('context-usage-breakdown-invalid')).toHaveCount(0);

  // The breakdown is a committed host fact on the prepared provider request.
  const log = await readAgentHostLog(electron.getUserDataDir());
  expect(log.typeCounts['provider.request.prepared']).toBeGreaterThan(0);
  expect(modelProvider.refusals()).toEqual([]);
});
