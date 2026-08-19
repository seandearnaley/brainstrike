import { expect, type Page, test } from '@playwright/test';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import { openAssistantWorkspace } from './utils/assistant-workspace';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

// Assistant-UI E2E (web): uses the local-runtime UI path with a mocked `window.llmHost`
// so the shared assistant-ui message rendering and local status states are exercised
// without downloading a real Gemma model during E2E.

const ASSISTANT_UI_PANEL_ROOT_NAME = 'assistant-ui-panel';
const ASSISTANT_UI_PANEL_TREE = {
  'README.md': '# BrainStrike test workspace',
};
// Report interaction latency separately from functional visibility assertions,
// so a loaded runner identifies a performance-budget miss rather than disguising
// it as a missing icon/color regression.
const THREAD_CUSTOMIZATION_FEEDBACK_BUDGET_MS = 1000;

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

interface AssistantThreadStartupEvent {
  readonly kind: 'error' | 'loading';
  readonly marker: string;
}

async function readWebE2eDbPath(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
      .__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected web E2E hooks to be available');
    }
    return hooks.dbPath;
  });
}

// Assistant threads persist under the workspace-global resource id (see
// WORKSPACE_MEMORY_RESOURCE_ID in packages/assistant-data/src/assistant-memory-resource.ts —
// not exported from the package barrel, hence the literal), not the focused
// root name, since #1214 made threads workspace-global.
const WORKSPACE_MEMORY_RESOURCE_ID = 'brainstrike:workspace';

async function readFirstAssistantThreadMetadata(
  page: Page,
  resourceId = WORKSPACE_MEMORY_RESOURCE_ID
): Promise<unknown> {
  return await page.evaluate(async (targetResourceId) => {
    const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
      .__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected web E2E hooks to be available');
    }
    const threads = await hooks.readAssistantThreads();
    return threads.find((thread) => thread.resourceId === targetResourceId)?.metadata ?? null;
  }, resourceId);
}

async function restoreAssistantFixtureRoot(page: Page): Promise<void> {
  await page.evaluate(
    async (fixture: { readonly name: string; readonly tree: typeof ASSISTANT_UI_PANEL_TREE }) => {
      const loadFixture = (
        window as unknown as {
          __BRAINSTRIKE_LOAD_FIXTURE__?: (nextFixture: unknown) => Promise<unknown>;
        }
      ).__BRAINSTRIKE_LOAD_FIXTURE__;
      if (typeof loadFixture !== 'function') {
        throw new Error('Expected fixture loader to be available after reload');
      }
      await loadFixture(fixture);
    },
    {
      name: ASSISTANT_UI_PANEL_ROOT_NAME,
      tree: ASSISTANT_UI_PANEL_TREE,
    }
  );
}

