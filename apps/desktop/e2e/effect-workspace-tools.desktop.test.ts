import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree } from './utils/agent-host-log';
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

test('Effect workspace inputs, refusal and resumed decisions complete through the app', async ({
  electron,
  modelProvider,
  window,
}) => {
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
