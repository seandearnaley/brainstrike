import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-cost';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
const REPLY = 'A costed host reply.';

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

/** Legacy usage rows, read-only through the app's own query path. */
function legacyUsageRows(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const db = window.electronAPI?.db;
    if (!db) {
      throw new Error('The app database query path is unavailable');
    }
    const { rows } = await db.query<{ rows: number }>(
      'SELECT count(*)::int AS rows FROM brainstrike_assistant_run_usage'
    );
    const row = rows[0];
    if (!row) {
      throw new Error('No legacy usage count');
    }
    return row.rows;
  });
}

async function openCostTracking(page: Page) {
  await new HomePage(page).openSettings();
  return new SettingsPage(page).openCategory(/Cost Tracking/i, 'cost-tracking');
}

test('a host run counts toward the daily cap, gates the next send, and lists in the Task Ledger', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await enableModel(page);
  const cost = await openCostTracking(page);
  // Any priced call exceeds this cap: the shim reports 4 input and 3 output tokens.
  await cost.getByTestId('budget-daily-cap-input').fill('0.000001');
  await page.keyboard.press('Escape');
  const usageBefore = await legacyUsageRows(page);

  modelProvider.setScript({ finalText: REPLY });
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await expect(region.getByTestId('budget-guardrail-chip')).toContainText('Last 24h:', {
    timeout: 30_000,
  });
  await input.fill('Spend a little.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });

  // The host run's committed usage reaches the cap: the next send is paused, visibly.
  const blocked = region.getByTestId('budget-guardrail-blocked');
  await expect(blocked).toContainText('Last-24h budget cap reached', { timeout: 30_000 });
  await expect(blocked).toContainText('Sending is paused.');
  await expect(input).toBeDisabled();
  await expect(region.getByTestId('budget-guardrail-unpriced')).toHaveCount(0);

  // The cost views list the host run from its committed log.
  const ledger = (await openCostTracking(page)).getByTestId('task-ledger-panel');
  const run = ledger.getByTestId('task-ledger-run-row').filter({ hasText: MODEL_ID });
  await expect(run).toHaveCount(1, { timeout: 30_000 });
  await expect(run).toContainText('openrouter');
  await expect(run.getByTestId('task-ledger-run-cost')).not.toHaveText(/^\s*$/u);
  await page.keyboard.press('Escape');

  // Projected, never written: the legacy usage table is untouched.
  expect(await legacyUsageRows(page)).toBe(usageBefore);
  expect(modelProvider.refusals()).toEqual([]);
});
