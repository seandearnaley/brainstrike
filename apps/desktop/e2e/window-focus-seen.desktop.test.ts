import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

/**
 * The app-active signal follows the NATIVE window's focus (BST-1864), end to end
 * through the real main, preload, `useAppActive()` and BST-1845's seen rule: a
 * run that finishes while the window is not focused is unseen, and focusing the
 * window marks the on-screen thread seen. Only the external model provider is
 * simulated.
 *
 * WHAT THIS RELIES ON, AND CANNOT SHOW. The harness window is `focusable: false`
 * and never shown (test mode), so it never takes OS focus: `isFocused()` is
 * false and stays false. This spec therefore (1) opts the `windowFocus` bridge
 * in (the harness leaves it off by default), (2) reads the window's real
 * `isFocused()` for the initial value, and (3) SYNTHESIZES the `focus` event an
 * OS would deliver with `BrowserWindow.emit`. Playwright also forces the
 * renderer's `document.hasFocus()` to true for every page, which is why the RED
 * run is the bridge-off run: `useAppActive()` then follows that forced document
 * focus, the completion reads as seen, and the first assertion fails. What
 * Playwright's forced focus hides is the bug's own symptom, keyboard focus in a
 * child `WebContentsView` making the renderer's `document.hasFocus()` false
 * while the window keeps native focus. That is pinned by the unit tests and by
 * the Electron 44 probe recorded in
 * docs/agents/assistant-persistence/thread-groups-and-folders.md.
 *
 * RED: `BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES=windowFocus` (the harness
 * default); GREEN: unset, which this spec turns into an opt-in.
 */
const THREAD_TITLE = 'Native focus decides seen';
const REPLY_TEXT = 'NATIVE_FOCUS_REPLY';
const MODEL = 'openrouter::openai/gpt-5.4';
const BRIDGE_ENV = 'BRAINSTRIKE_E2E_DISABLE_PRELOAD_BRIDGES';

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

/** What the host BrowserWindow reports in main, and what its renderer's bridge reports. */
async function readFocusReports(
  app: ElectronApplication,
  page: Page
): Promise<{ readonly bridge: boolean | undefined; readonly native: boolean }> {
  const host = await app.browserWindow(page);
  const native = await host.evaluate((win) => win.isFocused());
  const bridge = await page.evaluate(() =>
    (
      window as unknown as { windowFocus?: { isFocused: () => Promise<boolean> } }
    ).windowFocus?.isFocused()
  );
  return { bridge, native };
}

test('the seen rule follows the native window focus: a run finishing in an unfocused window is unseen, focusing the window marks it seen', async ({
  electron,
}) => {
  test.setTimeout(180_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-window-focus-'));
  const provider = await startModelProviderShim(({ toolNames }) =>
    // Title generation runs without tools; only the root turn carries them.
    toolNames.length === 0 ? { finalText: THREAD_TITLE } : { finalText: REPLY_TEXT }
  );
  const previous = {
    bridges: process.env[BRIDGE_ENV],
    key: process.env['BRAINSTRIKE_OPENROUTER_API_KEY'],
    root: process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'],
    url: process.env['OPENROUTER_BASE_URL'],
  };
  // Opt in unless the caller already chose (the RED run exports `windowFocus`).
  process.env[BRIDGE_ENV] ??= '';
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = workspace;
  process.env['OPENROUTER_BASE_URL'] = provider.baseUrl;
  process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = 'isolated-window-focus-provider-key';
  try {
    const { app } = await electron.ensureContext();
    const window = await electron.ensureWindow();
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window, { compositeModelKey: MODEL, provider: 'openrouter' });
    await ensureAssistantShellVisible(window);
    await openThreadsPanel(window);

    const strip = window.getByRole('tablist', { name: 'Open assistant threads' });
    await expect(strip.getByRole('tab')).toHaveCount(1, { timeout: 30_000 });
    const tabId = (await strip.getByRole('tab').getAttribute('id')) ?? '';
    const threadId = tabId.replace('assistant-thread-tab-', '');
    const panel = window.getByTestId(`assistant-thread-panel-${threadId}`);
    const threadsPanel = window.getByTestId('threads-panel');
    const unseen = threadsPanel.getByTestId('thread-unseen-glyph');

    // The window has never been focused, and its transcript is on screen.
    await panel.getByRole('textbox', { name: 'Message input' }).fill('Say the sentence.');
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(panel.getByText(REPLY_TEXT, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => readLatestRunStatus(window, threadId), { timeout: 60_000 })
      .toBe('completed');
    await expect(strip.getByRole('tab', { name: THREAD_TITLE })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(threadsPanel.getByTestId('thread-active-spinner')).toHaveCount(0);

    // RED: without the bridge the signal is Playwright's forced document focus
    // (true), the completion is stamped seen, and no glyph ever appears.
    await expect(unseen).toHaveCount(1);

    // The OS gives the window focus (synthesized: this window cannot take it).
    const host = await app.browserWindow(window);
    await host.evaluate((win) => {
      win.emit('focus');
    });
    await expect(unseen).toHaveCount(0);

    // The bridge is the real one: its initial read is the host window's own.
    expect(await readFocusReports(app, window)).toEqual({ bridge: false, native: false });
  } finally {
    try {
      await electron.dispose();
    } finally {
      await provider.close();
      for (const [key, value] of [
        [BRIDGE_ENV, previous.bridges],
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
