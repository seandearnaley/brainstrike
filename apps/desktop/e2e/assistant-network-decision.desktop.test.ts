import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAssistantMockRequests, setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const PROMPT_TEXT = 'Use Python to inspect a package index';

async function openAssistantChat(window: Page): Promise<void> {
  const assistantChatCard = await ensureAssistantShellVisible(window);
  await expect(assistantChatCard).toBeVisible({ timeout: E2E_TIMEOUTS.cardVisibility });

  const loadingIndicator = window.getByText(/Loading assistant/i);
  if (await loadingIndicator.isVisible().catch(() => false)) {
    await loadingIndicator.waitFor({
      state: 'hidden',
      timeout: E2E_TIMEOUTS.loadingIndicator,
    });
  }

  await expect(window.getByTestId('chat-panel')).toBeVisible({
    timeout: E2E_TIMEOUTS.chatPanel,
  });
}

async function sendPrompt(window: Page): Promise<void> {
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill(PROMPT_TEXT);
  await window.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(window.getByText(PROMPT_TEXT).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
}

interface AssistantRequestBody {
  readonly messages?: unknown[];
  readonly runConfig?: {
    readonly custom?: {
      readonly brainstrikeToolSuspend?: {
        readonly resumeData?: { readonly action?: string };
      };
    };
  };
}

interface NetworkDecisionCase {
  readonly action: 'allow' | 'deny';
  readonly chip: string;
  readonly summary: string;
}

async function runNetworkDecisionCase(window: Page, decision: NetworkDecisionCase): Promise<void> {
  await setupAssistantMock(window, { variant: 'network-suspend' });
  await openAssistantChat(window);
  await sendPrompt(window);

  const notice = window.getByTestId('assistant-run-python-network-notice');
  await expect(notice).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
  await expect(notice.getByText('pypi.org')).toBeVisible();
  await expect(notice.getByText('*.githubusercontent.com')).toBeVisible();

  if (decision.action === 'allow') {
    await window.getByTestId('run-python-network-domain-pypi.org').click();
    await window.getByTestId('run-python-network-domain-*.githubusercontent.com').click();
    await window.getByTestId('run-python-network-allow').click();
  } else {
    await window.getByTestId('run-python-network-deny').click();
  }

  await expect(window.getByTestId('approval-action-chip').getByText(decision.chip)).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(window.getByText('Network decision resumed.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });

  // The original domain card remains in the thread and the bookkeeping
  // message does not acquire the ordinary user-message bubble treatment.
  await expect(notice).toBeVisible();
  await expect(notice.getByText('pypi.org')).toBeVisible();
  await expect(notice.getByText('*.githubusercontent.com')).toBeVisible();
  await expect(
    window.getByTestId('assistant-user-message-content').filter({ hasText: decision.summary })
  ).toHaveCount(0);

  const requests = (await readAssistantMockRequests(window)) as AssistantRequestBody[];
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0]?.messages)).toContain(PROMPT_TEXT);
  expect(requests[1]?.messages).toEqual([]);
  expect(requests[1]?.runConfig?.custom?.brainstrikeToolSuspend?.resumeData).toEqual({
    action: decision.action,
  });
  expect(JSON.stringify(requests[1])).not.toContain(decision.summary);
}

test.describe('run_python network decision chips (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
  });

  test('allow keeps the domain card, uses a chip, and leaves model context unchanged', async ({
    window,
  }) => {
    await runNetworkDecisionCase(window, {
      action: 'allow',
      chip: 'Allowed internet access',
      summary: 'You allowed 2 domains.',
    });
  });

  test('deny keeps the domain card, uses a chip, and leaves model context unchanged', async ({
    window,
  }) => {
    await runNetworkDecisionCase(window, {
      action: 'deny',
      chip: "Didn't allow internet access",
      summary: "You didn't allow internet access.",
    });
  });
});
