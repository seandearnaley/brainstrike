import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { E2E_TIMEOUTS } from './utils/timeouts';

const DOMAINS = ['pypi.org', '*.githubusercontent.com'];
const FINAL = 'Network decision recorded.';
const CALL = {
  arguments: { allowedDomains: DOMAINS, code: 'print("network check")' },
  name: 'brainstrike_runPython',
};

/** run_python asks for its domains under an `ask` policy; returns the panel once the first card shows. */
async function askForNetwork(
  window: Page,
  modelProvider: ModelProviderShim,
  calls: number
): Promise<Locator> {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  await window.getByTestId('permission-policy-execute').selectOption('ask');
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? {
          finalText: FINAL,
          // Hosted discovery defers run_python: the model loads it first.
          toolCallStages: [
            [{ arguments: { toolName: CALL.name }, name: 'load_tool' }],
            ...Array.from({ length: calls }, () => [CALL]),
          ],
        }
      : { finalText: 'Network consent check' }
  );
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Use Python to inspect a package index.');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByTestId('committed-network-consent')).toBeVisible({
    timeout: E2E_TIMEOUTS.toolVisibility,
  });
  return panel;
}

/** The one card shows the code-execution facts and each requested domain. */
async function expectNetworkCard(card: Locator): Promise<void> {
  await expect(card.getByTestId('approval-run-python-write')).toContainText('inside');
  await expect(card.getByTestId('approval-run-python-sandbox')).toBeVisible();
  for (const domain of DOMAINS) {
    await expect(card.getByTestId(`run-python-network-domain-${domain}`)).toBeVisible();
  }
}

async function tickAll(card: Locator): Promise<void> {
  for (const domain of DOMAINS) {
    await card.getByTestId(`run-python-network-domain-${domain}`).click();
  }
}

/** Every run_python result the model was given, as the provider received them. */
function providerMessages(modelProvider: ModelProviderShim): string {
  return JSON.stringify(modelProvider.requests().map(({ messages }) => messages));
}

test("don't allow settles the call as network_denied without running it", async ({
  modelProvider,
  window,
}) => {
  const panel = await askForNetwork(window, modelProvider, 1);
  const card = panel.getByTestId('committed-network-consent');
  await expectNetworkCard(card);
  await card.getByTestId('run-python-network-deny').click();

  await expect(panel.getByText(FINAL).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(panel.getByTestId('committed-network-consent')).toHaveCount(0);
  expect(providerMessages(modelProvider)).toContain('network_denied');
  expect(modelProvider.refusals()).toEqual([]);
});

test('allowing with the session grant approves the run once; the next networked call asks again', async ({
  modelProvider,
  window,
}) => {
  const panel = await askForNetwork(window, modelProvider, 2);
  const first = panel.getByTestId('committed-network-consent');
  await expectNetworkCard(first);
  const sessionGrant = first.getByTestId('run-python-network-grant-session');
  await expect(sessionGrant).toHaveAttribute('aria-disabled', 'true');
  await tickAll(first);
  await expect(sessionGrant).not.toHaveAttribute('aria-disabled');
  await sessionGrant.click();

  // The grant answered the run approval only: once the first card resolves, the
  // second call's card asks for its network again and offers no grant.
  await expect(panel.getByTestId('run-python-network-grant-session')).toHaveCount(0, {
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  const second = panel.getByTestId('committed-network-consent');
  await expect(second).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
  await expectNetworkCard(second);
  await expect(second.getByTestId('run-python-network-grant-tool')).toHaveCount(0);
  await tickAll(second);
  await second.getByTestId('run-python-network-allow').click();

  await expect(panel.getByText(FINAL).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  // Both calls passed the network gate: neither came back refused.
  const messages = providerMessages(modelProvider);
  expect(messages).not.toContain('network_denied');
  expect(messages).not.toContain('network_confirmation_unavailable');
  expect(messages).not.toContain('resume_unrecognized');
  expect(modelProvider.refusals()).toEqual([]);
});
