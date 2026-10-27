// The agent browses only in its own tab, behind the egress proxy (BST-1238,
// ADR-0025), in the real app. A scripted model calls browser navigate on a
// host that cannot resolve (RFC 2606 `.invalid`), which needs no network: the
// call forks the real egress utility, routes the agent partition, answers the
// proxy credential and gets the proxy's refusal back as a typed failure. The
// user's own tab is never touched, and only the agent partition is proxied,
// loopback included. The first call to the host asks a person (BST-1178),
// answered here with Allow once. The agent's page opens among its
// conversation's workspace tabs (BST-1271).
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { openBrowserPage, startConversation, visibleAddress } from './utils/browser-page-helpers';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';

const NAVIGATE = 'brainstrike_browserNavigate';
const UNRESOLVABLE = 'bst-1238-egress-proof.invalid';
const USER_PAGE = `data:text/html,${encodeURIComponent('<title>User page</title><p>User page</p>')}`;

function streaming(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'stream' in value && value.stream === true;
}

/** Live pages in one browser partition. */
function countPartitionPages(app: ElectronApplication, partition: string): Promise<number> {
  return app.evaluate(({ session, webContents }, name) => {
    const target = session.fromPartition(name);
    return webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed() && contents.session === target).length;
  }, partition);
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

  // The person's own tab, opened from the workspace of the conversation the
  // first send starts.
  await ensureAssistantShellVisible(window);
  await startConversation(window, modelProvider, 'Get ready to browse.');
  const userTab = await openBrowserPage(window, USER_PAGE, 'User page');
  await expect(window.getByTestId('browser-page-agent').filter({ visible: true })).toHaveCount(0);

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
  await panel
    .getByRole('group', { name: `Open https://${UNRESOLVABLE}` })
    .getByRole('button', { name: 'Allow once' })
    .click({ timeout: 60_000 });
  await expect(panel.getByText('Agent browsing proof complete.', { exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // The proxy refused the host as unresolved, and that reached the model as a
  // failed load naming it: the utility ran, the partition routed through it,
  // and the credential was answered (an unanswered challenge names nothing).
  const requests = JSON.stringify(modelProvider.requests());
  expect(requests).toContain('load_failed');
  expect(requests).toContain(`agent browsing could not resolve ${UNRESOLVABLE}`);

  // The agent's page opened in a tab of its own in this conversation, and
  // was selected as it opened, with the person watching.
  const app = (await electron.ensureContext()).app;
  await expect.poll(() => countPartitionPages(app, 'browser-pane-agent')).toBe(1);
  await expect(window.getByTestId('browser-page-agent').filter({ visible: true })).toBeVisible();
  // The person's tab is still theirs, on their page.
  await expect(userTab).toHaveAttribute('title', USER_PAGE);
  await userTab.click();
  await expect(visibleAddress(window)).toHaveValue(USER_PAGE);
  await expect(window.getByTestId('browser-page-agent').filter({ visible: true })).toHaveCount(0);

  // Only the agent partition is proxied, and loopback goes through the proxy too.
  for (const url of ['http://127.0.0.1:9/', 'http://localhost:9/', 'https://example.com/']) {
    const proxies = await resolveProxies(app, url);
    expect(proxies.agent, url).toMatch(/^PROXY 127\.0\.0\.1:\d+$/u);
    expect(proxies.user, url).toBe('DIRECT');
  }
});
