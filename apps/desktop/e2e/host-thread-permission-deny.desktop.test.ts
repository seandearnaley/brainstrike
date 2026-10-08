import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const WRITE = 'brainstrike_writeWorkspaceFile';
const READ = 'brainstrike_readWorkspaceFile';
const REPLY = 'Checked the tools.';

/** A tool the saved policy denies is neither offered to the model nor named in its instructions. */
test('denying edits removes the edit tools from the next host run and its instructions', async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? { finalText: REPLY }
      : { finalText: 'Permission check' }
  );
  const send = async (prompt: string, replies: number): Promise<void> => {
    await ensureAssistantShellVisible(window);
    const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
    const input = panel.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
    await input.fill(prompt);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(panel.getByText(REPLY)).toHaveCount(replies, {
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
  };
  const lastRunRequest = () => {
    const request = modelProvider
      .requests()
      .filter(({ toolNames }) => toolNames.length > 0)
      .at(-1);
    if (!request) {
      throw new Error('No model request offered tools');
    }
    // The run's instructions: its system (chat) or developer (responses) message.
    const instructions = request.messages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        (message.role === 'system' || message.role === 'developer')
    );
    if (!instructions) {
      throw new Error('The model request carried no instructions');
    }
    return { instructions: JSON.stringify(instructions), toolNames: request.toolNames };
  };

  // Control: with edits allowed, the run is offered the edit tool and told about it.
  await send('First look.', 1);
  const allowed = lastRunRequest();
  expect(allowed.toolNames).toContain(WRITE);
  expect(allowed.instructions).toMatch(/writeWorkspaceFile/);

  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  await window.getByTestId('permission-policy-edit').selectOption('deny');

  await send('Second look.', 2);
  const denied = lastRunRequest();
  expect(denied.toolNames).toContain(READ);
  expect(denied.toolNames).not.toContain(WRITE);
  expect(denied.toolNames).not.toContain('brainstrike_stringReplaceWorkspaceFile');
  expect(denied.instructions).not.toMatch(/writeWorkspaceFile/);
  expect(modelProvider.refusals()).toEqual([]);
});
