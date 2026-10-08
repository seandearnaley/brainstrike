import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const TITLE = 'Release rollback plan';

/** A host thread's first completed run gets a provider title that survives a reload. */
test('a host thread is titled after its first run, and the title survives a reload', async ({
  modelProvider,
  window,
}) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  // The run streams; the title request is the one non-streaming request.
  modelProvider.setScript(({ requestBody }) =>
    (requestBody as { stream?: unknown }).stream === true
      ? { finalText: 'Rollback steps drafted.' }
      : { finalText: TITLE }
  );
  await ensureAssistantShellVisible(window);
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Plan a rollback for the release');
  await window.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(window.getByText('Rollback steps drafted.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });

  const strip = window.getByRole('tablist', { name: 'Open assistant threads' });
  await expect(strip.getByRole('tab', { name: TITLE })).toHaveCount(1, { timeout: 30_000 });
  expect(
    modelProvider
      .requests()
      .filter(({ requestBody }) => (requestBody as { stream?: unknown }).stream !== true)
  ).toHaveLength(1);

  await window.reload();
  await expect(strip.getByRole('tab', { name: TITLE })).toHaveCount(1, { timeout: 30_000 });
  expect(modelProvider.refusals()).toEqual([]);
});
