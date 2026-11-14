import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

// BST-2542: a send on a model switched off in Settings is refused with a
// sentence naming the model; the draft stays, and sends once the model is on.
const DRAFT = 'Hello from a model that was switched off.';
const REPLY = 'The model is back on.';
const REFUSAL = 'GPT-6 Luna is switched off in Settings; switch it on or choose another model.';
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-send-disabled-model-')));
writeFileSync(path.join(root, 'notes.md'), 'notes\n');
test.afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

/** Switches GPT-6 Luna on or off in Settings, as a person does. */
async function switchLuna(page: Page, homePage: HomePage, on: boolean): Promise<void> {
  await homePage.openSettings();
  await new SettingsPage(page).openCategory(/Model Catalog/iu, 'model-catalog');
  const toggle = page.getByTestId('model-toggle-gpt-6-luna');
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: on });
  await page.keyboard.press('Escape');
}

test('a send on a model switched off in Settings names the model, keeps the draft and sends once it is on', async ({
  homePage,
  modelProvider,
  window: page,
}) => {
  await seedRoot(page, root, { reloadReason: 'send-disabled-model-root', rootId: randomUUID() });
  await configureAssistantProvider(page, {
    apiKey: 'test-key-send-disabled-model',
    compositeModelKey: 'openai::gpt-6-luna',
    provider: 'openai',
  });
  modelProvider.setScript(() => ({ finalText: REPLY }));
  await switchLuna(page, homePage, false);

  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await input.fill(DRAFT);
  await region.getByRole('button', { exact: true, name: 'Send' }).click();

  const refusal = page.getByRole('alert', { name: 'Agent command error' });
  await expect(refusal.getByText(REFUSAL, { exact: true })).toBeVisible();
  await test
    .info()
    .attach('refused-send', { body: await page.screenshot(), contentType: 'image/png' });
  await expect(input).toHaveValue(DRAFT);
  expect(modelProvider.requests()).toEqual([]);

  await switchLuna(page, homePage, true);
  await ensureAssistantShellVisible(page);
  await expect(input).toHaveValue(DRAFT);
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(REPLY, { exact: true })).toBeVisible();
  await expect(region.getByText(DRAFT, { exact: true })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
});
