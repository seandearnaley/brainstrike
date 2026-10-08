import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
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

/** Rows in the legacy assistant's task list and canvas tables, which a host thread never writes. */
async function legacyToolStateRows(page: Page): Promise<Record<string, number>> {
  return await page.evaluate(async () => {
    const db = (
      window as unknown as {
        electronAPI: {
          db: {
            query: (sql: string, params: unknown[]) => Promise<{ rows: { count: number }[] }>;
          };
        };
      }
    ).electronAPI.db;
    const counts: Record<string, number> = {};
    for (const table of ['brainstrike_assistant_task_lists', 'brainstrike_canvas_versions']) {
      const { rows } = await db.query(`SELECT count(*)::int AS count FROM ${table}`, []);
      counts[table] = rows[0]?.count ?? -1;
    }
    return counts;
  });
}

async function expectTaskListAndCanvas(page: Page, region: Locator): Promise<void> {
  const tasks = region.getByRole('region', { name: 'Task list progress' });
  await expect(tasks).toBeVisible({ timeout: 30_000 });
  await expect(tasks.getByText('Drafting the launch plan')).toBeVisible();
  await expect(tasks.getByText('Review the launch plan')).toBeVisible();
  const chip = region.getByTestId('canvas-link-chip');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  const panel = page.getByTestId('canvas-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(CANVAS_TITLE, { exact: true })).toBeVisible();
  await expect(panel.getByTestId('canvas-version-label')).toHaveText('v1 / 1');
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
      disableBackgroundIndexing: true,
      reloadReason: 'm3-tool-state-root',
      rootId: randomUUID(),
    });
    await enableModel(page);
    modelProvider.setScript((request) => {
      if ((request.requestBody as { stream?: unknown }).stream !== true) {
        return { finalText: THREAD_TITLE };
      }
      const taskList = request.toolNames.find((tool) => tool.endsWith('manageTaskList'));
      const canvas = request.toolNames.find((tool) => tool.endsWith('manageCanvas'));
      if (!(taskList && canvas)) {
        return { finalText: `Missing tools: ${request.toolNames.join(', ')}` };
      }
      return {
        finalText: REPLY,
        toolCallStages: [
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
    const approve = region.getByRole('button', { name: /^Approve / });
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
    expect(await legacyToolStateRows(page)).toEqual({
      brainstrike_assistant_task_lists: 0,
      brainstrike_canvas_versions: 0,
    });

    // Delete the titled thread from the Threads panel while another (new) host thread is active.
    const newThread = page.getByTestId('assistant-new-thread-button');
    await expect(newThread).toBeEnabled({ timeout: 15_000 });
    await newThread.click();
    await expect.poll(async () => (await readAgentHostLog(userDataDir)).threads).toBe(2);
    const actions = page.getByRole('button', {
      exact: true,
      name: `Thread actions ${THREAD_TITLE}`,
    });
    await expect(actions).toHaveCount(1, { timeout: 30_000 });
    await actions.click();
    await page.getByRole('button', { exact: true, name: 'Delete…' }).click();
    await page.getByRole('button', { name: /^Confirm delete thread / }).click();
    await expect(actions).toHaveCount(0, { timeout: 30_000 });

    // The deleted thread's committed tool state went with it; the new thread remains.
    const after = await readAgentHostLog(userDataDir);
    expect(after.threads).toBe(1);
    expect(after.typeCounts['tool.state.updated']).toBeUndefined();
    expect(await legacyToolStateRows(page)).toEqual({
      brainstrike_assistant_task_lists: 0,
      brainstrike_canvas_versions: 0,
    });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
