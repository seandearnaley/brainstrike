import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostRunTelemetry } from '@brainstrike/agent-host/protocol';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { attachAppHost, readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';

function streaming(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'stream' in value && value.stream === true;
}

const root = mkdtempSync(join(tmpdir(), 'bs-effect-workspace-'));
const READ = 'brainstrike_readWorkspaceFile';
const WRITE = 'brainstrike_writeWorkspaceFile';
const ASK = 'brainstrike_askUser';
const PLAN = 'brainstrike_submitPlan';
const PYTHON = 'brainstrike_runPython';
test.use({ electronEnv: { BRAINSTRIKE_E2E_REAL_ROOT_PATH: root } });
test.afterAll(() => rmSync(root, { force: true, recursive: true }));

test('Effect workspace and MCP producers retain validation, decisions, progress, Stop and reopen', async ({
  electron,
  modelProvider,
  window,
}) => {
  test.setTimeout(240_000);
  await writeFile(join(root, 'evidence.txt'), 'E02_EVIDENCE\n');
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  const settings = async () => {
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  };
  await settings();
  await window.getByTestId('permission-policy-edit').selectOption('allow');
  await window.getByTestId('permission-policy-execute').selectOption('allow');
  await window.getByTestId('permission-policy-mcp').selectOption('ask');
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const send = async (prompt: string) => {
    await ensureAssistantShellVisible(window);
    await panel.getByRole('textbox', { name: 'Message input' }).fill(prompt);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  };
  modelProvider.setScript(({ requestBody }) => {
    if (!streaming(requestBody)) {
      return { finalText: 'Effect workspace qualification' };
    }
    return {
      finalText: 'Workspace schema checks complete.',
      toolCallStages: [
        [{ arguments: { maxChars: null, path: 'evidence.txt' }, name: READ }],
        [{ arguments: { content: 'E02_WRITE\n', path: 'written.txt', root: null }, name: WRITE }],
        [{ arguments: { toolNames: [PYTHON] }, name: 'load_tool' }],
        [{ arguments: { code: '' }, name: PYTHON }],
      ],
    };
  });
  await send('Read evidence.txt, write written.txt, then validate the empty Python input.');
  await expect(panel.getByText('Workspace schema checks complete.', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect(await readFile(join(root, 'written.txt'), 'utf8')).toBe('E02_WRITE\n');
  const requests = JSON.stringify(modelProvider.requests());
  expect(requests).toContain('E02_EVIDENCE');
  expect(requests).toMatch(/code[\s\S]*(?:Invalid|invalid|Expected|expected|at least)/u);

  modelProvider.setScript(({ requestBody }) =>
    streaming(requestBody)
      ? {
          finalText: 'Question resumed.',
          toolCall: { arguments: { question: 'Which evidence?' }, name: ASK },
        }
      : { finalText: 'Effect workspace qualification' }
  );
  await send('Ask which evidence to use.');
  const question = panel.getByRole('group', { name: 'Question for you' });
  await expect(question).toBeVisible({ timeout: 30_000 });
  await question.getByRole('textbox', { name: 'Your answer' }).fill('E02_EVIDENCE');
  await question.getByRole('button', { exact: true, name: 'Send answer' }).click();
  await expect(panel.getByText('Question resumed.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  modelProvider.setScript(({ requestBody, toolNames }) => {
    if (!streaming(requestBody) || toolNames.length === 0) {
      return { finalText: 'Effect workspace qualification' };
    }
    return toolNames.includes(WRITE)
      ? {
          finalText: 'Plan implemented.',
          toolCall: { arguments: { content: 'E02_PLAN\n', path: 'planned.txt' }, name: WRITE },
        }
      : {
          finalText: 'Plan ready.',
          toolCall: {
            arguments: {
              overview: 'Write the approved evidence.',
              risks: null,
              steps: [{ detail: null, title: 'Write planned.txt' }],
              title: 'Write planned.txt',
            },
            name: PLAN,
          },
        };
  });
  await panel.getByRole('button', { name: 'Toggle plan mode' }).click();
  await send('Plan, then write planned.txt.');
  const approve = panel.getByRole('button', { exact: true, name: 'Approve plan' });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await approve.click();
  await expect(panel.getByText('Plan implemented.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(await readFile(join(root, 'planned.txt'), 'utf8')).toBe('E02_PLAN\n');

  await settings();
  await window.getByTestId('permission-policy-edit').selectOption('deny');
  const before = modelProvider.requests().length;
  modelProvider.setScript(() => ({ finalText: 'Permission refusal checked.' }));
  await send('Check the available tools with edits denied.');
  await expect(panel.getByText('Permission refusal checked.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const denied = modelProvider
    .requests()
    .slice(before)
    .find((request) => request.toolNames.length > 0);
  expect(denied?.toolNames).toContain(READ);
  expect(denied?.toolNames).not.toContain(WRITE);
  // The same disposable app now drives the real MCP producer and stdio SDK.
  const stateFile = join(root, 'mcp-cancelled.json');
  const serverId = 'effect-progress';
  const toolName = 'effect-progress_progress_forever';
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/AI Tools/i, 'ai-tools');
  await window.getByRole('tab', { name: 'MCP Config' }).click();
  await window.getByTestId('mcp-config-editor').fill(
    JSON.stringify({
      servers: [
        {
          args: [
            fileURLToPath(
              import.meta.resolve(
                '@brainstrike/agent/test-fixtures/mcp-stdio-progress-cancellation-server.mjs'
              )
            ),
          ],
          command: process.execPath,
          env: { BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE: stateFile },
          name: serverId,
          protocol: 'legacy',
          transport: 'stdio',
        },
      ],
    })
  );
  await window.getByTestId('mcp-config-save').click();
  await expect(window.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await window.getByRole('tab', { exact: true, name: 'Tools' }).click();
  await expect(window.getByTestId(`mcp-server-row-${serverId}`)).toContainText(/connected/i, {
    timeout: 60_000,
  });
  modelProvider.setScript(({ requestBody }) =>
    streaming(requestBody)
      ? {
          deferredTool: true,
          finalText: 'MCP permission refusal checked.',
          toolCall: { arguments: {}, name: toolName },
        }
      : { finalText: 'Effect workspace qualification' }
  );
  await send('Start the MCP progress tool.');
  const approval = panel.getByRole('button', {
    exact: true,
    name: `Approve ${serverId}.progress_forever`,
  });
  await expect(approval).toBeVisible({ timeout: 30_000 });
  await panel
    .getByRole('button', { exact: true, name: `Decline ${serverId}.progress_forever` })
    .click();
  await expect(panel.getByText('MCP permission refusal checked.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(existsSync(stateFile)).toBe(false);
  const observer = await attachAppHost(electron.getUserDataDir());
  const telemetry: HostRunTelemetry[] = [];
  const release = observer.onTelemetry((item) => telemetry.push(item));
  try {
    for (const thread of await readHostThreadTree(electron.getUserDataDir())) {
      await observer.request('log/subscribe', { fromSeq: 0, threadId: thread.threadId });
    }
    await send('Start it again; I will approve and then stop it.');
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await approval.click();
    await expect
      .poll(
        () =>
          telemetry.filter(
            (item) =>
              typeof item.chunk === 'object' &&
              item.chunk !== null &&
              'type' in item.chunk &&
              item.chunk['type'] === 'brainstrike.mcp-progress.chunk'
          ).length
      )
      .toBeGreaterThan(0);
    await panel.getByRole('button', { exact: true, name: 'Stop' }).click();
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect.poll(() => existsSync(stateFile)).toBe(true);
    const receipt: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(receipt).toMatchObject({ cancelled: true, progressSent: expect.any(Number) });
    await test.info().attach('mcp-progress-telemetry', {
      body: JSON.stringify(telemetry),
      contentType: 'application/json',
    });
  } finally {
    release();
    await observer.close();
  }
  const tree = await readHostThreadTree(electron.getUserDataDir());
  const events = tree.flatMap((thread) => thread.rows.map(({ event }) => event));
  expect(
    events.filter((event) => event.type === 'interaction.requested' && event.kind === 'question')
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.type === 'interaction.requested' && event.kind === 'plan')
  ).toHaveLength(1);
  await test
    .info()
    .attach('host-log', { body: JSON.stringify(tree, null, 2), contentType: 'application/json' });
  await reloadRenderer(window, 'effect-workspace-resume');
  await expect(window.getByText('Permission refusal checked.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(modelProvider.refusals()).toEqual([]);
});
