import { expect, test } from '@playwright/test';
import { openAssistantWorkspace } from './utils/assistant-workspace';
import { getPanelElements } from './utils/layout-helpers';

// Assistant-UI E2E (web): uses the local-runtime UI path with a mocked `window.llmHost`
// so the shared assistant-ui message rendering and local status states are exercised
// without downloading a real Gemma model during E2E.

type MockProgressPayload =
  | {
      clientRequestId?: string;
      kind: 'stage';
      message: 'reasoning' | 'responding';
    }
  | {
      clientRequestId?: string;
      kind: 'reasoning';
      reasoningText: string;
    }
  | {
      clientRequestId?: string;
      kind: 'text';
      text: string;
    };

type MockProgressPayloadInput =
  | {
      kind: 'stage';
      message: 'reasoning' | 'responding';
    }
  | {
      kind: 'reasoning';
      reasoningText: string;
    }
  | {
      kind: 'text';
      text: string;
    };

interface MockProgressEvent {
  payload: MockProgressPayload;
  requestId: string;
  type: 'progress';
}

interface MockToolCall {
  function: {
    arguments: string;
    name: string;
  };
  id: string;
  type: 'function';
}

interface MockLlmMessage {
  content: string;
  role: 'assistant' | 'system' | 'tool' | 'user';
}

interface MockLlmGenerateRequest {
  messages: MockLlmMessage[];
  requestId: string;
}

test.describe('Assistant UI panel (web, assistant-ui mode)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const STREAM_STEP_DELAY_MS = 300;

      // @ts-expect-error test-only override
      window.__assistantAvailabilityOverride = { state: 'enabled' };
      const progressListeners = new Set<(event: MockProgressEvent) => void>();

      const emitProgress = (requestId: string, payload: MockProgressPayloadInput) => {
        for (const listener of progressListeners) {
          const event: MockProgressEvent = {
            type: 'progress',
            requestId,
            payload: {
              clientRequestId: requestId,
              ...payload,
            },
          };
          listener(event);
        }
      };

      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      // @ts-expect-error local runtime host mock for e2e
      window.llmHost = {
        warmup: async () => undefined,
        onProgress(callback: (event: MockProgressEvent) => void) {
          progressListeners.add(callback);
          return () => progressListeners.delete(callback);
        },
        async generate({ requestId, messages }: MockLlmGenerateRequest) {
          const latestUserMessage = [...messages]
            .reverse()
            .find((message: MockLlmMessage) => message.role === 'user');
          const latestUserText =
            typeof latestUserMessage?.content === 'string' ? latestUserMessage.content : '';
          const hasToolResponse = messages.some(
            (message: MockLlmMessage) => message.role === 'tool'
          );

          if (latestUserText.includes('hidden tool details') && !hasToolResponse) {
            emitProgress(requestId, { kind: 'stage', message: 'reasoning' });
            emitProgress(requestId, {
              kind: 'reasoning',
              reasoningText: 'Inspect whether a tool is needed.',
            });
            await delay(STREAM_STEP_DELAY_MS);
            return {
              text: '',
              reasoningText: 'Inspect whether a tool is needed.',
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: 'tool-call-1',
                  type: 'function',
                  function: {
                    name: 'web.echo',
                    arguments: JSON.stringify({ text: 'hello from mock' }),
                  },
                },
              ] satisfies MockToolCall[],
              usage: { promptTokens: 12, completionTokens: 10, totalTokens: 22 },
            };
          }

          emitProgress(requestId, { kind: 'stage', message: 'reasoning' });
          emitProgress(requestId, {
            kind: 'reasoning',
            reasoningText: hasToolResponse ? 'Summarize the tool result.' : 'Plan a short reply.',
          });
          await delay(STREAM_STEP_DELAY_MS);
          emitProgress(requestId, { kind: 'stage', message: 'responding' });
          await delay(STREAM_STEP_DELAY_MS);
          emitProgress(requestId, {
            kind: 'text',
            text: 'Assistant: Mock response from tests.',
          });
          await delay(STREAM_STEP_DELAY_MS);
          return {
            text: 'Assistant: Mock response from tests.',
            reasoningText: hasToolResponse ? 'Summarize the tool result.' : 'Plan a short reply.',
            finishReason: 'stop',
            usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
          };
        },
      };

      // @ts-expect-error tool bridge mock for local-runtime tool execution
      window.tools = {
        async execute(toolId: string, input: unknown) {
          return {
            success: true,
            durationMs: 5,
            result: {
              toolId,
              input,
              echoed: 'hello from mock',
            },
          };
        },
      };
    });

    await openAssistantWorkspace(page, { rootName: 'assistant-ui-panel' });
  });

  test('send message and see assistant stream with tool progress', async ({ page }) => {
    // Ensure right panel is visible
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    // Assistant UI viewport should be present (assistant-ui path)
    const viewport = page.getByTestId('assistant-ui-viewport');
    await expect(viewport).toBeVisible();

    await page.locator('#assistant-input').fill('tell me a joke');
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await sendBtn.click();

    const stopBtn = page.getByRole('button', { name: 'Stop' });
    await expect(stopBtn).toBeVisible({ timeout: 5000 });

    await expect(page.getByTestId('local-model-status')).toContainText(/generating answer/i, {
      timeout: 10_000,
    });

    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });

    await expect(stopBtn).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('local-model-status')).toBeHidden({ timeout: 5000 });
  });

  test('keeps streamed tool details collapsed until explicitly expanded', async ({ page }) => {
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    const viewport = page.getByTestId('assistant-ui-viewport');
    await expect(viewport).toBeVisible();

    await page.locator('#assistant-input').fill('echo hidden tool details');
    await page.getByRole('button', { name: 'Send' }).click();

    await page.getByRole('button', { name: /show reasoning/i }).click();

    const toolCard = viewport.getByTestId('tool-fallback');
    await expect(toolCard).toBeVisible({ timeout: 10_000 });
    await expect(toolCard).toContainText(/web\.echo/i);
    await expect(toolCard).toContainText(/Completed/i);
    await expect(toolCard.getByText('Arguments:')).toBeHidden();
    await expect(toolCard.getByText('Result:')).toBeHidden();

    await toolCard.getByRole('button', { name: 'Expand details' }).click();
    await expect(toolCard.getByText('Arguments:')).toBeVisible();
    await expect(toolCard.getByText('Result:')).toBeVisible();
  });
});
