import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readCommittedMcpTasks } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { getBufferedElectronOutput } from './utils/electron-helpers.mts';
import { runInteractiveChildFixture } from './utils/interactive-child-fixture';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startPendingInputFixture } from './utils/mcp-pending-input-fixture';
import { startModelProviderShim } from './utils/model-provider-shim';

const SERVER_ID = 'pending-input';
const TOOL_NAME = 'pending-input_start_task';
const FINAL_TEXT = 'The task observation has returned.';

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
  const row = page.getByTestId(`mcp-server-row-${SERVER_ID}`);
  await expect(row).toContainText(/Connected/i, { timeout: 60_000 });
  await expect(row).toContainText('2026-07-28');
  await settings.openCategory(/Permissions/i, 'permissions');
  const permission = page.getByRole('combobox', { name: 'MCP permission' });
  await permission.selectOption('ask');
  await expect(permission).toHaveValue('ask');
  await page.keyboard.press('Escape');
}

async function beginTask(page: Page, prompt: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message input' }).fill(prompt);
  await page.getByRole('button', { exact: true, name: 'Send' }).click();
  await page
    .getByRole('button', { exact: true, name: `Approve ${SERVER_ID}.start_task` })
    .click({ timeout: 45_000 });
  const dialog = page.getByTestId('mcp-elicitation-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText('Approve the reference task?');
  await expect(dialog).toContainText(`Configured server "${SERVER_ID}"`);
  await expect(dialog.getByRole('button', { name: /^Decline/u })).toBeFocused();
}

async function buildIdentity(): Promise<Readonly<Record<string, string>>> {
  const sha256 = async (file: string): Promise<string> =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    mainSha256: await sha256('dist/main.js'),
    rendererEntrySha256: await sha256('dist/renderer/index.html'),
  };
}

test('cancels a real MCP task while user input is pending (BST-1948)', async ({
  electron,
}, testInfo) => {
  const identity = await buildIdentity();
  // The host's StateStore rows; the window shows them through the agent host's task bridge.
  const readTasks = () => readCommittedMcpTasks(electron.getUserDataDir());
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bst1948-input-cancel-'));
  const server = await startPendingInputFixture();
  const provider = await startModelProviderShim({
    deferredTool: true,
    finalText: FINAL_TEXT,
    toolCall: { arguments: {}, name: TOOL_NAME },
  });
  const capture = async (page: Page, label: string): Promise<void> => {
    await testInfo.attach(label, {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  };
  await runInteractiveChildFixture({
    captureFailure: async (page) => {
      await capture(page, 'pending-input-cancel-failure');
      await attachEvidence(testInfo, 'failure-observation', {
        electron: await getBufferedElectronOutput((await electron.ensureContext()).app),
        identity,
        provider: provider.transcript(),
        server: server.snapshot(),
        tasks: await readTasks(),
      });
    },
    closeProvider: async () => {
      const results = await Promise.allSettled([provider.close(), server.close()]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'BST-1948 provider or Tasks reference cleanup failed');
      }
      await expect
        .poll(() => server.snapshot())
        .toMatchObject({
          activeRequests: 0,
          listening: false,
          openSockets: 0,
        });
    },
    electron,
    environment: {
      BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
      BRAINSTRIKE_OPENROUTER_API_KEY: 'test-key-bst1948',
      OPENROUTER_BASE_URL: provider.baseUrl,
    },
    run: async (page) => {
      await ensureMockWorkspaceOpen(page);
      await configureServer(page, server.url);
      await configureAssistantProvider(page, {
        apiKey: 'test-key-bst1948',
        compositeModelKey: 'openrouter::openai/gpt-5.4',
        provider: 'openrouter',
      });
      await enableAssistantCatalogModel(page, 'openrouter::openai/gpt-5.4');
      await ensureAssistantShellVisible(page);
      await beginTask(page, 'Start the task whose pending input I will cancel.');
      // The task-bound input is visible; its card projection updates only after
      // the interaction handler returns. Do not require that card to lead the modal.
      const pending = await readTasks();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.status).toBe('input_required');
      const taskId = pending[0]?.taskId;
      expect(taskId).toBeDefined();
      expect(
        server.snapshot().requests.filter(({ method }) => method === 'tasks/update')
      ).toHaveLength(0);
      await capture(page, 'input-pending');
      const dialog = page.getByTestId('mcp-elicitation-dialog');
      // A normal, accessible task action while the modal owns focus. Cancelling
      // the elicitation itself answers it via tasks/update and is not this proof.
      await dialog
        .getByRole('button', { exact: true, name: 'Cancel task' })
        .click({ timeout: 10_000 });
      await expect.poll(() => server.snapshot().cancellationAcknowledged).toBe(true);
      await expect.poll(() => server.snapshot().heldTerminalPolls).toBeGreaterThan(0);
      expect(
        server
          .snapshot()
          .requests.filter(({ method, taskId: id }) => method === 'tasks/cancel' && id === taskId)
      ).toHaveLength(1);
      await expect(
        dialog.getByRole('button', { name: /^Accept|^Decline|^Cancel MCP/u })
      ).toHaveCount(0);
      await expect(dialog).toContainText('no answer can be sent');
      const afterAcknowledgement = await readTasks();
      expect(afterAcknowledgement[0]?.status).not.toBe('cancelled');
      await capture(page, 'cancel-acknowledged-input-withdrawn');
      server.releaseTerminalObservation();
      await expect.poll(async () => (await readTasks())[0]?.status).toBe('cancelled');
      await dialog.getByRole('button', { name: /^Dismiss retired MCP request/u }).click();
      await expect(page.getByText(FINAL_TEXT, { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('assistant-activity-summary').first().click();
      const card = page.getByTestId('mcp-task-status-card').first();
      await expect(card.getByTestId('mcp-task-status-summary')).toContainText('Cancelled');
      await expect(card.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
      await capture(page, 'observed-terminal-cancelled');

      // Positive control: the same provider/transport/presenter really delivers
      // a later answer for a different task. Absence of a cancelled-task update
      // must not be explained by a broken observer or disabled input delivery.
      await beginTask(page, 'Start a fresh task and accept its input as a control.');
      await dialog.getByRole('checkbox', { name: /approved/i }).check();
      await dialog.getByRole('button', { name: /^Accept and send input/u }).click();
      await expect
        .poll(async () => (await readTasks()).map(({ status }) => status))
        .toEqual(['cancelled', 'completed']);
      const updates = server.snapshot().requests.filter(({ method }) => method === 'tasks/update');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.taskId).not.toBe(taskId);
      expect(
        server.snapshot().requests.filter(({ method }) => method === 'tasks/cancel')
      ).toHaveLength(1);
      await attachEvidence(testInfo, 'pending-input-cancel-observation', {
        afterAcknowledgement,
        identity,
        pending,
        provider: provider.transcript(),
        server: server.snapshot(),
        terminal: await readTasks(),
      });
    },
    workspace,
  });
});

async function attachEvidence(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}
