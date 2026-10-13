import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import {
  MCP_APP_FIXTURE_SERVER as SERVER,
  startMcpAppFixture,
  MCP_APP_FIXTURE_TOOL as TOOL,
} from './utils/mcp-app-fixture';

const FINAL_TEXT = 'The counter app is open.';
const API_KEY = 'test-key-host-mcp-app';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function configureServer(page: Page, url: string): Promise<void> {
  await new HomePage(page).openSettings();
  const settings = new SettingsPage(page);
  await settings.openCategory(/AI Tools/i, 'ai-tools');
  await page.getByRole('tab', { name: 'MCP Config' }).click();
  const editor = page.getByTestId('mcp-config-editor');
  await expect(editor).toBeVisible();
  await editor.fill(
    JSON.stringify({
      servers: [{ name: SERVER, protocol: 'legacy', transport: 'streamable-http', url }],
    })
  );
  await page.getByTestId('mcp-config-save').click();
  await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
  await expect(page.getByTestId(`mcp-server-row-${SERVER}`)).toContainText(/Connected/i, {
    timeout: 60_000,
  });
  // MCP tools ask: the model's call and the app's call meet the same policy.
  await settings.openCategory(/Permissions/i, 'permissions');
  await page.getByTestId('permission-policy-mcp').selectOption('ask');
  await page.keyboard.press('Escape');
}

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

test("an MCP App's tool call on a host thread is admitted by the host's policy and approved", async ({
  electron,
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(300_000);
  const server = await startMcpAppFixture();
  try {
    await configureServer(page, server.url);
    await enableModel(page);
    // Hosted discovery defers MCP tools: the shim loads the tool, then calls it.
    modelProvider.setScript((request) =>
      request.toolNames.includes('load_tool')
        ? {
            deferredTool: true,
            finalText: FINAL_TEXT,
            toolCall: { arguments: { source: 'model' }, name: `${SERVER}_${TOOL}` },
          }
        : { finalText: `No load_tool offered: ${request.toolNames.join(', ')}` }
    );
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Open the counter.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    const diagnose = async (error: unknown): Promise<never> => {
      await testInfo.attach('host-mcp-app-diagnostic', {
        body: JSON.stringify(
          {
            calls: server.calls(),
            host: await readAgentHostLog(electron.getUserDataDir()).catch(String),
            region: await region.innerText().catch(() => '<unavailable>'),
            transcript: modelProvider.transcript(),
          },
          null,
          2
        ),
        contentType: 'application/json',
      });
      throw error;
    };
    // The model's call asks under the policy and runs once approved.
    await region
      .getByRole('button', { exact: true, name: `Approve ${SERVER}.${TOOL}` })
      .click({ timeout: 90_000 })
      .catch(diagnose);
    await expect(region.getByText(FINAL_TEXT)).toBeVisible({ timeout: 60_000 });
    expect(server.calls()).toEqual(['model']);

    // Its result mounts the app, whose own call asks the same policy before anything runs.
    const allow = region.getByRole('button', { name: `Allow ${TOOL} once` });
    await expect(allow).toBeVisible({ timeout: 60_000 }).catch(diagnose);
    expect(server.calls()).toEqual(['model']);
    await allow.click();

    // Approved, the host runs it on the app's server and the app shows the result.
    await expect.poll(() => server.calls(), { timeout: 30_000 }).toEqual(['model', 'app']);
    const app = region
      .frameLocator(`iframe[title="${TOOL} app"]`)
      .frameLocator('iframe')
      .locator('body');
    await expect(app).toHaveText('App call returned: count 2', { timeout: 30_000 });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await server.close();
  }
});
