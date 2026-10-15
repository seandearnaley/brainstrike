import { expect, type Page, test } from '@playwright/test';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import {
  GATED_RUN_RESPONSE,
  mockGatedAssistantApi,
  readGatedRuns,
  releaseGatedRuns,
} from './utils/assistant-mocks';
import { openAssistantWorkspace } from './utils/assistant-workspace';
import { getPanelElements } from './utils/layout-helpers';

/**
 * Thread tabs vs. runs in flight (BST-1838 characterisation, held green across
 * the tab-strip migration; BST-1844 flipped the close case to close = hide).
 * Every turn on the hosted `/api/assistant` data stream is held open until the
 * test releases it, so each tab gesture lands mid-run.
 *
 * QUARANTINED — web has no sendable composer.
 *
 * These turns are driven through the composer, and on web the composer is
 * disabled for every provider web can offer. `resolveAssistantMemoryDisabledReason`
 * (packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts) disables it
 * whenever a provider is selected and `resolveHostedMemoryBackendAvailable` is
 * false, and that resolves `selectedProvider === 'local' || desktopAssistantBackendAvailable`.
 * Web's `desktopAssistantBackendAvailable` is `hasDurableAssistantUsageCapability()`,
 * which is false without `window.agentHost` — so before the built-in local
 * provider was retired, `local` was the ONLY provider that cleared this gate on
 * web, which is why the original suites seeded it.
 *
 * The transport itself is fine: with that one gate cleared, a turn streams over
 * `/api/assistant` end to end, tool chunks and all. So these are unquarantined
 * by enabling hosted web chat, not by changing the tests. Faking the capability
 * probe would assert a configuration that cannot exist (web + durable agent
 * host), so it is deliberately not done here.
 *
 * Desktop covers the close-while-running case in
 * `apps/desktop/e2e/assistant-thread-tab-close-running.desktop.test.ts`.
 */

async function readOpenThreadTabIds(page: Page): Promise<readonly string[]> {
  return await page
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab')
    .evaluateAll((tabs) => tabs.map((tab) => tab.id.replace(/^assistant-thread-tab-/, '')));
}

/** The status of every run row the thread has, in creation order. */
async function readThreadRunStatuses(page: Page, threadId: string): Promise<readonly string[]> {
  return await page.evaluate(async (id) => {
    const hooks = (window as unknown as { __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks })
      .__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Expected web E2E hooks to be available');
    }
    return await hooks.readAssistantThreadRunStatuses(id);
  }, threadId);
}

/** Two open thread tabs, the FIRST one active and mid-run. Returns their ids in tab order. */
async function startHeldRunInFirstOfTwoThreads(
  page: Page
): Promise<{ readonly alphaId: string; readonly betaId: string }> {
  const elements = getPanelElements(page);
  if (await elements.showRightPanelShim.isVisible()) {
    await elements.showRightPanelShim.click();
    await expect(elements.rightPanel).toBeVisible();
  }
  const tabList = page.getByRole('tablist', { name: 'Open assistant threads' });
  await page.getByTestId('assistant-new-thread-button').click();
  await expect(tabList.getByRole('tab')).toHaveCount(2);
  const [alphaId, betaId] = await readOpenThreadTabIds(page);
  if (!(alphaId && betaId)) {
    throw new Error('Expected two open assistant thread tabs');
  }
  const alphaTab = page.locator(`[id="assistant-thread-tab-${alphaId}"]`);
  await alphaTab.click();
  await expect(alphaTab).toHaveAttribute('aria-selected', 'true');

  const alphaPanel = page.getByTestId(`assistant-thread-panel-${alphaId}`);
  await alphaPanel.getByRole('textbox', { name: 'Message input' }).fill('held run alpha');
  await alphaPanel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect.poll(async () => (await readGatedRuns(page)).started).toBe(1);
  await expect(page.getByTestId('threads-panel').getByTestId('thread-active-spinner')).toHaveCount(
    1
  );
  return { alphaId, betaId };
}

