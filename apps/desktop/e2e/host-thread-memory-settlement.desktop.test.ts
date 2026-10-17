import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-memory-settlement';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
// The renderer's persisted memory settings (app-state assistant-memory-preferences-store).
const MEMORY_SETTINGS_KEY = 'assistant-memory-preferences.v1';
const MEMORY_SETTINGS_VERSION = 2;
const ANSWER = 'SETTLEMENT_ANSWER_COMPLETE';
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
 * Mastra buffers observations in the background (bufferTokens) and joins them
 * only before its storage closes (`Memory.settled()`). The answer is done at
 * `run.finished`: Stop and Thinking clear while the observer is still out, and
 * its usage commits after.
 */
test('Stop clears when the answer finishes while its memory observation is still buffering', async ({
  electron,
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
    await enableModel(page);
    await ensureAssistantShellVisible(page);
    const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
    const input = panel.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await input.fill(PROMPT);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await observerEntered.promise;

    // The answer is finished with its observer still held at the provider.
    await expect(panel.getByText(ANSWER, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(panel.getByTestId('assistant-thinking-indicator')).toHaveCount(0);
    await testInfo.attach('answer-finished-observer-held', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const rows = () =>
      withAppHost(electron.getUserDataDir(), async (client) => {
        const { threads } = await client.request('thread/list', {});
        const read = await Promise.all(
          threads.map(({ threadId }) => client.request('thread/read', { fromSeq: 0, threadId }))
        );
        return read.flatMap((thread) => thread.rows);
      });
    const held = await rows();
    const finished = held.find(({ event }) => event.type === 'run.finished');
    expect(finished?.event).toMatchObject({ outcome: 'completed' });
    expect(held.some(({ event }) => event.type === 'memory.usage')).toBe(false);

    releaseObserver.resolve();
    // The observer's spend is still the run's, committed after its end.
    await expect
      .poll(
        async () =>
          (await rows()).find(
            ({ event }) => event.type === 'memory.usage' && event.kind === 'observation'
          )?.seq ?? 0,
        { timeout: 30_000 }
      )
      .toBeGreaterThan(finished?.seq ?? Number.POSITIVE_INFINITY);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    releaseObserver.resolve();
  }
});
