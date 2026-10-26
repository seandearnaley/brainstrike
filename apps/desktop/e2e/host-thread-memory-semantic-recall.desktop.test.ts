import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-memory-semantic-recall';
const OPENAI_KEY = 'test-key-host-memory-semantic-recall-openai';
// The assistant panel's persisted Detail level (assistant-detail-level-context.tsx).
const DETAIL_LEVEL_KEY = 'brainstrike.assistant.detail-level';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL_ID = 'anthropic/claude-sonnet-4.6';
// The renderer's persisted memory settings (app-state assistant-memory-preferences-store).
const MEMORY_SETTINGS_KEY = 'assistant-memory-preferences.v1';
const MEMORY_SETTINGS_VERSION = 2;
const GENERIC_FAULT = 'Something went wrong. The details were recorded in the diagnostic log.';
const PROMPT = 'Remember that the launch venue is the riverside hall in Lisbon.';
const ANSWER = 'SEMANTIC_RECALL_ANSWER';

// OpenAI embeddings come from the shim through OPENAI_BASE_URL; no Google credential reaches the profile.
test.use({
  electronEnv: {
    AI_GOOGLE_API_KEY: '',
    BRAINSTRIKE_GOOGLE_API_KEY: '',
    BRAINSTRIKE_OPENAI_API_KEY: OPENAI_KEY,
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

async function writeStorage(page: Page, key: string, value: unknown): Promise<void> {
  await page.evaluate(
    async (entry) => {
      const storage = window.electronAPI?.storage;
      if (!storage) {
        throw new Error('The app storage bridge is unavailable');
      }
      await storage.setItem(entry.key, entry.value);
    },
    { key, value: JSON.stringify(value) }
  );
}

/** Observations stay on (Auto, the default); semantic recall embeds with `embedder`. */
async function enableSemanticRecall(page: Page, embedder: string): Promise<void> {
  await writeStorage(page, MEMORY_SETTINGS_KEY, {
    state: {
      ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      semanticRecall: {
        ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
        embeddingModelTarget: embedder,
        enabled: true,
      },
    },
    version: MEMORY_SETTINGS_VERSION,
  });
  // The renderer reads its persisted memory settings when it loads.
  await reloadRenderer(page, 'host-thread-memory-semantic-recall: reload');
  await enableModel(page);
  await ensureAssistantShellVisible(page);
}

async function sendFirstMessage(page: Page): Promise<void> {
  const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(PROMPT);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  const answer = panel.getByText(ANSWER, { exact: true });
  // Settled either way, so a failed send fails here with its own words.
  await expect(answer.or(page.getByText(GENERIC_FAULT)).first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(GENERIC_FAULT)).toHaveCount(0);
  await expect(answer).toBeVisible();
}

/** A new thread's composer is ready: its memory precondition passed. */
async function startNewThread(page: Page): Promise<void> {
  await page.getByTestId('assistant-new-thread-button').click();
  await expect(
    page.getByRole('tab', { exact: true, name: 'New Thread', selected: true })
  ).toBeVisible();
  const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(panel.getByRole('textbox', { name: 'Message input' })).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.getByText(GENERIC_FAULT)).toHaveCount(0);
}

interface MainLogRecord {
  readonly args?: readonly unknown[];
  readonly scope?: string;
}

/** Main's session log records, as Settings → Logs reads them. */
async function mainLogRecords(page: Page): Promise<readonly MainLogRecord[]> {
  return await page.evaluate(async () => {
    const logging = (
      window as Window & {
        logging?: {
          getBufferedLogs(): Promise<
            { ok: true; value: MainLogRecord[] } | { error: unknown; ok: false }
          >;
        };
      }
    ).logging;
    if (!logging) {
      throw new Error('The logging bridge is unavailable');
    }
    const result = await logging.getBufferedLogs();
    if (!result.ok) {
      throw new Error(JSON.stringify(result.error));
    }
    return result.value;
  });
}

/** BST-2226: every committed hosted-embedder spend receipt, across the app's threads. */
async function embeddingReceipts(page: Page): Promise<readonly unknown[]> {
  const userData = await page.evaluate(() => globalThis.window.electronAPI!.getUserDataPath());
  return await withAppHost(userData, async (client) => {
    const { threads } = await client.request('thread/list', {});
    const read = await Promise.all(
      threads.map(({ threadId }) => client.request('thread/read', { fromSeq: 0, threadId }))
    );
    return read
      .flatMap((thread) => thread.rows)
      .flatMap(({ event }) =>
        event.type === 'memory.usage' && event.kind === 'embedding' ? [event] : []
      );
  });
}

async function finishedOutcomes(page: Page): Promise<readonly unknown[]> {
  const userData = await page.evaluate(() => globalThis.window.electronAPI!.getUserDataPath());
  return await withAppHost(userData, async (client) => {
    const { threads } = await client.request('thread/list', {});
    const read = await Promise.all(
      threads.map(({ threadId }) => client.request('thread/read', { fromSeq: 0, threadId }))
    );
    return read
      .flatMap((thread) => thread.rows)
      .flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []));
  });
}

/**
 * BST-2193: semantic recall with observations on (Auto) answers the first send
 * of a new thread.
 */
