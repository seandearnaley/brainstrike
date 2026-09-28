import { expect, type Locator, type Page, type Route, test } from '@playwright/test';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import { HomePage } from './page-objects/home-page';

/**
 * Failed lazy chunk recovery (BST-1850), against the built preview.
 *
 * Library › Prompts is a real lazy chunk behind a `TabPanelBoundary`. Answering
 * it with a 404 is what a deployment that replaced the hashed file, or a dropped
 * connection, looks like to the page. `React.lazy` caches that rejection, so only
 * a full reload recovers; the reload is always the user's click, and on web it
 * waits for running assistant runs.
 *
 * Reloads are counted as main-frame navigation REQUESTS, not `framenavigated`
 * (which also fires for same-document history changes) and not an init-script
 * counter in `sessionStorage` (which the app owns, factory reset clears, and
 * same-origin iframes share). The request fires the moment `location.reload()`
 * runs, before any response, so "no reload happened" is judged where a reload
 * would already have been asked for, not after the new document loads.
 */

const PROMPTS_CHUNK_GLOB = '**/assets/connected-prompt-manager-*.js';
const WORKSPACE_MEMORY_RESOURCE_ID = 'brainstrike:workspace';
const ONE_RUN_COPY = '1 assistant run is still in progress. Reloading now stops it.';
const FIRST_NOTICE_COPY = 'Part of BrainStrike failed to load. Reload the app to fix it.';
const REPEAT_NOTICE_COPY = "Part of BrainStrike still can't load. Reloading didn't fix this.";
const UNCOUNTED_COPY = "BrainStrike can't confirm whether assistant runs are in progress.";

interface PromptsChunk {
  /** From now on, answer the chunks the page had not loaded at startup with a 404. */
  readonly block: () => Promise<void>;
  readonly release: () => Promise<void>;
}

/**
 * The prompt manager's implementation is shared with the startup graph, so it
 * loads with the app; only a tiny re-export chunk with the same name prefix is
 * requested when Prompts opens. A deploy that replaced the hashed files fails the
 * chunks a page has not loaded yet, so: remember what startup loaded (call
 * before `goto`) and let only those keep loading. Hashes are never spelled out.
 */
function watchPromptsChunk(page: Page): PromptsChunk {
  const requested = new Set<string>();
  page.on('request', (request) => {
    if (/\/assets\/connected-prompt-manager-/.test(request.url())) {
      requested.add(request.url());
    }
  });
  let loadedAtStartup: ReadonlySet<string> = new Set();
  const answer = (route: Route): Promise<void> =>
    loadedAtStartup.has(route.request().url()) ? route.continue() : route.fulfill({ status: 404 });
  return {
    block: async () => {
      loadedAtStartup = new Set(requested);
      await page.route(PROMPTS_CHUNK_GLOB, answer);
    },
    release: () => page.unroute(PROMPTS_CHUNK_GLOB, answer),
  };
}

interface ReloadCounter {
  readonly count: () => number;
}

function trackReloads(page: Page): ReloadCounter {
  let count = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      count += 1;
    }
  });
  return { count: () => count };
}

async function openPromptsPanel(page: Page): Promise<Locator> {
  await page.getByTestId('prompts-tab-trigger').click();
  return page.getByTestId('prompts-tab-content');
}

/** The app-level notice; the panel's own alert is told apart by its copy. */
function appNotice(page: Page, copy: string): Locator {
  return page.getByRole('alert').filter({ hasText: copy });
}

/**
 * Asks for a reload the way a user does and reports what the gate did. Until the
 * startup reap and the live run count have both delivered, the gate cannot tell
 * zero runs from unknown and says so in its dialog (unit-tested); a user cancels
 * that and asks again, and so does this, until the gate has counted.
 */
async function askForReload(
  button: Locator,
  dialog: Locator,
  reloads: ReloadCounter
): Promise<'asked' | 'reloading'> {
  let outcome: 'asked' | 'reloading' = 'asked';
  await expect(async () => {
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
    }
    const before = reloads.count();
    await button.click();
    await expect
      .poll(async () => reloads.count() > before || (await dialog.isVisible()))
      .toBe(true);
    if (reloads.count() > before) {
      outcome = 'reloading';
      return;
    }
    await expect(dialog.getByText(UNCOUNTED_COPY)).toHaveCount(0);
    outcome = 'asked';
  }).toPass({ timeout: 30_000 });
  return outcome;
}

async function startScriptedRun(page: Page): Promise<string> {
  // The Threads panel lists the thread once it is persisted; a run needs that row.
  await expect(page.getByTestId('thread-row')).toHaveCount(1);
  const runId = `e2e-reload-gate-run-${crypto.randomUUID()}`;
  await page.evaluate(
    async ({ id, resourceId }) => {
      const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
        .__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Expected web E2E hooks to be available');
      }
      const thread = (await hooks.readAssistantThreads())[0];
      if (!thread) {
        throw new Error('Expected an assistant thread to attach the scripted run to');
      }
      await hooks.createAssistantThreadRun({ id, resourceId, threadId: thread.id });
    },
    { id: runId, resourceId: WORKSPACE_MEMORY_RESOURCE_ID }
  );
  return runId;
}

async function finishScriptedRun(page: Page, runId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
      .__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected web E2E hooks to be available');
    }
    await hooks.completeAssistantThreadRun(id, 'completed');
  }, runId);
}

async function expectPromptsWorkbench(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Prompt workbench' })).toBeVisible({
    timeout: 60_000,
  });
}

