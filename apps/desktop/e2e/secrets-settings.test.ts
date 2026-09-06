import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';

/**
 * The Provider Hub (BST-1358) replaced the "API Keys" category: credentials
 * now live inside the provider card they belong to, so every credential
 * assertion here first expands that card.
 *
 * Note the settings-modal contract: while the dialog is open, an unscoped
 * `getByRole` can match the app sidebar behind it, so nav lookups stay scoped
 * to the "Settings categories" navigation.
 */
async function openProvidersCategory(window: Page): Promise<void> {
  await expect(window.getByRole('navigation', { name: 'Settings categories' })).toBeVisible();
  await window
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { name: /^Providers$/i })
    .click();
  await expect(window.getByTestId('settings-category-providers')).toBeVisible();
}

test.describe('Provider Hub Settings', { tag: '@smoke' }, () => {
  test('locks the injected OpenAI environment key row and enables its composer models', async ({
    window,
    homePage,
  }) => {
    await homePage.openSettings();
    await openProvidersCategory(window);

    // The hub lists every registry provider as a card, grouped by runtime.
    await expect(window.getByTestId('provider-card-openai')).toBeVisible();
    await expect(window.getByTestId('provider-card-anthropic')).toBeVisible();
    await expect(window.getByTestId('provider-group-hosted')).toBeVisible();
    // The old single-provider dropdown is gone for good.
    await expect(window.getByTestId('llm-provider')).toHaveCount(0);

    // The injected env var reads as connected on the card face, naming the
    // variable that will actually sign the request.
    await expect(window.getByTestId('provider-connection-openai')).toHaveAttribute(
      'data-connection',
      'connected'
    );
    await expect(window.getByTestId('provider-key-source-openai')).toContainText(
      'Env (BRAINSTRIKE_OPENAI_API_KEY)'
    );

    // Expanding the card reveals the credential row for THAT provider only.
    await window.getByTestId('provider-card-toggle-openai').click();
    await expect(window.getByTestId('credential-row-openai')).toBeVisible();
    await expect(window.getByTestId('credential-row-anthropic')).toHaveCount(0);
    await expect(window.getByTestId('credential-env-var-openai')).toHaveText('OPENAI_API_KEY');

    // An env-sourced row stays read-only: badge + lock, no editor.
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

  test('sets, fingerprints, retrieves, and removes an Anthropic key inside its card', async ({
    window,
    homePage,
  }) => {
    await homePage.openSettings();
    await openProvidersCategory(window);

    // Nothing stored yet: the card reads disconnected before it is opened.
    await expect(window.getByTestId('provider-connection-anthropic')).toHaveAttribute(
      'data-connection',
      'disconnected'
    );
    await window.getByTestId('provider-card-toggle-anthropic').click();

    // Registry metadata drives the guidance — no per-provider UI copy.
    await expect(window.getByTestId('provider-docs-link-anthropic')).toBeVisible();
    // A disconnected provider has nothing to probe.
    await expect(window.getByTestId('provider-test-connection-anthropic')).toBeDisabled();

    // Inline editor: Set expands the row, Enter saves (keyboard flow). The
    // editor is where the registry's key-format hint belongs — at the moment
    // the user is typing a key, not repeated on the card above it.
    await window.getByTestId('credential-set-anthropic').click();
    await expect(window.getByTestId('credential-editor-hint-anthropic')).toContainText('sk-ant-');
    const keyInput = window.getByTestId('credential-key-input-anthropic');
    await expect(keyInput).toBeFocused();
    await keyInput.fill('sk-ant-test-123');
    await window.keyboard.press('Enter');

    await expect(window.getByTestId('credential-status-anthropic')).toContainText('Stored');
    // Non-secret fingerprint: only the last four characters ever render.
    await expect(window.getByTestId('credential-fingerprint-anthropic')).toContainText('…-123');
    await expect(window.getByTestId('credential-editor-anthropic')).toHaveCount(0);

    // The card face follows the credential, and the probe becomes available.
    await expect(window.getByTestId('provider-connection-anthropic')).toHaveAttribute(
      'data-connection',
      'connected'
    );
    await expect(window.getByTestId('provider-key-source-anthropic')).toContainText('Stored');
    await expect(window.getByTestId('provider-test-connection-anthropic')).toBeEnabled();

    const fetched = await window.evaluate(async () => {
      const globals = window as unknown as {
        secrets?: { getKey?: (provider: string) => Promise<string | null> };
      };
      const key = await globals.secrets?.getKey?.('anthropic');
      return key || null;
    });
    expect(fetched).toBe('sk-ant-test-123');

    // Removing the key returns the whole card to disconnected.
    await window.getByTestId('credential-remove-anthropic').click();
    await expect(window.getByTestId('credential-status-anthropic')).toContainText('Not set');
    await expect(window.getByTestId('credential-fingerprint-anthropic')).toHaveCount(0);
    await expect(window.getByTestId('provider-connection-anthropic')).toHaveAttribute(
      'data-connection',
      'disconnected'
    );
    await expect(window.getByTestId('provider-test-connection-anthropic')).toBeDisabled();
  });

  test('keeps non-provider credentials reachable and cancels the editor with Escape', async ({
    window,
    homePage,
  }) => {
    await homePage.openSettings();
    await openProvidersCategory(window);

    // Tavily is not a model provider, so it has no card — it lives in the
    // other-credentials table rather than being orphaned by the restructure.
    await expect(window.getByTestId('other-credentials-section')).toBeVisible();
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

  test('cross-links an environment variable chip to the credential inside its provider card', async ({
    window,
    homePage,
  }) => {
    await homePage.openSettings();
    await openProvidersCategory(window);

    // BST-1363's chip → row cross-link must survive the restructure: the row
    // now lives inside a COLLAPSED card, so activating the chip has to open
    // that card before the highlight can mean anything.
    await expect(window.getByTestId('provider-card-body-openai')).toHaveCount(0);
    await window.getByTestId('env-bootstrap-chip-BRAINSTRIKE_OPENAI_API_KEY').click();

    await expect(window.getByTestId('provider-card-body-openai')).toBeVisible();
    await expect(window.getByTestId('credential-row-openai')).toBeVisible();
  });
});