test('a hosted embedder recalls from the first send, with observations on', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  modelProvider.setScript(({ requestBody }) => ({
    finalText: (requestBody as { stream?: unknown }).stream === true ? ANSWER : 'Lisbon venue',
  }));
  // text-embedding-3-small's catalog dimensions.
  modelProvider.serveEmbeddings(1536);
  await enableModel(page);
  // BST-2225: the Developer detail level shows the recall in the memory panel.
  await page.evaluate((key) => window.localStorage.setItem(key, 'developer'), DETAIL_LEVEL_KEY);
  await enableSemanticRecall(page, 'openai/text-embedding-3-small');

  await sendFirstMessage(page);
  // Recall embedded the message through the provider the settings name.
  expect(modelProvider.embeddingRequests()).toContainEqual({
    input: [PROMPT],
    model: 'text-embedding-3-small',
  });
  // The recall reached this view live, never as a committed row.
  await page
    .getByRole('region', { exact: true, name: 'Assistant' })
    .getByTestId('context-usage-trigger')
    .hover();
  await expect(page.getByTestId('context-usage-memory-last-recall')).toContainText(
    / messages? · top \d+ · (all threads|this thread) · [\d,]+ ms/u,
    { timeout: 30_000 }
  );
  // BST-2226: the embedder's provider-reported tokens are this thread's spend.
  await expect(page.getByTestId('context-usage-source-memory-embedding')).toContainText(
    'Memory embeddings',
    { timeout: 30_000 }
  );
  await startNewThread(page);
  expect(await finishedOutcomes(page)).toEqual(['completed']);
  expect(await embeddingReceipts(page)).toContainEqual(
    expect.objectContaining({
      kind: 'embedding',
      modelId: 'openai::text-embedding-3-small',
      usage: expect.objectContaining({ outputTokens: 0 }),
    })
  );
  expect(modelProvider.refusals()).toEqual([]);
});

/**
 * BST-2202: a memory embedder's provider rejection is memory's typed failure,
 * named after the embedder's own provider (never the OpenRouter chat model),
 * with the reference its cause was logged under in Main's diagnostics.
 */
const embedderRejected = (step: 'recall' | 'save'): RegExp =>
  new RegExp(
    `^Memory ${step} failed because its embedding model \\(OpenAI text-embedding-3-small\\) failed: Embedding provider openai refused the request \\(HTTP 401\\)\\. Check the OpenAI API key in Settings → Providers, or choose another embedding model in Settings → Assistant Memory\\. Provider response: OpenAI returned HTTP 401\\. Reference: [0-9a-f-]{36}$`,
    'u'
  );
const RECALL_NOTICE = 'Memory recall failed; this answer has no recalled history';

/**
 * BST-2277 (ADR-0026's memory lane): a failed recall is the turn's notice, not
 * its outcome, so the turn answers without recalled history. The save that
 * embeds the turn then meets the same refusal, and that failure ends the run.
 */
test('a hosted embedder’s rejection is the turn’s recall notice, then the run’s save failure, each with its reference', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  modelProvider.setScript(({ requestBody }) => ({
    finalText: (requestBody as { stream?: unknown }).stream === true ? ANSWER : 'Lisbon venue',
  }));
  // No embeddings are served: the shim refuses each embedder request with a terminal 401.
  await enableModel(page);
  await enableSemanticRecall(page, 'openai/text-embedding-3-small');

  const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(PROMPT);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  // The save failure is the run's failure row.
  const saved = panel.getByRole('alert').getByText(embedderRejected('save'));
  await expect(saved.or(page.getByText(GENERIC_FAULT)).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(GENERIC_FAULT)).toHaveCount(0);
  await expect(page.getByText(/OpenRouter rejected/u)).toHaveCount(0);
  // The recall's failure did not end the turn: its notice, then the answer.
  await expect(panel.getByText(ANSWER, { exact: true })).toBeVisible();
  const notice = panel.getByTestId('assistant-run-timeline').filter({ hasText: RECALL_NOTICE });
  await expect(notice.getByRole('img', { name: 'Failed' })).toBeVisible();
  const recalled = notice.getByText(embedderRejected('recall'));
  await expect(recalled).toBeVisible();
  const references = [await recalled.textContent(), await saved.textContent()].map(
    (detail) => /Reference: ([0-9a-f-]{36})$/u.exec(detail ?? '')?.[1]
  );
  expect(new Set(references).size).toBe(2);
  // The agent host's record of each cause reached Main's logger under its reference.
  for (const reference of references) {
    expect(reference).toBeDefined();
    await expect
      .poll(
        async () =>
          (await mainLogRecords(page)).some(
            (record) =>
              record.scope?.startsWith('AgentHost') === true &&
              JSON.stringify(record.args).includes(`"correlationId":"${reference}"`) &&
              JSON.stringify(record.args).includes('"code":"memory.embedder-failed"')
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
  }
  expect(await finishedOutcomes(page)).toEqual(['failed']);
  // Every refusal is the embedder's: no other provider route was refused.
  const refusals = modelProvider.refusals();
  expect(refusals).toEqual(
    refusals.map(() =>
      expect.objectContaining({ knob: 'OPENAI_BASE_URL', method: 'POST', route: '/embeddings' })
    )
  );
  const turn = modelProvider
    .requests()
    .find(({ requestBody }) => (requestBody as { stream?: unknown }).stream === true);
  if (!turn) {
    throw new Error('The turn sent no streamed model request');
  }
  // The recall embeds its query once, before the turn's model request.
  expect(refusals.filter(({ requestIndex }) => requestIndex < turn.requestIndex)).toHaveLength(1);
  // The save embeds the prompt and the answer at once (Mastra `Memory.saveMessages`
  // maps them through `Promise.all`). The first 401 fails the save, the host aborts
  // the run on it (agent-host `onStepFinish`, core-run-execution.ts), and the run
  // signal cancels the other embed (`MemoryProviderLifetime.embeddingCall`). That
  // embed reaches the provider only if it was sent before the abort, a race decided
  // within a millisecond (BST-2290), so the save is refused once or twice.
  const saveRefusals = refusals.filter(({ requestIndex }) => requestIndex > turn.requestIndex);
  expect(saveRefusals.length).toBeGreaterThanOrEqual(1);
  expect(saveRefusals.length).toBeLessThanOrEqual(2);
});
