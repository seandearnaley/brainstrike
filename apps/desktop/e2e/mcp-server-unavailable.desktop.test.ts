import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import type { McpLabSession } from '../../../packages/mcp-test-lab/dist/index.js';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const REACHABLE = 'reference';
const DOWN = 'down';
const FINAL_TEXT = 'The reachable MCP server answered.';
const API_KEY = 'test-key-mcp-server-unavailable';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function startReference(): Promise<McpLabSession> {
  const lab: {
    startMcpLabScenario(
      id: 'modern-reference',
      options: { readonly execution: 'loopback' }
    ): Promise<McpLabSession>;
  } = await import(
    pathToFileURL(path.resolve(process.cwd(), '../../packages/mcp-test-lab/dist/index.js')).href
  );
  return await lab.startMcpLabScenario('modern-reference', { execution: 'loopback' });
}

/** A loopback port nothing listens on: every connection is refused. */
async function refusedUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((listening) => probe.listen(0, '127.0.0.1', listening));
  const address = probe.address();
  await new Promise<void>((closed) => probe.close(() => closed()));
  if (!address || typeof address === 'string') {
    throw new Error('The loopback probe has no port');
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function configureServers(page: Page, reachable: string, down: string): Promise<void> {
  await new HomePage(page).openSettings();
  const settings = new SettingsPage(page);
  await settings.openCategory(/AI Tools/i, 'ai-tools');
  await page.getByRole('tab', { name: 'MCP Config' }).click();
  const editor = page.getByTestId('mcp-config-editor');
  await expect(editor).toBeVisible();
  await editor.fill(
    JSON.stringify({
      servers: [
        { name: REACHABLE, protocol: '2026-07-28', transport: 'streamable-http', url: reachable },
        { name: DOWN, protocol: '2026-07-28', transport: 'streamable-http', url: down },
      ],
    })
  );
  await page.getByTestId('mcp-config-save').click();
  await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
  await expect(page.getByTestId(`mcp-server-row-${REACHABLE}`)).toContainText(/Connected/i, {
    timeout: 60_000,
  });
  await page.keyboard.press('Escape');
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

test('a host run proceeds past an unreachable MCP server and names it in the run view', async ({
  electron,
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(300_000);
  const reference = await startReference();
  try {
    if (reference.endpoint.kind !== 'loopback-http') {
      throw new Error('The modern reference scenario has no loopback HTTP endpoint');
    }
    await configureServers(page, reference.endpoint.url.href, await refusedUrl());
    await enableModel(page);
    modelProvider.setScript((request) => {
      const name = request.toolNames.find((tool) => tool.endsWith('test_simple_text'));
      return name
        ? { finalText: FINAL_TEXT, toolCall: { arguments: {}, name } }
        : { finalText: `No test_simple_text tool offered: ${request.toolNames.join(', ')}` };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Call the reference server.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    await expect(region.getByText(FINAL_TEXT).first())
      .toBeVisible({ timeout: 90_000 })
      .catch(async (error: unknown) => {
        await testInfo.attach('mcp-server-unavailable-diagnostic', {
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
      });
    // The run used the reachable server and shows the skipped one, without blocking.
    await expect(region.getByText('MCP server tools unavailable').first()).toBeVisible();
    await expect(region.getByText(`${DOWN} skipped for this request`).first()).toBeVisible();
    await expect(region.getByText(`${REACHABLE} skipped for this request`)).toHaveCount(0);
  } finally {
    await reference.close();
  }
});
