import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

/**
 * BST-2227: Settings → Assistant Memory's Test embedder embeds one fixed text
 * with the selected hosted embedder through the agent host, resolved and
 * credentialed as a run resolves it, with semantic recall still off. OpenAI
 * embeddings come from the shim through OPENAI_BASE_URL.
 */
const OPENAI_KEY = 'test-key-settings-memory-embedder-test';
const PROBE_TEXT = 'Brainstrike memory embedder test.';

test.use({ electronEnv: { BRAINSTRIKE_OPENAI_API_KEY: OPENAI_KEY } });

async function openAssistantMemory(homePage: HomePage, page: Page): Promise<Locator> {
  await homePage.openSettings();
  const section = await new SettingsPage(page).openCategory(
    /Assistant Memory/iu,
    'assistant-memory'
  );
  // A fresh profile selects text-embedding-3-small, with semantic recall off.
  await expect(
    section.getByRole('combobox', { name: 'Semantic recall embedding model' })
  ).toHaveValue('openai/text-embedding-3-small', { timeout: 30_000 });
  await expect(section.getByRole('switch', { name: 'Enable semantic recall' })).not.toBeChecked();
  return section;
}

test('Test embedder reports the hosted embedder’s dimensions and latency', async ({
  homePage,
  modelProvider,
  window: page,
}) => {
  // text-embedding-3-small's catalog dimensions.
  modelProvider.serveEmbeddings(1536);
  const section = await openAssistantMemory(homePage, page);

  await section.getByRole('button', { name: 'Test embedder' }).click();

  await expect(section.getByTestId('assistant-memory-embedder-test-result')).toHaveText(
    /^openai::text-embedding-3-small embedded the test text in \d+ ms: 1536 dimensions\.$/u,
    { timeout: 30_000 }
  );
  // One provider call with the fixed text: no retry and no user content.
  expect(modelProvider.embeddingRequests()).toEqual([
    { input: [PROBE_TEXT], model: 'text-embedding-3-small' },
  ]);
  expect(modelProvider.refusals()).toEqual([]);
});

test('a rejected key shows the embedder’s typed failure, with its status, remedy and reference', async ({
  homePage,
  modelProvider,
  window: page,
}) => {
  // No embeddings are served: the shim refuses the probe with a terminal 401.
  const section = await openAssistantMemory(homePage, page);

  await section.getByRole('button', { name: 'Test embedder' }).click();

  const failure = section.getByTestId('assistant-memory-embedder-test-failure');
  await expect(failure).toHaveText(
    /^Memory embedder test failed because its embedding model \(OpenAI text-embedding-3-small\) failed: Embedding provider openai refused the request \(HTTP 401\)\.OpenAI returned HTTP 401\.Check the OpenAI API key in Settings → Providers, or choose another embedding model in Settings → Assistant Memory\.Reference: [0-9a-f-]{36}$/u,
    { timeout: 30_000 }
  );
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(page.getByText(OPENAI_KEY)).toHaveCount(0);
  expect(modelProvider.refusals()).toEqual([
    expect.objectContaining({ knob: 'OPENAI_BASE_URL', method: 'POST', route: '/embeddings' }),
  ]);
});
