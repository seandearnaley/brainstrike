// The agent asks a person before it opens each site (BST-1178), in the real
// app. A scripted model opens two pages of one site and then another site:
// Always allow on the first site lets its second page open unasked, Don't
// allow on the other reaches the model as a final refusal, and Settings →
// Permissions lists both answers and removes one. The hosts are RFC 2606
// `.invalid`, so no network is needed: an allowed call reaches the egress proxy
// and fails as an unresolved load. A second test opens a dev server on this
// machine: a loopback origin opens only once approved, and only at its port.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';

const NAVIGATE = 'brainstrike_browserNavigate';
const ALLOWED = 'bst-1178-allowed.invalid';
const DENIED = 'bst-1178-denied.invalid';
const FINAL = 'Origin consent proof complete.';

function streaming(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'stream' in value && value.stream === true;
}

test('the agent asks once per site, and Settings lists and removes the saved answers (BST-1178)', async ({
  modelProvider,
  window,
}) => {
  test.setTimeout(180_000);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript(({ requestBody }) =>
    streaming(requestBody)
      ? {
          finalText: FINAL,
          toolCallStages: [
            [{ arguments: { toolNames: [NAVIGATE] }, name: 'load_tool' }],
            [{ arguments: { url: `https://${ALLOWED}/first` }, name: NAVIGATE }],
            [{ arguments: { url: `https://${ALLOWED}/second` }, name: NAVIGATE }],
            [{ arguments: { url: `https://${DENIED}/` }, name: NAVIGATE }],
          ],
        }
      : { finalText: 'Origin consent proof' }
  );
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  await panel.getByRole('textbox', { name: 'Message input' }).fill('Open the proof pages.');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();

  const allowedCard = panel.getByRole('group', { name: `Open https://${ALLOWED}` });
  await expect(allowedCard.getByTestId('committed-origin-consent-origin')).toHaveText(
    `https://${ALLOWED}`,
    { timeout: 60_000 }
  );
  // A public site carries no local-server note.
  await expect(allowedCard.getByTestId('committed-origin-consent-local')).toHaveCount(0);
  await allowedCard.getByRole('button', { name: 'Always allow' }).click();

  // The stages run in order: the other site's card shows only once the saved
  // site's second page was opened, and nothing asked about it.
  const deniedCard = panel.getByRole('group', { name: `Open https://${DENIED}` });
  await expect(deniedCard).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByTestId('committed-origin-consent')).toHaveCount(1);
  await deniedCard.getByRole('button', { name: "Don't allow" }).click();
  await expect(panel.getByText(FINAL, { exact: true })).toBeVisible({ timeout: 60_000 });

  // The allowed pages reached the egress proxy; the denied one never ran, and
  // the model read why.
  const requests = JSON.stringify(modelProvider.requests());
  expect(requests).toContain(`agent browsing could not resolve ${ALLOWED}`);
  expect(requests).toContain(`The user doesn't allow opening https://${DENIED}.`);
  expect(requests).not.toContain(`agent browsing could not resolve ${DENIED}`);

  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/iu, 'permissions');
  const saved = window.getByTestId('saved-browser-origins');
  await expect(saved.getByTestId(`saved-browser-origin-https://${ALLOWED}`)).toContainText(
    'Always allowed'
  );
  await expect(saved.getByTestId(`saved-browser-origin-https://${DENIED}`)).toContainText(
    'Not allowed'
  );
  await saved.getByRole('button', { name: `Remove https://${DENIED}` }).click();
  await expect(saved.getByTestId(`saved-browser-origin-https://${DENIED}`)).toHaveCount(0);
  await expect(saved.getByTestId(`saved-browser-origin-https://${ALLOWED}`)).toBeVisible();
});

test('the agent opens an approved localhost dev server, at its port only (BST-1178)', async ({
  modelProvider,
  window,
}) => {
  test.setTimeout(180_000);
  const server = createServer((_request, response) => {
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<title>BST-1178 dev server</title><p>dev page body</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://localhost:${port}`;
  try {
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window);
    modelProvider.setScript(({ requestBody }) =>
      streaming(requestBody)
        ? {
            finalText: FINAL,
            toolCallStages: [
              [{ arguments: { toolNames: [NAVIGATE] }, name: 'load_tool' }],
              [{ arguments: { url: `${origin}/` }, name: NAVIGATE }],
            ],
          }
        : { finalText: 'Origin consent proof' }
    );
    await ensureAssistantShellVisible(window);
    const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
    await panel.getByRole('textbox', { name: 'Message input' }).fill('Open my dev server.');
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();

    const card = panel.getByRole('group', { name: `Open ${origin}` });
    await expect(card.getByTestId('committed-origin-consent-local')).toBeVisible({
      timeout: 60_000,
    });
    await card.getByRole('button', { name: 'Allow once' }).click();
    await expect(panel.getByText(FINAL, { exact: true })).toBeVisible({ timeout: 60_000 });

    // The approved dev server loaded through the egress proxy: its title can
    // only come from the page itself.
    const requests = JSON.stringify(modelProvider.requests());
    expect(requests).toContain('BST-1178 dev server');
    expect(requests).toContain(`${origin}/`);
  } finally {
    server.close();
  }
});