test.describe('Assistant thread tabs with runs in flight @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ page }) => {
    await mockGatedAssistantApi(page);
    await openAssistantWorkspace(page, { hostedAssistantModel: true });
  });

  test.fixme('switching thread tabs mid-run neither aborts the run nor throws', {
    annotation: {
      description: 'Blocked: web composer is disabled for hosted providers',
      type: 'quarantine',
    },
  }, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const { alphaId, betaId } = await startHeldRunInFirstOfTwoThreads(page);
    const alphaTab = page.locator(`[id="assistant-thread-tab-${alphaId}"]`);
    const betaTab = page.locator(`[id="assistant-thread-tab-${betaId}"]`);
    const alphaPanel = page.getByTestId(`assistant-thread-panel-${alphaId}`);
    const betaPanel = page.getByTestId(`assistant-thread-panel-${betaId}`);
    const runningSpinners = page.getByTestId('threads-panel').getByTestId('thread-active-spinner');

    for (let round = 0; round < 2; round += 1) {
      await betaTab.click();
      await expect(betaTab).toHaveAttribute('aria-selected', 'true');
      await expect(betaPanel).toBeVisible();
      await expect(alphaPanel).toBeHidden();
      await alphaTab.click();
      await expect(alphaPanel).toBeVisible();
    }
    await betaTab.click();
    await expect(alphaPanel).toBeHidden();
    await expect(runningSpinners).toHaveCount(1);

    // Released while its panel is hidden, the run still finishes in place.
    await releaseGatedRuns(page);
    await expect(runningSpinners).toHaveCount(0);
    await alphaTab.click();
    await expect(
      alphaPanel.getByTestId('assistant-ui-viewport').getByText(GATED_RUN_RESPONSE)
    ).toBeVisible();
    expect((await readGatedRuns(page)).cancelled).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  // BST-1844, maintainer decision 2026-09-28: closing a tab HIDES a running
  // thread. Its run keeps going in the background exactly as it does on a tab
  // switch; only the Stop button ever aborts a run.
  test.fixme('closing a running root thread tab hides it and the run completes in the background', {
    annotation: {
      description: 'Blocked: web composer is disabled for hosted providers',
      type: 'quarantine',
    },
  }, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const { alphaId, betaId } = await startHeldRunInFirstOfTwoThreads(page);
    const alphaTab = page.locator(`[id="assistant-thread-tab-${alphaId}"]`);
    const betaTab = page.locator(`[id="assistant-thread-tab-${betaId}"]`);
    const alphaPanel = page.getByTestId(`assistant-thread-panel-${alphaId}`);
    const threadsPanel = page.getByTestId('threads-panel');
    const runningSpinners = threadsPanel.getByTestId('thread-active-spinner');

    await alphaTab.focus();
    await page.keyboard.press('Delete');
    await expect(alphaTab).toHaveCount(0);
    await expect(betaTab).toHaveAttribute('aria-selected', 'true');
    // Hidden, not unmounted: the panel still owns the run and its conversation.
    await expect(alphaPanel).toHaveCount(1);
    await expect(alphaPanel).toBeHidden();
    await expect(runningSpinners).toHaveCount(1);

    // The run finishes in the background: its row reaches a terminal status
    // (the spinner reads the row) and the Threads panel badges it as finished.
    await releaseGatedRuns(page);
    await expect(runningSpinners).toHaveCount(0);
    await expect(threadsPanel.getByTestId('thread-unseen-glyph')).toHaveCount(1);

    // Reopening from the Threads panel shows the finished conversation.
    await threadsPanel.getByRole('button', { name: / has unseen activity/ }).click();
    await expect(alphaTab).toHaveAttribute('aria-selected', 'true');
    await expect(
      alphaPanel.getByTestId('assistant-ui-viewport').getByText(GATED_RUN_RESPONSE)
    ).toBeVisible();
    expect(await readGatedRuns(page)).toEqual({ cancelled: [], started: 1 });
    expect(pageErrors).toEqual([]);
  });

  // Stop is the one gesture that aborts a run. On the hosted transport Stop
  // detaches the request through its `AbortSignal` — the mock records that
  // abort exactly as the server would observe it — and the run must still end
  // `cancelled` rather than simply stopping at `running`.
  test.fixme('Stop cancels the held run: the request is aborted and the run ends cancelled', {
    annotation: {
      description: 'Blocked: web composer is disabled for hosted providers',
      type: 'quarantine',
    },
  }, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const { alphaId } = await startHeldRunInFirstOfTwoThreads(page);
    const alphaPanel = page.getByTestId(`assistant-thread-panel-${alphaId}`);
    const runningSpinners = page.getByTestId('threads-panel').getByTestId('thread-active-spinner');
    await expect.poll(() => readThreadRunStatuses(page, alphaId)).toEqual(['running']);

    await alphaPanel.getByRole('button', { name: 'Stop' }).click();

    await expect.poll(async () => (await readGatedRuns(page)).cancelled).toHaveLength(1);
    await expect.poll(() => readThreadRunStatuses(page, alphaId)).toEqual(['cancelled']);
    await expect(runningSpinners).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test.fixme('reopening a hidden running thread shows the live run, which then finishes in place', {
    annotation: {
      description: 'Blocked: web composer is disabled for hosted providers',
      type: 'quarantine',
    },
  }, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const { alphaId } = await startHeldRunInFirstOfTwoThreads(page);
    const alphaTab = page.locator(`[id="assistant-thread-tab-${alphaId}"]`);
    const alphaPanel = page.getByTestId(`assistant-thread-panel-${alphaId}`);
    const alphaViewport = alphaPanel.getByTestId('assistant-ui-viewport');
    const threadsPanel = page.getByTestId('threads-panel');
    const runningSpinners = threadsPanel.getByTestId('thread-active-spinner');

    await alphaTab.focus();
    await page.keyboard.press('Delete');
    await expect(alphaTab).toHaveCount(0);

    // Alpha's row is the one badged running: its select button's name includes
    // the spinner's "<title> is active" label.
    await threadsPanel.getByRole('button', { name: / is active/ }).click();
    await expect(alphaTab).toHaveAttribute('aria-selected', 'true');
    await expect(alphaViewport.getByText('held run alpha')).toBeVisible();
    await expect(runningSpinners).toHaveCount(1);

    await releaseGatedRuns(page);
    await expect(alphaViewport.getByText(GATED_RUN_RESPONSE)).toBeVisible();
    await expect(runningSpinners).toHaveCount(0);
    expect(await readGatedRuns(page)).toEqual({ cancelled: [], started: 1 });
    expect(pageErrors).toEqual([]);
  });
});
