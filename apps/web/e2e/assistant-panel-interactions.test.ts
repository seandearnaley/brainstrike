import type { LocalLlmGenerationResult, LocalLlmMessage } from '@brainstrike/assistant-contract';
import { expect, test } from '@playwright/test';
import { openAssistantWorkspace } from './utils/assistant-workspace';

interface ControlledGeneration {
  readonly messages: readonly unknown[];
  readonly requestId: string;
}

interface StopRetryFixture {
  readonly cancelled: string[];
  emit: (text: string) => void;
  finish: (text: string) => void;
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
      const listeners = new Set<(event: unknown) => void>();
      const pending = new Map<
        string,
        {
          resolve: (result: LocalLlmGenerationResult) => void;
          reject: (error: Error) => void;
        }
      >();
      const fixture: StopRetryFixture = {
        cancelled: [],
        emit(text) {
          const requestId = fixture.requests.at(-1)?.requestId;
          if (!(requestId && pending.has(requestId))) {
            throw new Error('No active generation to stream');
          }
          for (const listener of listeners) {
            listener({
              payload: { clientRequestId: requestId, kind: 'text', text },
              requestId,
              type: 'progress',
            });
          }
        },
        finish(text) {
          const requestId = fixture.requests.at(-1)?.requestId;
          const generation = requestId ? pending.get(requestId) : undefined;
          if (!(requestId && generation)) {
            throw new Error('No active generation to finish');
          }
          pending.delete(requestId);
          generation.resolve({ finishReason: 'stop', text });
        },
        requests: [],
      };
      const host = {
        cancel: async (requestId: string): Promise<void> => {
          const generation = pending.get(requestId);
          if (!generation) {
            throw new Error('Cancellation targeted an unknown generation');
          }
          fixture.cancelled.push(requestId);
          pending.delete(requestId);
          generation.reject(new DOMException('Generation cancelled.', 'AbortError'));
        },
        generate: ({
          requestId,
          messages,
        }: {
          requestId?: string;
          messages: LocalLlmMessage[];
        }): Promise<LocalLlmGenerationResult> => {
          if (!requestId || pending.has(requestId)) {
            throw new Error('Expected a distinct native generation request ID');
          }
          fixture.requests.push({ messages, requestId });
          return new Promise<LocalLlmGenerationResult>((resolve, reject) => {
            pending.set(requestId, { reject, resolve });
          });
        },
        onProgress: (listener: (event: unknown) => void): (() => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        warmup: async () => undefined,
      };
      // The selected local runtime consumes this host, not the hosted HTTP API.
      Object.defineProperty(window, 'llmHost', { configurable: true, value: host });
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
      window.__assistantStopRetryFixture.emit('Partial response before stop.')
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
      window.__assistantStopRetryFixture.emit('Completed regenerated response.');
      window.__assistantStopRetryFixture.finish('Completed regenerated response.');
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
      window.__assistantStopRetryFixture.emit('Long response. '.repeat(300))
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
