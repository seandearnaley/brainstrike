/**
 * Desktop E2E (semantic arm): the Threads panel finds an agent-host thread by
 * meaning, through the shipped search embedder, when no word of the query is
 * in the thread. The first search starts the backlog drain; a later search,
 * once the host row is embedded, returns it.
 */
import { setVectorDevicePreference } from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const PROMPT = 'Plan the marigold and tulip beds for the spring garden.';
const TITLE = 'Spring planting';
const REPLY = 'Noted.';
/** Shares no word with the prompt, the reply or the title. */
const QUERIES = ['flowers to grow outdoors', 'blooming plants outside'];

test('the Threads panel finds a host thread by meaning, with no shared word', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await setVectorDevicePreference(page, 'wasm');
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'host-thread-semantic-search-device');
  await ensureMockWorkspaceOpen(page);
  await configureAssistantProvider(page);
  // Each run streams; its thread's title request is the one non-streaming request.
  modelProvider.setScript(({ requestBody }) =>
    (requestBody as { stream?: unknown }).stream === true
      ? { finalText: REPLY }
      : { finalText: TITLE }
  );
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await expect(async () => {
    await input.fill(PROMPT);
    await expect(input).toHaveValue(PROMPT, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  const strip = page.getByRole('tablist', { name: 'Open assistant threads' });
  await expect(strip.getByRole('tab', { name: TITLE })).toHaveCount(1, { timeout: 60_000 });

  const showSidebar = page.getByTestId('show-threads-panel');
  if (await showSidebar.isVisible().catch(() => false)) {
    await showSidebar.click();
  }
  await page.getByTestId('threads-tab-trigger').click();
  await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
  const search = page.getByRole('combobox', { name: 'Search threads' });
  // Each match is its own result row; the user message's row carries its opening text.
  const match = page
    .getByTestId('thread-search-result')
    .filter({ hasText: TITLE })
    .filter({ hasText: 'marigold and tulip beds' });
  // Each search queues the backlog drain; once the host row is embedded, the
  // next search's query vector finds it.
  let next = 0;
  await expect(async () => {
    await search.fill(QUERIES[next % QUERIES.length] ?? '');
    next += 1;
    await expect(match).toHaveCount(1, { timeout: 5000 });
  }).toPass({ timeout: 180_000 });
  // The semantic match's headline is the message's opening text, unmarked.
  await expect(match.getByTestId('thread-search-match')).toContainText(PROMPT);

  // A host result opens its thread.
  await match.click();
  await expect(strip.getByRole('tab', { name: TITLE, selected: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(modelProvider.refusals()).toEqual([]);
});
