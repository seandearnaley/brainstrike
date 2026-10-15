import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { readCommittedRunStatus, readCommittedRuns } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';

/**
 * Thread tabs vs. runs in flight (BST-1838 characterisation; BST-1844 made
 * closing a tab a HIDE). Three gestures land while a run is held open at the
 * external provider: switching tabs, Stop, and reopening a hidden running
 * thread. Only the model provider is simulated; the run, its committed rows,
 * the Threads panel and the tab strip are the real ones.
 *
 * These are the web suite's cases, moved to the shell that can still drive a
 * turn. `apps/web/e2e/assistant-thread-tab-runs.test.ts` holds them quarantined
 * because web's composer is disabled for every provider web can offer; desktop
 * has the agent host, so the behaviour they describe is live here.
 *
 * Three deliberate differences from the web originals:
 *
 * - The held run is the SECOND turn of a thread that already has its title,
 *   as in `assistant-thread-tab-close-running.desktop.test.ts` (which covers
 *   the fourth case, closing a running tab). A thread's first run writes its
 *   title, and that write refreshes the loaded thread list; holding turn one
 *   would make every Threads-panel badge depend on a list refresh the run has
 *   not yet earned.
 * - A stopped run's committed outcome is `stopped`, not the web row's
 *   `cancelled`: `run.finished` carries `completed | failed | stopped |
 *   interrupted` (packages/agent-host/src/protocol.ts), and `stopped` is the
 *   host's own name for the fact web records as `cancelled`.
 * - Web proves "this gesture did / did not abort the run" at the wire, off a
 *   mock that records the `AbortSignal` its `/api/assistant` request carried.
 *   Desktop has no such wire to watch: the renderer reaches the host through
 *   the `window.agentHost` IPC capability (ADR-0008), so a Stop is not a page
 *   request, and the provider shim records no aborts. The same facts are read
 *   off the committed log instead — a run that was not aborted reaches
 *   `completed` and shows its held text, and an aborted one reaches `stopped`
 *   and never shows the text the provider still had to send.
 */
const FIRST_TEXT = 'TAB_RUNS_FIRST_TURN';
const FINAL_TEXT = 'TAB_RUNS_HELD_TURN_COMPLETE';
const HELD_PROMPT = 'Say the held sentence.';
const THREAD_TITLE = 'Tab gestures over a running thread';

interface HeldRunFixture {
  readonly panel: Locator;
  /** Releases the held provider response. Safe to call more than once. */
  readonly release: () => void;
  readonly spinners: Locator;
  readonly strip: Locator;
  readonly tab: Locator;
  readonly threadId: string;
  readonly threadsPanel: Locator;
}

async function openThreadsPanel(page: Page): Promise<void> {
  const showSidebar = page.getByTestId('show-threads-panel');
  if (await showSidebar.isVisible().catch(() => false)) {
    await showSidebar.click();
  }
  await page.getByTestId('threads-tab-trigger').click();
  await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
}

/**
 * A titled thread whose SECOND turn is held open at the provider, with the
 * Threads panel showing.
 *
 * `extraThreads` opens that many further empty threads first, so the held
 * thread is the one the tab strip lists first.
 */
async function startHeldSecondTurn(
  electron: ElectronHarness,
  modelProvider: ModelProviderShim,
  options: { readonly extraThreads?: number; readonly streamedBeforeHold?: string } = {}
): Promise<{ readonly held: HeldRunFixture; readonly window: Page }> {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let rootTurns = 0;
  modelProvider.setScript(({ toolNames }) => {
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
    return {
      beforeFinalText: release.promise,
      finalText: FINAL_TEXT,
      ...(options.streamedBeforeHold === undefined
        ? {}
        : { streamedBeforeHold: options.streamedBeforeHold }),
    };
  });

  const window = await electron.ensureWindow();
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await ensureAssistantShellVisible(window);
  await openThreadsPanel(window);

  const strip = window.getByRole('tablist', { name: 'Open assistant threads' });
  await expect(strip.getByRole('tab')).toHaveCount(1, { timeout: 30_000 });
  for (let opened = 0; opened < (options.extraThreads ?? 0); opened += 1) {
    await window.getByTestId('assistant-new-thread-button').click();
    await expect(strip.getByRole('tab')).toHaveCount(opened + 2, { timeout: 30_000 });
  }
  const tab = strip.getByRole('tab').first();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const threadId = ((await tab.getAttribute('id')) ?? '').replace('assistant-thread-tab-', '');
  const panel = window.getByTestId(`assistant-thread-panel-${threadId}`);
  const threadsPanel = window.getByTestId('threads-panel');
  const spinners = threadsPanel.getByTestId('thread-active-spinner');

  // Turn 1 runs to completion in the foreground, and the thread gets its title.
  await panel.getByRole('textbox', { name: 'Message input' }).fill('Say the first sentence.');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText(FIRST_TEXT, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => readCommittedRunStatus(electron.getUserDataDir(), threadId), { timeout: 60_000 })
    .toBe('completed');
  await expect(strip.getByRole('tab', { name: THREAD_TITLE })).toHaveCount(1, { timeout: 30_000 });

  // Turn 2 is held open at the provider, so every gesture below lands mid-run.
  await panel.getByRole('textbox', { name: 'Message input' }).fill(HELD_PROMPT);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await entered.promise;
  await expect(spinners).toHaveCount(1);

  return {
    held: {
      panel,
      release: () => {
        release.resolve();
      },
      spinners,
      strip,
      tab,
      threadId,
      threadsPanel,
    },
    window,
  };
}

