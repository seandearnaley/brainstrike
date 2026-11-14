import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
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

/** A provider request's messages of `roles`. */
function withRole(request: ModelProviderRequest | undefined, roles: readonly string[]): unknown[] {
  return (request?.messages ?? []).filter(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      typeof message.role === 'string' &&
      roles.includes(message.role)
  );
}

/** The last user message's text in a provider request. */
function lastUser(request: ModelProviderRequest): string {
  return JSON.stringify(withRole(request, ['user']).at(-1) ?? null);
}

/** Whether a user message is the host's notice rather than the person's words. */
function isHostNotice(message: unknown): boolean {
  return JSON.stringify(message).includes('<brainstrike_notice>');
}

/** The person's user messages of a provider request, serialized. */
function userMessages(request: ModelProviderRequest | undefined): string {
  return JSON.stringify(withRole(request, ['user']).filter((message) => !isHostNotice(message)));
}

/** The compaction note: the host's notice that leads the history (BST-2532). */
function compactionNote(request: ModelProviderRequest | undefined): string {
  const first = (request?.messages ?? []).find(
    (message) => !withRole(request, ['system', 'developer']).includes(message)
  );
  return isHostNotice(first) ? JSON.stringify(first) : '';
}

/** The request's instructions, which a compaction leaves as they were. */
function instructions(request: ModelProviderRequest | undefined): string {
  return JSON.stringify(withRole(request, ['system', 'developer']));
}

/** The thread's own run, which carries tools; side calls such as its title do not. */
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
}, testInfo) => {
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
    // BST-2201: the committed reason and the turns it compacted; no summarizer ran.
    await expect(card.getByTestId('compaction-summary-reason')).toContainText(
      'After the provider reported a context overflow'
    );
    await expect(card.getByTestId('compaction-summary-turns')).toContainText('1 turn');
    await expect(card.getByTestId('compaction-summary-model')).toHaveCount(0);
    await expect(card.getByTestId('compaction-summary-usage')).toHaveCount(0);
    // BST-2527: no model ran, and the host still lists the person's own words.
    await expect(card.getByRole('list', { name: 'Earlier requests' })).toHaveText(FIRST);
  };
  await expectDivider();
  await testInfo.attach('compaction-card', {
    body: await card.screenshot(),
    contentType: 'image/png',
  });
  expect(overflowAttempts).toBe(2);
  // The re-attempt left the dropped oldest turn out of its request; its note
  // quotes what the person asked in it.
  const attempts = modelProvider
    .requests()
    .filter((request) => threadRun(request) && lastUser(request).includes(OVERFLOW));
  expect(attempts).toHaveLength(2);
  expect(userMessages(attempts[0])).toContain(FIRST);
  expect(userMessages(attempts[1])).not.toContain(FIRST);
  expect(compactionNote(attempts[1])).toContain(`Earlier requests:\\n- ${FIRST}`);
  // The note leads the history; the instructions stay as the first attempt sent them.
  expect(instructions(attempts[1])).toBe(instructions(attempts[0]));

  // The divider is durable: the committed thread renders it again after a reload.
  await reloadRenderer(window, 'assistant-compaction: reload');
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
  expect(userMessages(followUp)).not.toContain(FIRST);
  expect(userMessages(followUp)).toContain(SECOND);
  await expect(card).toHaveCount(1);
  expect(modelProvider.refusals()).toEqual([]);
});
