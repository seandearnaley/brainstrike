import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

const PROMPT_TEXT = 'find db files';
// A new thread runs on the agent host, so its tool card comes from a real
// internal tool the host runs, scripted at the provider. The retrieval tool
// these cards once showed was deleted with BST-974 (#2105).
const TOOL = 'brainstrike.readWorkspaceFile';
const workspace = mkdtempSync(join(tmpdir(), 'bs-e2e-tool-card-visuals-'));
writeFileSync(join(workspace, 'db-files.txt'), 'notes.db\n');

test.use({ electronEnv: { BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace } });
test.afterAll(() => {
  rmSync(workspace, { force: true, recursive: true });
});

// Mirrored from assistant-retrieval.desktop.test.ts so the spec drives the real
// desktop assistant in exactly the same way.
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

/** The run's turns read `path`, then answer; other provider calls just answer. */
function scriptRead(modelProvider: ModelProviderShim, path: string, answer: string): void {
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? {
          finalText: answer,
          toolCall: { arguments: { path }, name: 'brainstrike_readWorkspaceFile' },
        }
      : { finalText: 'Tool card check' }
  );
}

test.describe('Assistant tool card visuals (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window);
  });

  test('tool card is compact, tinted internal, and badge-free', async ({
    modelProvider,
    window,
  }) => {
    scriptRead(modelProvider, 'db-files.txt', 'Retrieved answer.');
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    await expect(window.getByText('Retrieved answer.').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    // See the note in assistant-retrieval.desktop.test.ts: the group is
    // collapsed at all times since BST-1679, so `data-state` — not
    // `aria-expanded` — is the turn-finished sync.
    await expect(window.getByTestId('assistant-activity-group').first()).toHaveAttribute(
      'data-state',
      'done',
      { timeout: E2E_TIMEOUTS.toolVisibility }
    );
    const summary = window.getByTestId('assistant-activity-summary').first();
    await summary.click();
    const toolCard = window.getByTestId('tool-fallback').first();
    await expect(toolCard).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    await expect(toolCard).toHaveAttribute('data-tool-category', 'internal');
    // The refreshed card no longer renders a visible status badge; the status is
    // conveyed by the rail icon (tooltip-only label), so "Completed" is absent.
    await expect(toolCard.getByText('Completed', { exact: true })).toHaveCount(0);

    await window.screenshot({ path: 'e2e-artifacts/tool-card-success.png' });
  });

  test('tool-error card renders the error state', async ({ modelProvider, window }) => {
    // The tool guard's model- and user-facing text for a failed execution.
    const errorMessage = 'The tool did not complete successfully. Try another approach.';
    scriptRead(modelProvider, 'missing-db-files.txt', 'The file is missing.');
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    const activityGroup = window.getByTestId('assistant-activity-group').first();
    await expect(activityGroup).toHaveAttribute('data-state', 'done', {
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    const summary = window.getByTestId('assistant-activity-summary').first();
    await expect(summary).toContainText('1 failed');
    // The resting headline is the verb summary now (BST-1679), not the fixed
    // word "Worked": the file read reads "Read". `data-state` (synced above) is
    // the state sync; the text proves which step it summarizes.
    await expect(summary).toContainText('Read');
    await summary.click();
    const toolCard = window.getByTestId('tool-fallback').first();
    await expect(toolCard).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    await expect(toolCard).toContainText(TOOL);
    // Category classification is independent of the failure state; an internal
    // tool stays tinted as internal even when its execution errors.
    await expect(toolCard).toHaveAttribute('data-tool-category', 'internal');
    await expect(toolCard.getByText(errorMessage).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });

    await window.screenshot({ path: 'e2e-artifacts/tool-card-error.png' });
  });
});
