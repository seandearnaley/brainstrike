import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readAgentHostLog, readCommittedMcpTasks, readCommittedRuns } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import {
  type PendingInputFixture,
  startPendingInputFixture,
} from './utils/mcp-pending-input-fixture';
import type { ModelProviderShim } from './utils/model-provider-shim';

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

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

interface InputTaskHarness {
  readonly electron: ElectronHarness;
  readonly modelProvider: ModelProviderShim;
  readonly server: PendingInputFixture;
  readonly testInfo: TestInfo;
}

/** Diagnostics for a dialog that never appeared: the host log, the thread, the server and the shim. */
async function attachDiagnostic(page: Page, harness: InputTaskHarness): Promise<void> {
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await harness.testInfo.attach('mcp-host-input-diagnostic', {
    body: JSON.stringify(
      {
        host: await readAgentHostLog(harness.electron.getUserDataDir()).catch(String),
        region: await region.innerText().catch(() => '<unavailable>'),
        server: harness.server.snapshot(),
        transcript: harness.modelProvider.transcript(),
      },
      null,
      2
    ),
    contentType: 'application/json',
  });
}

/** Configures the server, sends the turn that starts its input task, and returns the open dialog. */
async function startInputTask(page: Page, harness: InputTaskHarness): Promise<Locator> {
  await configureServer(page, harness.server.url);
  await enableModel(page);
  // Hosted discovery defers MCP tools: the shim loads the tool, then calls it.
  harness.modelProvider.setScript((request) =>
    request.toolNames.includes('load_tool')
      ? {
          deferredTool: true,
          finalText: FINAL_TEXT,
          toolCall: { arguments: {}, name: `${SERVER_ID}_start_task` },
        }
      : { finalText: `No load_tool offered: ${request.toolNames.join(', ')}` }
  );
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
      await attachDiagnostic(page, harness);
      throw error;
    });
  if (await approve.isVisible()) {
    await approve.click();
  }
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toContainText('Approve the reference task?');
  await expect(dialog).toContainText(`Configured server "${SERVER_ID}"`);
  return dialog;
}

test('a host-run MCP server input is presented once and answered once through Core', async ({
  electron,
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(300_000);
  const server = await startPendingInputFixture();
  try {
    const dialog = await startInputTask(page, { electron, modelProvider, server, testInfo });
    // Core committed the request before the committed view showed it, and the global
    // presenter shows no second dialog for the same input.
    const pending = await readAgentHostLog(electron.getUserDataDir());
    expect(pending.mcpInputs).toEqual([{ type: 'mcp.input.requested' }]);
    await expect(dialog).toHaveCount(1);
    // The host's StateStore holds the task, bound to the thread whose run created it.
    const [stored, ...others] = await readCommittedMcpTasks(electron.getUserDataDir());
    expect(others).toEqual([]);
    expect(stored).toMatchObject({ status: 'input_required', threadId: expect.any(String) });
    expect(await readCommittedRuns(electron.getUserDataDir(), stored?.threadId ?? '')).toHaveLength(
      1
    );
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

test('a durable MCP server input recovers into Core after an app restart and is answered once', async ({
  electron,
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(300_000);
  const server = await startPendingInputFixture();
  try {
    const harness = { electron, modelProvider, server, testInfo };
    await startInputTask(page, harness);
    const userDataDir = electron.getUserDataDir();
    expect((await readAgentHostLog(userDataDir)).mcpInputs).toEqual([
      { type: 'mcp.input.requested' },
    ]);

    // The server keeps its task while the whole app restarts on the same profile.
    const restarted = (await electron.restart()).window;
    // The restarted host connects the configured server, which opens its Tasks session.
    await new HomePage(restarted).openSettings();
    await new SettingsPage(restarted).openCategory(/AI Tools/i, 'ai-tools');
    await restarted.getByRole('tab', { exact: true, name: 'Tools' }).click();
    await expect(restarted.getByTestId(`mcp-server-row-${SERVER_ID}`)).toContainText(/Connected/i, {
      timeout: 60_000,
    });
    await restarted.keyboard.press('Escape');
    await ensureAssistantShellVisible(restarted);
    // The restart interrupted the run, which retired its first input. Its notice comes
    // first; dismissing it shows the input Core recovered.
    const retired = restarted
      .getByRole('status')
      .filter({ hasText: 'This server input is no longer available.' });
    await expect(retired).toBeVisible({ timeout: 60_000 });
    await retired.getByRole('button', { exact: true, name: 'Dismiss' }).click();
    // Core owns the recovered task: its input is the thread's committed dialog, never a
    // second presenter dialog.
    const dialog = restarted.getByTestId('mcp-elicitation-dialog');
    await expect(dialog)
      .toBeVisible({ timeout: 60_000 })
      .catch(async (error: unknown) => {
        await attachDiagnostic(restarted, harness);
        throw error;
      });
    await expect(dialog).toContainText('Approve the reference task?');
    await expect(dialog).toHaveCount(1);
    // The recovered input is committed under the run that bound the task, with no second binding.
    const recovered = await readAgentHostLog(userDataDir);
    expect(recovered.mcpInputs).toEqual([
      { type: 'mcp.input.requested' },
      { type: 'mcp.input.requested' },
    ]);
    expect(recovered.typeCounts['mcp.task.bound']).toBe(1);

    await dialog.getByRole('checkbox', { name: /approved/i }).check();
    await dialog.getByRole('button', { name: /^Accept and send input/u }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // The server completes the task, and the host's StateStore records it.
    await expect
      .poll(async () => (await readCommittedMcpTasks(userDataDir)).map(({ status }) => status), {
        timeout: 60_000,
      })
      .toEqual(['completed']);

    const settled = await readAgentHostLog(userDataDir);
    expect(settled.mcpInputs).toEqual([
      { type: 'mcp.input.requested' },
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
