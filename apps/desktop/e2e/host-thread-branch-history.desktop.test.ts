import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

const FIRST = 'First question';
const SECOND = 'Second question';
const EDITED = 'Second question, edited';

/** The last user message's text in a provider request. */
function lastUser(request: ModelProviderRequest): string {
  const users = request.messages.filter(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'user'
  );
  return JSON.stringify(users.at(-1) ?? null);
}

/**
 * A provider request's conversation: user texts in order, and how many prior
 * assistant turns it carries (inline, or as Responses item references).
 */
function conversation(request: ModelProviderRequest | undefined): {
  readonly answers: number;
  readonly users: readonly string[];
} {
  const items = (request?.messages ?? []).map((item) => item as Record<string, unknown>);
  return {
    answers: items.filter(
      (item) => item['type'] === 'item_reference' || item['role'] === 'assistant'
    ).length,
    users: items.flatMap((item) =>
      item['role'] === 'user' && Array.isArray(item['content'])
        ? item['content'].flatMap((part) =>
            typeof part === 'object' && part !== null && 'text' in part ? [String(part.text)] : []
          )
        : []
    ),
  };
}

const streaming = (request: ModelProviderRequest): boolean =>
  (request.requestBody as { stream?: unknown }).stream === true;

/**
 * Branch history on a host thread in the real app: an Edit makes a sibling
 * user message, a Regenerate makes a sibling answer, each request carries the
 * selected path only, and the branches survive a reload.
 */
test('a host thread edit and regenerate are navigable branches that survive a reload', async ({
  modelProvider,
  window,
}) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  let editedAnswers = 0;
  modelProvider.setScript((request) => {
    if (!streaming(request)) {
      return { finalText: 'Branch history check' };
    }
    const user = lastUser(request);
    if (user.includes(EDITED)) {
      editedAnswers += 1;
      return { finalText: editedAnswers === 1 ? 'Gamma answer.' : 'Delta answer.' };
    }
    return { finalText: user.includes(SECOND) ? 'Beta answer.' : 'Alpha answer.' };
  });
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  const row = (text: string): Locator =>
    panel.locator('[data-message-id]').filter({ hasText: text }).last();
  // An answer shows before its run ends. Message action bars hide while a run is
  // active, and a user message's bar shows only under the pointer, so a hover
  // made before the run settles can be lost when the layout changes.
  const settled = async (answer: string) => {
    await expect(panel.getByText(answer, { exact: true })).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
    await expect(panel.getByRole('button', { exact: true, name: 'Send' })).toBeVisible();
  };
  const send = async (text: string, answer: string) => {
    await input.fill(text);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await settled(answer);
  };
  await send(FIRST, 'Alpha answer.');
  await send(SECOND, 'Beta answer.');

  // Edit the second user message: a sibling user message at its parent.
  await row(SECOND).hover();
  await row(SECOND).getByRole('button', { exact: true, name: 'Edit message' }).click();
  const editor = panel
    .locator('form')
    .filter({ has: window.getByRole('button', { exact: true, name: 'Cancel' }) });
  await editor.getByRole('textbox').fill(EDITED);
  await editor.getByRole('button', { exact: true, name: 'Send' }).click();
  await settled('Gamma answer.');
  const editRequest = modelProvider
    .requests()
    .find((request) => streaming(request) && lastUser(request).includes(EDITED));
  // Exactly the selected path: First, its answer, and the edited message. The
  // sibling's message and answer would add a user turn and an answer.
  expect(conversation(editRequest)).toEqual({ answers: 1, users: [FIRST, EDITED] });

  // The picker on the edited message switches between the two user branches.
  await expect(row(EDITED).getByText('2 / 2')).toBeVisible();
  await row(EDITED).getByRole('button', { exact: true, name: 'Previous branch' }).click();
  await expect(panel.getByText('Beta answer.', { exact: true })).toBeVisible();
  await expect(panel.getByText('Gamma answer.', { exact: true })).toHaveCount(0);
  await expect(row(SECOND).getByText('1 / 2')).toBeVisible();
  await row(SECOND).getByRole('button', { exact: true, name: 'Next branch' }).click();
  await expect(panel.getByText('Gamma answer.', { exact: true })).toBeVisible();

  // Regenerate the edited branch's answer: a sibling answer to the same message.
  await row('Gamma answer.').hover();
  await row('Gamma answer.')
    .getByRole('button', { exact: true, name: 'Regenerate response' })
    .click();
  await expect(panel.getByText('Delta answer.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  const regenerateRequest = modelProvider
    .requests()
    .filter((request) => streaming(request) && lastUser(request).includes(EDITED))
    .at(1);
  // The same path again, without the answer being regenerated.
  expect(conversation(regenerateRequest)).toEqual({ answers: 1, users: [FIRST, EDITED] });
  await expect(row('Delta answer.').getByText('2 / 2')).toBeVisible();

  // After a reload the committed head (the regeneration) is selected and every
  // branch is still reachable.
  await window.reload();
  await ensureAssistantShellVisible(window);
  await expect(panel.getByText('Delta answer.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(row('Delta answer.').getByText('2 / 2')).toBeVisible();
  await row('Delta answer.').getByRole('button', { exact: true, name: 'Previous branch' }).click();
  await expect(panel.getByText('Gamma answer.', { exact: true })).toBeVisible();
  await expect(row(EDITED).getByText('2 / 2')).toBeVisible();
  await row(EDITED).getByRole('button', { exact: true, name: 'Previous branch' }).click();
  await expect(panel.getByText('Beta answer.', { exact: true })).toBeVisible();
  expect(modelProvider.refusals()).toEqual([]);
});