interface FailedPromptsPanel {
  readonly chunk: PromptsChunk;
  readonly dialog: Locator;
  readonly panel: Locator;
  readonly reloads: ReloadCounter;
}

/** Fails the Prompts chunk and opens the panel, which shows the failure at once. */
async function failPromptsPanel(page: Page, chunk: PromptsChunk): Promise<FailedPromptsPanel> {
  await chunk.block();
  const reloads = trackReloads(page);
  const panel = await openPromptsPanel(page);
  await expect(panel.getByText("Prompts couldn't load")).toBeVisible();
  expect(reloads.count()).toBe(0);
  return {
    chunk,
    dialog: page.getByRole('dialog', { name: 'Reload BrainStrike?' }),
    panel,
    reloads,
  };
}

async function startWithFailedPromptsPanel(page: Page): Promise<FailedPromptsPanel> {
  const chunk = watchPromptsChunk(page);
  await new HomePage(page).goto({ waitForDatabase: true });
  return await failPromptsPanel(page, chunk);
}

/**
 * The Threads panel's spinner is the app reporting the run from the same table
 * change the reload gate counts. The run is waited on there before the chunk
 * fails, so the gate is asked about a run the app already knows about: a click
 * that beat the count would find zero runs and rightly reload.
 */
async function startWithFailedPromptsPanelAndRun(
  page: Page
): Promise<FailedPromptsPanel & { readonly runId: string }> {
  const chunk = watchPromptsChunk(page);
  await new HomePage(page).goto({ waitForDatabase: true });
  const runId = await startScriptedRun(page);
  await expect(page.getByTestId('threads-panel').getByTestId('thread-active-spinner')).toHaveCount(
    1
  );
  return { ...(await failPromptsPanel(page, chunk)), runId };
}

test.describe('Failed lazy chunk recovery', { tag: '@web-smoke' }, () => {
  test.beforeEach(() => {
    // Each case pays a database start, and most a second one after the reload.
    test.setTimeout(120_000);
  });

  test('a failed panel offers Reload app, and one click reloads once and recovers it', async ({
    page,
  }) => {
    const { chunk, dialog, panel, reloads } = await startWithFailedPromptsPanel(page);
    await expect(panel.getByRole('button', { name: 'Reload app' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reload tab' })).toHaveCount(0);
    await expect(appNotice(page, FIRST_NOTICE_COPY)).toBeVisible();

    await chunk.release();
    const outcome = await askForReload(
      panel.getByRole('button', { name: 'Reload app' }),
      dialog,
      reloads
    );

    expect(outcome).toBe('reloading');
    await expectPromptsWorkbench(page);
    expect(reloads.count()).toBe(1);
  });

  test('with a run in flight it asks first, waits behind a banner, and reloads once when the run ends', async ({
    page,
  }) => {
    const { chunk, dialog, panel, reloads, runId } = await startWithFailedPromptsPanelAndRun(page);

    const outcome = await askForReload(
      panel.getByRole('button', { name: 'Reload app' }),
      dialog,
      reloads
    );
    expect(outcome).toBe('asked');
    await expect(dialog.getByText(ONE_RUN_COPY)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reload now' })).toBeVisible();

    // Cancel leaves the page as it was.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel.getByText("Prompts couldn't load")).toBeVisible();
    expect(reloads.count()).toBe(0);

    await panel.getByRole('button', { name: 'Reload app' }).click();
    await expect(dialog.getByText(ONE_RUN_COPY)).toBeVisible();
    await dialog.getByRole('button', { name: 'Reload when finished' }).click();
    const banner = page.getByTestId('app-reload-pending-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(dialog).toBeHidden();
    expect(reloads.count()).toBe(0);

    await chunk.release();
    await finishScriptedRun(page, runId);
    await expectPromptsWorkbench(page);
    expect(reloads.count()).toBe(1);
  });

  test('Reload now reloads at once, past the running run', async ({ page }) => {
    const { chunk, dialog, panel, reloads } = await startWithFailedPromptsPanelAndRun(page);

    const outcome = await askForReload(
      panel.getByRole('button', { name: 'Reload app' }),
      dialog,
      reloads
    );
    expect(outcome).toBe('asked');
    await expect(dialog.getByText(ONE_RUN_COPY)).toBeVisible();
    expect(reloads.count()).toBe(0);

    await chunk.release();
    await dialog.getByRole('button', { name: 'Reload now' }).click();
    await expectPromptsWorkbench(page);
    expect(reloads.count()).toBe(1);
  });

  test('a reload that does not fix the chunk stops offering itself as the fix and never repeats', async ({
    page,
  }) => {
    const { dialog, panel, reloads } = await startWithFailedPromptsPanel(page);

    // The 404 outlives the reload, as a build that really lacks the chunk would.
    const outcome = await askForReload(
      panel.getByRole('button', { name: 'Reload app' }),
      dialog,
      reloads
    );
    expect(outcome).toBe('reloading');

    // Prompts is still the active Library tab after the reload.
    const reloadedPanel = await openPromptsPanel(page);
    await expect(reloadedPanel.getByText("Prompts still can't load")).toBeVisible();
    await expect(appNotice(page, REPEAT_NOTICE_COPY)).toBeVisible();
    await expect(reloadedPanel.getByRole('button')).toHaveText(['Copy details', 'Reload app']);
    await expect(reloadedPanel.getByRole('button', { name: 'Reload tab' })).toHaveCount(0);
    expect(reloads.count()).toBe(1);
  });
});
