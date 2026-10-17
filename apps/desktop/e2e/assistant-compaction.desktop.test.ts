import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

const FIRST = 'Compaction first question';
const SECOND = 'Compaction second question';
const OVERFLOW = 'Compaction question that overflows';
const FOLLOW_UP = 'Continue after the compacted context';
// The host protects the newest turns up to 20,000 estimated tokens (chars / 4),
// plus the current turn and its predecessor. This answer fills that window, so
// the first turn is the one an overflow can drop.
const SECOND_ANSWER =
  `Second answer. ${'Context that fills the protected window. '.repeat(2200)}`.trim();

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

/** The thread's own run, which carries tools; side calls such as memory observation do not. */
const threadRun = (request: ModelProviderRequest): boolean =>
  (request.requestBody as { stream?: unknown }).stream === true && request.toolNames.length > 0;

/**
 * A host thread compacts after the provider reports a context overflow
 * (BST-1951). The host drops its oldest droppable turn, commits that as the
 * thread's compaction and re-attempts, so the reply arrives with the durable
 * "Conversation compacted" divider. The divider survives a reload, and the
 * same thread keeps working without resending the dropped turn.
 */
test('a context overflow compacts the host thread behind a durable divider and the thread stays usable', async ({
  modelProvider,
  window,
}) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  let overflowAttempts = 0;
  modelProvider.setScript((request) => {
    if (!threadRun(request)) {
      return { finalText: 'Compaction check' };
    }
    const user = lastUser(request);
    if (user.includes(OVERFLOW)) {
      overflowAttempts += 1;
      return overflowAttempts === 1
        ? { contextOverflow: true, finalText: '' }
        : { finalText: 'Answer after compaction.' };
    }
    if (user.includes(FOLLOW_UP)) {
      return { finalText: 'Answer to the follow-up.' };
    }
    return { finalText: user.includes(SECOND) ? SECOND_ANSWER : 'First answer.' };
  });
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  const send = async (text: string, answer: string | RegExp) => {
    await input.fill(text);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(panel.getByText(answer, { exact: true }).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
    await expect(panel.getByRole('button', { exact: true, name: 'Send' })).toBeVisible();
  };
  await send(FIRST, 'First answer.');
  await send(SECOND, /^Second answer\./u);
  await send(OVERFLOW, 'Answer after compaction.');

  const card = panel.getByTestId('compaction-summary-card');
  const expectDivider = async () => {
    await expect(card).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
    await expect(card).toHaveAttribute('data-compaction-fallback', 'deterministic');
    await expect(card).toContainText('Conversation compacted');
    await expect(card).toContainText('Deterministic compaction (no summarization model ran)');
    await expect(card).toContainText('after a provider context-overflow error');
  };
  await expectDivider();
  expect(overflowAttempts).toBe(2);
  // The re-attempt left the dropped oldest turn out of its request.
  const attempts = modelProvider
    .requests()
    .filter((request) => threadRun(request) && lastUser(request).includes(OVERFLOW));
  expect(attempts).toHaveLength(2);
  expect(JSON.stringify(attempts[0]?.messages)).toContain(FIRST);
  expect(JSON.stringify(attempts[1]?.messages)).not.toContain(FIRST);

  // The divider is durable: the committed thread renders it again after a reload.
  await window.reload();
  await ensureAssistantShellVisible(window);
  await expect(panel.getByText('Answer after compaction.', { exact: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expectDivider();

  // The same thread keeps working, and the compacted turn stays out of its requests.
  await send(FOLLOW_UP, 'Answer to the follow-up.');
  const followUp = modelProvider
    .requests()
    .find((request) => threadRun(request) && lastUser(request).includes(FOLLOW_UP));
  expect(JSON.stringify(followUp?.messages)).not.toContain(FIRST);
  expect(JSON.stringify(followUp?.messages)).toContain(SECOND);
  await expect(card).toHaveCount(1);
  expect(modelProvider.refusals()).toEqual([]);
});
