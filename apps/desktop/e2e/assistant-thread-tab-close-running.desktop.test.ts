import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

/**
 * Closing the tab of a RUNNING thread hides it (BST-1844), on desktop as on
 * web: the panel stays mounted so nothing is aborted, the host finishes the run
 * and writes its terminal status, and reopening shows the finished response.
 * Only the external model provider is simulated; the run, its durable row, the
 * Threads panel and the tab strip are the real ones. The provider holds the
 * final response until released, so the close lands mid-run.
 *
 * The held run is the SECOND turn of a thread that already has its title. A
 * thread's first run writes its title, and that write happens to refresh the
 * loaded thread list; a second turn has no such write, so the finished badge
 * then depends on the list refreshing for the run row's terminal write alone.
 */
const FIRST_TEXT = 'CLOSE_HIDES_FIRST_TURN';
const FINAL_TEXT = 'CLOSE_HIDES_COMPLETE';
const THREAD_TITLE = 'Close hides a running thread';
const MODEL = 'openrouter::openai/gpt-5.4';

async function openThreadsPanel(page: Page): Promise<void> {
  const showSidebar = page.getByTestId('show-threads-panel');
  if (await showSidebar.isVisible().catch(() => false)) {
    await showSidebar.click();
  }
  await page.getByTestId('threads-tab-trigger').click();
  await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
}

async function readLatestRunStatus(page: Page, threadId: string): Promise<string | null> {
  return await page.evaluate(async (id) => {
    const { query } = (
      window as unknown as {
        electronAPI: {
          db: {
            query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ status: string }> }>;
          };
        };
      }
    ).electronAPI.db;
    const result = await query(
      'SELECT status FROM brainstrike_assistant_thread_runs WHERE thread_id = $1 ORDER BY started_at DESC LIMIT 1',
      [id]
    );
    return result.rows[0]?.status ?? null;
  }, threadId);
}

test('closing a running second turn of a titled thread hides it: no cancel, the run completes, reopening shows the response', async ({
  electron,
}) => {
  test.setTimeout(180_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-close-running-'));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let rootTurns = 0;
  const provider = await startModelProviderShim(({ toolNames }) => {
    // Title generation runs without tools; only root turns carry them.
    if (toolNames.length === 0) {
      return { finalText: THREAD_TITLE };
    }
    rootTurns += 1;
    // The first root turn completes at once; the second is the one held.
    if (rootTurns === 1) {
      return { finalText: FIRST_TEXT };
    }
    entered.resolve();
    return { beforeFinalText: release.promise, finalText: FINAL_TEXT };
  });
  const previous = {
    key: process.env['BRAINSTRIKE_OPENROUTER_API_KEY'],
    root: process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'],
    url: process.env['OPENROUTER_BASE_URL'],
  };
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = workspace;
  process.env['OPENROUTER_BASE_URL'] = provider.baseUrl;
  process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = 'isolated-close-running-provider-key';
  try {
    const window = await electron.ensureWindow();
    const cancels: string[] = [];
    window.on('request', (request) => {
      if (new URL(request.url()).pathname === '/assistant/cancel' && request.method() === 'POST') {
        cancels.push(request.url());
      }
    });
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window, { compositeModelKey: MODEL, provider: 'openrouter' });
    await ensureAssistantShellVisible(window);
    await openThreadsPanel(window);

    const strip = window.getByRole('tablist', { name: 'Open assistant threads' });
    await expect(strip.getByRole('tab')).toHaveCount(1, { timeout: 30_000 });
    const tab = strip.getByRole('tab');
    const tabId = (await tab.getAttribute('id')) ?? '';
    const threadId = tabId.replace('assistant-thread-tab-', '');
    const panel = window.getByTestId(`assistant-thread-panel-${threadId}`);
    const threadsPanel = window.getByTestId('threads-panel');
    const spinners = threadsPanel.getByTestId('thread-active-spinner');

    // Turn 1 runs to completion in the foreground, and the thread gets its title.
    await panel.getByRole('textbox', { name: 'Message input' }).fill('Say the first sentence.');
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(panel.getByText(FIRST_TEXT, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => readLatestRunStatus(window, threadId), { timeout: 60_000 })
      .toBe('completed');
    await expect(strip.getByRole('tab', { name: THREAD_TITLE })).toHaveCount(1, {
      timeout: 30_000,
    });

    // Turn 2 is held mid-run, and its tab closed.
    await panel.getByRole('textbox', { name: 'Message input' }).fill('Say the closing sentence.');
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await entered.promise;
    await expect(spinners).toHaveCount(1);

    await tab.focus();
    await window.keyboard.press('Delete');
    await expect(strip.getByRole('tab')).toHaveCount(0);
    // Hidden, not unmounted: the panel still owns the run and its conversation.
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeHidden();
    await expect(spinners).toHaveCount(1);

    release.resolve();
    await expect
      .poll(() => readLatestRunStatus(window, threadId), { timeout: 60_000 })
      .toBe('completed');
    await expect(spinners).toHaveCount(0);
    await expect(threadsPanel.getByTestId('thread-unseen-glyph')).toHaveCount(1);

    await threadsPanel.getByRole('button', { name: / has unseen activity/ }).click();
    await expect(strip.getByRole('tab')).toHaveCount(1);
    await expect(panel).toBeVisible();
    await expect(panel.getByText(FINAL_TEXT, { exact: true })).toBeVisible();
    expect(cancels).toEqual([]);
  } finally {
    release.resolve();
    try {
      await electron.dispose();
    } finally {
      await provider.close();
      for (const [key, value] of [
        ['OPENROUTER_BASE_URL', previous.url],
        ['BRAINSTRIKE_OPENROUTER_API_KEY', previous.key],
        ['BRAINSTRIKE_E2E_REAL_ROOT_PATH', previous.root],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(workspace, { force: true, recursive: true });
    }
  }
});
