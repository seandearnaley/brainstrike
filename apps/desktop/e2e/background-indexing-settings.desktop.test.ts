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

interface WorkspaceIndexRow {
  readonly dimensions: number;
  readonly id: string;
  readonly model_id: string;
  readonly model_key: string;
  readonly name: string;
  readonly system_role: 'workspace-index';
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

async function readWorkspaceIndexRows(page: Page): Promise<WorkspaceIndexRow[]> {
  return await page.evaluate(async () => {
    const api = window.electronAPI;
    if (!api?.db.query) {
      throw new Error('Desktop DB query bridge is unavailable.');
    }

    const result = await api.db.query<WorkspaceIndexRow>(
      `SELECT id, name, model_id, model_key, dimensions, system_role
       FROM embedding_sets
       WHERE system_role = $1
       ORDER BY created_at ASC`,
      ['workspace-index']
    );
    return result.rows;
  });
}

test.describe('Workspace Index settings (desktop)', () => {
  test('rebinds a stale managed collection to the protected workspace index', async ({
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
    await expect(window.getByRole('switch', { name: 'Workspace Index' })).toBeChecked({
      timeout: 15_000,
    });
    await expect(managedCollectionTrigger).toContainText('Workspace Index', {
      timeout: 15_000,
    });
    await expect(window.getByText(/Current managed collection:\s*Workspace Index/)).toBeVisible({
      timeout: 15_000,
    });

    await expect
      .poll(
        async () =>
          await window
            .getByText('Managed collection metadata is invalid.', { exact: true })
            .count(),
        {
          message: 'Stale managed collection ids should not surface the invalid-metadata error.',
          timeout: 15_000,
        }
      )
      .toBe(0);

    await expect
      .poll(async () => await readWorkspaceIndexRows(window), {
        message: 'Expected exactly one protected Workspace Index embedding set.',
        timeout: 15_000,
      })
      .toMatchObject([
        {
          dimensions: 384,
          model_id: 'Xenova/all-MiniLM-L6-v2',
          model_key: 'local::Xenova/all-MiniLM-L6-v2',
          name: 'Workspace Index',
          system_role: 'workspace-index',
        },
      ]);
  });
});
