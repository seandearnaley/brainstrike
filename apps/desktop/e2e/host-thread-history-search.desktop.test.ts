/**
 * Desktop E2E: the Threads search box finds committed agent-host history.
 *
 * A message sent on a host thread is indexed by the host's own derived state
 * index; searching one of its words finds the thread, opening the hit selects
 * that thread, and once the thread is deleted the same search finds nothing.
 */
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const TITLE = 'Zephyrine release plan';
const WORD = 'zephyrine';

test('Threads search finds a host thread by a word from its message, opens it, and forgets it after delete', async ({
  modelProvider,
  window,
}) => {
  test.setTimeout(180_000);
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  // The run streams; the title request is the one non-streaming request.
  modelProvider.setScript(({ requestBody }) =>
    (requestBody as { stream?: unknown }).stream === true
      ? { finalText: 'Release steps drafted.' }
      : { finalText: TITLE }
  );
  await ensureAssistantShellVisible(window);
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill(`Plan the ${WORD} release`);
  await window.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(window.getByText('Release steps drafted.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  const strip = window.getByRole('tablist', { name: 'Open assistant threads' });
  const titled = strip.getByRole('tab', { name: TITLE });
  await expect(titled).toHaveCount(1, { timeout: 30_000 });

  // Select another thread so opening the hit is observable.
  await window.getByTestId('assistant-new-thread-button').click();
  await expect(titled).toHaveAttribute('aria-selected', 'false', { timeout: 15_000 });

  const search = window.getByTestId('thread-search-input');
  await search.fill(WORD);
  const hit = window.getByTestId('thread-search-result').filter({ hasText: TITLE });
  await expect(hit).toHaveCount(1, { timeout: 30_000 });
  await expect(hit.getByTestId('thread-search-match').first()).toContainText(WORD);
  await hit.click();
  await expect(titled).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

  await search.fill('');
  const row = window.getByTestId('thread-row').filter({ hasText: TITLE });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await row.getByRole('button', { name: /^Thread actions / }).click();
  await window.getByRole('button', { exact: true, name: 'Delete…' }).click();
  await window.getByRole('button', { name: /^Confirm delete thread / }).click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });

  await search.fill(WORD);
  await expect(window.getByTestId('thread-search-empty')).toBeVisible({ timeout: 30_000 });
  await expect(window.getByTestId('thread-search-result')).toHaveCount(0);
  expect(modelProvider.refusals()).toEqual([]);
});
