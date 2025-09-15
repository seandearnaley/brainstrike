import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import type { ElectronAppContext } from './utils/electron-helpers';
import { closeElectronApp, launchElectronApp, waitForAppReady } from './utils/electron-helpers';

test.describe('Secrets Settings', () => {
  let appContext: ElectronAppContext;
  let homePage: HomePage;

  test.beforeEach(async () => {
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
    homePage = new HomePage(appContext.window);
  });

  test.afterEach(async () => {
    if (appContext) await closeElectronApp(appContext);
  });

  test('save and retrieve provider key via settings UI + IPC', async () => {
    await homePage.openSettings();
    // Ensure settings section is visible
    await expect(appContext.window.getByTestId('settings-section')).toBeVisible();

    // Fill API key for OpenAI and save
    const providerSelect = appContext.window.getByTestId('llm-provider');
    await expect(providerSelect).toBeVisible();
    await providerSelect.click();
    // Select may render listbox options; be flexible
    const option = appContext.window
      .getByRole('option', { name: 'OpenAI' })
      .or(appContext.window.getByRole('option', { name: /OpenAI/i }));
    await option.click();

    await appContext.window.getByTestId('llm-api-key').fill('sk-test-123');
    await appContext.window.getByTestId('save-llm-key').click();

    // Saved providers list should include openai
    await expect(appContext.window.getByTestId('saved-llm-providers')).toContainText('openai');

    // Verify via IPC that we can retrieve it
    const fetched = await appContext.window.evaluate(async () => {
      const w = window as unknown as {
        secrets?: { getKey?: (p: string) => Promise<string | null> };
      };
      const key = await w.secrets?.getKey?.('openai');
      return key || null;
    });
    expect(fetched).toBe('sk-test-123');

    // Delete and verify removal
    await appContext.window.getByTestId('delete-llm-key').click();
    await expect(appContext.window.getByTestId('saved-llm-providers')).not.toContainText('openai');
  });
});
