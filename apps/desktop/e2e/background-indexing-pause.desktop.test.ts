import type { Locator, Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';

const BACKGROUND_INDEXING_PREFERENCES_KEY = 'background-indexing-preferences.v1' as const;

interface PersistedBackgroundIndexingPreferences {
  readonly paused: boolean;
}

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

async function readBackgroundIndexingPreferences(
  page: Page
): Promise<PersistedBackgroundIndexingPreferences | null> {
  const raw = await page.evaluate(async (key) => {
    const api = (
      window as Window & {
        electronAPI?: {
          storage?: {
            getItem?: (storageKey: string) => Promise<string | null>;
          };
        };
      }
    ).electronAPI;
    if (!api?.storage?.getItem) {
      throw new Error('Desktop storage bridge is unavailable.');
    }
    return await api.storage.getItem(key);
  }, BACKGROUND_INDEXING_PREFERENCES_KEY);
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as { state?: Partial<PersistedBackgroundIndexingPreferences> };
  return {
    paused: parsed.state?.paused === true,
  };
}

test.describe('Workspace Index pause controls', { tag: '@smoke' }, () => {
  test('pause and resume the bootstrapped workspace index from settings', async ({
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
    await expect(window.getByRole('switch', { name: 'Workspace Index' })).toBeChecked({
      timeout: 15_000,
    });
    await expect(window.locator('#managed-cache-collection')).toContainText('Workspace Index', {
      timeout: 15_000,
    });

    const indexingTrigger = window.getByTestId('indexing-status-trigger');
    const statusBarRight = window.getByTestId('status-bar-right');
    await expect(indexingTrigger).toBeVisible({ timeout: 15_000 });
    await expect(statusBarRight).toContainText('Workspace Index');
    const triggerBeforePause = await requireBoundingBox(indexingTrigger);

    const pauseButton = settingsPanel.getByRole('button', { name: 'Pause workspace index' });
    await expect(pauseButton).toBeVisible({ timeout: 15_000 });
    await pauseButton.focus();
    await window.keyboard.press('Enter');

    const resumeButton = settingsPanel.getByRole('button', { name: 'Resume workspace index' });
    await expect(resumeButton).toBeVisible({ timeout: 15_000 });
    await expect(indexingTrigger).toContainText('Paused', { timeout: 15_000 });
    expectStableRect(triggerBeforePause, await requireBoundingBox(indexingTrigger));

    await expect
      .poll(async () => await readBackgroundIndexingPreferences(window), {
        message: 'Expected activating Pause workspace index to persist paused=true.',
        timeout: 15_000,
      })
      .toMatchObject({ paused: true });

    await resumeButton.focus();
    await window.keyboard.press('Enter');

    await expect
      .poll(async () => await readBackgroundIndexingPreferences(window), {
        message: 'Expected activating Resume workspace index to persist paused=false.',
        timeout: 15_000,
      })
      .toMatchObject({ paused: false });

    await expect(settingsPanel.getByRole('button', { name: 'Pause workspace index' })).toBeVisible({
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
    const popoverBeforeDiagnostics = await requireBoundingBox(indexingPopover);

    // BST-1335: this test bootstraps the managed collection but never selects a
    // workspace root, so the sync status is `unconfigured` — setup incomplete,
    // nothing broken. It previously read 'Blocked' (alarming amber) only because
    // the no-root case was misclassified as `error`; asserting that again would
    // re-pin the bug this change removed. The pause control stays hidden either
    // way: `shouldShowWorkspaceCollectionSyncPauseControl` is an allow-list of
    // running/pausable states and excludes `unconfigured`.
    await expect(indexingTrigger).toContainText('No root selected');
    await expect(
      indexingPopover.getByRole('button', { name: 'Pause workspace index' })
    ).toHaveCount(0);
    await expect(indexingPopover.getByTestId('indexing-action-region')).toHaveClass(/\bh-11\b/);

    await indexingPopover.getByRole('button', { name: 'Worker and database diagnostics' }).click();
    await expect(indexingPopover.getByText('Worker state')).toBeVisible();
    expectStableRect(triggerBeforePause, await requireBoundingBox(indexingTrigger));
    expectStableRect(popoverBeforeDiagnostics, await requireBoundingBox(indexingPopover));
  });
});
