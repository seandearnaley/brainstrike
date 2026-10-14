/**
 * Desktop E2E (BST-1990, D4; the #3572 smoke's W7): a write the model sends
 * with no `root` still asks for approval naming the folder it lands in, the
 * one the host resolved for the call.
 */
import { expect, test } from './fixtures/electron-fixture';
import { readHostRootRecords } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const FINAL = 'The write was declined.';

test("a write with no root asks for approval naming the thread's folder", async ({
  modelProvider,
  window: page,
}) => {
  await ensureMockWorkspaceOpen(page);
  await configureAssistantProvider(page);
  const userData = await page.evaluate(() => window.electronAPI!.getUserDataPath());
  const roots = (await readHostRootRecords(userData)).filter((root) => root.status === 'live');
  expect(roots).toHaveLength(1);
  const folderName = roots[0]!.displayName;
  modelProvider.setScript(({ requestBody, toolNames }) => {
    const write = toolNames.find((name) => name.endsWith('writeWorkspaceFile'));
    return (requestBody as { stream?: unknown }).stream === true && write
      ? {
          finalText: FINAL,
          toolCall: { arguments: { content: 'hello\n', path: 'approval-root.txt' }, name: write },
        }
      : { finalText: 'Approval target check' };
  });
  await ensureAssistantShellVisible(page);
  const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Write a note.');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();

  // The default `edit: ask` policy pauses the write; its card names the folder.
  await expect(panel.getByTestId('approval-file-target-summary')).toContainText(
    'approval-root.txt',
    { timeout: E2E_TIMEOUTS.messageVisibility }
  );
  await expect(panel.getByTestId('approval-workspace-root-value')).toHaveText(folderName);
  await panel
    .getByRole('button', { exact: true, name: 'Decline brainstrike.writeWorkspaceFile' })
    .click();
  await expect(panel.getByText(FINAL).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  expect(modelProvider.refusals()).toEqual([]);
});
