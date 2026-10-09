import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

const SERVER = 'probe';

async function openTools(page: Page): Promise<void> {
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/AI Tools/i, 'ai-tools');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
}

test('Settings reads MCP server status from the agent host and retries a failed server there', async ({
  electron,
  window: page,
}) => {
  test.setTimeout(240_000);
  const server = await startStatefulMcpHostServer();
  try {
    const userDataDir = electron.getUserDataDir();

    // The host connects a server saved from Settings and reports its status.
    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/AI Tools/i, 'ai-tools');
    await page.getByRole('tab', { name: 'MCP Config' }).click();
    const editor = page.getByTestId('mcp-config-editor');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    const config = {
      servers: [
        { name: SERVER, protocol: 'legacy', transport: 'streamable-http', url: server.url },
      ],
    };
    await editor.fill(JSON.stringify(config));
    await page.getByTestId('mcp-config-save').click();
    await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
    expect(
      JSON.parse(await readFile(path.join(userDataDir, 'mcp', 'mcp.config.json'), 'utf8'))
    ).toEqual(config);
    await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
    const row = page.getByTestId(`mcp-server-row-${SERVER}`);
    await expect(row).toContainText('connected', { timeout: 60_000 });

    // Restart against the fixture's spent session: the reconnect fails, and the
    // host's status says so with the retry its control offers.
    await electron.closeForStateSeeding();
    const restarted = (await electron.restart()).window;
    await openTools(restarted);
    const failedRow = restarted.getByTestId(`mcp-server-row-${SERVER}`);
    await expect(failedRow).toContainText('error', { timeout: 60_000 });
    const retry = restarted.getByTestId(`mcp-retry-${SERVER}`);
    await expect(retry).toBeVisible();

    // A fresh session, then Retry: the host runs the control and the pushed
    // status flips the row to connected with the server's tool.
    await server.resetSession();
    const before = server.requests.length;
    await retry.click();
    await expect(failedRow).toContainText('connected', { timeout: 60_000 });
    await expect(restarted.getByTestId(`mcp-retry-${SERVER}`)).toHaveCount(0);
    expect(server.requests.length).toBeGreaterThan(before);
  } finally {
    await server.close();
  }
});
