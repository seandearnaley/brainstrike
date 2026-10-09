import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

interface ReferenceFixture {
  close(): Promise<unknown>;
  readonly manifest: { readonly url: string };
}
interface ReferenceFixtureModule {
  startPackagedCoreFixture(id: 'legacy-reference'): Promise<ReferenceFixture>;
}

const SERVER = 'legacy';
const API_KEY = 'test-key-mcp-host-content';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
// The echo reference fixture's user-visible content, kept literal so the proof
// fails if it drifts instead of silently following it.
const RESOURCE_TITLE = 'Echo reference notes';
const RESOURCE_URI = 'brainstrike://reference/echo-notes';
const RESOURCE_MARKER = 'bst-1592-resource-body';
const PROMPT_COMMAND_ID = 'mcp:legacy:echo_prompt';
const PROMPT_MENU_LABEL = 'Echo reference prompt · legacy';
const PROMPT_ARGUMENT = 'subject';
const PROMPT_ARGUMENT_VALUE = 'bst-1930-content';
const PROMPT_MESSAGE = `Echo the reference subject "${PROMPT_ARGUMENT_VALUE}" back to me.`;

async function loadReferenceFixtures(): Promise<ReferenceFixtureModule> {
  return (await import(
    pathToFileURL(path.resolve(process.cwd(), '../../packages/mcp-test-lab/dist/index.js')).href
  )) as unknown as ReferenceFixtureModule;
}

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

/** A model makes the composer usable; this proof never sends a turn. */
async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    const db = (
      window as unknown as {
        electronAPI: { db: { query: (sql: string, params: unknown[]) => Promise<unknown> } };
      }
    ).electronAPI.db;
    await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
      model,
      'openrouter',
    ]);
  }, MODEL);
}

async function saveServer(page: Page, url: string): Promise<void> {
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/AI Tools/i, 'ai-tools');
  await page.getByRole('tab', { name: 'MCP Config' }).click();
  const editor = page.getByTestId('mcp-config-editor');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.fill(
    JSON.stringify({
      servers: [{ name: SERVER, protocol: 'legacy', transport: 'streamable-http', url }],
    })
  );
  await page.getByTestId('mcp-config-save').click();
  await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
  await expect(page.getByTestId(`mcp-server-row-${SERVER}`)).toContainText('connected', {
    timeout: 60_000,
  });
}

test('Settings and the composer browse MCP content through the agent host', async ({
  window: page,
}) => {
  test.setTimeout(240_000);
  const fixture = await (await loadReferenceFixtures()).startPackagedCoreFixture(
    'legacy-reference'
  );
  try {
    await saveServer(page, fixture.manifest.url);

    // A user-initiated `resources/read` from Settings: the host reads the body.
    const catalog = page.getByTestId(`mcp-server-catalog-${SERVER}`);
    await expect(catalog).toBeVisible({ timeout: 60_000 });
    await catalog.getByRole('button', { name: `Read ${RESOURCE_TITLE}` }).click();
    const content = page.getByTestId(`mcp-catalog-content-${SERVER}`);
    await expect(content).toContainText(RESOURCE_URI, { timeout: 30_000 });
    await expect(content).toContainText(RESOURCE_MARKER);
    await page.keyboard.press('Escape');
    await enableModel(page);

    // The composer's "/" prompt: its argument and `prompts/get` go to the host,
    // and the server's message lands in the draft, never sent.
    await ensureAssistantShellVisible(page);
    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.click();
    await input.pressSequentially(`/${PROMPT_COMMAND_ID}`);
    const popover = page.getByTestId('assistant-slash-popover');
    await expect(popover).toBeVisible({ timeout: 30_000 });
    await popover.getByRole('option', { name: PROMPT_MENU_LABEL }).click();
    const dialog = page.getByTestId('mcp-prompt-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText(SERVER);
    await dialog.getByLabel(PROMPT_ARGUMENT).fill(PROMPT_ARGUMENT_VALUE);
    await dialog.getByRole('button', { exact: true, name: 'Insert prompt' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(input).toHaveValue(PROMPT_MESSAGE, { timeout: 30_000 });
  } finally {
    await fixture.close();
  }
});
