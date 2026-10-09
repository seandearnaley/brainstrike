import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readCommittedRuns } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-session';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const REPLY = 'The session is running.';

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

test('a host run’s command session appears in the Terminal panel and stops from it', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-host-session-')));
  const rootId = randomUUID();
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'm3-host-session-root',
      rootId,
    });
    await enableModel(page);
    modelProvider.setScript((request) => {
      // Hosted discovery defers the session tool: the model loads it first.
      if (!request.toolNames.includes('load_tool')) {
        return { finalText: `No load_tool offered: ${request.toolNames.join(', ')}` };
      }
      const session = 'brainstrike_manageCommandSession';
      return {
        finalText: REPLY,
        toolCallStages: [
          [{ arguments: { toolName: session }, name: 'load_tool' }],
          [
            {
              arguments: { operation: { action: 'start', command: 'sleep 120' } },
              name: session,
            },
          ],
        ],
      };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Start a session.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    // The default `execute: ask` policy pauses the start until it is approved.
    const approve = region.getByRole('button', { name: /^Approve / });
    await expect(approve).toBeVisible({ timeout: 90_000 });
    await approve.click();
    await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });
    const tabId =
      (await page
        .getByRole('tablist', { name: 'Open assistant threads' })
        .getByRole('tab', { selected: true })
        .getAttribute('id')) ?? '';
    const threadId = tabId.replace('assistant-thread-tab-', '');
    // The reply streams before its run commits run.finished.
    await expect
      .poll(async () => (await readCommittedRuns(electron.getUserDataDir(), threadId))[0]?.status, {
        timeout: 30_000,
      })
      .toBe('completed');
    const [run] = await readCommittedRuns(electron.getUserDataDir(), threadId);
    // load_tool's result comes first, then the session start's.
    expect(run?.results).toHaveLength(2);
    expect(run?.results[0]?.output).toMatchObject({ success: true });
    const sessionId = (run?.results[1]?.output as { readonly id?: string } | undefined)?.id;
    expect(sessionId).toMatch(/^command-session-/);

    // Main holds no session for this run: the panel lists the agent host's.
    await page.getByTestId('workspace-add-tab').click({ timeout: 15_000 });
    await page.getByRole('menuitem', { name: /Terminal/ }).click({ timeout: 15_000 });
    await page.getByTestId('terminal-panel').waitFor({ state: 'visible', timeout: 30_000 });
    await page
      .getByRole('navigation', { name: 'Terminal surfaces' })
      .getByRole('button', { name: 'Command sessions' })
      .click();
    await page.getByRole('button', { name: 'Refresh command sessions' }).click();
    // The inventory row names the session by its id's tail and its PID.
    await page
      .getByRole('button')
      .filter({ hasText: `${sessionId?.slice(-6)} · PID` })
      .click();
    const header = page.getByText(`${sessionId} · root ${rootId} · running`);
    await expect(header).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { exact: true, name: 'Stop' }).click();
    await expect(page.getByText(new RegExp(`${sessionId} · root ${rootId} · exited`))).toBeVisible({
      timeout: 30_000,
    });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