test.describe('Assistant UI panel (web, assistant-ui mode) @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const STREAM_STEP_DELAY_MS = 300;

      // Declared by app-shell's `use-assistant-availability` global augmentation,
      // which the settings page now pulls into this app's type program.
      window.__assistantAvailabilityOverride = { state: 'enabled' };
      const startupEvents: AssistantThreadStartupEvent[] = [];
      const startupEventKeys = new Set<string>();
      const recordStartupEvent = (kind: AssistantThreadStartupEvent['kind'], marker: string) => {
        const key = `${kind}:${marker}`;
        if (startupEventKeys.has(key)) {
          return;
        }
        startupEventKeys.add(key);
        startupEvents.push({ kind, marker });
      };
      const recordAssistantThreadStartupText = () => {
        const surfaces = [
          ...document.querySelectorAll<HTMLElement>('[data-testid="threads-panel"]'),
          ...document.querySelectorAll<HTMLElement>(
            '[data-testid="assistant-thread-tabs-workspace"]'
          ),
        ];
        for (const surface of surfaces) {
          const loadingSurfaces = surface.querySelectorAll(
            '[data-testid="threads-loading-card"], [data-testid="assistant-thread-workspace-state"]:not([data-variant="error"])'
          );
          for (const element of loadingSurfaces) {
            recordStartupEvent('loading', element.getAttribute('data-testid') ?? 'loading');
          }
          const errorSurfaces = surface.querySelectorAll(
            '[data-testid="threads-error-card"], [data-testid="assistant-thread-workspace-state"][data-variant="error"]'
          );
          for (const element of errorSurfaces) {
            recordStartupEvent('error', element.getAttribute('data-testid') ?? 'error');
          }
        }
      };
      const installAssistantThreadStartupObserver = () => {
        const target = document.documentElement;
        if (!target) {
          window.setTimeout(installAssistantThreadStartupObserver, 0);
          return;
        }
        const observer = new MutationObserver(recordAssistantThreadStartupText);
        observer.observe(target, { characterData: true, childList: true, subtree: true });
        recordAssistantThreadStartupText();
      };
      Object.defineProperty(window, '__assistantThreadStartupEvents', {
        configurable: true,
        value: startupEvents,
      });
      installAssistantThreadStartupObserver();
      const progressListeners = new Set<(event: MockProgressEvent) => void>();

      const emitProgress = (requestId: string, payload: MockProgressPayloadInput) => {
        for (const listener of progressListeners) {
          const event: MockProgressEvent = {
            payload: {
              clientRequestId: requestId,
              ...payload,
            },
            requestId,
            type: 'progress',
          };
          listener(event);
        }
      };

      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      // @ts-expect-error local runtime host mock for e2e
      window.llmHost = {
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
              finishReason: 'tool_calls',
              reasoningText: 'Inspect whether a tool is needed.',
              text: '',
              toolCalls: [
                {
                  function: {
                    arguments: JSON.stringify({ text: 'hello from mock' }),
                    name: 'web.echo',
                  },
                  id: 'tool-call-1',
                  type: 'function',
                },
              ] satisfies MockToolCall[],
              usage: { completionTokens: 10, promptTokens: 12, totalTokens: 22 },
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
            finishReason: 'stop',
            reasoningText: hasToolResponse ? 'Summarize the tool result.' : 'Plan a short reply.',
            text: 'Assistant: Mock response from tests.',
            usage: { completionTokens: 24, promptTokens: 12, totalTokens: 36 },
          };
        },
        onProgress(callback: (event: MockProgressEvent) => void) {
          progressListeners.add(callback);
          return () => progressListeners.delete(callback);
        },
        warmup: async () => undefined,
      };

      // @ts-expect-error tool bridge mock for local-runtime tool execution
      window.tools = {
        async execute(toolId: string, input: unknown) {
          return {
            durationMs: 5,
            result: {
              echoed: 'hello from mock',
              input,
              toolId,
            },
            success: true,
          };
        },
      };
    });

    await openAssistantWorkspace(page, {
      enableLocalAssistantModel: true,
      rootName: ASSISTANT_UI_PANEL_ROOT_NAME,
      tree: ASSISTANT_UI_PANEL_TREE,
    });
  });

  test('loads assistant thread surfaces without startup error states', async ({ page }) => {
    await expect(page.getByTestId('threads-panel')).toBeVisible();
    await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible();
    const startupEvents = await page.evaluate(
      () =>
        (window as unknown as { __assistantThreadStartupEvents?: AssistantThreadStartupEvent[] })
          .__assistantThreadStartupEvents ?? []
    );
    expect(startupEvents.filter((event) => event.kind === 'error')).toEqual([]);
    await expect(page.getByText('Failed to load threads')).toHaveCount(0);
    await expect(page.getByText('Assistant threads failed to load')).toHaveCount(0);
    await expect(page.getByText('Assistant memory database unavailable')).toHaveCount(0);
    await expect(page.getByText('Memory database unavailable')).toHaveCount(0);
  });

  test('customizes thread identity and keeps diagnostics out of the primary row', async ({
    page,
  }) => {
    await expect(page.getByTestId('threads-panel')).toBeVisible();
    const threadRow = page.getByTestId('thread-row').first();
    await expect(threadRow).toBeVisible();
    await expect(threadRow).not.toContainText(/thread-[0-9a-f-]+/i);
    const threadTab = page
      .getByRole('tablist', { name: 'Open assistant threads' })
      .getByRole('tab')
      .first();
    await expect(threadTab).toBeVisible();
    await expect(threadTab.getByTestId('assistant-thread-tab-glyph-message')).toBeVisible();

    // Customization moved into the row's "Thread actions" popover (#1661). The
    // popover renders in a portal, so its controls are scoped to the open
    // popover (role=dialog) rather than the row — page-wide getByRole would
    // collide with the group popover's identically-named items. Escape closes
    // it (and exits customize mode) before the flow interacts with the row
    // again; the toHaveCount(0) barrier pins that both `actionsOpen` and
    // `customizing` actually cleared (BST-1033).
    await threadRow.getByRole('button', { name: /Thread actions/i }).click();
    const threadActions = page.getByRole('dialog');
    await threadActions.getByRole('button', { name: 'Customize' }).click();
    const iconCustomizationStartedAt = Date.now();
    await threadActions.getByRole('button', { name: 'Use Bug icon' }).click();
    await expect(threadRow.getByTestId('thread-icon-bug')).toBeVisible();
    await expect(threadTab.getByTestId('assistant-thread-tab-glyph-bug')).toBeVisible();
    expect(
      Date.now() - iconCustomizationStartedAt,
      'Thread icon customization exceeded the click-to-paint performance budget.'
    ).toBeLessThan(THREAD_CUSTOMIZATION_FEEDBACK_BUDGET_MS);

    const colorCustomizationStartedAt = Date.now();
    await threadActions.getByRole('button', { name: 'Use Rose color' }).click();
    await expect(threadRow.getByTestId('thread-color-rose')).toBeVisible();
    await expect(threadTab.getByTestId('assistant-thread-tab-icon-rose')).toBeVisible();
    expect(
      Date.now() - colorCustomizationStartedAt,
      'Thread color customization exceeded the click-to-paint performance budget.'
    ).toBeLessThan(THREAD_CUSTOMIZATION_FEEDBACK_BUDGET_MS);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('thread-customization-panel')).toHaveCount(0);

    await expect(threadRow.getByTestId('thread-icon-bug')).toBeVisible();
    await expect(threadRow.getByTestId('thread-color-rose')).toBeVisible();
    await expect(threadRow).not.toContainText(/thread-[0-9a-f-]+/i);

    await threadRow.getByRole('button', { name: /Show thread details/ }).click();
    await expect(threadRow.getByTestId('thread-expanded-details')).toContainText('Diagnostics');
    await expect(threadRow.getByTestId('thread-expanded-details')).toContainText(
      /thread-[0-9a-f-]+/i
    );

    await expect
      .poll(async () => await readFirstAssistantThreadMetadata(page))
      .toMatchObject({ color: 'rose', icon: 'bug' });
    await page.waitForFunction(() =>
      Boolean(
        (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
          .__brainstrikeWebE2ETestHooks__
      )
    );
    await page.evaluate(async () => {
      await (
        window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks }
      ).__brainstrikeWebE2ETestHooks__?.syncDatabase();
    });
    const dbPathBeforeReload = await readWebE2eDbPath(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: true });
    await restoreAssistantFixtureRoot(page);
    await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(async () => await readWebE2eDbPath(page), {
        message: 'Expected the Playwright E2E DB path to stay stable across reload',
      })
      .toBe(dbPathBeforeReload);
    await expect
      .poll(async () => await readFirstAssistantThreadMetadata(page))
      .toMatchObject({ color: 'rose', icon: 'bug' });
    const reloadedThreadRow = page.getByTestId('thread-row').first();
    await expect(reloadedThreadRow).toBeVisible();
    await expect(reloadedThreadRow.getByTestId('thread-icon-bug')).toBeVisible();
    await expect(reloadedThreadRow.getByTestId('thread-color-rose')).toBeVisible();
    await expect(reloadedThreadRow).not.toContainText(/thread-[0-9a-f-]+/i);
    const reloadedThreadTab = page
      .getByRole('tablist', { name: 'Open assistant threads' })
      .getByRole('tab')
      .first();
    await expect(reloadedThreadTab.getByTestId('assistant-thread-tab-glyph-bug')).toBeVisible();
    await expect(reloadedThreadTab.getByTestId('assistant-thread-tab-icon-rose')).toBeVisible();
  });

  test('tracks concurrent thread activity from durable runs and clears every terminal spinner', async ({
    page,
  }) => {
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.getByTestId('new-agent-button').click();
    await expect(page.getByTestId('thread-row')).toHaveCount(2);

    const threads = await page.evaluate(async (resourceId) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Expected web E2E hooks to be available');
      }
      return (await hooks.readAssistantThreads()).filter(
        (thread) => thread.resourceId === resourceId
      );
    }, WORKSPACE_MEMORY_RESOURCE_ID);
    expect(threads).toHaveLength(2);
    const firstThread = threads[0];
    const secondThread = threads[1];
    if (!(firstThread && secondThread)) {
      throw new Error('Expected two assistant threads for concurrent activity coverage');
    }
    const firstRunId = `e2e-active-run-${crypto.randomUUID()}`;
    const secondRunId = `e2e-active-run-${crypto.randomUUID()}`;
    await page.evaluate(
      async ({ first, firstId, resourceId, second, secondId }) => {
        const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
          .__brainstrikeWebE2ETestHooks__;
        if (!hooks) {
          throw new Error('Expected web E2E hooks to be available');
        }
        await Promise.all([
          hooks.createAssistantThreadRun({ id: firstId, resourceId, threadId: first }),
          hooks.createAssistantThreadRun({ id: secondId, resourceId, threadId: second }),
        ]);
      },
      {
        first: firstThread.id,
        firstId: firstRunId,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        second: secondThread.id,
        secondId: secondRunId,
      }
    );

    await expect(page.getByTestId('thread-active-spinner')).toHaveCount(2);
    await expect(
      page.getByTestId('thread-row').locator('[data-testid^="thread-icon-"]')
    ).toHaveCount(2);
    await expect(page.getByTestId('thread-active-spinner').first()).toHaveCSS(
      'animation-name',
      'none'
    );

    await page.evaluate(async (runId) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Expected web E2E hooks to be available');
      }
      await hooks.completeAssistantThreadRun(runId, 'completed');
    }, firstRunId);
    await expect(page.getByTestId('thread-active-spinner')).toHaveCount(1);

    await page.evaluate(async (runId) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Expected web E2E hooks to be available');
      }
      await hooks.completeAssistantThreadRun(runId, 'failed');
    }, secondRunId);
    await expect(page.getByTestId('thread-active-spinner')).toHaveCount(0);
    await expect(
      page.getByTestId('thread-row').locator('[data-testid^="thread-icon-"]')
    ).toHaveCount(2);

    const cancellationRunId = `e2e-cancelled-run-${crypto.randomUUID()}`;
    await page.evaluate(
      async ({ resourceId, runId, threadId }) => {
        const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
          .__brainstrikeWebE2ETestHooks__;
        if (!hooks) {
          throw new Error('Expected web E2E hooks to be available');
        }
        await hooks.createAssistantThreadRun({ id: runId, resourceId, threadId });
      },
      {
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        runId: cancellationRunId,
        threadId: firstThread.id,
      }
    );
    await expect(page.getByTestId('thread-active-spinner')).toHaveCount(1);
    await page.evaluate(async (runId) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Expected web E2E hooks to be available');
      }
      await hooks.completeAssistantThreadRun(runId, 'cancelled');
    }, cancellationRunId);
    await expect(page.getByTestId('thread-active-spinner')).toHaveCount(0);

    const orphanedRunId = `e2e-orphaned-run-${crypto.randomUUID()}`;
    await page.evaluate(
      async ({ resourceId, runId, startedAt, threadId }) => {
        const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
          .__brainstrikeWebE2ETestHooks__;
        if (!hooks) {
          throw new Error('Expected web E2E hooks to be available');
        }
        await hooks.createAssistantThreadRun({ id: runId, resourceId, startedAt, threadId });
        await hooks.syncDatabase();
      },
      {
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        runId: orphanedRunId,
        startedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        threadId: firstThread.id,
      }
    );
    await expect(page.getByTestId('thread-active-spinner')).toHaveCount(1);

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: true });
    await restoreAssistantFixtureRoot(page);
    await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('thread-active-spinner')).toHaveCount(0);
  });

  test('keeps thread identity aligned when switching into rename mode', async ({ page }) => {
    await expect(page.getByTestId('threads-panel')).toBeVisible();
    const threadRow = page.getByTestId('thread-row').first();
    await expect(threadRow).toBeVisible();
    // Color-agnostic identity-mark locator: threads without explicit color
    // metadata render `thread-color-unassigned` since #1643 (was blue before);
    // this test pins the mark's ALIGNMENT across modes, not its color
    // (BST-1034).
    const renderedIdentity = threadRow.locator('[data-testid^="thread-color-"]');
    await expect(renderedIdentity).toBeVisible();
    const renderedBox = await renderedIdentity.boundingBox();
    expect(renderedBox).not.toBeNull();

    // Rename moved into the row's "Thread actions" popover (#1661), scoped to
    // the open popover like the customize/delete flows.
    await threadRow.getByRole('button', { name: /Thread actions/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
    const editIdentity = threadRow.locator('[data-testid^="thread-color-"]');
    await expect(editIdentity).toBeVisible();
    const editBox = await editIdentity.boundingBox();
    expect(editBox).not.toBeNull();

    expect(Math.abs((renderedBox?.x ?? 0) - (editBox?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((renderedBox?.y ?? 0) - (editBox?.y ?? 0))).toBeLessThanOrEqual(1);
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
    const sendBtn = page.getByRole('button', { exact: true, name: 'Send' });
    await sendBtn.click();

    const stopBtn = page.getByRole('button', { exact: true, name: 'Stop' });
    await expect(stopBtn).toBeVisible({ timeout: 5000 });

    await expect(page.getByTestId('local-model-status')).toContainText(/generating answer/i, {
      timeout: 10_000,
    });

    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });

    await expect(stopBtn).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole('button', { exact: true, name: 'Send' })).toBeVisible({
      timeout: 15_000,
    });
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
    await page.getByRole('button', { exact: true, name: 'Send' }).click();

    // Since #1237/#1240 a turn's tool cards live inside a per-turn Activity
    // group that auto-collapses when the turn finishes (the card stays in the
    // DOM but hidden). Deterministically wait out the auto-collapse, then
    // expand the group — the per-card details below must STILL be collapsed
    // until explicitly expanded (the behavior this test exists to pin).
    const activitySummary = viewport.getByTestId('assistant-activity-summary');
    await expect(activitySummary).toBeVisible({ timeout: 10_000 });
    await expect(activitySummary).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
    await activitySummary.click();

    const toolCard = viewport.getByTestId('tool-fallback');
    await expect(toolCard).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('local-reasoning-part')).toHaveCount(0);
    await expect(toolCard).toContainText(/web\.echo/i);
    // Status is conveyed by the icon's accessible label, not visible text.
    await expect(toolCard.getByLabel('Completed')).toBeVisible();
    await expect(toolCard.getByText('Arguments:')).toBeHidden();
    await expect(toolCard.getByText('Result:')).toBeHidden();

    await toolCard.getByRole('button', { name: 'Expand details' }).click();
    await expect(toolCard.getByText('Arguments:')).toBeVisible();
    await expect(toolCard.getByText('Result:')).toBeVisible();
  });

  test('keeps composer controls in the input shell and jumps back to the latest message', async ({
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
    await expect(composerShell.getByRole('button', { exact: true, name: 'Send' })).toBeVisible();
    await expect(composerShell.getByText('Send', { exact: true })).toHaveCount(0);

    const modelBox = await composerShell
      .getByTestId('assistant-model-dropdown')
      .getByTestId('composer-model-menu-trigger')
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

    // The dock is a wrapping flex row (BST-950): chips that share a line must
    // be dead-centered (2px absorbs sub-pixel rounding only), and when the
    // panel is too narrow to fit them the wrap must be clean — stacked rows,
    // never overlapping. Measured at the default layout (1280px viewport) all
    // chips share one line; the wrap branch guards narrow-panel layouts.
    const modelCenterY = modelBox.y + modelBox.height / 2;
    const controlsCenterY = controlsBox.y + controlsBox.height / 2;
    const sharesRow = Math.abs(modelBox.y - controlsBox.y) < 1;
    if (sharesRow) {
      expect(Math.abs(modelCenterY - controlsCenterY)).toBeLessThan(2);
    } else {
      expect(controlsBox.y).toBeGreaterThanOrEqual(modelBox.y + modelBox.height - 1);
    }

    const longPrompt = [
      'thread scroll turn 1',
      'You are improving unit test coverage on the BrainStrike project.',
      'Priority targets include local-runtime-adapter, database setup, and assistant panel tests.',
      'Write a careful implementation plan that preserves renderer-only local LLM execution.',
      'Do not skip verification and do not hide errors behind fallback behavior.',
      ...Array.from(
        { length: 8 },
        (_, index) =>
          `Detailed verification note ${index + 1}: keep the chat message tall enough to exercise the expandable-message affordance across responsive assistant layouts.`
      ),
    ].join('\n\n');

    const input = page.locator('#assistant-input');
    await input.fill(longPrompt);
    await composerShell.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(viewport.getByText(/Mock response from tests/i)).toHaveCount(1, {
      timeout: 15_000,
    });

    const longUserMessage = viewport
      .getByTestId('assistant-user-message-content')
      .filter({ hasText: 'thread scroll turn 1' })
      .first();
    const messageBody = longUserMessage.locator('.bs-expandable-message-body');
    const messageContent = longUserMessage.locator('.bs-expandable-message-content');
    await expect(longUserMessage.getByRole('button', { name: 'Show more' })).toBeVisible();
    const collapsedGeometry = await messageBody.evaluate((body) => {
      const inner = body.querySelector<HTMLElement>('.bs-expandable-message-content');
      if (!inner) {
        throw new Error('Expandable message is missing its inner content element.');
      }
      return {
        bodyHeight: body.getBoundingClientRect().height,
        contentHeight: inner.getBoundingClientRect().height,
        maxHeight: getComputedStyle(body).maxHeight,
      };
    });
    expect(collapsedGeometry.maxHeight).toBe('176px');
    expect(collapsedGeometry.bodyHeight).toBeLessThan(collapsedGeometry.contentHeight);

    await longUserMessage.getByRole('button', { name: 'Show more' }).click();
    await expect(longUserMessage.getByRole('button', { name: 'Show less' })).toBeVisible();
    await expect
      .poll(
        async () =>
          await messageBody.evaluate((body) => {
            const inner = body.querySelector<HTMLElement>('.bs-expandable-message-content');
            if (!inner) {
              throw new Error('Expandable message is missing its inner content element.');
            }
            const bodyRect = body.getBoundingClientRect();
            const innerRect = inner.getBoundingClientRect();
            return {
              heightDelta: Math.abs(bodyRect.height - innerRect.height),
              maxHeight: getComputedStyle(body).maxHeight,
              widthDelta: Math.abs(bodyRect.width - innerRect.width),
            };
          })
      )
      .toEqual({ heightDelta: 0, maxHeight: 'none', widthDelta: 0 });

    const rightPanelResizeHandle = elements.rightPanel.locator(
      'xpath=preceding-sibling::*[@data-separator][1]'
    );
    const resizeHandleBox = await rightPanelResizeHandle.boundingBox();
    if (!resizeHandleBox) {
      throw new Error('Workspace panel resize handle has no geometry.');
    }
    const initialContentBox = await messageContent.boundingBox();
    if (!initialContentBox) {
      throw new Error('Expanded message content has no geometry.');
    }
    const resizeHandleCenterY = resizeHandleBox.y + resizeHandleBox.height / 2;
    await page.mouse.move(resizeHandleBox.x + resizeHandleBox.width / 2, resizeHandleCenterY);
    await page.mouse.down();
    await page.mouse.move(resizeHandleBox.x - 120, resizeHandleCenterY, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(async () => {
        const resizedContentBox = await messageContent.boundingBox();
        if (!resizedContentBox) {
          return null;
        }
        return {
          isNaturalHeight: await messageBody.evaluate((body) => {
            const inner = body.querySelector<HTMLElement>('.bs-expandable-message-content');
            if (!inner) {
              return false;
            }
            return (
              getComputedStyle(body).maxHeight === 'none' &&
              Math.abs(
                body.getBoundingClientRect().height - inner.getBoundingClientRect().height
              ) <= 1
            );
          }),
          widthChanged: Math.abs(resizedContentBox.width - initialContentBox.width) > 20,
        };
      })
      .toEqual({ isNaturalHeight: true, widthChanged: true });

    await longUserMessage.getByRole('button', { name: 'Show less' }).click();
    await expect(messageBody).toHaveCSS('max-height', '176px');
    const recollapsedGeometry = await messageBody.evaluate((body) => {
      const inner = body.querySelector<HTMLElement>('.bs-expandable-message-content');
      if (!inner) {
        throw new Error('Expandable message is missing its inner content element.');
      }
      return {
        bodyHeight: body.getBoundingClientRect().height,
        contentHeight: inner.getBoundingClientRect().height,
      };
    });
    expect(recollapsedGeometry.bodyHeight).toBeLessThan(recollapsedGeometry.contentHeight);

    // `exact: true` on every Send locator in this file: getByRole's name
    // match is a case-insensitive SUBSTRING by default, and while a run is
    // active the composer's running branch offers "Queue message to send
    // after this run" — a substring hit that silently queued the next turn as
    // a follow-up chip instead of waiting for Send to remount. The queue
    // flush then shrank the composer and unpinned stick-to-bottom, failing
    // the toBeDisabled below only on fast (warm-worker) runs (BST-1036).
    for (let turn = 2; turn <= 5; turn += 1) {
      await input.fill(`thread scroll turn ${turn}`);
      await composerShell.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(viewport.getByText(/Mock response from tests/i)).toHaveCount(turn, {
        timeout: 15_000,
      });
    }

    // BST-896: 10 messages (well past the 8 the old collapsed-history toggle
    // hid) and EVERY one of them still renders — no toggle, nothing hidden.
    await expect(page.getByTestId('assistant-history-toggle')).toHaveCount(0);
    await expect(longUserMessage).toBeVisible();

    // Sending pins the thread at the bottom, so the jump affordance is hidden.
    const scrollToBottom = page.getByTestId('assistant-scroll-to-bottom');
    await expect(scrollToBottom).toBeDisabled();

    const viewportOverflow = await viewport.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(viewportOverflow).toBeGreaterThan(0);

    // Scrolling up disengages auto-follow and offers the jump button …
    await viewport.evaluate((el) => {
      el.scrollTo({ behavior: 'instant', top: 0 });
    });
    await expect(scrollToBottom).toBeEnabled();

    // … clicking it returns to the latest message and hides itself again.
    await scrollToBottom.click();
    await expect(scrollToBottom).toBeDisabled();
    await expect
      .poll(async () =>
        viewport.evaluate((el) => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight))
      )
      .toBeLessThanOrEqual(1);
  });

  test('deletes assistant thread history without loading errors', async ({ page }) => {
    await expect(page.getByTestId('threads-panel')).toBeVisible();
    await page.getByTestId('new-agent-button').click();
    await expect(page.getByTestId('thread-row')).toHaveCount(2);

    const newestThread = page.getByTestId('thread-row').first();
    // Deletion moved into the row's "Thread actions" popover (#1661); the
    // Delete item (scoped to the open popover to avoid the group popover's
    // identically-named item) closes the popover and opens the inline row
    // confirm (aria-label "Confirm delete thread …") — BST-1035.
    await newestThread.getByRole('button', { name: /Thread actions/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Delete/ })
      .click();
    await page.getByRole('button', { name: /Confirm delete thread/i }).click();

    await expect(page.getByTestId('thread-row')).toHaveCount(1);
    await expect(page.getByText('Failed to load threads')).toHaveCount(0);
    await expect(page.getByText('Assistant threads failed to load')).toHaveCount(0);
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

    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (let index = 1; index <= 8; index += 1) {
      await newThreadButton.click();
      await expect(tabList.getByRole('tab')).toHaveCount(initialTabCount + index);
    }

    const scrollMetrics = await tabScroll.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(scrollMetrics.scrollWidth).toBeGreaterThan(scrollMetrics.clientWidth);
    await expect(scrollLeftButton).toBeEnabled();
    await expect(scrollRightButton).toBeDisabled();

    await tabScroll.evaluate((element) => {
      element.scrollTo({ behavior: 'instant', left: 0 });
    });
    await expect(scrollLeftButton).toBeDisabled();
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
