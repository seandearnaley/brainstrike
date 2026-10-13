import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

interface ReferenceAppFixture {
  close(): Promise<void>;
  readonly url: string;
}

interface ReferenceAppFixtureModule {
  startReferenceElicitationAppFixture(app: {
    document: string;
    resourceUri: `ui://${string}`;
  }): Promise<ReferenceAppFixture>;
}

const SERVER = 'reference';
const TOOL = 'elicit_confirm';
const MODEL_PAYLOAD = 'from-model';
const PAYLOAD = 'from-app';
const FINAL_TEXT = 'The reference app is open.';
const API_KEY = 'test-key-mcp-app-elicitation';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';

/**
 * The app initializes (retrying until the host's frame bridge answers), then
 * calls the tool that mounted it, the reference `elicit_confirm`, and shows
 * the outcome.
 */
const APP_DOCUMENT = `<!doctype html><body>Starting</body><script>
  const send = (message) => top.postMessage(message, '*');
  let attempt = 0;
  let initialized = false;
  const initialize = () => {
    if (initialized) return;
    attempt += 1;
    send({ id: 'init-' + attempt, jsonrpc: '2.0', method: 'ui/initialize', params: {
      appCapabilities: {}, appInfo: { name: 'reference', version: '1.0.0' }, protocolVersion: '2026-01-26' } });
    setTimeout(initialize, 500);
  };
  addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== top || !message || typeof message !== 'object') return;
    if (String(message.id).startsWith('init-') && message.result && !initialized) {
      initialized = true;
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
      send({ id: 'call', jsonrpc: '2.0', method: 'tools/call',
        params: { arguments: { text: '${PAYLOAD}' }, name: '${TOOL}' } });
    }
    if (message.id === 'call') {
      document.body.textContent = message.error
        ? 'App call failed: ' + message.error.message
        : 'App elicitation confirmed: ' + message.result.structuredContent.confirmed;
    }
  });
  initialize();
</script>`;

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function loadReferenceAppFixtures(): Promise<ReferenceAppFixtureModule> {
  return (await import(
    pathToFileURL(path.resolve(process.cwd(), '../../packages/mcp-test-lab/dist/index.js')).href
  )) as unknown as ReferenceAppFixtureModule;
}

async function configureServer(page: Page, url: string): Promise<void> {
  await new HomePage(page).openSettings();
  const settings = new SettingsPage(page);
  await settings.openCategory(/AI Tools/i, 'ai-tools');
  await page.getByRole('tab', { name: 'MCP Config' }).click();
  const editor = page.getByTestId('mcp-config-editor');
  await expect(editor).toBeVisible();
  await editor.fill(
    JSON.stringify({
      servers: [{ name: SERVER, protocol: '2026-07-28', transport: 'streamable-http', url }],
    })
  );
  await page.getByTestId('mcp-config-save').click();
  await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
  await expect(page.getByTestId(`mcp-server-row-${SERVER}`)).toContainText(/Connected/i, {
    timeout: 60_000,
  });
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

/**
 * BST-1930 c5e: an MCP App's own tool call asks for input. The app calls the
 * lab reference server's real `elicit_confirm` on the host's App path; the
 * server's elicitation reaches the user through the host's global MCP input,
 * and the answer returns to the app.
 */
test("an MCP App's tool call asks the user through the host's global MCP input", async ({
  electron,
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(300_000);
  const fixture = await (await loadReferenceAppFixtures()).startReferenceElicitationAppFixture({
    document: APP_DOCUMENT,
    resourceUri: 'ui://reference/app.html',
  });
  try {
    await configureServer(page, fixture.url);
    await enableModel(page);
    modelProvider.setScript((request) =>
      request.toolNames.includes('load_tool')
        ? {
            deferredTool: true,
            finalText: FINAL_TEXT,
            toolCall: { arguments: { text: MODEL_PAYLOAD }, name: `${SERVER}_${TOOL}` },
          }
        : { finalText: `No load_tool offered: ${request.toolNames.join(', ')}` }
    );
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Open the reference app.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    const diagnose = async (error: unknown): Promise<never> => {
      await testInfo.attach('mcp-app-elicitation-diagnostic', {
        body: JSON.stringify(
          {
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
    const dialog = page.getByTestId('mcp-elicitation-dialog');
    const confirm = async (payload: string): Promise<void> => {
      await expect(dialog).toBeVisible({ timeout: 45_000 }).catch(diagnose);
      await expect(dialog).toContainText('brainstrike-reference-elicitation-app');
      await expect(dialog).toContainText(`Configured server "${SERVER}"`);
      await expect(dialog).toContainText(`Confirm the reference elicitation for "${payload}".`);
      await dialog.getByRole('checkbox', { name: 'Confirm' }).click();
      await dialog.getByRole('button', { name: /^Accept/u }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
    };
    // The model's call asks under the policy, then the server asks the user for input.
    await region
      .getByRole('button', { exact: true, name: `Approve ${SERVER}.${TOOL}` })
      .click({ timeout: 90_000 })
      .catch(diagnose);
    await confirm(MODEL_PAYLOAD);
    await expect(region.getByText(FINAL_TEXT)).toBeVisible({ timeout: 60_000 });

    // Its result mounts the app, whose own call asks the thread's policy first.
    await region
      .getByRole('button', { name: `Allow ${TOOL} once` })
      .click({ timeout: 60_000 })
      .catch(diagnose);

    // The server's elicitation for the app's call reaches the user through the
    // host's global MCP input.
    await confirm(PAYLOAD);

    // The answer returns to the app through its tool call.
    const app = region
      .frameLocator(`iframe[title="${TOOL} app"]`)
      .frameLocator('iframe')
      .locator('body');
    await expect(app).toHaveText('App elicitation confirmed: true', { timeout: 30_000 });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await fixture.close();
  }
});
