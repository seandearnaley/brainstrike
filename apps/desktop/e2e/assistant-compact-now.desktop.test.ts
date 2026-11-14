import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

// BST-2536: a person compacts a host thread from the context meter between
// runs, saying what to keep. The thread shows the compaction card, and the
// next request starts from the summary without the compacted turn.
const FIRST = 'Compact now first question';
const SECOND = 'Compact now second question';
const THIRD = 'Compact now third question';
const FOLLOW_UP = 'Continue after compacting';
const FOCUS = 'Keep the port decision';
const SUMMARY =
  'Goal: Move the port.\nConstraints: None.\nDecisions: Port 8443.\nErrors and fixes: None.\nState: Asked three questions.\nNext: Continue.';
// The host keeps the newest turns up to 20,000 estimated tokens (chars / 4),
// and the current turn and its predecessor. This answer fills that window, so
// the first turn is the one a compaction replaces.
const THIRD_ANSWER =
  `Third answer. ${'Context that fills the protected window. '.repeat(2200)}`.trim();

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

/** Whether a user message is the host's notice rather than the person's words. */
function isHostNotice(message: unknown): boolean {
  return JSON.stringify(message).includes('<brainstrike_notice>');
}

/** The last user message's text in a provider request. */
function lastUser(request: ModelProviderRequest): string {
  return JSON.stringify(withRole(request, ['user']).at(-1) ?? null);
}

/** The person's user messages of a provider request, serialized. */
function userMessages(request: ModelProviderRequest | undefined): string {
  return JSON.stringify(withRole(request, ['user']).filter((message) => !isHostNotice(message)));
}

/** The thread's own run, which streams and carries tools; a summary or title does not. */
const threadRun = (request: ModelProviderRequest): boolean =>
  (request.requestBody as { stream?: unknown }).stream === true && request.toolNames.length > 0;

/** The compaction's summary call: the thread's next request, asked without streaming. */
const summaryCall = (request: ModelProviderRequest): boolean =>
  !threadRun(request) && request.toolNames.length > 0;

test('Compact now from the context meter shows the card, and the next request starts from the summary', async ({
  modelProvider,
  window,
}, testInfo) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript((request) => {
    if (!threadRun(request)) {
      return { finalText: SUMMARY };
    }
    const user = lastUser(request);
    if (user.includes(FOLLOW_UP)) {
      return { finalText: 'Answer to the follow-up.' };
    }
    if (user.includes(THIRD)) {
      return { finalText: THIRD_ANSWER };
    }
    return { finalText: user.includes(SECOND) ? 'Second answer.' : 'First answer.' };
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
  await send(SECOND, 'Second answer.');
  await send(THIRD, /^Third answer\./u);

  // The meter's popover: what to keep, then Compact now.
  await panel.getByTestId('context-usage-trigger').click();
  const popover = window.getByTestId('context-usage-popover');
  await popover.getByRole('textbox', { name: 'What to keep' }).fill(FOCUS);
  await popover.screenshot({ path: path.join(testInfo.outputDir, 'compact-now-popover.png') });
  await popover.getByRole('button', { exact: true, name: 'Compact now' }).click();

  const card = panel.getByTestId('compaction-summary-card');
  await expect(card).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
  await expect(popover.getByRole('textbox', { name: 'What to keep' })).toHaveValue('');
  await window.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(card).toHaveAttribute('data-compaction-fallback', 'agentic');
  await expect(card.getByTestId('compaction-summary-reason')).toContainText('Requested');
  await expect(card.getByTestId('compaction-summary-focus')).toContainText(FOCUS);
  await expect(card.getByTestId('compaction-summary-turns')).toContainText('1 turn');
  await expect(card.getByRole('list', { name: 'Earlier requests' })).toHaveText(FIRST);
  await expect(card).toContainText('Goal: Move the port.');
  await card.screenshot({ path: path.join(testInfo.outputDir, 'compact-now-card.png') });

  // The summary was asked on the thread's history, with the person's words last.
  const summaries = modelProvider.requests().filter(summaryCall);
  expect(summaries).toHaveLength(1);
  expect(userMessages(summaries[0])).toContain(FIRST);
  expect(lastUser(summaries[0] as ModelProviderRequest)).toContain(FOCUS);

  // The next request starts from the summary: the compacted turn is left out.
  await send(FOLLOW_UP, 'Answer to the follow-up.');
  const followUp = modelProvider
    .requests()
    .find((request) => threadRun(request) && lastUser(request).includes(FOLLOW_UP));
  expect(userMessages(followUp)).not.toContain(FIRST);
  expect(userMessages(followUp)).toContain(SECOND);
  expect(JSON.stringify(followUp?.messages)).toContain('Goal: Move the port.');
  await expect(card).toHaveCount(1);
  expect(modelProvider.refusals()).toEqual([]);
});
