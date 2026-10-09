import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const COMMAND = 'echo approval-preview-check';
const FINAL = 'Both calls were declined.';

/** A host approval shows what the call will do: the command's facts, run_python's sandbox facts. */
test('a host approval previews a command and run_python’s host-computed sandbox facts', async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  await window.getByTestId('permission-policy-execute').selectOption('ask');
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? {
          finalText: FINAL,
          toolCallStages: [
            [{ arguments: { command: COMMAND }, name: 'brainstrike_executeCommand' }],
            [{ arguments: { code: 'print("preview")' }, name: 'brainstrike_runPython' }],
          ],
        }
      : { finalText: 'Approval preview check' }
  );
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Run a command, then a script.');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();

  // The command approval names the exact command and where it runs.
  await expect(panel.getByTestId('approval-command-code')).toHaveText(COMMAND, {
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(panel.getByTestId('approval-command-cwd')).toBeVisible();
  await panel
    .getByRole('button', { exact: true, name: 'Decline brainstrike.executeCommand' })
    .click();

  // The run_python approval shows the host's sandbox facts and keeps its grants.
  await expect(panel.getByTestId('approval-run-python-internet')).toHaveText('No internet access', {
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(panel.getByTestId('approval-run-python-write')).toContainText('inside');
  await expect(
    panel.getByRole('button', { exact: true, name: 'Always allow brainstrike.runPython' })
  ).toBeVisible();
  await panel.getByRole('button', { exact: true, name: 'Decline brainstrike.runPython' }).click();

  await expect(panel.getByText(FINAL).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  expect(modelProvider.refusals()).toEqual([]);
});
