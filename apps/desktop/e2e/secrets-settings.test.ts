import { expect, test } from './fixtures/electron-fixture';

test.describe('Secrets Settings', () => {
  test('save and retrieve provider key via settings UI + IPC', async ({ window, homePage }) => {
    await homePage.openSettings();
    await expect(window.getByTestId('settings-section')).toBeVisible();

    // Navigate to Models & Providers category
    await window.getByRole('button', { name: /Models & Providers/i }).click();

    const providerSelect = window.getByTestId('llm-provider');
    await expect(providerSelect).toBeVisible();
    await providerSelect.click();

    const option = window
      .getByRole('option', { name: 'OpenAI' })
      .or(window.getByRole('option', { name: /OpenAI/i }));
    await option.click();

    await window.getByTestId('llm-api-key').fill('sk-test-123');
    await window.getByTestId('save-llm-key').click();

    await expect(window.getByTestId('saved-llm-providers')).toContainText('openai');

    const fetched = await window.evaluate(async () => {
      const globals = window as unknown as {
        secrets?: { getKey?: (provider: string) => Promise<string | null> };
      };
      const key = await globals.secrets?.getKey?.('openai');
      return key || null;
    });
    expect(fetched).toBe('sk-test-123');

    await window.getByTestId('delete-llm-key').click();
    await expect(window.getByTestId('saved-llm-providers')).not.toContainText('openai');
  });
});
