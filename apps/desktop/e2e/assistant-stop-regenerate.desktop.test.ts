import { expect, test } from './fixtures/electron-fixture';
import { readCommittedRuns } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';

/**
 * Stop and regenerate over one host thread: a reply stopped mid-stream, the
 * same prompt regenerated from the stopped answer, and a long reply stopped
 * again. Every stoppable turn is held open at the external provider after it
 * has streamed its text, so each Stop lands mid-run; only the provider is
 * simulated, and the runs, their committed outcomes and the composer are real.
 *
 * This is `apps/web/e2e/assistant-panel-interactions.test.ts`'s case, moved to
 * the shell that can still drive a turn — web quarantines it because its
 * composer is disabled for every provider web can offer.
 *
 * What is new here, over the desktop coverage these parts already have:
 * `host-thread-send-lifecycle.desktop.test.ts` stops a text-only reply, and
 * `host-thread-branch-history.desktop.test.ts` regenerates a COMPLETED answer.
 * Neither regenerates a STOPPED one, which is the sequence this proves: the
 * regenerate re-sends the original prompt, read back off the provider wire,
 * and runs to completion between two stopped runs.
 *
 * A stopped run's committed outcome is `stopped` — `run.finished` carries
 * `completed | failed | stopped | interrupted`
 * (packages/agent-host/src/protocol.ts) — which is the host's own name for the
 * fact the web row records as `cancelled`.
 */
const PROMPT = 'Compare the evidence for this response.';
const PARTIAL = 'Partial response before stop.';
const REGENERATED = 'Completed regenerated response.';
const LONG_PROMPT = 'Write a long response that I can stop.';
const LONG = 'Long response. '.repeat(300);
const NEVER = 'NEVER_COMMITTED';

test('stops the owned generation, regenerates the prompt and stops a long response', async ({
  electron,
  modelProvider,
  window,
}) => {
  test.setTimeout(180_000);
  const firstHold = Promise.withResolvers<void>();
  const longHold = Promise.withResolvers<void>();
  let rootTurns = 0;
  modelProvider.setScript(({ toolNames }) => {
    // Title generation runs without tools; only root turns carry them.
    if (toolNames.length === 0) {
      return { finalText: 'Stop and regenerate' };
    }
    rootTurns += 1;
    if (rootTurns === 1) {
      return { beforeFinalText: firstHold.promise, finalText: NEVER, streamedBeforeHold: PARTIAL };
    }
    if (rootTurns === 2) {
      return { finalText: REGENERATED };
    }
    return { beforeFinalText: longHold.promise, finalText: NEVER, streamedBeforeHold: LONG };
  });
  const rootRequests = (): readonly ModelProviderRequest[] =>
    modelProvider.requests().filter(({ toolNames }) => toolNames.length > 0);

  try {
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window);
    await ensureAssistantShellVisible(window);
    const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
    const input = panel.getByRole('textbox', { name: 'Message input' });
    const send = panel.getByRole('button', { exact: true, name: 'Send' });
    const stop = panel.getByRole('button', { exact: true, name: 'Stop' });
    await expect(input).toBeVisible({ timeout: 30_000 });
    const threadId = (
      (await window
        .getByRole('tablist', { name: 'Open assistant threads' })
        .getByRole('tab')
        .first()
        .getAttribute('id')) ?? ''
    ).replace('assistant-thread-tab-', '');

    // Turn 1: stopped while its partial reply is on screen.
    await input.fill(PROMPT);
    await send.click();
    await expect(panel.getByText(PARTIAL, { exact: true })).toBeVisible({ timeout: 60_000 });
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
    firstHold.resolve();
    await expect(panel.getByText(PARTIAL, { exact: true })).toBeVisible();
    await expect(panel.getByText(NEVER, { exact: true })).toHaveCount(0);

    // Turn 2: regenerate the STOPPED answer. The action bar shows under the
    // pointer and only once the run has settled.
    const stoppedAnswer = panel.locator('[data-message-id]').filter({ hasText: PARTIAL }).last();
    await stoppedAnswer.hover();
    await stoppedAnswer.getByRole('button', { exact: true, name: 'Regenerate response' }).click();
    await expect(panel.getByText(REGENERATED, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(stop).toHaveCount(0);
    // The regenerate re-sent the same user prompt, read back off the wire.
    expect(JSON.stringify(rootRequests()[1]?.messages)).toContain(PROMPT);

    // Turn 3: a long reply, stopped the same way.
    await input.fill(LONG_PROMPT);
    await send.click();
    await expect(panel.getByText(/Long response\. Long response\./).first()).toBeVisible({
      timeout: 60_000,
    });
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
    longHold.resolve();
    await expect(send).toBeVisible();

    // Only the two stopped turns were aborted; the regenerated one completed.
    await expect
      .poll(
        async () =>
          (await readCommittedRuns(electron.getUserDataDir(), threadId)).map(
            ({ status }) => status
          ),
        { timeout: 60_000 }
      )
      .toEqual(['stopped', 'completed', 'stopped']);
    expect(rootRequests()).toHaveLength(3);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    firstHold.resolve();
    longHold.resolve();
  }
});
