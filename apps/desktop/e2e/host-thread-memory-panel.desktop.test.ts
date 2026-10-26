import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-memory-panel';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
// The renderer's persisted memory settings (app-state assistant-memory-preferences-store).
const MEMORY_SETTINGS_KEY = 'assistant-memory-preferences.v1';
const MEMORY_SETTINGS_VERSION = 2;
// The assistant panel's persisted Detail level (assistant-detail-level-context.tsx).
const DETAIL_LEVEL_KEY = 'brainstrike.assistant.detail-level';
const ANSWER = 'MEMORY_PANEL_ANSWER_COMPLETE';
// Mastra's observer system prompt, as the external provider receives it.
const OBSERVER = /memory consciousness of an AI assistant\. Your observations/u;
// Long enough to cross one async buffer interval (bufferTokens 0.2 x 1,000),
// far below the synchronous observation threshold.
const PROMPT = `Remember these launch facts for later. ${Array.from(
  { length: 40 },
  (_, index) => `Fact ${index + 1}: the venue on day ${index + 1} is the riverside hall in Lisbon.`
).join(' ')}`;

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
 * BST-2201: at the Developer detail level, the context popover's Memory panel
 * shows what the host's memory read reports — the record's live buffering
 * flag while Mastra's background observer is still out, the observer that
 * runs it, both thresholds against the current tokens — then the buffered
 * observation once the observer answers, with its committed cycle (BST-2224),
 * and the idle record on the next read.
 */
test('the Developer memory panel shows the observer buffering live, then its buffered observation', async ({
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(300_000);
  const observerEntered = Promise.withResolvers<void>();
  const releaseObserver = Promise.withResolvers<void>();
  modelProvider.setScript(({ messages }) => {
    if (OBSERVER.test(JSON.stringify(messages))) {
      observerEntered.resolve();
      return {
        beforeFinalText: releaseObserver.promise,
        finalText: '<observations>\n* User named Lisbon as the launch city.\n</observations>',
      };
    }
    return { finalText: ANSWER };
  });
  try {
    await enableModel(page);
    const settings = {
      ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      observationalMemory: {
        ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
        enabled: true,
        messageTokens: 1000,
        modelTarget: `openrouter/${MODEL_ID}`,
      },
    };
    await page.evaluate(
      async ({ detail, detailKey, key, value }) => {
        const storage = window.electronAPI?.storage;
        if (!storage) {
          throw new Error('The app storage bridge is unavailable');
        }
        await storage.setItem(key, value);
        window.localStorage.setItem(detailKey, detail);
      },
      {
        detail: 'developer',
        detailKey: DETAIL_LEVEL_KEY,
        key: MEMORY_SETTINGS_KEY,
        value: JSON.stringify({ state: settings, version: MEMORY_SETTINGS_VERSION }),
      }
    );
    // The renderer reads its persisted memory settings and Detail level when it loads.
    await reloadRenderer(page, 'host-thread-memory-panel: reload 1');
    await enableModel(page);
    await ensureAssistantShellVisible(page);
    const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
    const input = panel.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await input.fill(PROMPT);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await observerEntered.promise;
    await expect(panel.getByText(ANSWER, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0, {
      timeout: 10_000,
    });

    // The observer is still held at the provider: the record says it is buffering.
    await panel.getByTestId('context-usage-trigger').hover();
    const memory = page.getByTestId('context-usage-memory-panel');
    await expect(memory.getByTestId('context-usage-memory-live')).toContainText(
      'Buffering observation',
      { timeout: 30_000 }
    );
    await expect(memory.getByTestId('context-usage-memory-observer')).toContainText(
      `openrouter::${MODEL_ID}`
    );
    await expect(memory.getByTestId('context-usage-memory-observe-threshold')).toContainText(
      '/ 1,000 message tokens'
    );
    await expect(memory.getByTestId('context-usage-memory-reflect-threshold')).toContainText(
      'observation tokens'
    );
    await expect(memory.getByTestId('context-usage-memory-generation')).toContainText(
      '0 (initial)'
    );
    await expect(memory.getByTestId('context-usage-memory-last-buffered')).toContainText('Never');
    await expect(memory.getByTestId('context-usage-memory-embedder')).toContainText('Off');
    await testInfo.attach('memory-panel-buffering', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // The observer answers: its committed usage re-reads the record, which now
    // holds the buffered chunk. Each read is dated: Mastra clears its flag after
    // storing the chunk, and no committed row marks that.
    releaseObserver.resolve();
    await expect(
      memory.getByTestId('context-usage-memory-last-buffered').locator('time')
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(memory.getByTestId('context-usage-memory-read-at').locator('time')).toHaveCount(1);
    await expect(page.getByTestId('context-usage-om-buffered')).toContainText('Buffered OM');
    // BST-2224: the buffered observation committed its cycle, which the panel shows.
    const cycle = memory.getByTestId('context-usage-memory-last-observation-cycle');
    await expect(cycle).toContainText('Completed · async-buffer', { timeout: 30_000 });
    await expect(cycle).toContainText(/ in \/ [\d,]+ out/u);

    // The thread's next read, when it reopens, finds the record idle again.
    await reloadRenderer(page, 'host-thread-memory-panel: reload 2');
    await ensureAssistantShellVisible(page);
    const reopened = page.getByRole('region', { exact: true, name: 'Assistant' });
    await expect(reopened.getByText(ANSWER, { exact: true })).toBeVisible({ timeout: 30_000 });
    await reopened.getByTestId('context-usage-trigger').hover();
    await expect(memory.getByTestId('context-usage-memory-live')).toHaveText(/Idle$/u, {
      timeout: 30_000,
    });
    await expect(
      memory.getByTestId('context-usage-memory-last-buffered').locator('time')
    ).toHaveCount(1);
    // The cycle is a committed fact: the reopened thread still shows it.
    await expect(memory.getByTestId('context-usage-memory-last-observation-cycle')).toContainText(
      'Completed · async-buffer'
    );
    await testInfo.attach('memory-panel-buffered', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    releaseObserver.resolve();
  }
});
