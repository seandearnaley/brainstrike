import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-no-legacy-rows';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const FINAL = 'The plan, canvas and file are ready.';
const ORIGINAL = 'original evidence\n';
const WRITTEN = 'written by the host thread\n';

/**
 * Every legacy PGlite table the old assistant path writes for a turn and for
 * the task list, canvas, file-edit journal and checkpoint undo it runs: the
 * run ledger and its events, tool telemetry and artifacts, turn snapshots and
 * the Mastra memory. A host thread owns all of these facts in its own log.
 */
const LEGACY_TABLES = [
  'brainstrike_assistant_compaction_ranges',
  'brainstrike_assistant_edit_checkpoints',
  'brainstrike_assistant_message_parents',
  'brainstrike_assistant_message_tombstones',
  'brainstrike_assistant_native_runs',
  'brainstrike_assistant_prompt_manifests',
  'brainstrike_assistant_run_errors',
  'brainstrike_assistant_run_events',
  'brainstrike_assistant_run_outcomes',
  'brainstrike_assistant_run_treatments',
  'brainstrike_assistant_run_usage',
  'brainstrike_assistant_task_lists',
  'brainstrike_assistant_thread_runs',
  'brainstrike_assistant_thread_workspaces',
  'brainstrike_assistant_tool_output_artifacts',
  'brainstrike_canvas_versions',
  'brainstrike_thread_message_index',
  'brainstrike_tool_call_telemetry',
  'brainstrike_workspace_snapshots',
  'mastra_messages',
  'mastra_observational_memory',
  'mastra_resources',
  'mastra_threads',
] as const;

interface TableState {
  readonly digest: string;
  readonly rows: number;
}

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

/**
 * Each legacy table's row count and a digest of every row, read through the
 * app's own database query path. Read-only: one SELECT per table.
 */
function legacySnapshot(page: Page): Promise<Record<string, TableState | 'absent'>> {
  return page.evaluate(async (tables) => {
    const db = window.electronAPI?.db;
    if (!db) {
      throw new Error('The app database query path is unavailable');
    }
    const present = await db.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [tables]
    );
    const names = new Set(present.rows.map((row) => row.name));
    const snapshot: Record<string, { digest: string; rows: number } | 'absent'> = {};
    for (const table of tables) {
      if (!names.has(table)) {
        snapshot[table] = 'absent';
        continue;
      }
      const { rows } = await db.query<{ digest: string; rows: number }>(
        `SELECT count(*)::int AS rows,
                coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest
         FROM ${table} t`,
        []
      );
      const row = rows[0];
      if (!row) {
        throw new Error(`No snapshot row for ${table}`);
      }
      snapshot[table] = { digest: row.digest, rows: row.rows };
    }
    return snapshot;
  }, LEGACY_TABLES);
}

/** The tables whose rows changed, with their before/after counts. */
function changedTables(
  before: Record<string, TableState | 'absent'>,
  after: Record<string, TableState | 'absent'>
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const table of LEGACY_TABLES) {
    const was = before[table];
    const now = after[table];
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      const count = (state: TableState | 'absent' | undefined): string =>
        state === undefined || state === 'absent' ? 'absent' : `${state.rows} rows`;
      changed[table] = `${count(was)} -> ${count(now)}`;
    }
  }
  return changed;
}

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    const db = window.electronAPI?.db;
    if (!db) {
      throw new Error('The app database query path is unavailable');
    }
    await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
      model,
      'openrouter',
    ]);
  }, MODEL);
}

test('a host thread using the task list, a canvas, a file write and its undo writes no legacy rows', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-no-legacy-rows-')));
  const evidence = path.join(root, 'evidence.md');
  writeFileSync(evidence, ORIGINAL);
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'm3-no-legacy-rows',
      rootId: randomUUID(),
    });
    await expect(page.getByText('evidence.md').first()).toBeVisible({ timeout: 30_000 });
    await enableModel(page);
    modelProvider.setScript((request) => {
      const tool = (suffix: string): string => {
        const name = request.toolNames.find((candidate) => candidate.endsWith(suffix));
        if (!name) {
          throw new Error(`No ${suffix} tool offered: ${request.toolNames.join(', ')}`);
        }
        return name;
      };
      // Hosted discovery defers the task list and canvas: the model loads them first.
      const taskList = 'brainstrike_manageTaskList';
      const canvas = 'brainstrike_manageCanvas';
      return {
        finalText: FINAL,
        toolCallStages: [
          [{ arguments: { toolNames: [taskList, canvas] }, name: tool('load_tool') }],
          [
            {
              arguments: {
                tasks: [
                  {
                    activeForm: 'Drafting the plan',
                    content: 'Draft the plan',
                    status: 'in_progress',
                  },
                  { activeForm: 'Writing the file', content: 'Write the file', status: 'pending' },
                ],
              },
              name: taskList,
            },
          ],
          [
            {
              arguments: { action: 'create', html: '<h1>Plan</h1>', title: 'Plan canvas' },
              name: canvas,
            },
          ],
          [
            {
              arguments: { content: WRITTEN, path: 'evidence.md' },
              name: tool('writeWorkspaceFile'),
            },
          ],
        ],
      };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await expect(region).toBeVisible({ timeout: 30_000 });
    const before = await legacySnapshot(page);

    await region
      .getByRole('textbox', { name: 'Message input' })
      .fill('Plan the work, sketch it on a canvas, then write evidence.md.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    // Edit-risk tools (the canvas and the write) ask first; approve each as it comes.
    const final = region.getByText(FINAL);
    const approve = region.getByRole('button', { name: /^Approve / });
    await expect(async () => {
      if (await final.isVisible()) {
        return;
      }
      if (await approve.first().isVisible()) {
        await approve.first().click();
      }
      await expect(final).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 120_000 });
    expect(readFileSync(evidence, 'utf8')).toBe(WRITTEN);

    const afterRun = await legacySnapshot(page);
    expect(changedTables(before, afterRun), 'legacy rows written by the host run').toEqual({});

    // Checkpoint undo of that write restores the file's turn-start content.
    await region
      .getByRole('button', { name: 'Restore 1 file edit in this turn to their turn-start state' })
      .click();
    await region.getByRole('button', { name: 'Revert 1 edit' }).click();
    await expect.poll(() => readFileSync(evidence, 'utf8')).toBe(ORIGINAL);

    const afterUndo = await legacySnapshot(page);
    expect(changedTables(before, afterUndo), 'legacy rows written by the undo').toEqual({});
    const log = await readAgentHostLog(electron.getUserDataDir());
    expect(log.typeCounts['effect.finished']).toBe(4);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
