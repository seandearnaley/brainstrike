import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
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
// The hidden embedding host's saved device for unpinned loads (app-state vector-preferences-store).
const VECTOR_PREFERENCES_KEY = 'vector-preferences.v1';
// The catalog's local model recommended without WebGPU (BST-1993).
const LOCAL_EMBEDDER = 'local/Xenova/bge-small-en-v1.5';
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
  await page.reload();
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
 * of a new thread, whether its embedder is hosted or on-device.
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
  await startNewThread(page);
  expect(await finishedOutcomes(page)).toEqual(['completed']);
  expect(modelProvider.refusals()).toEqual([]);
});

test('an on-device embedder recalls from the first send, with observations on', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  modelProvider.setScript(({ requestBody }) => ({
    finalText: (requestBody as { stream?: unknown }).stream === true ? ANSWER : 'Lisbon venue',
  }));
  // A saved WASM device, so the host resolves the same device with or without WebGPU.
  await writeStorage(page, VECTOR_PREFERENCES_KEY, {
    state: {
      devicePref: 'wasm',
      devicePrefConfigured: true,
      reinitEveryN: 200,
      verboseOrtLogs: false,
    },
    version: 3,
  });
  await enableModel(page);
  await enableSemanticRecall(page, LOCAL_EMBEDDER);

  await sendFirstMessage(page);
  await startNewThread(page);
  expect(await finishedOutcomes(page)).toEqual(['completed']);
  // No hosted embedding was requested: the shim serves none here, so one would be refused.
  expect(modelProvider.refusals()).toEqual([]);
});

/**
 * BST-2202: a memory embedder's provider rejection is memory's typed failure,
 * named after the embedder's own provider (never the OpenRouter chat model),
 * with the reference its cause was logged under in Main's diagnostics.
 */
test('a hosted embedder’s rejection names the memory embedder and its diagnostic reference', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  modelProvider.setScript(({ requestBody }) => ({
    finalText: (requestBody as { stream?: unknown }).stream === true ? ANSWER : 'Lisbon venue',
  }));
  // No embeddings are served: the shim refuses the embedder's request with a terminal 401.
  await enableModel(page);
  await enableSemanticRecall(page, 'openai/text-embedding-3-small');

  const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(PROMPT);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  // The failure row: the run timeline also titles the run with the same reason.
  const typed = panel
    .getByRole('alert')
    .getByText(
      /^Memory recall failed because its embedding model \(OpenAI text-embedding-3-small\) failed: Embedding provider openai refused the request \(HTTP 401\)\. Check the OpenAI API key in Settings → Providers, or choose another embedding model in Settings → Assistant Memory\. Provider response: OpenAI returned HTTP 401\. Reference: [0-9a-f-]{36}$/u
    );
  await expect(typed.or(page.getByText(GENERIC_FAULT)).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(GENERIC_FAULT)).toHaveCount(0);
  await expect(page.getByText(/OpenRouter rejected/u)).toHaveCount(0);
  const reference = /Reference: ([0-9a-f-]{36})$/u.exec((await typed.textContent()) ?? '')?.[1];
  expect(reference).toBeDefined();
  // The agent host's record of the cause reached Main's logger under that reference.
  await expect
    .poll(
      async () =>
        (await mainLogRecords(page)).some(
          (record) =>
            record.scope === 'AgentHost' &&
            JSON.stringify(record.args).includes(`"correlationId":"${reference}"`) &&
            JSON.stringify(record.args).includes('"code":"memory.embedder-failed"')
        ),
      { timeout: 30_000 }
    )
    .toBe(true);
  expect(await finishedOutcomes(page)).toEqual(['failed']);
  expect(modelProvider.refusals()).toEqual([
    expect.objectContaining({ knob: 'OPENAI_BASE_URL', method: 'POST', route: '/embeddings' }),
  ]);
});

test('an on-device embedder with no execution device refuses with its reason, not a fault', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(300_000);
  // The launcher disables the GPU under CI unless GPU E2E is allowed: no WebGPU adapter,
  // and no saved device, so the embedding host cannot choose one for an unpinned load.
  const previous = {
    allowGpu: process.env['BRAINSTRIKE_E2E_ALLOW_GPU'],
    ci: process.env['CI'],
  };
  process.env['CI'] = 'true';
  delete process.env['BRAINSTRIKE_E2E_ALLOW_GPU'];
  let page: Page;
  try {
    page = await electron.ensureWindow();
  } finally {
    if (previous.ci === undefined) {
      delete process.env['CI'];
    } else {
      process.env['CI'] = previous.ci;
    }
    if (previous.allowGpu !== undefined) {
      process.env['BRAINSTRIKE_E2E_ALLOW_GPU'] = previous.allowGpu;
    }
  }
  await enableModel(page);
  await enableSemanticRecall(page, LOCAL_EMBEDDER);

  const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
  // The reason is the refusal run/start would fail with, shown before any send.
  const reason = panel.getByText(
    /^The on-device memory embedder has no execution device: .*WebGPU.* Choose a device in Settings → Assistant Memory → On-device embedding device, choose a hosted embedding model there, or turn off semantic recall and vector observation retrieval\.$/u
  );
  await expect(reason.or(page.getByText(GENERIC_FAULT)).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(GENERIC_FAULT)).toHaveCount(0);
  await expect(reason).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Message input' })).toBeDisabled();
  expect(modelProvider.refusals()).toEqual([]);
});
