import type {
  LocalLlmBackend,
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
} from '@brainstrike/assistant-contract';
import { expect, test } from '@playwright/test';
import { openAssistantWorkspace } from './utils/assistant-workspace';

interface ControlledGeneration {
  readonly messages: readonly unknown[];
  readonly requestId: string;
}

interface StopRetryFixture {
  readonly cancelled: string[];
  emit: (requestIndex: number, text: string) => void;
  finish: (requestIndex: number, text: string) => void;
  readonly requests: ControlledGeneration[];
}

declare global {
  interface Window {
    __assistantStopRetryFixture: StopRetryFixture;
  }
}

test.describe('Assistant stop/retry @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.__assistantAvailabilityOverride = { state: 'enabled' };
      const pending = new Map<
        string,
        {
          resolve: (result: LocalLlmGenerationResult) => void;
          stream: NonNullable<LocalLlmGenerationOptions['stream']>;
          cleanup: () => void;
        }
      >();
      const fixture: StopRetryFixture = {
        cancelled: [],
        emit(requestIndex, text) {
          const requestId = fixture.requests[requestIndex]?.requestId;
          if (!(requestId && pending.has(requestId))) {
            throw new Error('No active generation to stream');
          }
          pending.get(requestId)?.stream.onTextSnapshot?.(text);
        },
        finish(requestIndex, text) {
          const requestId = fixture.requests[requestIndex]?.requestId;
          const generation = requestId ? pending.get(requestId) : undefined;
          if (!(requestId && generation)) {
            throw new Error('No active generation to finish');
          }
          pending.delete(requestId);
          generation.cleanup();
          generation.resolve({ finishReason: 'stop', text });
        },
        requests: [],
      };
      let ready = false;
      const backend: LocalLlmBackend = {
        dispose: async () => {
          ready = false;
        },
        generate: async (messages, options = {}) => {
          const { signal, stream } = options;
          if (!(signal && stream?.onTextSnapshot)) {
            throw new Error('The browser adapter must supply cancellation and streaming');
          }
          signal.throwIfAborted();
          const requestId = crypto.randomUUID();
          fixture.requests.push({ messages, requestId });
          return new Promise<LocalLlmGenerationResult>((resolve, reject) => {
            const onAbort = (): void => {
              fixture.cancelled.push(requestId);
              pending.delete(requestId);
              reject(signal.reason);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            pending.set(requestId, {
              cleanup: () => signal.removeEventListener('abort', onAbort),
              resolve,
              stream,
            });
          });
        },
        initialize: async () => {
          ready = true;
        },
        isReady: () => ready,
      };
      window.__brainstrikeWebLocalLlmBackendFixture__ = backend;
      window.__assistantStopRetryFixture = fixture;
    });
    await openAssistantWorkspace(page, {
      enableLocalAssistantModel: true,
      rootName: 'assistant-stop-retry',
    });
  });

  test('stops the owned generation, regenerates the prompt and stops a long response', async ({
    page,
  }) => {
    expect(await page.evaluate(() => 'llmHost' in window)).toBe(false);
    const viewport = page.getByTestId('assistant-ui-viewport');
    const input = page.getByRole('textbox', { name: 'Message input' });
    const send = page.getByRole('button', { exact: true, name: 'Send' });
    const stop = page.getByRole('button', { exact: true, name: 'Stop' });
    const prompt = 'Compare the evidence for this response.';
    await input.fill(prompt);
    await send.click();
    await expect
      .poll(() => page.evaluate(() => window.__assistantStopRetryFixture.requests.length))
      .toBe(1);
    await page.evaluate(() =>
      window.__assistantStopRetryFixture.emit(0, 'Partial response before stop.')
    );
    await expect(
      viewport.getByText('Partial response before stop.', { exact: true })
    ).toBeVisible();
    await stop.click();
    await expect
      .poll(() => page.evaluate(() => window.__assistantStopRetryFixture.cancelled.length))
      .toBe(1);
    await expect(stop).toBeHidden();

    await page.getByRole('button', { name: 'Regenerate response' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__assistantStopRetryFixture.requests.length))
      .toBe(2);
    const generations = await page.evaluate(() => window.__assistantStopRetryFixture.requests);
    expect(generations[1]?.messages).toContainEqual(
      expect.objectContaining({ content: prompt, role: 'user' })
    );
    expect(generations[1]?.requestId).not.toBe(generations[0]?.requestId);
    await page.evaluate(() => {
      // Host progress is a cumulative snapshot; the final result is the same
      // complete text, not an additional delta to append.
      window.__assistantStopRetryFixture.emit(1, 'Completed regenerated response.');
      window.__assistantStopRetryFixture.finish(1, 'Completed regenerated response.');
    });
    await expect(
      viewport.getByText('Completed regenerated response.', { exact: true })
    ).toBeVisible();
    await expect(stop).toBeHidden();

    await input.fill('Write a long response that I can stop.');
    await send.click();
    await expect
      .poll(() => page.evaluate(() => window.__assistantStopRetryFixture.requests.length))
      .toBe(3);
    await page.evaluate(() =>
      window.__assistantStopRetryFixture.emit(2, 'Long response. '.repeat(300))
    );
    await expect(viewport.getByText(/^Long response\. Long response\./)).toBeVisible();
    await stop.click();
    await expect
      .poll(() => page.evaluate(() => window.__assistantStopRetryFixture.cancelled.length))
      .toBe(2);
    await expect(stop).toBeHidden();
    await expect(send).toBeVisible();
    const evidence = await page.evaluate(() => ({
      cancelled: window.__assistantStopRetryFixture.cancelled,
      requests: window.__assistantStopRetryFixture.requests,
    }));
    expect(evidence.cancelled).toEqual([
      evidence.requests[0]?.requestId,
      evidence.requests[2]?.requestId,
    ]);
    expect(evidence.requests).toHaveLength(3);
  });
});
