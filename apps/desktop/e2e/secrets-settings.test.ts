import { expect, test } from './fixtures/electron-fixture';

test.describe('Secrets Settings', { tag: '@smoke' }, () => {
  test('locks the injected OpenAI environment key row and enables its composer models', async ({
    window,
    homePage,
  }) => {
    await homePage.openSettings();
    await expect(window.getByRole('navigation', { name: 'Settings categories' })).toBeVisible();
    await expect(window.getByRole('heading', { exact: true, name: 'Settings' })).toBeVisible();

    // Navigate to API Keys category (scoped to settings nav to avoid nav sidebar conflicts)
    await window
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: /API Keys/i })
      .click();
    await expect(window.getByTestId('settings-category-api-keys')).toBeVisible();

    // The Credential Inventory shows EVERY slot at once — no dropdown remains.
    await expect(window.getByTestId('credential-row-openai')).toBeVisible();
    await expect(window.getByTestId('credential-row-anthropic')).toBeVisible();
    await expect(window.getByTestId('credential-row-tavily')).toBeVisible();
    await expect(window.getByTestId('llm-provider')).toHaveCount(0);

    // The Variable column teaches the canonical vendor env name.
    await expect(window.getByTestId('credential-env-var-openai')).toHaveText('OPENAI_API_KEY');

    // The injected env var locks the row read-only: badge + lock, no editor.
    await expect(window.getByTestId('credential-status-openai')).toContainText(
      'Env (BRAINSTRIKE_OPENAI_API_KEY)'
    );
    await expect(window.getByTestId('credential-env-lock-openai')).toBeVisible();
    await expect(window.getByTestId('credential-set-openai')).toHaveCount(0);
    await expect(window.getByTestId('credential-replace-openai')).toHaveCount(0);
    await expect(window.getByTestId('credential-remove-openai')).toHaveCount(0);

    await window.keyboard.press('Escape');
    await expect(window.getByRole('navigation', { name: 'Settings categories' })).not.toBeVisible();

    const modelPicker = window.getByTestId('composer-model-menu-trigger');
    await expect(modelPicker).toBeEnabled();
    await modelPicker.click();
    const moreModels = window.getByTestId('composer-more-models-trigger');
    await expect(moreModels).toBeEnabled();
    await moreModels.focus();
    await window.keyboard.press('ArrowRight');

    const openAiProvider = window.getByRole('menuitem', { name: /OpenAI/ }).last();
    await expect(openAiProvider).toBeVisible();
    await openAiProvider.focus();
    await window.keyboard.press('ArrowRight');

    const openAiModel = window.getByRole('menuitemradio').filter({ hasText: /GPT/i }).first();
    await expect(openAiModel).toBeVisible();
    await expect(openAiModel).toBeEnabled();
    await openAiModel.click();
    await expect(modelPicker).toHaveAccessibleName(/Selected model:.*GPT/i);
  });

  test('sets, fingerprints, retrieves, and removes an Anthropic key through the inventory row', async ({
    window,
    homePage,
  }) => {
    await homePage.openSettings();
    await window
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: /API Keys/i })
      .click();
    await expect(window.getByTestId('settings-category-api-keys')).toBeVisible();

    const anthropicRow = window.getByTestId('credential-row-anthropic');
    await expect(anthropicRow).toBeVisible();
    await expect(window.getByTestId('credential-status-anthropic')).toContainText('Not set');

    // Inline editor: Set expands the row, Enter saves (keyboard flow).
    await window.getByTestId('credential-set-anthropic').click();
    const keyInput = window.getByTestId('credential-key-input-anthropic');
    await expect(keyInput).toBeFocused();
    await keyInput.fill('sk-ant-test-123');
    await window.keyboard.press('Enter');

    await expect(window.getByTestId('credential-status-anthropic')).toContainText('Stored');
    // Non-secret fingerprint: only the last four characters ever render.
    await expect(window.getByTestId('credential-fingerprint-anthropic')).toContainText('…-123');
    await expect(window.getByTestId('credential-editor-anthropic')).toHaveCount(0);

    const fetched = await window.evaluate(async () => {
      const globals = window as unknown as {
        secrets?: { getKey?: (provider: string) => Promise<string | null> };
      };
      const key = await globals.secrets?.getKey?.('anthropic');
      return key || null;
    });
    expect(fetched).toBe('sk-ant-test-123');

    // Remove flow returns the row to Not set.
    await window.getByTestId('credential-remove-anthropic').click();
    await expect(window.getByTestId('credential-status-anthropic')).toContainText('Not set');
    await expect(window.getByTestId('credential-fingerprint-anthropic')).toHaveCount(0);
  });

  test('cancels the inline editor with Escape without closing the settings dialog', async ({
    window,
    homePage,
  }) => {
    await homePage.openSettings();
    await window
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: /API Keys/i })
      .click();
    await expect(window.getByTestId('settings-category-api-keys')).toBeVisible();

    await window.getByTestId('credential-set-tavily').click();
    const keyInput = window.getByTestId('credential-key-input-tavily');
    await expect(keyInput).toBeFocused();
    await keyInput.fill('tvly-discarded');
    await window.keyboard.press('Escape');

    // The editor closed, nothing saved, and the settings dialog stayed open.
    await expect(window.getByTestId('credential-editor-tavily')).toHaveCount(0);
    await expect(window.getByTestId('credential-status-tavily')).toContainText('Not set');
    await expect(window.getByRole('navigation', { name: 'Settings categories' })).toBeVisible();
  });
});
