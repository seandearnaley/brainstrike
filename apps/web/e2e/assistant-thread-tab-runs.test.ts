import { expect, type Page, test } from '@playwright/test';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import {
  GATED_RUN_RESPONSE,
  mockGatedLocalLlmHost,
  readGatedRuns,
  releaseGatedRuns,
} from './utils/assistant-mocks';
import { openAssistantWorkspace } from './utils/assistant-workspace';
import { getPanelElements } from './utils/layout-helpers';

/**
 * Thread tabs vs. runs in flight (BST-1838 characterisation, held green across
 * the tab-strip migration; BST-1844 flipped the close case to close = hide).
 * Every turn on the mocked local host is held until the test releases it, so
 * each tab gesture lands mid-run.
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
    await mockGatedLocalLlmHost(page);
    await openAssistantWorkspace(page, { enableLocalAssistantModel: true });
  });

  test('switching thread tabs mid-run neither aborts the run nor throws', async ({ page }) => {
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
  test('closing a running root thread tab hides it and the run completes in the background', async ({
    page,
  }) => {
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

  // Stop is the one gesture that aborts a run. The real desktop host answers
  // the cancel by rejecting `generate` with an error that has crossed Electron
  // IPC (a plain Error, message only), and the run must still end `cancelled`.
  test('Stop cancels the held run: the host is told and the run ends cancelled', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const { alphaId } = await startHeldRunInFirstOfTwoThreads(page);
    const alphaPanel = page.getByTestId(`assistant-thread-panel-${alphaId}`);
    const runningSpinners = page.getByTestId('threads-panel').getByTestId('thread-active-spinner');
    expect(await readThreadRunStatuses(page, alphaId)).toEqual(['running']);

    await alphaPanel.getByRole('button', { name: 'Stop' }).click();

    await expect.poll(async () => (await readGatedRuns(page)).cancelled).toHaveLength(1);
    await expect.poll(() => readThreadRunStatuses(page, alphaId)).toEqual(['cancelled']);
    await expect(runningSpinners).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('reopening a hidden running thread shows the live run, which then finishes in place', async ({
    page,
  }) => {
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
