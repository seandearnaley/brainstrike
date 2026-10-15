import { expect, test } from '@playwright/test';
import {
  finishGatedRun,
  mockGatedAssistantApi,
  readGatedRunPrompts,
  readGatedRuns,
  streamGatedRunText,
} from './utils/assistant-mocks';
import { openAssistantWorkspace } from './utils/assistant-workspace';

/**
 * Stop and regenerate over the hosted `/api/assistant` data stream. Every turn
 * is held open, so Stop always lands mid-run; the mock records the abort its
 * `AbortSignal` carries and keeps the body each request posted, which is what
 * proves a regenerate re-sent the original prompt.
 *
 * QUARANTINED — web has no sendable composer.
 *
 * These turns are driven through the composer, and on web the composer is
 * disabled for every provider web can offer. `resolveAssistantMemoryDisabledReason`
 * (packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts) disables it
 * whenever a provider is selected and `resolveHostedMemoryBackendAvailable` is
 * false, and that resolves `selectedProvider === 'local' || desktopAssistantBackendAvailable`.
 * Web's `desktopAssistantBackendAvailable` is `hasDurableAssistantUsageCapability()`,
 * which is false without `window.agentHost` — so before the built-in local
 * provider was retired, `local` was the ONLY provider that cleared this gate on
 * web, which is why the original suites seeded it.
 *
 * The transport itself is fine: with that one gate cleared, a turn streams over
 * `/api/assistant` end to end, tool chunks and all. So these are unquarantined
 * by enabling hosted web chat, not by changing the tests. Faking the capability
 * probe would assert a configuration that cannot exist (web + durable agent
 * host), so it is deliberately not done here.
 *
 * Desktop covers the close-while-running case in
 * `apps/desktop/e2e/assistant-thread-tab-close-running.desktop.test.ts`.
 */

test.describe('Assistant stop/retry @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ page }) => {
    await mockGatedAssistantApi(page);
    await openAssistantWorkspace(page, {
      hostedAssistantModel: true,
      rootName: 'assistant-stop-retry',
    });
  });

  test.fixme('stops the owned generation, regenerates the prompt and stops a long response', {
    annotation: {
      description: 'Blocked: web composer is disabled for hosted providers',
      type: 'quarantine',
    },
  }, async ({ page }) => {
    const viewport = page.getByTestId('assistant-ui-viewport');
    const input = page.getByRole('textbox', { name: 'Message input' });
    const send = page.getByRole('button', { exact: true, name: 'Send' });
    const stop = page.getByRole('button', { exact: true, name: 'Stop' });
    const prompt = 'Compare the evidence for this response.';
    await input.fill(prompt);
    await send.click();
    await expect.poll(async () => (await readGatedRuns(page)).started).toBe(1);
    await streamGatedRunText(page, 0, 'Partial response before stop.');
    await expect(
      viewport.getByText('Partial response before stop.', { exact: true })
    ).toBeVisible();
    await stop.click();
    await expect.poll(async () => (await readGatedRuns(page)).cancelled).toHaveLength(1);
    await expect(stop).toBeHidden();

    await page.getByRole('button', { name: 'Regenerate response' }).click();
    await expect.poll(async () => (await readGatedRuns(page)).started).toBe(2);
    // The regenerate re-sends the same user prompt, read back off the wire.
    expect((await readGatedRunPrompts(page))[1]).toContain(prompt);
    // Data-stream text chunks are DELTAS, not the cumulative snapshots the
    // old host progress emitted, so the final text is streamed exactly once.
    await finishGatedRun(page, 1, 'Completed regenerated response.');
    await expect(
      viewport.getByText('Completed regenerated response.', { exact: true })
    ).toBeVisible();
    await expect(stop).toBeHidden();

    await input.fill('Write a long response that I can stop.');
    await send.click();
    await expect.poll(async () => (await readGatedRuns(page)).started).toBe(3);
    await streamGatedRunText(page, 2, 'Long response. '.repeat(300));
    await expect(viewport.getByText(/^Long response\. Long response\./)).toBeVisible();
    await stop.click();
    await expect.poll(async () => (await readGatedRuns(page)).cancelled).toHaveLength(2);
    await expect(stop).toBeHidden();
    await expect(send).toBeVisible();
    // Only the two stopped turns were aborted; the regenerated one ran to completion.
    expect(await readGatedRuns(page)).toEqual({
      cancelled: ['gated-run-0', 'gated-run-2'],
      started: 3,
    });
  });
});
