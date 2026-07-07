import type { Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';

const BACKGROUND_INDEXING_PREFERENCES_KEY = 'background-indexing-preferences.v1' as const;

interface PersistedBackgroundIndexingPreferences {
  readonly paused: boolean;
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

    const pauseButton = settingsPanel.getByRole('button', { name: 'Pause workspace index' });
    await expect(pauseButton).toBeVisible({ timeout: 15_000 });
    await pauseButton.focus();
    await window.keyboard.press('Enter');

    const resumeButton = settingsPanel.getByRole('button', { name: 'Resume workspace index' });
    await expect(resumeButton).toBeVisible({ timeout: 15_000 });

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
  });
});
