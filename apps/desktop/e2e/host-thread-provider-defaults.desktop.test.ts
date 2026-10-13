import {
  getProviderModelDefinitions,
  OPENROUTER_RECOMMENDED_CODING_MODEL_IDS,
} from '@brainstrike/assistant-contract';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const KEY = 'sk-or-test-host-provider-defaults';
// A recommended model with a recorded public metadata fixture the shim serves.
const SEND_MODEL = 'openai/gpt-5.6-terra';
const REPLY = 'A reply from a newly enabled model.';

/** The recommended OpenRouter rows' `is_enabled`, as host admission reads them. */
async function recommendedRows(page: Page): Promise<Record<string, boolean>> {
  return await page.evaluate(
    async (ids) => {
      if (!window.modelCatalog) {
        throw new Error('Canonical model catalog unavailable');
      }
      const { models } = await window.modelCatalog.read();
      const wanted = new Set<string>(ids);
      return Object.fromEntries(
        models
          .filter((row) => row.providerId === 'openrouter' && wanted.has(row.id))
          .map((row) => [row.id, row.isEnabled])
      );
    },
    [...OPENROUTER_RECOMMENDED_CODING_MODEL_IDS]
  );
}

/**
 * First-configuration defaults on a host thread: adding an OpenRouter key
 * enables its recommended starter models, as it did for legacy threads, the
 * host composer offers them, and a send on one runs through the provider shim.
 */
test('adding a provider key on a host thread enables its recommended models, which send', async ({
  homePage,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(180_000);
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(region.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  const off = Object.fromEntries(OPENROUTER_RECOMMENDED_CODING_MODEL_IDS.map((id) => [id, false]));
  // A fresh profile ships the starter kit off.
  expect(await recommendedRows(page)).toEqual(off);

  await homePage.openSettings();
  await page
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { name: /^Providers$/i })
    .click();
  await page.getByTestId('provider-card-toggle-openrouter').click();
  await page.getByTestId('credential-set-openrouter').click();
  await page.getByTestId('credential-key-input-openrouter').fill(KEY);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('credential-status-openrouter')).toContainText('Stored');
  await homePage.leaveSettings();
  await ensureAssistantShellVisible(page);

  const on = Object.fromEntries(OPENROUTER_RECOMMENDED_CODING_MODEL_IDS.map((id) => [id, true]));
  await expect.poll(() => recommendedRows(page), { timeout: 30_000 }).toEqual(on);

  // The host composer's picker reads the same rows.
  const catalog = getProviderModelDefinitions('openrouter');
  await region.getByTestId('composer-model-menu-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  for (const id of OPENROUTER_RECOMMENDED_CODING_MODEL_IDS) {
    const definition = catalog.find((model) => model.id === id);
    if (!definition) {
      throw new Error(`The OpenRouter catalog has no recommended model ${id}`);
    }
    const name = definition.label ?? id;
    await picker.getByRole('combobox').fill(name);
    await expect(picker.getByRole('option', { name }).first()).toBeVisible();
  }

  // A newly enabled model sends. No env key is set: the key saved through
  // Settings is the credential the host signs the request with.
  const sendModel = catalog.find((model) => model.id === SEND_MODEL);
  if (!sendModel) {
    throw new Error(`The OpenRouter catalog has no ${SEND_MODEL}`);
  }
  const sendModelName = sendModel.label ?? SEND_MODEL;
  await picker.getByRole('combobox').fill(sendModelName);
  await picker.getByRole('option', { name: sendModelName }).first().click();
  modelProvider.setScript({ finalText: REPLY });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill('Say the reply.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });
  expect(modelProvider.servedMetadata()).toContain(SEND_MODEL);
  expect(
    modelProvider
      .requests()
      .map(({ requestBody }) =>
        typeof requestBody === 'object' && requestBody !== null && 'model' in requestBody
          ? requestBody.model
          : undefined
      )
  ).toContain(SEND_MODEL);
  // Settings' credential checks (OpenRouter `GET /key`, OpenAI `GET /models`)
  // are unscripted, so the boundary refuses them; nothing on the send path is.
  expect(
    modelProvider
      .refusals()
      .filter(
        ({ knob, route }) =>
          !(
            (knob === 'OPENROUTER_BASE_URL' && route === '/key') ||
            (knob === 'OPENAI_BASE_URL' && route === '/models')
          )
      )
  ).toEqual([]);
});
