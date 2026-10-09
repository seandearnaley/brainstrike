import {
  getProviderModelDefinitions,
  OPENROUTER_RECOMMENDED_CODING_MODEL_IDS,
} from '@brainstrike/assistant-contract';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const KEY = 'sk-or-test-host-provider-defaults';

/** The recommended OpenRouter rows' `is_enabled`, as host admission reads them. */
async function recommendedRows(page: Page): Promise<Record<string, boolean>> {
  return await page.evaluate(
    async (ids) => {
      const db = window.electronAPI?.db;
      if (!db) {
        throw new Error('The app database query path is unavailable');
      }
      const result = await db.query(
        `SELECT id, is_enabled AS "isEnabled" FROM models WHERE provider_id = 'openrouter' AND id = ANY($1)`,
        [ids]
      );
      const rows: readonly unknown[] = result.rows;
      return Object.fromEntries(
        rows.map((row) => {
          if (
            !(
              typeof row === 'object' &&
              row !== null &&
              'id' in row &&
              typeof row.id === 'string' &&
              'isEnabled' in row &&
              typeof row.isEnabled === 'boolean'
            )
          ) {
            throw new Error(`An unexpected models row: ${JSON.stringify(row)}`);
          }
          return [row.id, row.isEnabled];
        })
      );
    },
    [...OPENROUTER_RECOMMENDED_CODING_MODEL_IDS]
  );
}

/**
 * First-configuration defaults on a host thread: adding an OpenRouter key
 * enables its recommended starter models, as it did for legacy threads, and
 * the host composer offers them.
 */
test('adding a provider key on a host thread enables its recommended models', async ({
  homePage,
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
});
