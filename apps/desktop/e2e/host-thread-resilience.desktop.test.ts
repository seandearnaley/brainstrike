import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

/** Short, ordered stream windows (first output is never tighter than inactivity). */
const WINDOW_MS = 8000;
test.use({
  electronEnv: {
    BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS: String(WINDOW_MS),
    BRAINSTRIKE_STREAM_INACTIVITY_MS: String(WINDOW_MS),
  },
});

const RECOVER = 'Answer after one silent attempt';
const EXHAUST = 'Answer when every attempt is silent';
const RECOVERED_ANSWER = 'Recovered answer.';
const STALL_DETAIL = `The model produced no output within ${WINDOW_MS}ms of the request starting.`;
/** Two silent windows plus a slow, loaded machine. */
const ATTEMPTS_TIMEOUT = 4 * WINDOW_MS + E2E_TIMEOUTS.messageVisibility;

const streaming = (request: ModelProviderRequest): boolean =>
  (request.requestBody as { stream?: unknown }).stream === true;

/** Whether the request's latest user message names `prompt`. */
const asks = (request: ModelProviderRequest, prompt: string): boolean =>
  JSON.stringify(
    request.messages
      .filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'role' in message &&
          message.role === 'user'
      )
      .at(-1) ?? null
  ).includes(prompt);

/**
 * Host run resilience in the real app, through the provider boundary: a
 * provider that never answers is cancelled after the first-output window and
 * re-attempted over the committed conversation, and a run whose every attempt
 * is silent ends with its failure detail in the message's error box.
 */
test('a host thread re-attempts a silent provider, then fails visibly when every attempt is silent', async ({
  modelProvider,
  window,
}) => {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(window);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  // A held response never sends its headers: the provider stays silent until
  // the host aborts the request. It is released when the test ends.
  const silence = Promise.withResolvers<void>();
  let recoverAttempts = 0;
  modelProvider.setScript((request) => {
    if (!streaming(request)) {
      return { finalText: 'Resilience check' };
    }
    if (asks(request, RECOVER)) {
      recoverAttempts += 1;
      return recoverAttempts === 1
        ? { beforeFinalText: silence.promise, finalText: 'Never sent.' }
        : { finalText: RECOVERED_ANSWER };
    }
    return { beforeFinalText: silence.promise, finalText: 'Never sent.' };
  });
  try {
    await ensureAssistantShellVisible(window);
    const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
    const input = panel.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
    const send = async (text: string): Promise<void> => {
      await input.fill(text);
      await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    };

    // One silent attempt: the stall row, the continuing row, then the answer.
    await send(RECOVER);
    const stalled = panel.getByText('Model stream stalled').first();
    await expect(stalled).toBeVisible({ timeout: ATTEMPTS_TIMEOUT });
    const continuing = panel.getByText('Continuing after a stall').first();
    await expect(continuing).toBeVisible();
    const answer = panel.getByText(RECOVERED_ANSWER, { exact: true });
    await expect(answer).toBeVisible({ timeout: ATTEMPTS_TIMEOUT });
    const [stalledBox, continuingBox, answerBox] = await Promise.all([
      stalled.boundingBox(),
      continuing.boundingBox(),
      answer.boundingBox(),
    ]);
    expect(stalledBox?.y).toBeLessThan(continuingBox?.y ?? 0);
    expect(continuingBox?.y).toBeLessThan(answerBox?.y ?? 0);
    expect(recoverAttempts).toBe(2);

    // Every attempt silent: the budget is spent and the detail is visible.
    await send(EXHAUST);
    await expect(panel.getByText(STALL_DETAIL, { exact: true })).toBeVisible({
      timeout: ATTEMPTS_TIMEOUT,
    });
    expect(modelProvider.requests().filter((request) => asks(request, EXHAUST))).toHaveLength(2);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    silence.resolve();
  }
});
