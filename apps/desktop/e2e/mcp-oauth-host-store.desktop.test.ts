import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

const SERVER_ID = 'oauth';

interface OAuthFixture {
  close(): Promise<{ readonly clean: boolean }>;
  readonly manifest: { readonly url: string };
}

/** The lab's loopback OAuth MCP server: its authorize endpoint redirects to the client's callback. */
async function startOAuthFixture(): Promise<OAuthFixture> {
  const lab = (await import(
    pathToFileURL(path.resolve(process.cwd(), '../../packages/mcp-test-lab/dist/index.js')).href
  )) as {
    startPackagedCoreFixture(id: 'oauth-reference'): Promise<OAuthFixture>;
  };
  return await lab.startPackagedCoreFixture('oauth-reference');
}

/** After the grant is stored, no flow may open a browser: Main's opener refuses. */
async function refuseBrowser(electron: ElectronHarness): Promise<void> {
  const { app } = await electron.ensureContext();
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (): Promise<void> => {
      throw new Error('No browser may open once the grant is stored');
    };
  });
}

/**
 * Stands in for the OS browser in Main, where `shell.openExternal` hands it the
 * authorization URL: follow the authorization redirect to the host's loopback callback.
 */
async function installBrowserStandIn(electron: ElectronHarness): Promise<void> {
  const { app } = await electron.ensureContext();
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string): Promise<void> => {
      const authorization = await fetch(url, { redirect: 'manual' });
      const callback = authorization.headers.get('location');
      if (authorization.status !== 302 || callback === null) {
        throw new Error(`Authorization did not redirect: ${authorization.status}`);
      }
      const response = await fetch(callback);
      if (!response.ok) {
        throw new Error(`Authorization callback failed: ${response.status}`);
      }
    };
  });
}

async function openTools(page: Page): Promise<void> {
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/AI Tools/i, 'ai-tools');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
}

async function configureServer(page: Page, url: string): Promise<void> {
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/AI Tools/i, 'ai-tools');
  await page.getByRole('tab', { name: 'MCP Config' }).click();
  const editor = page.getByTestId('mcp-config-editor');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.fill(
    JSON.stringify({
      servers: [
        {
          auth: { type: 'oauth-user' },
          name: SERVER_ID,
          protocol: '2026-07-28',
          startup: 'authentication-required',
          transport: 'streamable-http',
          url,
        },
      ],
    })
  );
  await page.getByTestId('mcp-config-save').click();
  await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
}

/** The isolated profile's credential file, which the agent host owns and writes. */
async function readOAuthRecords(userDataDir: string): Promise<Record<string, string>> {
  const file: unknown = JSON.parse(
    await readFile(path.join(userDataDir, 'brainstrike-credentials.json'), 'utf8')
  );
  if (typeof file !== 'object' || file === null || !('records' in file)) {
    throw new Error('The profile credential file has no records section');
  }
  return file.records as Record<string, string>;
}

test('the agent host stores an MCP OAuth grant in its profile store and reconnects with it after a restart', async ({
  electron,
  window: page,
}) => {
  test.setTimeout(240_000);
  const fixture = await startOAuthFixture();
  try {
    await installBrowserStandIn(electron);
    await configureServer(page, fixture.manifest.url);
    const row = page.getByTestId(`mcp-server-row-${SERVER_ID}`);
    await page
      .getByRole('button', { exact: true, name: `Connect ${SERVER_ID}` })
      .click({ timeout: 60_000 });
    await expect(row).toContainText(/Connected/i, { timeout: 60_000 });
    await expect(row).toContainText('OAuth credentials stored');

    // The grant sits in the host's profile store under one 64-hex identity account;
    // Main's retired safeStorage file is never written.
    const userDataDir = electron.getUserDataDir();
    const records = await readOAuthRecords(userDataDir);
    expect(Object.keys(records)).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/u)]);
    const [grant] = Object.values(records);
    expect(Object.values(JSON.parse(grant ?? '{}') as Record<string, unknown>)).toEqual([
      expect.objectContaining({
        tokens: expect.objectContaining({ access_token: expect.any(String) }),
      }),
    ]);
    await expect(access(path.join(userDataDir, 'brainstrike-mcp-oauth.json'))).rejects.toThrow();

    // A restarted host reads the stored grant and reconnects without another Connect.
    const restarted = (await electron.restart()).window;
    await refuseBrowser(electron);
    await openTools(restarted);
    const restartedRow = restarted.getByTestId(`mcp-server-row-${SERVER_ID}`);
    await expect(restartedRow).toContainText(/Connected/i, { timeout: 60_000 });
    await expect(restartedRow).toContainText('OAuth credentials stored');
    await expect(
      restarted.getByRole('button', { exact: true, name: `Connect ${SERVER_ID}` })
    ).toHaveCount(0);
    expect(Object.keys(await readOAuthRecords(userDataDir))).toEqual(Object.keys(records));
  } finally {
    await fixture.close();
  }
});
