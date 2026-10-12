import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

const PROMPT_TEXT = 'Find relevant context';
// `brainstrike.retrieveContext` was deleted with the agent-side retrieval tools
// (BST-974, #2105); its cards were only ever fabricated by the renderer mock. A
// new thread runs on the agent host, so these cards come from a real context
// tool the host runs: reading a workspace file, scripted at the provider.
const TOOL = 'brainstrike.readWorkspaceFile';
const workspace = mkdtempSync(join(tmpdir(), 'bs-e2e-assistant-retrieval-'));
writeFileSync(join(workspace, 'context.txt'), 'const answer = 42;\n');

test.use({ electronEnv: { BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace } });
test.afterAll(() => {
  rmSync(workspace, { force: true, recursive: true });
});

async function openAssistantChat(window: Page): Promise<void> {
  const assistantChatCard = await ensureAssistantShellVisible(window);
  await expect(assistantChatCard).toBeVisible({ timeout: E2E_TIMEOUTS.cardVisibility });

  const loadingIndicator = window.getByText(/Loading assistant/i);
  if (await loadingIndicator.isVisible().catch(() => false)) {
    await loadingIndicator
      .waitFor({ state: 'hidden', timeout: E2E_TIMEOUTS.loadingIndicator })
      .catch(() => {
        console.warn('⚠️ Assistant UI chunk still loading after timeout');
      });
  }

  const chatPanel = window.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(chatPanel).toBeVisible({ timeout: E2E_TIMEOUTS.chatPanel });
}

async function sendPrompt(window: Page, prompt: string): Promise<void> {
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill(prompt);

  const sendBtn = window.getByRole('button', { exact: true, name: 'Send' });
  await expect(sendBtn).toBeVisible();
  await sendBtn.click();

  await expect(window.getByText(prompt).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
}

/** The run's turns call the context tool on `path`, then answer; other provider calls just answer. */
function scriptContextRead(modelProvider: ModelProviderShim, path: string, answer: string): void {
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? {
          finalText: answer,
          toolCall: { arguments: { path }, name: 'brainstrike_readWorkspaceFile' },
        }
      : { finalText: 'Context lookup' }
  );
}

test.describe('Assistant retrieval (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window);
  });

  test('shows retrieval tool event and response', async ({ modelProvider, window }) => {
    scriptContextRead(modelProvider, 'context.txt', 'Retrieved answer.');
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    await expect(window.getByText('Retrieved answer.').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    // Sync on the turn actually finishing. `aria-expanded` is no longer that
    // signal: since BST-1679 the group is collapsed at ALL times, running
    // included, so waiting for "false" resolves immediately and proves
    // nothing. `data-state` is what the trace publishes for the transition.
    await expect(window.getByTestId('assistant-activity-group').first()).toHaveAttribute(
      'data-state',
      'done',
      { timeout: E2E_TIMEOUTS.toolVisibility }
    );
    const summary = window.getByTestId('assistant-activity-summary').first();
    await summary.click();
    await expect(window.getByTestId('tool-fallback').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    // Scoped to the CARD: since BST-1679 the collapsed group header also names
    // the step, so an unscoped text query would pass on the header alone and
    // stop proving the card renders it.
    await expect(window.getByTestId('tool-fallback').first()).toContainText(TOOL, {
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    expect(modelProvider.refusals()).toEqual([]);
  });

  test('shows retrieval tool errors when execution fails', async ({ modelProvider, window }) => {
    // The tool guard's model- and user-facing text for a failed execution.
    const errorMessage = 'The tool did not complete successfully. Try another approach.';
    scriptContextRead(modelProvider, 'missing.txt', 'The context is unavailable.');
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    // Sync on the turn actually finishing. `aria-expanded` is no longer that
    // signal: since BST-1679 the group is collapsed at ALL times, running
    // included, so waiting for "false" resolves immediately and proves
    // nothing. `data-state` is what the trace publishes for the transition.
    await expect(window.getByTestId('assistant-activity-group').first()).toHaveAttribute(
      'data-state',
      'done',
      { timeout: E2E_TIMEOUTS.toolVisibility }
    );
    const summary = window.getByTestId('assistant-activity-summary').first();
    await summary.click();
    await expect(window.getByText(errorMessage).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    await expect(window.getByTestId('tool-fallback').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    // Scoped to the CARD: since BST-1679 the collapsed group header also names
    // the step, so an unscoped text query would pass on the header alone and
    // stop proving the card renders it.
    await expect(window.getByTestId('tool-fallback').first()).toContainText(TOOL, {
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    expect(modelProvider.refusals()).toEqual([]);
  });

  test('surfaces assistant stream failures', async ({ modelProvider, window }) => {
    const errorMessage = 'Network error while contacting assistant.';
    modelProvider.setScript(({ requestBody }) =>
      (requestBody as { stream?: unknown }).stream === true
        ? { finalText: '', streamError: errorMessage }
        : { finalText: 'Context lookup' }
    );
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    await expect(window.getByText(errorMessage).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
  });
});
