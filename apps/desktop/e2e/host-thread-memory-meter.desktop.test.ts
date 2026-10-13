import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-memory-meter';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
// The renderer's persisted memory settings (app-state assistant-memory-preferences-store).
const MEMORY_SETTINGS_KEY = 'assistant-memory-preferences.v1';
const MEMORY_SETTINGS_VERSION = 2;

// No Google credential reaches this profile, whatever the runner's own environment holds.
test.use({
  electronEnv: {
    AI_GOOGLE_API_KEY: '',
    BRAINSTRIKE_GOOGLE_API_KEY: '',
    BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY,
    GOOGLE_API_KEY: '',
    GOOGLE_GENERATIVE_AI_API_KEY: '',
  },
});

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL_ID}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL_ID}`);
}

/**
 * Gap 15: a host thread's meter shows the memory state the host reports for
 * the next send, and a memory precondition that send would fail gates it.
 */
test('a host thread meter shows its waiting observer, and a memory precondition gates Send', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await enableModel(page);
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(region.getByRole('textbox', { name: 'Message input' })).toBeEnabled({
    timeout: 30_000,
  });

  // Observations are on (Auto) by default, and none of OpenRouter's recommended
  // observer models is enabled: the host reports why the observer waits.
  await region.getByTestId('context-usage-trigger').hover();
  await expect(page.getByTestId('context-usage-om-note')).toContainText(
    'Observations on (Auto) — no recommended observer model is enabled in your model catalog',
    { timeout: 30_000 }
  );

  // Semantic recall saved on a Google embedder whose credential the profile
  // does not hold. Settings offers only keyed embedders, so a key removed
  // after the embedder was chosen is how a profile reaches this state.
  const settings = {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
    semanticRecall: {
      ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
      embeddingModelTarget: 'google/gemini-embedding-001',
      enabled: true,
    },
  };
  await page.evaluate(
    async ({ key, value }) => {
      const storage = window.electronAPI?.storage;
      if (!storage) {
        throw new Error('The app storage bridge is unavailable');
      }
      await storage.setItem(key, value);
    },
    {
      key: MEMORY_SETTINGS_KEY,
      value: JSON.stringify({ state: settings, version: MEMORY_SETTINGS_VERSION }),
    }
  );
  // The renderer reads its persisted memory settings when it loads.
  await page.reload();
  await ensureAssistantShellVisible(page);
  const reopened = page.getByRole('region', { exact: true, name: 'Assistant' });

  // The reason is the error run/start would fail with, shown before any send.
  await expect(
    reopened.getByText(
      'Semantic recall requires a configured Google AI Studio API key. Configure it in Settings → Providers, choose a keyless local embedder, or turn semantic recall off.'
    )
  ).toBeVisible({ timeout: 30_000 });
  await expect(reopened.getByRole('textbox', { name: 'Message input' })).toBeDisabled();
  expect(modelProvider.refusals()).toEqual([]);
});
