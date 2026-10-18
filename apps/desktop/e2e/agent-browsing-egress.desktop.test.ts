// The agent browses only in its own tab, behind the egress proxy (BST-1238,
// ADR-0025), in the real app. A scripted model calls browser navigate on a
// host that cannot resolve (RFC 2606 `.invalid`), which needs no network: the
// call forks the real egress utility, routes the agent partition, answers the
// proxy credential and gets the proxy's refusal back as a typed failure. The
// user's own tab is never touched, and only the agent partition is proxied,
// loopback included.
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';

const NAVIGATE = 'brainstrike_browserNavigate';
const UNRESOLVABLE = 'bst-1238-egress-proof.invalid';
const USER_PAGE = `data:text/html,${encodeURIComponent('<title>User page</title><p>User page</p>')}`;

function streaming(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'stream' in value && value.stream === true;
}

async function openBrowserRoute(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { exact: true, name: 'Main navigation' })
    .getByRole('button', { exact: true, name: 'Browser' })
    .click({ timeout: 15_000 });
  await expect(page.getByTestId('browser-pane')).toBeVisible({ timeout: 15_000 });
}

/** The proxy Chromium would use for `url` in each pane partition. */
function resolveProxies(
  app: ElectronApplication,
  url: string
): Promise<{ readonly agent: string; readonly user: string }> {
  return app.evaluate(
    async ({ session }, target) => ({
      agent: await session.fromPartition('browser-pane-agent').resolveProxy(target),
      user: await session.fromPartition('persist:browser-pane').resolveProxy(target),
    }),
    url
  );
}

test('the agent opens its own proxied tab and never drives the user tab (BST-1238)', async ({
  electron,
  modelProvider,
  window,
}) => {
  test.setTimeout(180_000);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);

  // The user's own tab, opened from the pane.
  await openBrowserRoute(window);
  await window.getByTestId('browser-new-tab').click();
  const address = window.getByTestId('browser-url-input');
  await expect(address).toHaveValue('about:blank', { timeout: 15_000 });
  await address.fill(USER_PAGE);
  await address.press('Enter');
  const userTab = window.getByRole('tab', { name: 'User page' });
  await expect(userTab).toHaveAttribute('data-tab-owner', 'user', { timeout: 15_000 });

  modelProvider.setScript(({ requestBody }) =>
    streaming(requestBody)
      ? {
          finalText: 'Agent browsing proof complete.',
          toolCallStages: [
            [{ arguments: { toolNames: [NAVIGATE] }, name: 'load_tool' }],
            [{ arguments: { url: `https://${UNRESOLVABLE}/` }, name: NAVIGATE }],
          ],
        }
      : { finalText: 'Agent browsing proof' }
  );
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  await panel.getByRole('textbox', { name: 'Message input' }).fill('Open the proof page.');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText('Agent browsing proof complete.', { exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // The proxy refused the host as unresolved, and that reached the model as a
  // failed load naming it: the utility ran, the partition routed through it,
  // and the credential was answered (an unanswered challenge names nothing).
  const requests = JSON.stringify(modelProvider.requests());
  expect(requests).toContain('load_failed');
  expect(requests).toContain(`agent browsing could not resolve ${UNRESOLVABLE}`);

  await openBrowserRoute(window);
  const agentTabs = window.locator('[role="tab"][data-tab-owner="agent"]');
  await expect(agentTabs).toHaveCount(1);
  await expect(agentTabs.first()).toHaveAttribute('title', /^Agent tab/u);
  // The user's tab is still theirs, on their page.
  await expect(userTab).toHaveAttribute('data-tab-owner', 'user');
  await expect(userTab).toHaveAttribute('title', USER_PAGE);

  // Only the agent partition is proxied, and loopback goes through the proxy too.
  const app = (await electron.ensureContext()).app;
  for (const url of ['http://127.0.0.1:9/', 'http://localhost:9/', 'https://example.com/']) {
    const proxies = await resolveProxies(app, url);
    expect(proxies.agent, url).toMatch(/^PROXY 127\.0\.0\.1:\d+$/u);
    expect(proxies.user, url).toBe('DIRECT');
  }
});
