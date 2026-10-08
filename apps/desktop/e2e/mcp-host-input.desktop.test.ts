import { type McpTaskBridge, parseMcpTaskListResult } from '@brainstrike/assistant-contract';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startPendingInputFixture } from './utils/mcp-pending-input-fixture';

const SERVER_ID = 'pending-input';
const FINAL_TEXT = 'The MCP input task completed.';
const API_KEY = 'test-key-mcp-host-input';
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
      servers: [{ name: SERVER_ID, protocol: '2026-07-28', transport: 'streamable-http', url }],
    })
  );
  await page.getByTestId('mcp-config-save').click();
  await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
  await expect(page.getByTestId(`mcp-server-row-${SERVER_ID}`)).toContainText(/Connected/i, {
    timeout: 60_000,
  });
  await page.keyboard.press('Escape');
}

/** The renderer's Tasks list, read through the production bridge. */
async function readTasks(page: Page) {
  const raw = await page.evaluate(async () => {
    const host = window as Window & { mcp?: { tasks?: Pick<McpTaskBridge, 'list'> } };
    if (!host.mcp?.tasks) {
      throw new Error('Production MCP task read bridge is unavailable');
    }
    return await host.mcp.tasks.list();
  });
  return parseMcpTaskListResult(raw).tasks;
}

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

test('a host-run MCP server input is presented once and answered once through Core', async ({
  electron,
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(300_000);
  const server = await startPendingInputFixture();
  try {
    await configureServer(page, server.url);
    await enableModel(page);
    modelProvider.setScript((request) => {
      const name = request.toolNames.find((tool) => tool.endsWith('start_task'));
      return name
        ? { finalText: FINAL_TEXT, toolCall: { arguments: {}, name } }
        : { finalText: `No start_task tool offered: ${request.toolNames.join(', ')}` };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Start the input task.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    const approve = page.getByRole('button', {
      exact: true,
      name: `Approve ${SERVER_ID}.start_task`,
    });
    const dialog = page.getByTestId('mcp-elicitation-dialog');
    await expect(approve.or(dialog))
      .toBeVisible({ timeout: 90_000 })
      .catch(async (error: unknown) => {
        await testInfo.attach('mcp-host-input-diagnostic', {
          body: JSON.stringify(
            {
              host: await readAgentHostLog(electron.getUserDataDir()).catch(String),
              region: await region.innerText().catch(() => '<unavailable>'),
              server: server.snapshot(),
              transcript: modelProvider.transcript(),
            },
            null,
            2
          ),
          contentType: 'application/json',
        });
        throw error;
      });
    if (await approve.isVisible()) {
      await approve.click();
    }
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog).toContainText('Approve the reference task?');
    await expect(dialog).toContainText(`Configured server "${SERVER_ID}"`);
    // Core committed the request before the committed view showed it, and the global
    // presenter shows no second dialog for the same input.
    const pending = await readAgentHostLog(electron.getUserDataDir());
    expect(pending.mcpInputs).toEqual([{ type: 'mcp.input.requested' }]);
    await expect(dialog).toHaveCount(1);
    // The Tasks list the renderer reads is the same runtime's task.
    const tasks = await readTasks(page);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ recovery: 'live', status: 'input_required' });

    await dialog.getByRole('checkbox', { name: /approved/i }).check();
    await dialog.getByRole('button', { name: /^Accept and send input/u }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(FINAL_TEXT).first()).toBeVisible({ timeout: 90_000 });

    const settled = await readAgentHostLog(electron.getUserDataDir());
    expect(settled.mcpInputs).toEqual([
      { type: 'mcp.input.requested' },
      { action: 'accept', type: 'mcp.input.intent' },
      { status: 'remote-acknowledged', type: 'mcp.input.settled' },
    ]);
    expect(settled.typeCounts['mcp.task.bound']).toBe(1);
    expect(
      server.snapshot().requests.filter(({ method }) => method === 'tasks/update')
    ).toHaveLength(1);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await server.close();
  }
});
