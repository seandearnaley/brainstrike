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

test.describe('Assistant UI panel (web, assistant-ui mode) @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ page }) => {
    const tree = {
      'README.md': '# BrainStrike test workspace',
    };

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

    await openAssistantWorkspace(page, {
      enableLocalAssistantModel: true,
      rootName: 'assistant-ui-panel',
      tree,
    });
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

  test('keeps composer controls in the input shell and reveals collapsed history', async ({
    page,
  }) => {
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    const viewport = page.getByTestId('assistant-ui-viewport');
    const composerShell = page.getByTestId('assistant-composer-shell');
    await expect(viewport).toBeVisible();
    await expect(composerShell).toBeVisible();
    await expect(composerShell.getByTestId('assistant-composer-controls')).toBeVisible();
    await expect(composerShell.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(composerShell.getByText('Send', { exact: true })).toHaveCount(0);

    const modelBox = await composerShell
      .getByTestId('assistant-model-dropdown')
      .getByRole('combobox')
      .boundingBox();
    const controlsBox = await composerShell
      .getByRole('button', { name: 'Open assistant controls' })
      .boundingBox();

    expect(modelBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();
    await expect(composerShell.getByTestId('assistant-context-summary')).toHaveCount(0);
    if (!(modelBox && controlsBox)) {
      throw new Error('Assistant composer control alignment boxes were unavailable.');
    }

    const modelCenterY = modelBox.y + modelBox.height / 2;
    const controlsCenterY = controlsBox.y + controlsBox.height / 2;
    expect(Math.abs(modelCenterY - controlsCenterY)).toBeLessThan(6);

    const longPrompt = [
      'history collapse turn 1',
      'You are improving unit test coverage on the BrainStrike project.',
      'Priority targets include local-runtime-adapter, database setup, and assistant panel tests.',
      'Write a careful implementation plan that preserves renderer-only local LLM execution.',
      'Do not skip verification and do not hide errors behind fallback behavior.',
      ...Array.from(
        { length: 8 },
        (_, index) =>
          `Detailed verification note ${index + 1}: keep the chat message tall enough to exercise the collapsed-message affordance across responsive assistant layouts.`
      ),
    ].join('\n\n');

    const input = page.locator('#assistant-input');
    await input.fill(longPrompt);
    await composerShell.getByRole('button', { name: 'Send' }).click();
    await expect(viewport.getByText(/Mock response from tests/i)).toHaveCount(1, {
      timeout: 15_000,
    });

    const longUserMessage = viewport
      .getByTestId('assistant-user-message-content')
      .filter({ hasText: 'history collapse turn 1' })
      .first();
    await expect(longUserMessage.getByRole('button', { name: 'Show more' })).toBeVisible();
    await longUserMessage.getByRole('button', { name: 'Show more' }).click();
    await expect(longUserMessage.getByRole('button', { name: 'Show less' })).toBeVisible();

    for (let turn = 2; turn <= 5; turn += 1) {
      await input.fill(`history collapse turn ${turn}`);
      await composerShell.getByRole('button', { name: 'Send' }).click();
      await expect(viewport.getByText(/Mock response from tests/i)).toHaveCount(turn, {
        timeout: 15_000,
      });
    }

    await expect(page.getByTestId('assistant-history-control')).toHaveAttribute(
      'aria-live',
      'polite'
    );
    const historyToggle = page.getByTestId('assistant-history-toggle');
    await expect(historyToggle).toContainText('2 previous messages');
    await expect(longUserMessage).toBeHidden();

    await historyToggle.click();
    await expect(longUserMessage).toBeVisible();
  });

  test('keeps the assistant tab controller stable when tabs overflow', async ({ page }) => {
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    const tabStrip = page.getByTestId('assistant-thread-tab-strip');
    const tabScroll = page.getByTestId('assistant-thread-tab-scroll');
    const tabList = page.getByRole('tablist', { name: 'Open assistant threads' });
    const scrollLeftButton = page.getByTestId('assistant-tabs-scroll-left');
    const scrollRightButton = page.getByTestId('assistant-tabs-scroll-right');
    const newThreadButton = page.getByTestId('assistant-new-thread-button');

    await expect(tabStrip).toBeVisible();
    await expect(tabScroll).toBeVisible();
    await expect(scrollLeftButton).toBeVisible();
    await expect(scrollRightButton).toBeVisible();
    await expect(newThreadButton).toBeVisible();

    const initialTabCount = await tabList.getByRole('tab').count();
    const initialButtonBox = await newThreadButton.boundingBox();
    const initialFirstTabBox = await tabList.getByRole('tab').first().boundingBox();

    expect(initialButtonBox).not.toBeNull();
    expect(initialFirstTabBox).not.toBeNull();
    if (!(initialButtonBox && initialFirstTabBox)) {
      throw new Error('Assistant tab controller boxes were unavailable before overflow.');
    }

    for (let index = 1; index <= 8; index += 1) {
      await newThreadButton.click();
      await expect(tabList.getByRole('tab')).toHaveCount(initialTabCount + index);
    }

    const scrollMetrics = await tabScroll.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(scrollMetrics.scrollWidth).toBeGreaterThan(scrollMetrics.clientWidth);
    await expect(scrollRightButton).toBeEnabled();

    const overflowButtonBox = await newThreadButton.boundingBox();
    const overflowFirstTabBox = await tabList.getByRole('tab').first().boundingBox();
    const tabListBox = await tabList.boundingBox();

    expect(overflowButtonBox).not.toBeNull();
    expect(overflowFirstTabBox).not.toBeNull();
    expect(tabListBox).not.toBeNull();
    if (!(overflowButtonBox && overflowFirstTabBox && tabListBox)) {
      throw new Error('Assistant tab controller boxes were unavailable after overflow.');
    }

    expect(Math.abs(overflowButtonBox.y - initialButtonBox.y)).toBeLessThan(2);
    expect(Math.abs(overflowButtonBox.height - initialButtonBox.height)).toBeLessThan(2);
    expect(Math.abs(overflowFirstTabBox.y - initialFirstTabBox.y)).toBeLessThan(2);
    expect(Math.abs(overflowFirstTabBox.height - initialFirstTabBox.height)).toBeLessThan(2);
    expect(overflowButtonBox.x).toBeGreaterThanOrEqual(tabListBox.x + tabListBox.width);

    const beforeButtonScrollLeft = await tabScroll.evaluate((element) => element.scrollLeft);
    await scrollRightButton.click();
    await expect
      .poll(() => tabScroll.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(beforeButtonScrollLeft);
    await expect(scrollLeftButton).toBeEnabled();

    await tabScroll.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await tabScroll.hover();
    await page.mouse.wheel(0, 240);
    await expect.poll(() => tabScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

    await tabScroll.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });

    const scrolledButtonBox = await newThreadButton.boundingBox();
    expect(scrolledButtonBox).not.toBeNull();
    if (!scrolledButtonBox) {
      throw new Error('Assistant new-thread button disappeared after tab scroll.');
    }
    expect(Math.abs(scrolledButtonBox.x - overflowButtonBox.x)).toBeLessThan(2);
    expect(Math.abs(scrolledButtonBox.y - overflowButtonBox.y)).toBeLessThan(2);
  });
});
