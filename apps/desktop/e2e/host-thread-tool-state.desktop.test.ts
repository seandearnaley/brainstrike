import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAgentHostLog, readHostRetiredTableSnapshot } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startThread } from './utils/new-thread';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-tool-state';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
// The run streams; the host's title request is the one non-streaming request.
const THREAD_TITLE = 'Launch plan thread';
const REPLY = 'The launch plan and its canvas are ready.';
const CANVAS_TITLE = 'Launch plan canvas';
const CANVAS_HTML = '<h1>Launch plan</h1><p>Ship on Friday.</p>';
const TASKS = [
  {
    activeForm: 'Drafting the launch plan',
    content: 'Draft the launch plan',
    status: 'in_progress',
  },
  { activeForm: 'Reviewing the launch plan', content: 'Review the launch plan', status: 'pending' },
];

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

/**
 * Retired task/canvas rows remain unwritten; current facts live in the host log.
 * Any absent retired table has zero rows, and no renderer SQL capability exists.
 */
async function legacyToolStateTables(page: Page): Promise<Record<string, number>> {
  const userData = await page.evaluate(() => {
    if (!window.electronAPI || Reflect.has(window.electronAPI, 'db')) {
      throw new Error('Retired SQL capability exposed');
    }
    return window.electronAPI.getUserDataPath();
  });
  const snapshot = await readHostRetiredTableSnapshot(userData, [
    'brainstrike_assistant_task_lists',
    'brainstrike_canvas_versions',
  ]);
  return Object.fromEntries(
    Object.entries(snapshot).map(([table, state]) => [table, state === 'absent' ? 0 : state.rows])
  );
}

async function expectTaskListAndCanvas(page: Page, region: Locator): Promise<void> {
  const tasks = region.getByRole('region', { name: 'Task list progress' });
  await expect(tasks).toBeVisible({ timeout: 30_000 });
  await expect(tasks.getByText('Drafting the launch plan')).toBeVisible();
  await expect(tasks.getByText('Review the launch plan')).toBeVisible();
  const chip = region.getByTestId('canvas-link-chip');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await expect(page.getByRole('tab', { name: CANVAS_TITLE })).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 30_000 }
  );
  const canvas = page.getByTestId('canvas-document');
  await expect(canvas.getByTestId('canvas-title')).toHaveText(CANVAS_TITLE);
  await expect(canvas.getByTestId('canvas-version-label')).toHaveText('v1 / 1');
}

async function openArtifacts(page: Page): Promise<Locator> {
  await page
    .getByRole('navigation', { exact: true, name: 'Main navigation' })
    .getByRole('button', { exact: true, name: 'Artifacts' })
    .click();
  const artifacts = page.getByTestId('artifacts-page');
  await expect(artifacts).toBeVisible({ timeout: 15_000 });
  return artifacts;
}

test('a host run’s task list and canvas survive a reload and are gone with their deleted thread', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-tool-state-')));
  try {
    await seedRoot(page, root, {
      reloadReason: 'm3-tool-state-root',
      rootId: randomUUID(),
    });
    await enableModel(page);
    modelProvider.setScript((request) => {
      if ((request.requestBody as { stream?: unknown }).stream !== true) {
        return { finalText: THREAD_TITLE };
      }
      // Hosted discovery defers both tools: the model loads them first.
      if (!request.toolNames.includes('load_tool')) {
        return { finalText: `Missing tools: ${request.toolNames.join(', ')}` };
      }
      const taskList = 'brainstrike_manageTaskList';
      const canvas = 'brainstrike_manageCanvas';
      return {
        finalText: REPLY,
        toolCallStages: [
          [{ arguments: { toolNames: [taskList, canvas] }, name: 'load_tool' }],
          [{ arguments: { tasks: TASKS }, name: taskList }],
          [
            {
              arguments: { action: 'create', html: CANVAS_HTML, title: CANVAS_TITLE },
              name: canvas,
            },
          ],
        ],
      };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Plan the launch.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    // The task list is a read-risk action; the canvas write pauses under the default `edit: ask`.
    const approve = region.getByRole('button', { name: /^Approve /u });
    await expect(approve).toBeVisible({ timeout: 90_000 });
    await approve.click();
    await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });
    await expectTaskListAndCanvas(page, region);

    // Reload: the committed host log alone restores both.
    await reloadRenderer(page, 'm3-tool-state-reload');
    await ensureAssistantShellVisible(page);
    const reloaded = page.getByRole('region', { exact: true, name: 'Assistant' });
    await expect(reloaded.getByText(REPLY)).toBeVisible({ timeout: 60_000 });
    await expectTaskListAndCanvas(page, reloaded);

    const userDataDir = electron.getUserDataDir();
    const before = await readAgentHostLog(userDataDir);
    expect(before.threads).toBe(1);
    expect(before.typeCounts['tool.state.updated']).toBe(2);
    expect(await legacyToolStateTables(page)).toEqual({
      brainstrike_assistant_task_lists: 0,
      brainstrike_canvas_versions: 0,
    });
    // The canvas is listed in Artifacts with the thread it lives in.
    const artifacts = await openArtifacts(page);
    const card = artifacts.getByTestId('artifact-card');
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(card).toContainText(CANVAS_TITLE);
    await expect(card).toContainText(THREAD_TITLE);
    await page
      .getByRole('navigation', { exact: true, name: 'Main navigation' })
      .getByRole('button', { exact: true, name: 'Context Explorer' })
      .click();

    // Delete the titled thread from the Threads panel while another (new) host thread is active.
    // A new thread exists once its first message is sent; this one calls no tools.
    modelProvider.setScript({ finalText: 'Second thread ready.' });
    await startThread(page, 'Start another thread.');
    await expect.poll(async () => (await readAgentHostLog(userDataDir)).threads).toBe(2);
    const actions = page.getByRole('button', {
      exact: true,
      name: `Thread actions ${THREAD_TITLE}`,
    });
    await expect(actions).toHaveCount(1, { timeout: 30_000 });
    await actions.click();
    await page.getByRole('menuitem', { exact: true, name: 'Delete…' }).click();
    await page.getByRole('button', { name: /^Confirm delete thread /u }).click();
    await expect(actions).toHaveCount(0, { timeout: 30_000 });

    // The deleted thread's committed tool state went with it; the new thread remains.
    const after = await readAgentHostLog(userDataDir);
    expect(after.threads).toBe(1);
    expect(after.typeCounts['tool.state.updated']).toBeUndefined();
    expect(await legacyToolStateTables(page)).toEqual({
      brainstrike_assistant_task_lists: 0,
      brainstrike_canvas_versions: 0,
    });
    // Its artifact left Artifacts with it.
    await expect((await openArtifacts(page)).getByText('No artifacts yet')).toBeVisible({
      timeout: 30_000,
    });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
