import { expect, test } from './fixtures/electron-fixture';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const TASK = 'EXPLORE_TASK_ENV: list what the notes say.';
const FOLLOW_UP = 'FOLLOW_UP_ENV: anything else in the notes?';
const LEDGER = 'Background invocations of this turn';
const CONTINUATION = '<child_continuation_result>';
const CALL_SIGN = /^[A-Z][a-z]+-[a-f0-9]{6}$/u;
const CALL_SIGN_CONVERSATION = /^Open [A-Z][a-z]+-[a-f0-9]{6} conversation$/u;

// The environment holds the only OpenRouter credential; nothing is saved to the
// profile's credential store.
test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: 'env-only-openrouter-key' } });

/**
 * A delegated child runs on the credential its parent runs with, even when
 * that credential exists only in the environment: the child's composer reads
 * the host's configured providers, as the root's does, so it stays usable and
 * a follow-up continues the child on the parent's OpenRouter model.
 */
test('a delegated child continues on the env-only OpenRouter key its parent runs with', async ({
  modelProvider,
  window,
}) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  modelProvider.setScript(({ messages, requestBody, toolNames }) => {
    if ((requestBody as { stream?: unknown }).stream !== true) {
      return { finalText: 'Env key thread' };
    }
    const history = JSON.stringify(messages);
    if (toolNames.includes('agent-explore')) {
      if (history.includes(CONTINUATION)) {
        return { finalText: 'Parent read the follow-up.' };
      }
      return history.includes(LEDGER)
        ? { finalText: 'Parent read the child.' }
        : {
            finalText: 'Parent continues while Explorer runs.',
            toolCall: { arguments: { prompt: TASK }, name: 'agent-explore' },
          };
    }
    return {
      finalText: history.includes(FOLLOW_UP) ? 'Child follow-up answered.' : 'Child finding.',
    };
  });
  await ensureAssistantShellVisible(window);
  // The profile's credential store lists no key.
  expect(
    await window.evaluate(() =>
      (window as unknown as { secrets: { list(): Promise<unknown[]> } }).secrets.list()
    )
  ).toEqual([]);

  const root = window.getByRole('region', { exact: true, name: 'Assistant' });
  await root.getByTestId('composer-model-menu-trigger').click();
  const modelDialog = window.getByRole('dialog', { name: 'Choose a model' });
  await modelDialog.getByRole('combobox').fill('GPT-5.6 Terra');
  await modelDialog
    .getByRole('option', { name: /^GPT-5\.6 Terra/u })
    .filter({ hasText: 'OpenRouter' })
    .first()
    .click();
  await expect(root.getByTestId('composer-model-menu-trigger')).toContainText(
    'GPT-5.6 Terra (OpenRouter)'
  );
  const input = root.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Ask Explorer what the notes say');
  await root.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(root.getByText('Parent read the child.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });

  await root.getByRole('button', { exact: true, name: 'Expand activity' }).first().click();
  await root.getByRole('button', { name: CALL_SIGN_CONVERSATION }).click();
  const childTab = window
    .getByRole('tablist', { name: 'Workspace tabs' })
    .getByRole('tab', { selected: true });
  await expect(childTab).toHaveText(CALL_SIGN);
  const child = window.getByRole('region', {
    exact: true,
    name: (await childTab.innerText()).trim(),
  });
  await expect(child.getByText('Child finding.', { exact: true })).toBeVisible();

  // The child's composer offers the parent's model and accepts a follow-up.
  await expect(child.getByTestId('composer-model-menu-trigger')).toContainText(
    'GPT-5.6 Terra (OpenRouter)'
  );
  const childInput = child.getByRole('textbox', { name: 'Message input' });
  await expect(childInput).toBeEditable();
  await childInput.fill(FOLLOW_UP);
  await child.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(child.getByText('Child follow-up answered.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  const followUps = modelProvider
    .requests()
    .filter(
      ({ messages, toolNames }) =>
        !toolNames.includes('agent-explore') && JSON.stringify(messages).includes(FOLLOW_UP)
    );
  expect(followUps.map(({ requestBody }) => (requestBody as { model?: unknown }).model)).toEqual([
    'openai/gpt-5.6-terra',
  ]);
  expect(modelProvider.refusals()).toEqual([]);
});