test('switching thread tabs mid-run neither aborts the run nor throws', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(180_000);
  const { held, window } = await startHeldSecondTurn(electron, modelProvider, { extraThreads: 1 });
  const pageErrors: string[] = [];
  window.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    const betaTab = held.strip.getByRole('tab').nth(1);
    const betaId = ((await betaTab.getAttribute('id')) ?? '').replace('assistant-thread-tab-', '');
    const betaPanel = window.getByTestId(`assistant-thread-panel-${betaId}`);

    for (let round = 0; round < 2; round += 1) {
      await betaTab.click();
      await expect(betaTab).toHaveAttribute('aria-selected', 'true');
      await expect(betaPanel).toBeVisible();
      await expect(held.panel).toBeHidden();
      await held.tab.click();
      await expect(held.panel).toBeVisible();
    }
    await betaTab.click();
    await expect(held.panel).toBeHidden();
    await expect(held.spinners).toHaveCount(1);

    // Released while its panel is hidden, the run still finishes in place.
    held.release();
    await expect
      .poll(() => readCommittedRunStatus(electron.getUserDataDir(), held.threadId), {
        timeout: 60_000,
      })
      .toBe('completed');
    await expect(held.spinners).toHaveCount(0);
    await held.tab.click();
    await expect(held.panel.getByText(FINAL_TEXT, { exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    held.release();
  }
});

/**
 * Stop is the one gesture that aborts a run. The run must reach the terminal
 * `stopped` outcome rather than simply ceasing to be observed as running, and
 * the abort must be real: releasing the provider afterwards delivers the final
 * text to nobody, because the turn it belonged to was abandoned.
 */
test('Stop aborts the held run: it ends stopped and the released reply never lands', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(180_000);
  const { held, window } = await startHeldSecondTurn(electron, modelProvider, {
    streamedBeforeHold: 'STREAMED_BEFORE_STOP',
  });
  const pageErrors: string[] = [];
  window.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await expect(held.panel.getByText('STREAMED_BEFORE_STOP')).toBeVisible({ timeout: 30_000 });
    const stop = held.panel.getByRole('button', { exact: true, name: 'Stop' });
    await expect(stop).toBeVisible();
    await stop.click();

    await expect(stop).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await readCommittedRuns(electron.getUserDataDir(), held.threadId)).map(
            ({ status }) => status
          ),
        { timeout: 60_000 }
      )
      .toEqual(['completed', 'stopped']);
    await expect(held.spinners).toHaveCount(0);
    await expect(held.panel.getByRole('button', { exact: true, name: 'Send' })).toBeVisible();

    // The provider still owed a final response; the stopped turn takes none of it.
    held.release();
    await expect(held.panel.getByText('STREAMED_BEFORE_STOP')).toBeVisible();
    await expect(held.panel.getByText(FINAL_TEXT, { exact: true })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    held.release();
  }
});

test('reopening a hidden running thread shows the live run, which then finishes in place', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(180_000);
  const { held, window } = await startHeldSecondTurn(electron, modelProvider);
  const pageErrors: string[] = [];
  window.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await held.tab.focus();
    await window.keyboard.press('Delete');
    await expect(held.strip.getByRole('tab')).toHaveCount(0);
    await expect(held.panel).toBeHidden();

    // The held thread's row is the one badged running: its select button's
    // name carries the spinner's "<title> is active" label.
    await held.threadsPanel.getByRole('button', { name: / is active/ }).click();
    await expect(held.strip.getByRole('tab')).toHaveCount(1);
    await expect(held.panel).toBeVisible();
    await expect(held.panel.getByText(HELD_PROMPT, { exact: true })).toBeVisible();
    await expect(held.spinners).toHaveCount(1);

    held.release();
    await expect(held.panel.getByText(FINAL_TEXT, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(held.spinners).toHaveCount(0);
    await expect
      .poll(() => readCommittedRunStatus(electron.getUserDataDir(), held.threadId), {
        timeout: 60_000,
      })
      .toBe('completed');
    expect(pageErrors).toEqual([]);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    held.release();
  }
});
