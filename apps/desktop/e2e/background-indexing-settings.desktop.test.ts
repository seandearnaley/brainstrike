import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';

const BACKGROUND_INDEXING_PREFERENCES_KEY = 'background-indexing-preferences.v1' as const;

interface PersistedBackgroundIndexingPreferences {
  enabled: boolean;
  indexingPolicyPreset: 'balanced' | 'full-root';
  managedCollectionId: string | null;
  mode: 'root-folder-cache';
}

interface ElectronHarnessLike {
  getUserDataDir: () => string;
}

async function seedBackgroundIndexingPreferences(args: {
  electronHarness: ElectronHarnessLike;
  preferences: PersistedBackgroundIndexingPreferences;
}): Promise<void> {
  const userDataDir = args.electronHarness.getUserDataDir();
  await mkdir(userDataDir, { recursive: true });

  const storagePath = path.join(userDataDir, 'electron-storage.json');
  let existingStorage: Record<string, string> = {};
  try {
    existingStorage = JSON.parse(await readFile(storagePath, 'utf8')) as Record<string, string>;
  } catch {
    existingStorage = {};
  }

  const nextStorage = {
    ...existingStorage,
    [BACKGROUND_INDEXING_PREFERENCES_KEY]: JSON.stringify({
      state: args.preferences,
      version: 2,
    }),
  };

  await writeFile(storagePath, JSON.stringify(nextStorage, null, 2), 'utf8');
}

async function openSearchIndexingSettings(args: { homePage: HomePage; page: Page }): Promise<void> {
  await args.homePage.openSettings();
  await args.page.getByRole('button', { name: 'Search & Indexing' }).click();
  await expect(args.page.getByTestId('settings-category-search-indexing')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Background indexing settings (desktop)', () => {
  test('clears a stale managed collection after the DB is wiped instead of surfacing invalid metadata', async ({
    electron,
  }) => {
    await seedBackgroundIndexingPreferences({
      electronHarness: electron,
      preferences: {
        enabled: true,
        indexingPolicyPreset: 'balanced',
        managedCollectionId: 'set-stale-after-db-wipe',
        mode: 'root-folder-cache',
      },
    });

    const { window } = await electron.ensureContext();
    const homePage = new HomePage(window);
    await openSearchIndexingSettings({ homePage, page: window });

    const managedCollectionTrigger = window.locator('#managed-cache-collection');
    await expect(window.getByRole('switch', { name: /background indexing/i })).toBeChecked({
      timeout: 15_000,
    });
    await expect(managedCollectionTrigger).toContainText('No managed collection', {
      timeout: 15_000,
    });

    await expect
      .poll(
        async () =>
          await window
            .getByText('Managed collection metadata is invalid.', { exact: true })
            .count(),
        {
          timeout: 15_000,
          message: 'Stale managed collection ids should not surface the invalid-metadata error.',
        }
      )
      .toBe(0);
  });
});
