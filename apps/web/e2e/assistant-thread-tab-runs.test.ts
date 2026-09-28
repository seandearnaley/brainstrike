import { expect, type Page, test } from '@playwright/test';
import {
  GATED_RUN_RESPONSE,
  mockGatedLocalLlmHost,
  readGatedRuns,
  releaseGatedRuns,
} from './utils/assistant-mocks';
import { openAssistantWorkspace } from './utils/assistant-workspace';
import { getPanelElements } from './utils/layout-helpers';

/**
 * Thread tabs vs. runs in flight (BST-1838 characterisation, written before
 * the tab-strip migration and held green across it). Every turn on the mocked
 * local host is held until the test releases it, so each tab gesture lands
 * mid-run.
 */

async function readOpenThreadTabIds(page: Page): Promise<readonly string[]> {
  return await page
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab')
    .evaluateAll((tabs) => tabs.map((tab) => tab.id.replace(/^assistant-thread-tab-/, '')));
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

  // CHARACTERISATION, not a contract: on web, closing a running root thread's
  // tab unmounts its panel, which ABORTS the run (the local runtime cancels the
  // host request) and leaves the durable run row `running`, so its spinner
  // outlives the run until the next startup reap. Pinned so the tab-strip
  // migration cannot move it silently; changing it is its own ticket.
  test('closing a running root thread tab on web aborts the run (characterised)', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const { alphaId, betaId } = await startHeldRunInFirstOfTwoThreads(page);
    const alphaTab = page.locator(`[id="assistant-thread-tab-${alphaId}"]`);
    const betaTab = page.locator(`[id="assistant-thread-tab-${betaId}"]`);
    const threadsPanel = page.getByTestId('threads-panel');

    await alphaTab.focus();
    await page.keyboard.press('Delete');
    await expect(alphaTab).toHaveCount(0);
    await expect(betaTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId(`assistant-thread-panel-${alphaId}`)).toHaveCount(0);
    await expect.poll(async () => (await readGatedRuns(page)).cancelled.length).toBe(1);

    // Releasing the host after the abort lands nothing anywhere.
    await releaseGatedRuns(page);
    await threadsPanel
      .getByTestId('thread-row')
      .filter({ hasNot: page.locator('button[aria-current="true"]') })
      .locator('button')
      .first()
      .click();
    await expect(alphaTab).toHaveAttribute('aria-selected', 'true');
    const alphaViewport = page
      .getByTestId(`assistant-thread-panel-${alphaId}`)
      .getByTestId('assistant-ui-viewport');
    await expect(alphaViewport).toBeVisible();
    // A bounded observation window: an absence has no event to wait on.
    await page.waitForTimeout(1000);
    await expect(alphaViewport.getByText(GATED_RUN_RESPONSE)).toHaveCount(0);
    await expect(threadsPanel.getByTestId('thread-active-spinner')).toHaveCount(1);
    expect((await readGatedRuns(page)).started).toBe(1);
    expect(pageErrors).toEqual([]);
  });
});
