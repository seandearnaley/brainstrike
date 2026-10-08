import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

/** A committed host approval names the tool by its catalog ID, not the provider-sanitized name. */
test('a host tool approval is labelled with the catalog tool ID', async ({
  modelProvider,
  window,
}) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  await window.getByRole('combobox', { exact: true, name: 'Read permission' }).selectOption('ask');
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? {
          finalText: 'Read declined.',
          toolCall: { arguments: { path: 'notes.txt' }, name: 'brainstrike_readWorkspaceFile' },
        }
      : { finalText: 'Catalog name check' }
  );
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Read notes.txt');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();

  await expect(
    panel.getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
  ).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
  await expect(
    panel.getByRole('button', { exact: true, name: 'Approve brainstrike_readWorkspaceFile' })
  ).toHaveCount(0);
  await panel
    .getByRole('button', { exact: true, name: 'Decline brainstrike.readWorkspaceFile' })
    .click();
  await expect(panel.getByText('Read declined.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  expect(modelProvider.refusals()).toEqual([]);
});
