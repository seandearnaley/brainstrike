import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-tools-menu';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
const FIRST_REPLY = 'The first reply.';
const SECOND_REPLY = 'The second reply.';
const TOGGLED_TOOL = 'manageTaskList';

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

test("a host thread's Tools menu toggles a native tool, and the next host run leaves it out", async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await enableModel(page);
  modelProvider.setScript({ finalText: FIRST_REPLY });
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await input.fill('First turn.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(FIRST_REPLY)).toBeVisible({ timeout: 90_000 });
  // Run requests stream; the thread title request does not and offers no tools.
  const runRequests = () =>
    modelProvider
      .requests()
      .filter(({ requestBody }) => (requestBody as { stream?: unknown }).stream === true);
  expect(runRequests()).toHaveLength(1);
  expect(runRequests()[0]?.toolNames.some((name) => name.endsWith(TOGGLED_TOOL))).toBe(true);

  // The composer's controls carry the Tools section again, every tool enabled.
  await region.getByRole('button', { name: 'Open assistant controls' }).click();
  const tools = page.getByRole('region', { name: 'AI Tools' });
  await expect(tools).toContainText(/(\d+) of \1 enabled/u);
  await tools.getByRole('searchbox', { name: 'Search tools' }).fill('task list');
  const toggle = tools.getByRole('switch', { name: 'Manage Task List enabled' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(tools).not.toContainText(/(\d+) of \1 enabled/u);
  await page.keyboard.press('Escape');

  // The saved preference is what the next send captures for the host run.
  modelProvider.setScript({ finalText: SECOND_REPLY });
  await input.fill('Second turn.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(SECOND_REPLY)).toBeVisible({ timeout: 90_000 });
  expect(runRequests()).toHaveLength(2);
  const second = runRequests()[1]?.toolNames ?? [];
  expect(second.length).toBeGreaterThan(0);
  expect(second.some((name) => name.endsWith(TOGGLED_TOOL))).toBe(false);
  expect(modelProvider.refusals()).toEqual([]);
});
