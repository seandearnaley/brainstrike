import { waitForPopupAnimations } from '@brainstrike/e2e-test-utils/popup-animations';
import type { Locator } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';
import { readIndexConfig } from './utils/index-config';

async function requireBoundingBox(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Expected a visible indexing surface with measurable geometry.');
  }
  return box;
}

function expectStableRect(
  before: { height: number; width: number; x: number; y: number },
  after: { height: number; width: number; x: number; y: number }
): void {
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
}

test.describe('Workspace Index pause controls', { tag: '@smoke' }, () => {
  test('pause and resume a fresh profile Text index from settings', async ({
    homePage,
    window,
  }) => {
    await homePage.openSettings();
    await expect(window.getByRole('navigation', { name: 'Settings categories' })).toBeVisible();

    await window
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: /Search & Indexing/i })
      .click();

    const settingsPanel = window.getByTestId('settings-category-search-indexing');
    await expect(settingsPanel).toBeVisible();
    await expect(
      settingsPanel
        .getByRole('group', { name: 'Search mode' })
        .getByRole('button', { name: /^Text/ })
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    expect(await readIndexConfig(window)).toMatchObject({ mode: 'text', paused: false });

    const indexingTrigger = window.getByTestId('indexing-status-trigger');
    const statusBarRight = window.getByTestId('status-bar-right');
    await expect(indexingTrigger).toBeVisible({ timeout: 15_000 });
    await expect(statusBarRight).toContainText('Workspace Index');
    await expect(indexingTrigger).toContainText('Ready', { timeout: 15_000 });
    const triggerBeforePause = await requireBoundingBox(indexingTrigger);

    const pauseButton = settingsPanel.getByRole('button', { name: 'Pause indexing' });
    await expect(pauseButton).toBeVisible({ timeout: 15_000 });
    await pauseButton.focus();
    await window.keyboard.press('Enter');

    const resumeButton = settingsPanel.getByRole('button', { name: 'Resume indexing' });
    await expect(resumeButton).toBeVisible({ timeout: 15_000 });
    await expect(indexingTrigger).toContainText('Paused', { timeout: 15_000 });
    expectStableRect(triggerBeforePause, await requireBoundingBox(indexingTrigger));

    await expect
      .poll(async () => await readIndexConfig(window), {
        message: 'Expected activating Pause indexing to save paused=true.',
        timeout: 15_000,
      })
      .toMatchObject({ paused: true });

    await resumeButton.focus();
    await window.keyboard.press('Enter');

    await expect
      .poll(async () => await readIndexConfig(window), {
        message: 'Expected activating Resume indexing to save paused=false.',
        timeout: 15_000,
      })
      .toMatchObject({ paused: false });

    await expect(settingsPanel.getByRole('button', { name: 'Pause indexing' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(indexingTrigger).not.toContainText('Paused', { timeout: 15_000 });
    expectStableRect(triggerBeforePause, await requireBoundingBox(indexingTrigger));

    await homePage.leaveSettings();

    await indexingTrigger.click();
    const indexingPopover = window.getByTestId('indexing-status-popover');
    await expect(indexingPopover).toBeVisible({ timeout: 15_000 });
    await expect(indexingPopover.getByText('Files', { exact: true })).toBeVisible();
    await expect(indexingPopover.getByText('Chunks', { exact: true })).toBeVisible();
    await waitForPopupAnimations(indexingPopover);
    const popoverBeforeDiagnostics = await requireBoundingBox(indexingPopover);

    // The fresh profile's Text index is ready and pausable.
    await expect(indexingTrigger).toContainText('Ready');
    await expect(
      indexingPopover.getByRole('button', { name: 'Pause workspace index' })
    ).toBeVisible();
    await expect(indexingPopover.getByTestId('indexing-action-region')).toHaveClass(/\bh-11\b/);

    await indexingPopover.getByRole('button', { name: 'Worker and database diagnostics' }).click();
    // Native search has no JS embedding worker: fe6b0f85e (BST-1974) omits the
    // retired "Worker state" row, so the expanded diagnostics open on the
    // database rows it still shows.
    await expect(indexingPopover.getByText('Database QoS', { exact: true })).toBeVisible();
    await expect(indexingPopover.getByText('Worker state')).toHaveCount(0);
    expectStableRect(triggerBeforePause, await requireBoundingBox(indexingTrigger));
    expectStableRect(popoverBeforeDiagnostics, await requireBoundingBox(indexingPopover));
  });
});
