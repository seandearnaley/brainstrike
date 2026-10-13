import type { Locator, Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';

const BACKGROUND_INDEXING_PREFERENCES_KEY = 'background-indexing-preferences.v1' as const;

interface PersistedBackgroundIndexingPreferences {
  readonly managedCollectionId: string | null;
  readonly nativeIndexMode: string | null;
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
    managedCollectionId: parsed.state?.managedCollectionId ?? null,
    nativeIndexMode: parsed.state?.nativeIndexMode ?? null,
    paused: parsed.state?.paused === true,
  };
}

test.describe('Workspace Index pause controls', { tag: '@smoke' }, () => {
  test('pause and resume an explicitly configured TEXT collection from settings', async ({
    homePage,
    window,
  }) => {
    const collectionId = await window.evaluate(async () => {
      if (!globalThis.window.collectionCatalog) {
        throw new Error('Desktop collection catalog is unavailable');
      }
      return (
        await globalThis.window.collectionCatalog
          .create({
            dimensions: 384,
            distance: 'cosine',
            metadata: { name: 'Pause control collection' },
            modelId: 'Xenova/all-MiniLM-L6-v2',
            modelKey: 'local::Xenova/all-MiniLM-L6-v2',
          })
          .then((result) => {
            if (!result.ok) {
              throw new Error(result.error.message);
            }
            return result.value;
          })
      ).id;
    });
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
    const managedCollection = window.getByRole('combobox', { name: 'Managed collection' });
    await expect(managedCollection).toContainText('No managed collection', { timeout: 15_000 });
    await managedCollection.click();
    await window.getByRole('option', { exact: true, name: 'Pause control collection' }).click();
    await window.getByRole('combobox', { name: 'Search mode' }).click();
    await window.getByRole('option', { exact: true, name: 'Text search' }).click();
    await expect
      .poll(() => readBackgroundIndexingPreferences(window), { timeout: 15_000 })
      .toMatchObject({ managedCollectionId: collectionId, nativeIndexMode: 'TEXT', paused: false });

    const indexingTrigger = window.getByTestId('indexing-status-trigger');
    const statusBarRight = window.getByTestId('status-bar-right');
    await expect(indexingTrigger).toBeVisible({ timeout: 15_000 });
    await expect(statusBarRight).toContainText('Workspace Index');
    await expect(indexingTrigger).toContainText('Ready', { timeout: 15_000 });
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

    // An explicitly selected empty native collection is ready and pausable.
    await expect(indexingTrigger).toContainText('Ready');
    await expect(
      indexingPopover.getByRole('button', { name: 'Pause workspace index' })
    ).toBeVisible();
    await expect(indexingPopover.getByTestId('indexing-action-region')).toHaveClass(/\bh-11\b/);

    await indexingPopover.getByRole('button', { name: 'Worker and database diagnostics' }).click();
    // Native search has no JS embedding worker: fe6b0f85e (BST-1974) omits the
    // retired "Worker state" row, so the expanded diagnostics open on the
    // database rows it still shows.
    await expect(indexingPopover.getByText('Database QoS')).toBeVisible();
    await expect(indexingPopover.getByText('Worker state')).toHaveCount(0);
    expectStableRect(triggerBeforePause, await requireBoundingBox(indexingTrigger));
    expectStableRect(popoverBeforeDiagnostics, await requireBoundingBox(indexingPopover));
  });
});
