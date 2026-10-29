import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import { createSecretsMcpBearerCredentialWriter } from '@brainstrike/host-capabilities/mcp/bearer-credential';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

const SERVER = 'probe';
const TOOL = `${SERVER}.host_lifecycle_probe`;
const TOKEN = 'e2e-bearer-token-5a';

/**
 * The agent host reads MCP bearer references from the profile credential file
 * (an isolated run's store). The token is filed under the reference by the
 * host's own bearer credential writer over that file store, so the file is
 * private exactly as the host requires: POSIX mode 0600, or on Windows a
 * protected owner-only DACL that a plain `writeFile` with `mode` never sets.
 */
async function storeBearerCredential(userDataDir: string, id: string): Promise<void> {
  const credentials = createHostCredentials({
    selection: { kind: 'file', path: path.join(userDataDir, 'brainstrike-credentials.json') },
  });
  try {
    const reference = await createSecretsMcpBearerCredentialWriter(
      credentials.secrets(),
      () => id
    ).create(TOKEN);
    expect(reference).toEqual({ id, store: 'mcp-credentials' });
  } finally {
    await credentials.close();
  }
}

async function openTools(page: Page): Promise<void> {
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/AI Tools/iu, 'ai-tools');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
}

/** The server's tool row, once discovery has listed it. */
async function toolToggle(page: Page) {
  await expect(page.getByTestId(`mcp-server-row-${SERVER}`)).toContainText(/Connected/iu, {
    timeout: 60_000,
  });
  const trigger = page.getByTestId(`tool-group-trigger-mcp-${SERVER}`);
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  // A group discovered after the list mounted starts collapsed.
  if ((await trigger.getAttribute('data-state')) !== 'open') {
    await trigger.click();
  }
  const toggle = page.getByTestId(`tool-toggle-${TOOL}`);
  await expect(toggle).toBeVisible();
  return toggle;
}

test('the agent host owns MCP settings: saved config, discovered tools and a disabled tool survive a restart', async ({
  electron,
  window: page,
}) => {
  test.setTimeout(240_000);
  const server = await startStatefulMcpHostServer();
  try {
    const userDataDir = electron.getUserDataDir();
    const credential = randomUUID();
    await storeBearerCredential(userDataDir, credential);

    // 1. Edit the config in Settings: the host saves the profile's config file.
    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/AI Tools/iu, 'ai-tools');
    await page.getByRole('tab', { name: 'MCP Config' }).click();
    const editor = page.getByTestId('mcp-config-editor');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    const config = {
      servers: [
        {
          auth: { credential: { id: credential, store: 'mcp-credentials' }, type: 'bearer' },
          name: SERVER,
          protocol: 'legacy',
          transport: 'streamable-http',
          url: server.url,
        },
      ],
    };
    await editor.fill(JSON.stringify(config));
    await page.getByTestId('mcp-config-save').click();
    await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
    expect(
      JSON.parse(await readFile(path.join(userDataDir, 'mcp', 'mcp.config.json'), 'utf8'))
    ).toEqual(config);

    // 2. The host discovers the server's tools over the bearer reference.
    await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
    const toggle = await toolToggle(page);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(server.requests.length).toBeGreaterThan(0);
    expect(new Set(server.requests.map(({ authorization }) => authorization))).toEqual(
      new Set([`Bearer ${TOKEN}`])
    );

    // 3. Disable the tool: the host saves the choice in the profile's preferences.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(async () =>
        JSON.parse(
          await readFile(path.join(userDataDir, 'mcp', 'tool-preferences.json'), 'utf8').catch(
            () => '{}'
          )
        )
      )
      .toMatchObject({ disabledTools: [TOOL] });

    // 4. Restart: the bearer-referenced server reconnects and the tool stays disabled.
    // The fixture's session is fixed: a fresh one waits once the old client is gone.
    await electron.closeForStateSeeding();
    await server.resetSession();
    const before = server.requests.length;
    const restarted = (await electron.restart()).window;
    await openTools(restarted);
    const restartedToggle = await toolToggle(restarted);
    await expect(restartedToggle).toHaveAttribute('aria-checked', 'false');
    const reconnect = server.requests.slice(before);
    expect(reconnect.length).toBeGreaterThan(0);
    expect(new Set(reconnect.map(({ authorization }) => authorization))).toEqual(
      new Set([`Bearer ${TOKEN}`])
    );
  } finally {
    await server.close();
  }
});
